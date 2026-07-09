/**
 * Handoff clock-in wizard — /shifts/[id]/handoff-clock-in
 *
 * Recipient side of a mid-shift handoff. Single-file wizard with internal
 * step state (chosen over a nested Stack because the whole flow completes
 * in one screen lifetime; no push accumulation surface, no per-step back
 * gesture to defend against). Entry via router.push from shift detail;
 * completion via router.replace so back gesture doesn't dump the user
 * back into the wizard.
 *
 * Wizard shape mirrors regular clock-in but is shorter:
 *   step 1 — GPS Verification (same isPointInPolygon + haversine logic
 *            as clock-in step1, feeds off Bug 1's hydrated geofence)
 *   step 2 — Selfie capture (inline copy of step2.tsx's CameraView
 *            pattern; a follow-up hygiene commit will extract a shared
 *            SelfieCapture component and thin both files)
 *   step 3 — Submit: uploadToS3 → POST /handoff-clock-in → POST
 *            /locations/clock-in-verification. Idempotency key generated
 *            once per mount so a network-blip retry replays the same
 *            transaction.
 *
 * Preconditions (all enforced BEFORE step 1 renders):
 *   - GET /shifts/:id succeeds (server tenancy already allows accepted-
 *     handoff recipients per Phase 2a)
 *   - Shift is active
 *   - swap_history has an accepted-handoff row addressed to me
 *   - Shift geofence hydrated (Bug 1 fix)
 * On any precondition failure we bail with a clear error and the guard
 * returns to the shift-detail page.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert,
  Image, ScrollView,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Location from 'expo-location';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Sentry from '@sentry/react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import { apiClient } from '../../../lib/apiClient';
import { uploadToS3 } from '../../../lib/uploadToS3';
import { uuidv4 } from '../../../lib/uuid';
import { useAuthStore } from '../../../store/authStore';
import { isPointInPolygon, haversineDistance } from '../../../utils/geofence';
import { Colors, Spacing, Radius, Fonts } from '../../../constants/theme';

type Step = 'loading' | 'gps' | 'selfie' | 'preview' | 'submit' | 'error';

interface Geofence {
  polygon_coordinates: { lat: number; lng: number }[];
  center_lat:          number;
  center_lng:          number;
  radius_meters:       number;
}

interface SwapHistoryRow {
  id:              string;
  status:          'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  initiated_by:    'admin' | 'guard_pre_shift' | 'guard_handoff';
  to_guard_id:     string | null;
  from_guard_id:   string | null;
  from_guard_name: string | null;
}

interface ShiftDetail {
  id:              string;
  guard_id:        string | null;
  site_id:         string;
  site_name:       string;
  status:          'scheduled' | 'active' | 'completed' | 'missed' | 'cancelled';
  geofence:        Geofence | null;
  swap_history:    SwapHistoryRow[];
}

interface Selfie {
  uri:       string;
  latitude:  number;
  longitude: number;
  takenAt:   string;
}

const SUBMIT_STAGES = ['Uploading selfie…', 'Handing off…', 'Saving verification…'];

export default function HandoffClockInWizard() {
  const { id: shiftId } = useLocalSearchParams<{ id: string }>();
  const { guardId } = useAuthStore();

  const [step,      setStep]      = useState<Step>('loading');
  const [errMsg,    setErrMsg]    = useState<string | null>(null);
  const [shift,     setShift]     = useState<ShiftDetail | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);

  // GPS state
  const [verifiedCoords, setVerifiedCoords] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [gpsCoords,      setGpsCoords]      = useState<{ lat: number; lng: number } | null>(null);
  const [gpsState,       setGpsState]       = useState<'checking' | 'inside' | 'outside' | 'perm_denied' | 'error'>('checking');

  // Selfie state
  const [selfie,      setSelfie]      = useState<Selfie | null>(null);
  const [cameraReady, setCameraReady] = useState(false);
  const [capturing,   setCapturing]   = useState(false);
  const cameraRef = useRef<CameraView>(null);
  const [cameraPerm, requestCameraPerm] = useCameraPermissions();

  // Submit state
  const [submitStage, setSubmitStage] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [idempotencyKey] = useState(() => uuidv4());

  // ── Load + validate the shift ────────────────────────────────────────────
  useEffect(() => {
    Sentry.addBreadcrumb({
      category: 'handoff_clock_in',
      message: 'wizard mounted',
      level: 'info',
      data: { shift_id: shiftId },
    });
    let cancelled = false;
    (async () => {
      try {
        const data = await apiClient.get<ShiftDetail>(`/shifts/${shiftId}`);
        if (cancelled) return;

        // Precondition: shift is active
        if (data.status !== 'active') {
          setErrMsg(`This shift is ${data.status}. Handoff is only available for active shifts.`);
          setStep('error');
          return;
        }
        // Precondition: there's an accepted handoff for me on this shift
        const my = data.swap_history.find(
          (r) => r.initiated_by === 'guard_handoff'
              && r.status === 'accepted'
              && r.to_guard_id === guardId,
        );
        if (!my) {
          setErrMsg('No pending handoff for this shift.');
          setStep('error');
          return;
        }
        // Precondition: geofence hydrated (Bug 1)
        if (!data.geofence) {
          Sentry.captureMessage('handoff-clock-in: geofence null on active shift', {
            level: 'error',
            extra: { shift_id: shiftId },
          });
          setErrMsg('Site boundary not configured. Please contact your supervisor.');
          setStep('error');
          return;
        }
        setShift(data);
        setHistoryId(my.id);
        setStep('gps');
        Sentry.addBreadcrumb({
          category: 'handoff_clock_in',
          message: 'preconditions ok → step gps',
          level: 'info',
          data: { history_id: my.id, from_guard: my.from_guard_name },
        });
      } catch (err: any) {
        if (cancelled) return;
        Sentry.captureException(err, { extra: { where: 'handoff-clock-in.load' } });
        setErrMsg(err?.message ?? 'Could not load shift.');
        setStep('error');
      }
    })();
    return () => { cancelled = true; };
  }, [shiftId, guardId]);

  // ── Step 1: GPS check ────────────────────────────────────────────────────
  const checkGeofence = useCallback(async () => {
    if (!shift?.geofence) return;
    setGpsState('checking');
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setGpsState('perm_denied');
        Sentry.addBreadcrumb({
          category: 'handoff_clock_in',
          message: 'step gps: permission denied',
          level: 'warning',
        });
        return;
      }
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const point    = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      const accuracy = typeof loc.coords.accuracy === 'number' ? loc.coords.accuracy : 30;
      setGpsCoords(point);

      // Radius pre-check (Haversine) then polygon check (ray casting).
      // Same policy as regular clock-in — allow if inside polygon OR
      // within radius+accuracy budget.
      const distance = haversineDistance(point.lat, point.lng, shift.geofence.center_lat, shift.geofence.center_lng);
      if (distance > shift.geofence.radius_meters * 1.5) {
        setGpsState('outside');
        Sentry.addBreadcrumb({
          category: 'handoff_clock_in',
          message: 'step gps: outside (radius pre-check)',
          level: 'warning',
          data: { distance_m: Math.round(distance), radius_m: shift.geofence.radius_meters },
        });
        return;
      }
      const inside = isPointInPolygon(point, shift.geofence.polygon_coordinates);
      Sentry.addBreadcrumb({
        category: 'handoff_clock_in',
        message: `step gps: boundary check → ${inside ? 'inside' : 'outside'}`,
        level: inside ? 'info' : 'warning',
        data: { accuracy_m: Math.round(accuracy) },
      });
      if (inside) {
        setVerifiedCoords({ lat: point.lat, lng: point.lng, accuracy });
        setGpsState('inside');
      } else {
        setGpsState('outside');
      }
    } catch (err) {
      Sentry.captureException(err, { extra: { where: 'handoff-clock-in.checkGeofence' } });
      setGpsState('error');
    }
  }, [shift?.geofence]);

  useEffect(() => {
    if (step === 'gps') checkGeofence();
  }, [step, checkGeofence]);

  // ── Step 2: Selfie capture ───────────────────────────────────────────────
  // Android sometimes never fires onCameraReady — force-enable after 3s.
  useEffect(() => {
    if (step !== 'selfie') return;
    Sentry.addBreadcrumb({
      category: 'handoff_clock_in',
      message: 'entered step selfie',
      level: 'info',
    });
    const t = setTimeout(() => setCameraReady(true), 3000);
    return () => clearTimeout(t);
  }, [step]);

  async function capture() {
    if (!cameraRef.current || !cameraReady || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo?.uri) throw new Error('Camera did not return a photo. Try again.');
      let compressed: { uri: string } = { uri: photo.uri };
      try {
        const r = await ImageManipulator.manipulateAsync(
          photo.uri,
          [{ resize: { width: 1080 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        if (r?.uri) compressed = r;
      } catch { /* fall back to raw photo */ }

      // GPS tag: cached last-known first, then live with a 3s cap.
      const loc = await Location.getLastKnownPositionAsync() ?? await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((r) => setTimeout(() => r(null), 3000)),
      ]);
      setSelfie({
        uri:       compressed.uri,
        latitude:  (loc as any)?.coords?.latitude  ?? 0,
        longitude: (loc as any)?.coords?.longitude ?? 0,
        takenAt:   new Date().toISOString(),
      });
      setStep('preview');
      Sentry.addBreadcrumb({
        category: 'handoff_clock_in',
        message: 'step selfie: captured → preview',
        level: 'info',
      });
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: 'handoff-clock-in.capture' } });
      Alert.alert('Capture Failed', err?.message ?? 'Could not take photo. Try again.');
    } finally {
      setCapturing(false);
    }
  }

  // ── Step 3: Submit ───────────────────────────────────────────────────────
  async function startSubmit() {
    if (!verifiedCoords || !selfie || !shift) return;
    setStep('submit');
    setSubmitError(null);
    setSubmitStage(0);
    Sentry.addBreadcrumb({
      category: 'handoff_clock_in',
      message: 'submit initiated',
      level: 'info',
      data: { history_id: historyId, idempotency_key: idempotencyKey },
    });
    try {
      // 1) Upload selfie
      let selfieUrl = 'pending';
      try {
        const up = await uploadToS3(selfie.uri, 'clock_in');
        selfieUrl = up.public_url;
        Sentry.addBreadcrumb({
          category: 'handoff_clock_in',
          message: 'submit: selfie uploaded',
          level: 'info',
        });
      } catch (err) {
        // Non-fatal — fall through with 'pending' like regular clock-in.
        Sentry.addBreadcrumb({
          category: 'handoff_clock_in',
          message: 'submit: selfie upload failed (falling back to "pending")',
          level: 'warning',
          data: { error: (err as any)?.message ?? String(err) },
        });
      }

      // 2) Handoff clock-in — rotates the session + shift.guard_id atomically.
      setSubmitStage(1);
      Sentry.addBreadcrumb({
        category: 'handoff_clock_in',
        message: 'submit: POST /handoff-clock-in',
        level: 'info',
      });
      const session = await apiClient.post<{ id: string; site_id: string; clocked_in_at: string }>(
        `/shifts/${shift.id}/handoff-clock-in`,
        {
          lat:      verifiedCoords.lat,
          lng:      verifiedCoords.lng,
          accuracy: verifiedCoords.accuracy,
        },
        { headers: { 'Idempotency-Key': idempotencyKey } },
      );

      // 3) Verification row — same downstream table regular clock-in writes to.
      setSubmitStage(2);
      Sentry.addBreadcrumb({
        category: 'handoff_clock_in',
        message: 'submit: POST /locations/clock-in-verification',
        level: 'info',
        data: { session_id: session.id },
      });
      await apiClient.post('/locations/clock-in-verification', {
        shift_session_id:   session.id,
        selfie_url:         selfieUrl,
        site_photo_url:     null,
        verified_lat:       verifiedCoords.lat,
        verified_lng:       verifiedCoords.lng,
        accuracy:           verifiedCoords.accuracy,
        is_within_geofence: true,
      });

      Sentry.addBreadcrumb({
        category: 'handoff_clock_in',
        message: 'submit complete',
        level: 'info',
      });
      // Land on the schedule tab; the guard's shift-list will refetch on
      // focus and show the newly-active shift.
      router.replace('/(tabs)/schedule');
    } catch (err: any) {
      Sentry.addBreadcrumb({
        category: 'handoff_clock_in',
        message: 'submit failed',
        level: 'error',
        data: { error: err?.message ?? String(err) },
      });
      Sentry.captureException(err, { extra: { where: 'handoff-clock-in.submit' } });
      // 422 → geofence failed on server; bounce to gps step to re-check.
      if (err?.message === 'GEOFENCE_FAILED') {
        Alert.alert(
          'Outside Site',
          'You appear to be outside the site post. Move to the entrance and try again.',
          [{ text: 'OK', onPress: () => setStep('gps') }],
          { cancelable: false },
        );
        return;
      }
      setSubmitError(err?.message ?? 'Could not complete handoff.');
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace(`/shifts/${shiftId}`);
  }

  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={8}>
        <Ionicons name="chevron-back" size={22} color={Colors.warning} />
        <Text style={styles.backText}>SHIFT</Text>
      </TouchableOpacity>
      <Text style={styles.title}>HANDOFF CLOCK IN</Text>
    </View>
  );

  if (step === 'loading') {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.center}><ActivityIndicator color={Colors.warning} size="large" /></View>
      </View>
    );
  }
  if (step === 'error') {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.center}>
          <Text style={styles.errorText}>{errMsg}</Text>
          <TouchableOpacity style={styles.secondaryBtn} onPress={goBack}>
            <Text style={styles.secondaryBtnText}>BACK TO SHIFT</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (step === 'gps') {
    const distance = gpsCoords && shift?.geofence
      ? haversineDistance(gpsCoords.lat, gpsCoords.lng, shift.geofence.center_lat, shift.geofence.center_lng)
      : null;
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.body}>
          <Text style={styles.stepLabel}>STEP 1 OF 3 · GPS VERIFICATION</Text>
          <Text style={styles.stepTitle}>
            {gpsState === 'checking' ? 'Checking location…'
              : gpsState === 'inside' ? 'You are on-site'
              : gpsState === 'outside' ? 'Move to the site'
              : gpsState === 'perm_denied' ? 'Location permission needed'
              : 'Could not verify location'}
          </Text>
          <View style={styles.infoCard}>
            <InfoRow label="Site" value={shift?.site_name ?? '—'} />
            {gpsCoords && (
              <InfoRow label="Your GPS" value={`${gpsCoords.lat.toFixed(5)}, ${gpsCoords.lng.toFixed(5)}`} />
            )}
            {distance != null && (
              <InfoRow label="Distance to site" value={`${Math.round(distance)} m`} />
            )}
            <InfoRow
              label="Status"
              value={gpsState === 'checking' ? 'Checking…'
                : gpsState === 'inside' ? 'Inside boundary'
                : gpsState === 'outside' ? 'Outside boundary'
                : gpsState === 'perm_denied' ? 'Permission denied'
                : 'Error'}
              valueColor={gpsState === 'inside' ? Colors.success
                : gpsState === 'checking' ? Colors.muted : Colors.danger}
            />
          </View>

          {gpsState === 'outside' && (
            <Text style={styles.hint}>You must be at {shift?.site_name} to clock in.</Text>
          )}

          <View style={{ flex: 1 }} />

          <TouchableOpacity
            style={[styles.primaryBtn, gpsState !== 'inside' && styles.disabled]}
            disabled={gpsState !== 'inside'}
            onPress={() => {
              Sentry.addBreadcrumb({
                category: 'handoff_clock_in',
                message: 'gps → selfie',
                level: 'info',
              });
              setStep('selfie');
            }}
          >
            <Text style={styles.primaryBtnText}>NEXT: TAKE SELFIE</Text>
          </TouchableOpacity>
          {(gpsState === 'outside' || gpsState === 'error' || gpsState === 'perm_denied') && (
            <TouchableOpacity style={styles.retryLink} onPress={checkGeofence}>
              <Text style={styles.retryText}>Retry GPS check</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  if (step === 'selfie') {
    if (!cameraPerm) return null;
    if (!cameraPerm.granted) {
      return (
        <View style={styles.container}>
          {header}
          <View style={styles.center}>
            <Text style={styles.errorText}>Camera access required</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={requestCameraPerm}>
              <Text style={styles.primaryBtnText}>GRANT CAMERA ACCESS</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.body}>
          <Text style={styles.stepLabel}>STEP 2 OF 3 · SELFIE</Text>
          <Text style={styles.stepTitle}>Take a clear photo of yourself</Text>

          <View style={styles.cameraBox}>
            <CameraView
              ref={cameraRef}
              style={styles.camera}
              facing={'front' as CameraType}
              onCameraReady={() => setCameraReady(true)}
            />
            {!cameraReady && (
              <View style={styles.loadingOverlay}>
                <Text style={styles.loadingText}>Initialising camera…</Text>
              </View>
            )}
          </View>

          <TouchableOpacity
            style={[styles.shutter, (!cameraReady || capturing) && styles.disabled]}
            onPress={capture}
            disabled={!cameraReady || capturing}
          >
            <View style={[styles.shutterInner, capturing && styles.shutterCapturing]} />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (step === 'preview' && selfie) {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.body}>
          <Text style={styles.stepLabel}>PHOTO PREVIEW</Text>
          <Image source={{ uri: selfie.uri }} style={styles.previewImage} resizeMode="cover" />
          <View style={styles.previewActions}>
            <TouchableOpacity style={styles.secondaryBtn} onPress={() => { setSelfie(null); setStep('selfie'); }}>
              <Text style={styles.secondaryBtnText}>RETAKE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.primaryBtn} onPress={startSubmit}>
              <Text style={styles.primaryBtnText}>COMPLETE HANDOFF</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    );
  }

  // step === 'submit'
  return (
    <View style={styles.container}>
      {header}
      <View style={styles.body}>
        <Text style={styles.stepLabel}>STEP 3 OF 3 · CLOCKING IN</Text>
        {submitError ? (
          <ScrollView contentContainerStyle={styles.center}>
            <Text style={styles.errorText}>{submitError}</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={startSubmit}>
              <Text style={styles.primaryBtnText}>RETRY</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={goBack}>
              <Text style={styles.secondaryBtnText}>BACK TO SHIFT</Text>
            </TouchableOpacity>
          </ScrollView>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={Colors.warning} size="large" />
            {SUBMIT_STAGES.map((s, i) => (
              <Text
                key={s}
                style={[
                  styles.hint,
                  i === submitStage && { color: Colors.textPrimary, fontWeight: '700' },
                  i < submitStage  && { color: Colors.success },
                ]}
              >
                {i < submitStage ? '✓' : i === submitStage ? '·' : '·'} {s}
              </Text>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

function InfoRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, valueColor ? { color: valueColor } : undefined]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  header: {
    paddingHorizontal: Spacing.lg,
    paddingTop: 60,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: Spacing.xs,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  backText: { color: Colors.warning, fontFamily: Fonts.heading, fontSize: 12, letterSpacing: 2, marginLeft: 2 },
  title: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 22, letterSpacing: 3 },

  body: { flex: 1, padding: Spacing.md },
  stepLabel: { color: Colors.warning, fontFamily: Fonts.heading, fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm },
  stepTitle: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 22, letterSpacing: 2, marginBottom: Spacing.lg },

  infoCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.sm },
  infoLabel: { color: Colors.muted, fontSize: 13 },
  infoValue: { color: Colors.textPrimary, fontSize: 13, fontFamily: 'monospace' },
  hint: { color: Colors.muted, fontSize: 13, textAlign: 'center', marginBottom: Spacing.sm },

  cameraBox: { flex: 1, width: '100%', overflow: 'hidden', borderRadius: Radius.md, marginBottom: Spacing.md },
  camera: { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: { color: Colors.muted, fontSize: 14 },

  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: Colors.warning,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'center',
    marginBottom: Spacing.lg,
  },
  shutterInner:     { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.warning },
  shutterCapturing: { backgroundColor: Colors.action },
  disabled:         { opacity: 0.35 },

  previewImage: { width: '100%', flex: 1, borderRadius: Radius.md, marginBottom: Spacing.md },
  previewActions: {
    flexDirection: 'row',
    gap: Spacing.md,
    marginBottom: Spacing.md,
  },

  primaryBtn: {
    backgroundColor: Colors.warning,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    flex: 1,
  },
  primaryBtnText: { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 14, letterSpacing: 2 },
  secondaryBtn: {
    borderRadius: Radius.md,
    borderWidth: 1.5, borderColor: Colors.muted,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    flex: 1,
  },
  secondaryBtnText: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 14, letterSpacing: 2 },
  retryLink: { alignSelf: 'center', paddingVertical: Spacing.sm },
  retryText: { color: Colors.warning, fontSize: 13 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.lg, gap: Spacing.md },
  errorText: { color: Colors.textPrimary, fontSize: 15, textAlign: 'center' },
});
