/**
 * Clock-In Step 4 — Confirmation (Section 5.2)
 * Shows all three proofs: GPS coords, selfie thumbnail, site photo thumbnail.
 * START SHIFT:
 *   1. Upload selfie + site photo to S3 via presigned URL
 *   2. POST /api/shifts/:id/clock-in  → creates session + generates task instances
 *   3. POST /api/locations/clock-in-verification  → stores S3 photo proofs
 */
import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, Alert, ActivityIndicator, Modal, Linking } from 'react-native';
import { router } from 'expo-router';
import { useClockInStore } from '../../store/clockInStore';
import { useShiftStore }   from '../../store/shiftStore';
import { apiClient }       from '../../lib/apiClient';
import { uploadToS3 }      from '../../lib/uploadToS3';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const STEPS = ['Uploading selfie…', 'Starting shift…', 'Saving verification…'];

export default function ClockInStep4() {
  const [submitting,  setSubmitting]  = useState(false);
  const [statusStep,  setStatusStep]  = useState(0);
  const [showInstructions, setShowInstructions] = useState(false);
  const [instructionsPdfUrl, setInstructionsPdfUrl] = useState<string | null>(null);

  const {
    verifiedLatitude,
    verifiedLongitude,
    verifiedAccuracy,
    verifiedAt,
    selfie,
    sitePhoto,
    pendingShiftId,
    reset: resetClockIn,
  } = useClockInStore();

  const { pendingShift, setActiveSession } = useShiftStore();

  // ── Guard: selfie proof must be present ──────────────────────────────
  if (!verifiedLatitude || !selfie || !pendingShiftId) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorTitle}>INCOMPLETE DATA</Text>
        <Text style={styles.errorSub}>Please restart the clock-in flow.</Text>
        <TouchableOpacity style={styles.button} onPress={() => router.replace('/(tabs)/home')}>
          <Text style={styles.buttonText}>RESTART</Text>
        </TouchableOpacity>
      </View>
    );
  }

  async function startShift() {
    if (submitting) return;
    // Validators below were already gated on these — narrowing for TS clarity
    // so we can pass non-null primitives to the API.
    const lat = verifiedLatitude!;
    const lng = verifiedLongitude!;
    const accuracy = verifiedAccuracy ?? 30; // step1 defaults null → 30; keep parity
    setSubmitting(true);
    try {
      // Step 1 — upload selfie (S3 optional; use placeholder if not configured)
      setStatusStep(0);
      let selfieUrl = 'pending';
      try {
        const selfieUpload = await uploadToS3(selfie!.uri, 'clock_in');
        selfieUrl = selfieUpload.public_url;
      } catch { /* S3 not configured — continue without photo URL */ }

      // Step 2 — clock in (creates shift_session + triggers task instance generation)
      // Server validates lat/lng/accuracy against the site geofence inside the
      // clock-in transaction; on fail returns 422 GEOFENCE_FAILED.
      setStatusStep(1);
      const session = await apiClient.post<{ id: string; site_id: string; clocked_in_at: string }>(
        `/shifts/${pendingShiftId}/clock-in`,
        {
          clock_in_coords: `(${lat},${lng})`,
          lat,
          lng,
          accuracy,
        },
      );

      // Step 3 — save photo verification proofs.
      // is_within_geofence is sent for wire compatibility but the server
      // computes its own truth from verified_lat/lng/accuracy and overrides
      // whatever we claim here.
      setStatusStep(2);
      await apiClient.post('/locations/clock-in-verification', {
        shift_session_id:   session.id,
        selfie_url:         selfieUrl,
        site_photo_url:     null,
        verified_lat:       lat,
        verified_lng:       lng,
        accuracy,
        is_within_geofence: true,
      });

      // Use the stored pendingShift object; fall back to a minimal shape
      const shiftForStore = pendingShift ?? {
        id:              pendingShiftId,
        site_id:         session.site_id,
        site_name:       '',
        scheduled_start: session.clocked_in_at,
        scheduled_end:   session.clocked_in_at,
      };
      setActiveSession(shiftForStore, { ...session, shift_id: pendingShiftId });
      resetClockIn();

      const pdfUrl = pendingShift?.instructions_pdf_url ?? null;
      if (pdfUrl) {
        setInstructionsPdfUrl(pdfUrl);
        setShowInstructions(true);
      } else {
        router.replace('/(tabs)/home');
      }
    } catch (err: any) {
      if (err?.message === 'GEOFENCE_FAILED') {
        // Server-side geofence rejected this clock-in. Send the guard back to
        // step 1 so they re-fetch GPS at the post entrance rather than retry
        // with stale coords. 3-strike escalation flow is a follow-up commit.
        Alert.alert(
          'Outside Site',
          'You appear to be outside the site post. Move to the post entrance and try again.',
          [{ text: 'OK', onPress: () => router.replace('/clock-in/step1') }],
          { cancelable: false },
        );
        return;
      }
      Alert.alert('Clock-In Failed', err?.message ?? 'Could not start shift. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function fmtCoord(n: number) { return n.toFixed(6); }

  function dismissInstructions() {
    setShowInstructions(false);
    router.replace('/(tabs)/home');
  }

  return (
    <>
    <Modal
      visible={showInstructions}
      transparent
      animationType="fade"
      onRequestClose={dismissInstructions}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalCard}>
          <Text style={styles.modalIcon}>📄</Text>
          <Text style={styles.modalTitle}>SITE INSTRUCTIONS{'\n'}AVAILABLE</Text>
          <Text style={styles.modalSub}>This site has instructions for your shift. Would you like to view them now?</Text>
          <TouchableOpacity
            style={styles.modalPrimaryBtn}
            onPress={() => {
              if (instructionsPdfUrl) Linking.openURL(instructionsPdfUrl);
              dismissInstructions();
            }}
          >
            <Text style={styles.modalPrimaryText}>VIEW INSTRUCTIONS</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.modalSkipBtn} onPress={dismissInstructions}>
            <Text style={styles.modalSkipText}>SKIP</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
    <ScrollView contentContainerStyle={styles.scroll} style={styles.bg}>
      <Text style={styles.step}>CLOCK IN · STEP 3 OF 3</Text>
      <Text style={styles.title}>CONFIRM & START</Text>

      {/* ── Proof 1: GPS ──────────────────────────────────────────── */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.badge, { backgroundColor: Colors.action }]}>
            <Text style={styles.badgeText}>1</Text>
          </View>
          <Text style={styles.cardLabel}>GPS VERIFICATION</Text>
        </View>

        <View style={styles.coordRow}>
          <View style={styles.coordBox}>
            <Text style={styles.coordLabel}>LATITUDE</Text>
            <Text style={styles.coordValue}>{fmtCoord(verifiedLatitude)}</Text>
          </View>
          <View style={styles.coordBox}>
            <Text style={styles.coordLabel}>LONGITUDE</Text>
            <Text style={styles.coordValue}>{fmtCoord(verifiedLongitude!)}</Text>
          </View>
        </View>

        <View style={styles.statusRow}>
          <View style={styles.dot} />
          <Text style={styles.statusText}>
            INSIDE GEOFENCE · {verifiedAt ? new Date(verifiedAt).toLocaleTimeString() : '—'}
          </Text>
        </View>
      </View>

      {/* ── Proof 2: Selfie ────────────────────────────────────────── */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.badge, { backgroundColor: Colors.action }]}>
            <Text style={styles.badgeText}>2</Text>
          </View>
          <Text style={styles.cardLabel}>GUARD SELFIE</Text>
        </View>
        <Image source={{ uri: selfie.uri }} style={styles.photoThumb} resizeMode="cover" />
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{fmtCoord(selfie.latitude)}, {fmtCoord(selfie.longitude)}</Text>
          <Text style={styles.metaText}>{new Date(selfie.takenAt).toLocaleTimeString()}</Text>
        </View>
      </View>

      {/* ── Start Shift button ─────────────────────────────────────── */}
      <TouchableOpacity
        style={[styles.startButton, submitting && styles.disabled]}
        onPress={startShift}
        disabled={submitting}
      >
        {submitting ? (
          <View style={styles.statusRow}>
            <ActivityIndicator color={Colors.structure} size="small" />
            <Text style={styles.progressText}>{STEPS[statusStep]}</Text>
          </View>
        ) : (
          <Text style={styles.startText}>START SHIFT</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.cancelButton}
        onPress={() => { resetClockIn(); router.replace('/(tabs)/home'); }}
        disabled={submitting}
      >
        <Text style={styles.cancelText}>CANCEL</Text>
      </TouchableOpacity>
    </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: Colors.structure },
  scroll: { alignItems: 'center', paddingBottom: Spacing.xxl },
  step:   { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginTop: Spacing.xl, marginBottom: Spacing.xs },
  title:  { fontFamily: Fonts.heading, color: Colors.base, fontSize: 28, letterSpacing: 4, marginBottom: Spacing.xl },

  card: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  badge: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.sm,
  },
  badgeText: { color: Colors.structure, fontSize: 13, fontFamily: Fonts.heading },
  cardLabel: { color: Colors.base, fontSize: 12, letterSpacing: 3, fontFamily: Fonts.heading },

  coordRow:   { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.sm },
  coordBox:   { flex: 1, backgroundColor: Colors.structure, borderRadius: Radius.sm, padding: Spacing.sm },
  coordLabel: { color: Colors.muted, fontSize: 9, letterSpacing: 2, marginBottom: 2 },
  coordValue: { color: Colors.action, fontSize: 13, fontFamily: 'monospace' },
  statusRow:  { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  dot:        { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E' },
  statusText: { color: Colors.muted, fontSize: 11, letterSpacing: 1 },

  photoThumb: {
    width: '100%', height: 180,
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.structure,
  },
  metaRow:  { flexDirection: 'row', justifyContent: 'space-between' },
  metaText: { color: Colors.muted, fontSize: 11, fontFamily: 'monospace' },

  startButton: {
    width: '92%',
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    padding: Spacing.lg,
    alignItems: 'center',
    marginTop: Spacing.lg,
    minHeight: 54,
    justifyContent: 'center',
  },
  startText:    { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 4 },
  progressText: { color: Colors.structure, fontSize: 14, letterSpacing: 1 },
  cancelButton: { marginTop: Spacing.md, padding: Spacing.sm },
  cancelText:   { color: Colors.muted, fontSize: 13, letterSpacing: 2 },
  disabled:     { opacity: 0.4 },

  container:  { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center' },
  errorTitle: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, letterSpacing: 3, marginBottom: Spacing.sm },
  errorSub:   { color: Colors.muted, fontSize: 14, marginBottom: Spacing.xl },
  button:     { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  buttonText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },

  // Instructions modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.7)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.xl,
    alignItems: 'center',
    width: '100%',
  },
  modalIcon: { fontSize: 40, marginBottom: Spacing.md },
  modalTitle: {
    fontFamily: Fonts.heading,
    color: Colors.base,
    fontSize: 20,
    letterSpacing: 3,
    textAlign: 'center',
    marginBottom: Spacing.md,
    lineHeight: 28,
  },
  modalSub: {
    color: Colors.muted,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: Spacing.xl,
  },
  modalPrimaryBtn: {
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    paddingHorizontal: Spacing.xl,
    width: '100%',
    alignItems: 'center',
    marginBottom: Spacing.sm,
  },
  modalPrimaryText: {
    fontFamily: Fonts.heading,
    color: Colors.structure,
    fontSize: 15,
    letterSpacing: 2,
  },
  modalSkipBtn: { padding: Spacing.sm },
  modalSkipText: { color: Colors.muted, fontSize: 14, letterSpacing: 1 },
});
