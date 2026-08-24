/**
 * Clock-Out Confirmation (Section 5.7)
 * Shows shift summary card: total hours, ping count, reports filed.
 * Guard writes optional handover notes before confirming.
 * POSTs to /api/shifts/clock-out → clears session → returns to home.
 */
import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  TextInput, ScrollView, Alert, ActivityIndicator, Image,
} from 'react-native';
import * as Location from 'expo-location';
import { locationSignals, NO_LOCATION_SIGNALS, type LocationSignals } from '../../lib/locationSignals';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { apiClient, ApiError } from '../../lib/apiClient';
import { uploadToS3 } from '../../lib/uploadToS3';
import CameraCapture, { CapturedPhoto } from '../../components/CameraCapture';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import { guardMessage } from '../../lib/errorCopy';

const GPS_TIMEOUT_MS = 3000;

function pad(n: number) { return String(n).padStart(2, '0'); }

function formatDuration(startIso: string): string {
  const diffMs = Date.now() - new Date(startIso).getTime();
  const totalMin = Math.floor(diffMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${pad(h)}h ${pad(m)}m`;
}

export default function ClockOutScreen() {
  const [notes,       setNotes]       = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  // 'summary' is the confirm screen; 'camera' swaps in the full-bleed capture.
  const [phase,       setPhase]       = useState<'summary' | 'camera'>('summary');
  // Uploaded S3 url, or null. NULL IS A VALID OUTCOME — the photo is
  // skippable and the server records which via clock_out_reason.
  const [photoUrl,    setPhotoUrl]    = useState<string | null>(null);
  const [photoLocal,  setPhotoLocal]  = useState<string | null>(null);

  const { activeShift, activeSession, clearSession } = useShiftStore();

  if (!activeShift || !activeSession) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>No active shift to clock out of.</Text>
        <TouchableOpacity style={styles.homeBtn} onPress={() => router.replace('/(tabs)/home')}>
          <Text style={styles.homeBtnText}>GO HOME</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // `overrideUrl` lets the PHOTO_REJECTED retry resubmit with no photo
  // without waiting for a state round-trip. Defaults to whatever is attached.
  async function confirmClockOut(overrideUrl?: string | null) {
    if (submitting) return;
    const url = overrideUrl === undefined ? photoUrl : overrideUrl;
    setSubmitting(true);
    try {
      // C1 (T2-A) — capture GPS so the server's validateAtSite can verify the
      // guard is on-post before closing the session. Hard-fail on no lock —
      // same pattern as photo.tsx (T1-C-client). Outer catch surfaces the
      // user-facing message via the existing "Clock-Out Failed" alert.
      let lat: number | null = null;
      let lng: number | null = null;
      // Shadow capture (Wave 2) — sent, never evaluated on the client.
      let signals: LocationSignals = NO_LOCATION_SIGNALS;
      let acc: number | null = null;
      try {
        const last = await Location.getLastKnownPositionAsync();
        if (last) {
          lat = last.coords.latitude;
          lng = last.coords.longitude;
          acc = last.coords.accuracy;
          signals = locationSignals(last);
        } else {
          const live = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((r) => setTimeout(() => r(null), GPS_TIMEOUT_MS)),
          ]);
          if (live) {
            lat = (live as Location.LocationObject).coords.latitude;
            lng = (live as Location.LocationObject).coords.longitude;
            acc = (live as Location.LocationObject).coords.accuracy;
            signals = locationSignals(live as Location.LocationObject);
          }
        }
      } catch (err) {
        console.warn('[clock-out] GPS read threw:', err);
      }

      // NO GPS HARD-FAIL. This used to throw GuardFacingError('GPS lock
      // failed…') and refuse to close the shift — the stranding problem at
      // the END of the shift, and the exact mirror of the server-side reject
      // removed on 2026-08-22 (5dd8077) for the same reason: the fence
      // cannot tell an honest bad fix from a simulated one, so the refusal
      // only ever landed on the honest guard, who then could not end their
      // shift at all. The server now persists-and-flags and never rejects;
      // this screen stopped agreeing with it the moment that shipped.
      //
      // Coordinates are sent when we have them and omitted when we do not.
      // The server derives clock_out_reason ('manual' vs 'manual_no_gps',
      // and the _no_photo variants) from exactly what arrives.
      const haveCoords = lat !== null && lng !== null;
      if (!haveCoords) {
        console.warn('[clock-out] no GPS fix — closing shift without coordinates');
      }

      await apiClient.post(`/shifts/${activeShift!.id}/clock-out`, {
        handover_notes: notes.trim() || null,
        ...(haveCoords
          ? { lat, lng, accuracy: acc ?? 30 } // null-accuracy iOS sim / coarse-grant → conservative 30m
          : {}),
        // Same request as before — the photo rides along, it is NOT a second
        // POST. NULL when skipped or when capture/upload failed.
        clock_out_photo_url: url,
        // Wave 2 — clock-out PERSISTS AND FLAGS server-side; it is never
        // rejected on geofence, so there is no 422 to handle on this path.
        ...signals,
      });
      clearSession();

      // 5d — skip must be UNAMBIGUOUS. A silent success looks identical
      // whether a photo was attached or not, so the guard is told which
      // shift they just closed.
      if (url) {
        router.replace('/(tabs)/home');
      } else {
        Alert.alert(
          'Shift Closed — No Photo',
          'Your shift is closed. No clock-out photo was attached, and that is recorded on the shift.',
          [{ text: 'OK', onPress: () => router.replace('/(tabs)/home') }],
          { cancelable: false },
        );
      }
    } catch (err: any) {
      // HARD REQUIREMENT: a rejected photo is NOT a failed clock-out.
      // Branch on status PLUS code — never on message prose (the 2026-08-22
      // invariant). The server gained this code in the same ship; any other
      // 4xx keeps the existing behaviour, deliberately not widened.
      if (err instanceof ApiError && err.status === 400 && err.code === 'PHOTO_REJECTED') {
        setSubmitting(false);
        Alert.alert(
          "Photo Couldn't Be Saved",
          'Your shift has NOT been closed yet. You can retake the photo, or clock out without one.',
          [
            { text: 'Retake photo', onPress: () => setPhase('camera') },
            {
              // Skip is available RIGHT HERE — the guard never has to dismiss
              // an error and hunt for it. This resubmits immediately with no
              // photo, which the server records as manual_no_photo.
              text: 'Clock out without photo',
              style: 'destructive',
              onPress: () => { setPhotoUrl(null); setPhotoLocal(null); void confirmClockOut(null); },
            },
          ],
          { cancelable: false },
        );
        return;
      }
      Alert.alert('Clock-Out Failed', guardMessage(err, 'Could not end your shift. Try again, or tell your supervisor.', 'clock-out'));
    } finally {
      setSubmitting(false);
    }
  }

  /** Capture pipeline for the photo step. Runs inside CameraCapture while it
   *  holds the freeze-frame. A failure here NEVER blocks the clock-out — the
   *  guard is returned to the summary with the photo simply not attached. */
  async function onPhotoCaptured(photo: CapturedPhoto, setStatus: (m: string) => void) {
    try {
      setStatus('UPLOADING…');
      const { public_url } = await uploadToS3(photo.uri, 'clock_out');
      setPhotoUrl(public_url);
      setPhotoLocal(photo.uri);
      setPhase('summary');
    } catch (err: any) {
      setPhase('summary');
      // The skip lives INSIDE the error, not behind it. Requirement 5a: a
      // guard at the end of a shift must never have to dismiss a failure
      // before they can find the way out. Same shape as the server-side
      // PHOTO_REJECTED branch in confirmClockOut.
      Alert.alert(
        "Photo Couldn't Be Saved",
        `${guardMessage(err, 'That photo could not be uploaded.', 'clock-out.photo')}\n\nYour shift is still open. You can retake the photo, or clock out without one.`,
        [
          { text: 'Retake photo', onPress: () => setPhase('camera') },
          {
            text: 'Clock out without photo',
            style: 'destructive',
            onPress: () => { setPhotoUrl(null); setPhotoLocal(null); void confirmClockOut(null); },
          },
        ],
      );
    }
  }

  const elapsed = formatDuration(activeSession.clocked_in_at);

  // Full-bleed capture swaps in for the summary. Back camera — the photo is
  // evidence of the post at hand-off, not of the guard. gps="none": this
  // screen does its own read in confirmClockOut and a second one here would
  // be wasted battery and a second chance to hang.
  if (phase === 'camera') {
    return (
      <CameraCapture
        facing="back"
        gps="none"
        confirm
        breadcrumbCategory="clock_out"
        breadcrumbPrefix="clock_out"
        headerTitle="CLOCK OUT"
        headerSubtitle="POST PHOTO (OPTIONAL)"
        instruction="Photograph the post as you leave it."
        primaryButtonLabel="USE PHOTO"
        cancelButtonLabel="SKIP PHOTO"
        onCaptured={onPhotoCaptured}
        // Cancel IS the skip. It returns to the summary with nothing
        // attached, so the guard can leave the camera without taking one and
        // without dismissing anything first.
        onCancel={() => setPhase('summary')}
      />
    );
  }

  return (
    <ScrollView style={styles.bg} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

      {/* Header */}
      <Text style={styles.title}>CLOCK OUT</Text>
      <Text style={styles.subtitle}>Review your shift before confirming</Text>

      {/* Shift summary card */}
      <View style={styles.summaryCard}>
        <Text style={styles.sectionLabel}>SHIFT SUMMARY</Text>

        <SummaryRow label="SITE"          value={activeShift.site_name?.toUpperCase() ?? '—'} />
        <SummaryRow label="SHIFT ID"      value={activeShift.id.slice(0, 8).toUpperCase()} />
        <SummaryRow label="CLOCKED IN"    value={new Date(activeSession.clocked_in_at).toLocaleTimeString()} />
        <SummaryRow label="CLOCKING OUT"  value={new Date().toLocaleTimeString()} />
        <View style={styles.divider} />
        <SummaryRow label="TOTAL DURATION" value={elapsed} highlight />
      </View>

      {/* Shift schedule */}
      <View style={styles.scheduleCard}>
        <Text style={styles.sectionLabel}>SCHEDULED</Text>
        <SummaryRow
          label="START"
          value={new Date(activeShift.scheduled_start).toLocaleTimeString()}
        />
        <SummaryRow
          label="END"
          value={new Date(activeShift.scheduled_end).toLocaleTimeString()}
        />
      </View>

      {/* Clock-out photo — OPTIONAL. The confirm button below is never
          gated on this; skipping is always one tap and never requires
          dismissing an error first. */}
      <View style={styles.notesCard}>
        <Text style={styles.sectionLabel}>POST PHOTO</Text>
        <Text style={styles.notesHint}>
          {photoUrl
            ? 'Attached. This will be saved with your clock-out.'
            : 'Optional — a photo of the post as you leave it. You can clock out without one.'}
        </Text>

        {photoLocal && photoUrl ? (
          <>
            <Image source={{ uri: photoLocal }} style={styles.photoPreview} resizeMode="cover" />
            <View style={styles.photoRow}>
              <TouchableOpacity
                style={[styles.photoBtn, styles.photoBtnGhost]}
                onPress={() => setPhase('camera')}
                disabled={submitting}
              >
                <Text style={styles.photoBtnGhostText}>RETAKE</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.photoBtn, styles.photoBtnGhost]}
                onPress={() => { setPhotoUrl(null); setPhotoLocal(null); }}
                disabled={submitting}
              >
                <Text style={styles.photoBtnGhostText}>REMOVE</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <TouchableOpacity
            style={[styles.photoBtn, submitting && styles.disabled]}
            onPress={() => setPhase('camera')}
            disabled={submitting}
          >
            <Text style={styles.photoBtnText}>TAKE PHOTO</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Handover notes */}
      <View style={styles.notesCard}>
        <Text style={styles.sectionLabel}>HANDOVER NOTES</Text>
        <Text style={styles.notesHint}>Optional — leave a note for the incoming guard or supervisor.</Text>
        <TextInput
          style={styles.notesInput}
          value={notes}
          onChangeText={setNotes}
          placeholder="e.g. Gate 2 was left open. Reported to supervisor."
          placeholderTextColor={Colors.muted}
          multiline
          numberOfLines={4}
          maxLength={1000}
          textAlignVertical="top"
        />
        <Text style={styles.charCount}>{notes.length}/1000</Text>
      </View>

      {/* Confirm button */}
      <TouchableOpacity
        style={[styles.confirmBtn, submitting && styles.disabled]}
        onPress={() => confirmClockOut()}
        disabled={submitting}
      >
        {submitting
          ? <ActivityIndicator color={Colors.structure} />
          : <Text style={styles.confirmText}>
              {photoUrl ? 'CONFIRM CLOCK OUT' : 'CLOCK OUT WITHOUT PHOTO'}
            </Text>
        }
      </TouchableOpacity>

      {/* Back button */}
      <TouchableOpacity style={styles.backBtn} onPress={() => router.back()} disabled={submitting}>
        <Text style={styles.backText}>GO BACK TO SHIFT</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function SummaryRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <View style={styles.summaryRow}>
      <Text style={styles.summaryLabel}>{label}</Text>
      <Text style={[styles.summaryValue, highlight && styles.highlight]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: Colors.structure },
  scroll: { alignItems: 'center', paddingTop: Spacing.xxl, paddingBottom: 48 },
  center: { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },

  title:    { fontFamily: Fonts.heading, color: Colors.base, fontSize: 32, letterSpacing: 4, marginBottom: Spacing.xs },
  subtitle: { color: Colors.muted, fontSize: 13, letterSpacing: 2, marginBottom: Spacing.xl },

  // Cards
  summaryCard: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  scheduleCard: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  sectionLabel: { color: Colors.action, fontSize: 11, letterSpacing: 3, marginBottom: Spacing.md, fontFamily: Fonts.heading },

  summaryRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: Spacing.xs },
  summaryLabel: { color: Colors.muted, fontSize: 12, letterSpacing: 2 },
  summaryValue: { color: Colors.base,  fontSize: 13, fontFamily: 'monospace' },
  highlight:    { color: Colors.action, fontFamily: Fonts.heading, fontSize: 15 },

  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },

  // Notes
  photoPreview: {
    width: '100%',
    height: 180,
    borderRadius: Radius.md,
    marginTop: Spacing.sm,
    backgroundColor: Colors.structure,
  },
  photoRow: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.sm },
  photoBtn: {
    flex: 1,
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
    marginTop: Spacing.sm,
  },
  photoBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 15, letterSpacing: 2 },
  photoBtnGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: Colors.border,
    marginTop: 0,
  },
  photoBtnGhostText: { fontFamily: Fonts.heading, color: Colors.muted, fontSize: 14, letterSpacing: 2 },
  notesCard: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  notesHint:  { color: Colors.muted, fontSize: 12, lineHeight: 18, marginBottom: Spacing.md },
  notesInput: {
    backgroundColor: Colors.structure,
    borderRadius: Radius.sm,
    borderWidth: 1, borderColor: Colors.border,
    color: Colors.base,
    fontSize: 14, lineHeight: 20,
    padding: Spacing.md,
    minHeight: 100,
  },
  charCount: { color: Colors.muted, fontSize: 11, textAlign: 'right', marginTop: Spacing.xs },

  // Buttons
  confirmBtn: {
    width: '92%',
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    minHeight: 54, justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  confirmText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 4 },
  disabled:    { opacity: 0.4 },

  backBtn:  { paddingVertical: Spacing.sm },
  backText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },

  errorText:   { color: Colors.base, fontSize: 16, textAlign: 'center', marginBottom: Spacing.xl },
  homeBtn:     { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  homeBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
