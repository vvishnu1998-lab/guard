/**
 * Clock-Out Confirmation (Section 5.7)
 * Shows shift summary card: total hours, ping count, reports filed.
 * Guard writes optional handover notes before confirming.
 * POSTs to /api/shifts/clock-out → clears session → returns to home.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  TextInput, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import * as Location from 'expo-location';
import * as Sentry from '@sentry/react-native';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { apiClient }     from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

// iOS hands a relaunched process an EMPTY CLLocationManager cache, and a cold
// first fix needs 20-60s. At 07:00 a guard who has had the app backgrounded
// all night hits exactly that: nothing cached, no time to acquire. 3s could
// not close a shift; 15s plus the mount warm-up below can.
const GPS_TIMEOUT_MS = 15_000;

// Mount-time GPS warm-up — same pattern as components/CameraCapture.tsx.
// This screen dwells longer than any other (summary + handover notes), so
// the fix has the most time of anywhere in the app to converge.
const WARMUP_INTERVAL_MS = 1_000;
const WARMUP_DISTANCE_M  = 0;

// Wait-not-walk. The failure is a cold location service on a relaunched
// process, not where the guard is standing — the old copy told them to walk
// somewhere else, which was false and sent guards off post to chase it.
const GPS_NOT_READY_MSG =
  "Your phone's location is still starting up. Wait about 30 seconds with the app open, then try again.";

/** Separates cold GPS from a real clock-out failure so the alert can say
 *  what actually happened and that waiting fixes it. */
class GpsNotReadyError extends Error {
  constructor() {
    super(GPS_NOT_READY_MSG);
    this.name = 'GpsNotReadyError';
  }
}

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

  const { activeShift, activeSession, clearSession } = useShiftStore();

  // Warm-up subscription, torn down on unmount so we never leave a location
  // session running behind a closed screen.
  const gpsWarmupRef = useRef<Location.LocationSubscription | null>(null);

  // GPS warm-up — starts on mount so the fix converges while the guard reads
  // the summary and types handover notes. Every failure here is swallowed:
  // no permission, no hardware, no problem — confirmClockOut still runs its
  // own reads and the button is never gated on this. No permission prompt.
  //
  // MUST stay above the !activeShift early return below: a hook after a
  // conditional return runs on some renders and not others.
  useEffect(() => {
    let cancelled = false;
    let loggedFirstFix = false;
    (async () => {
      try {
        const sub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            timeInterval: WARMUP_INTERVAL_MS,
            distanceInterval: WARMUP_DISTANCE_M,
          },
          (loc) => {
            if (loggedFirstFix) return;
            loggedFirstFix = true;
            console.log(`[clock-out] GPS warm-up first fix acc=${loc.coords.accuracy}`);
          },
          (err) => console.warn('[clock-out] GPS warm-up error:', err),
        );
        // Unmounted while watchPositionAsync was still resolving.
        if (cancelled) { sub.remove(); return; }
        gpsWarmupRef.current = sub;
      } catch (err) {
        console.warn('[clock-out] GPS warm-up failed to start:', err);
      }
    })();
    return () => {
      cancelled = true;
      gpsWarmupRef.current?.remove();
      gpsWarmupRef.current = null;
    };
  }, []);

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

  async function confirmClockOut() {
    if (submitting) return;
    setSubmitting(true);
    try {
      // C1 (T2-A) — capture GPS so the server's validateAtSite can verify the
      // guard is on-post before closing the session. Hard-fail on no lock —
      // same pattern as photo.tsx (T1-C-client). Outer catch surfaces the
      // user-facing message via the existing "Clock-Out Failed" alert.
      let lat: number | null = null;
      let lng: number | null = null;
      let acc: number | null = null;
      let source = 'none';
      const tGps = Date.now();

      // Three legs, each independently guarded so a THROW on one still falls
      // through to the next (the old single try/catch skipped the rest).

      // 1 — cached last-known (instant). Empty on a relaunched process.
      try {
        const last = await Location.getLastKnownPositionAsync();
        if (last) {
          lat = last.coords.latitude;
          lng = last.coords.longitude;
          acc = last.coords.accuracy;
          source = 'cache';
        }
      } catch (err) {
        console.warn('[clock-out] cached GPS read threw:', err);
      }

      // 2 — bounded live read.
      if (lat === null) {
        try {
          const live = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((r) => setTimeout(() => r(null), GPS_TIMEOUT_MS)),
          ]);
          if (live) {
            lat = live.coords.latitude;
            lng = live.coords.longitude;
            acc = live.coords.accuracy;
            source = 'live';
          }
        } catch (err) {
          console.warn('[clock-out] live GPS read threw:', err);
        }
      }

      // 3 — cache again. The warm-up has been running since mount and may
      // have landed a fix that leg 1 (before the wait) and leg 2 (timed out)
      // both missed. This is the leg that rescues the relaunch case.
      if (lat === null) {
        try {
          const warmed = await Location.getLastKnownPositionAsync();
          if (warmed) {
            lat = warmed.coords.latitude;
            lng = warmed.coords.longitude;
            acc = warmed.coords.accuracy;
            source = 'warmed';
          }
        } catch (err) {
          console.warn('[clock-out] warmed GPS read threw:', err);
        }
      }

      Sentry.addBreadcrumb({
        category: 'clock-out',
        message: 'gps read',
        level: lat === null ? 'warning' : 'info',
        data: { source, gps_ms: Date.now() - tGps, accuracy_m: acc, got_fix: lat !== null },
      });

      if (lat === null || lng === null) {
        throw new GpsNotReadyError();
      }

      await apiClient.post(`/shifts/${activeShift!.id}/clock-out`, {
        handover_notes: notes.trim() || null,
        lat,
        lng,
        accuracy: acc ?? 30, // null-accuracy iOS sim / coarse-grant → conservative 30m
      });
      clearSession();
      router.replace('/(tabs)/home');
    } catch (err: any) {
      // Cold GPS is retryable and not a clock-out failure — titling it as one
      // reads as "your shift did not close", which is not what happened.
      if (err instanceof GpsNotReadyError) {
        Sentry.captureException(err, { extra: { where: 'clock-out.gps' } });
        Alert.alert('GPS Not Ready', GPS_NOT_READY_MSG);
      } else {
        Alert.alert('Clock-Out Failed', err?.message ?? 'Could not end shift. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const elapsed = formatDuration(activeSession.clocked_in_at);

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
        onPress={confirmClockOut}
        disabled={submitting}
      >
        {submitting
          ? <ActivityIndicator color={Colors.structure} />
          : <Text style={styles.confirmText}>CONFIRM CLOCK OUT</Text>
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
