/**
 * Active Shift Screen (Section 5.3)
 * Shown after successful clock-in. Stays active until clock-out.
 * - Elapsed timer strip (updates every second)
 * - Next ping countdown (per-site cadence from sites.ping_interval_minutes,
 *   default 30 min — Item 8; every ping is GPS + photo, the prior
 *   on-hour/half-hour alternation was retired in /app/ping/index.tsx)
 * - Action grid: Ping Now / Report / Tasks / Break
 * - Clock-Out button (amber, bottom of scroll)
 */
import { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Alert, AppState,
} from 'react-native';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { useAuthStore }  from '../../store/authStore';
import { pingState }     from '../../lib/pingState';
import { useBatteryThrottle } from '../../lib/batteryThrottle';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

function pad(n: number) { return String(n).padStart(2, '0'); }

function formatElapsed(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) return '00:00';
  const totalSeconds = Math.floor(ms / 1000);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${pad(m)}:${pad(s)}`;
}

export default function ActiveShiftScreen() {
  const { activeShift, activeSession } = useShiftStore();
  const { guardId } = useAuthStore();

  // Per-site cadence — captured ONCE at component mount via the store's
  // current value, NOT re-read reactively. Admin edits to the site's
  // ping_interval_minutes mid-shift do NOT disturb the active shift; the
  // new cadence is picked up at the next clock-in (Q37 semantics).
  const baseIntervalMs = (activeShift?.ping_interval_minutes ?? 30) * 60 * 1000;

  // Item 7 — battery-aware throttling layered on top of site cadence.
  // Low battery / low-power-mode multiplies the interval (2x / 3x) so a
  // failing phone makes fewer pings rather than dying mid-shift. The
  // returned throttleReason is also stamped onto each ping row so the
  // client portal can show "throttled" instead of "missed".
  const { intervalMs: pingIntervalMs, isThrottled } = useBatteryThrottle(baseIntervalMs);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [nextPingMs,     setNextPingMs]     = useState(pingIntervalMs);
  const [clockingOut,    setClockingOut]    = useState(false);

  const timerRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const pingRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const appStateRef = useRef(AppState.currentState);

  // ── Elapsed timer ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!activeSession?.clocked_in_at) return;

    function tick() {
      const start = new Date(activeSession!.clocked_in_at).getTime();
      setElapsedSeconds(Math.floor((Date.now() - start) / 1000));
    }

    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [activeSession?.clocked_in_at]);

  // ── Ping countdown ─────────────────────────────────────────────────────
  // Aligned to clock-in time so the cycle is correct even if the guard
  // navigates away and returns, or opens the app mid-shift.
  const pingAlertShownRef = useRef(false);
  const pingSnoozedUntilRef = useRef(0); // epoch ms — suppress re-alert until this time

  useEffect(() => {
    if (!activeSession?.clocked_in_at) return;

    function computeRemaining() {
      const clockInMs   = new Date(activeSession!.clocked_in_at).getTime();
      const elapsedMs   = Date.now() - clockInMs;
      const timeInCycle = elapsedMs % pingIntervalMs;
      return pingIntervalMs - timeInCycle;
    }

    // Set immediately so there's no 1 s delay on mount
    setNextPingMs(computeRemaining());

    pingRef.current = setInterval(() => {
      const remaining = computeRemaining();
      setNextPingMs(remaining);

      // When the cycle rolls over, prompt the guard to ping
      if (remaining >= pingIntervalMs - 2000) {
        const snoozed = Date.now() < pingSnoozedUntilRef.current || Date.now() < pingState.suppressAlertUntil;
        if (!pingAlertShownRef.current && !snoozed) {
          pingAlertShownRef.current = true;
          Alert.alert(
            'PING DUE',
            `Your ${Math.round(pingIntervalMs / 60000)}-minute check-in is due. Submit your location now.`,
            [
              { text: 'Later', style: 'cancel', onPress: () => {
                // Snooze for 5 minutes before re-alerting
                pingSnoozedUntilRef.current = Date.now() + 5 * 60 * 1000;
                pingAlertShownRef.current = false;
              }},
              { text: 'PING NOW', onPress: () => { pingAlertShownRef.current = false; router.push('/ping'); } },
            ],
            { cancelable: false }
          );
        }
      } else {
        pingAlertShownRef.current = false;
        pingSnoozedUntilRef.current = 0;
      }
    }, 1000);

    return () => { if (pingRef.current) clearInterval(pingRef.current); };
  }, [activeSession?.clocked_in_at]);

  // ── Resume correction when app comes back to foreground ───────────────
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      appStateRef.current = state;
    });
    return () => sub.remove();
  }, []);

  // ── Guard: no active session ───────────────────────────────────────────
  if (!activeShift || !activeSession) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>No active shift. Please clock in first.</Text>
        <TouchableOpacity style={styles.backBtn} onPress={() => router.replace('/(tabs)/home')}>
          <Text style={styles.backBtnText}>GO HOME</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Clock-out ──────────────────────────────────────────────────────────
  async function confirmClockOut() {
    Alert.alert(
      'CLOCK OUT',
      'Are you sure you want to end this shift?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clock Out',
          style: 'destructive',
          onPress: () => router.push('/clock-out'),
        },
      ]
    );
  }

  const pingUrgent = nextPingMs < 5 * 60 * 1000; // < 5 min = highlight

  return (
    <ScrollView style={styles.bg} contentContainerStyle={styles.scroll}>

      {/* ── Timer strip ────────────────────────────────────────────── */}
      <View style={styles.timerStrip}>
        <Text style={styles.timerLabel}>SHIFT ELAPSED</Text>
        <Text style={styles.timerValue}>{formatElapsed(elapsedSeconds)}</Text>
        <Text style={styles.siteName}>{activeShift.site_name?.toUpperCase()}</Text>
      </View>

      {/* ── Battery-throttle banner (Item 7) ────────────────────────── */}
      {isThrottled && (
        <View style={styles.throttleBanner}>
          <Text style={styles.throttleBannerText}>
            Low battery — pings reduced to every {Math.round(pingIntervalMs / 60000)} minutes. Plug in when possible.
          </Text>
        </View>
      )}

      {/* ── Ping countdown ──────────────────────────────────────────── */}
      <View style={[styles.pingCard, pingUrgent && styles.pingCardUrgent]}>
        <Text style={styles.pingLabel}>NEXT PING IN</Text>
        <Text style={[styles.pingValue, pingUrgent && styles.pingValueUrgent]}>
          {formatCountdown(nextPingMs)}
        </Text>
        <Text style={styles.pingNote}>NEXT: GPS + PHOTO</Text>
      </View>

      {/* ── Action grid ─────────────────────────────────────────────── */}
      <View style={styles.grid}>
        <ActionTile
          icon="📍"
          label="PING NOW"
          onPress={() => router.push('/ping')}
        />
        <ActionTile
          icon="📋"
          label="REPORT"
          onPress={() => router.push('/(tabs)/reports')}
        />
        <ActionTile
          icon="✅"
          label="TASKS"
          onPress={() => router.push('/(tabs)/tasks')}
        />
        <ActionTile
          icon="☕"
          label="BREAK"
          onPress={() => router.push('/break')}
        />
      </View>

      {/* ── Shift info ──────────────────────────────────────────────── */}
      <View style={styles.infoCard}>
        <InfoRow label="SHIFT ID"    value={activeShift.id.slice(0, 8).toUpperCase()} />
        <InfoRow label="STARTED"     value={new Date(activeSession.clocked_in_at).toLocaleTimeString()} />
        <InfoRow label="SCHEDULED END" value={new Date(activeShift.scheduled_end).toLocaleTimeString()} />
        <InfoRow label="GUARD ID"    value={guardId?.slice(0, 8).toUpperCase() ?? '—'} />
      </View>

      {/* ── Clock-out ───────────────────────────────────────────────── */}
      <TouchableOpacity
        style={[styles.clockOutBtn, clockingOut && styles.disabled]}
        onPress={confirmClockOut}
        disabled={clockingOut}
      >
        <Text style={styles.clockOutText}>CLOCK OUT</Text>
      </TouchableOpacity>

      <Text style={styles.footer}>GPS tracking active in background</Text>
    </ScrollView>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function ActionTile({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <TouchableOpacity style={styles.tile} onPress={onPress}>
      <Text style={styles.tileIcon}>{icon}</Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: Colors.structure },
  scroll: { alignItems: 'center', paddingBottom: 48 },
  center: { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },

  // Timer strip
  timerStrip: {
    width: '100%',
    backgroundColor: Colors.surface,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    alignItems: 'center',
    paddingVertical: Spacing.xl,
    paddingTop: Spacing.xxl,
  },
  timerLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: Spacing.xs },
  timerValue: { fontFamily: 'monospace', color: Colors.base, fontSize: 52, letterSpacing: 4 },
  siteName:   { color: Colors.action, fontSize: 13, letterSpacing: 3, marginTop: Spacing.xs, fontFamily: Fonts.heading },

  // Battery-throttle banner (Item 7) — amber, persistent, not dismissible.
  throttleBanner: {
    width: '92%',
    backgroundColor: '#3A2410', // dark amber tint compatible with the dark theme
    borderRadius: Radius.md,
    borderLeftWidth: 4,
    borderLeftColor: Colors.action,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    marginTop: Spacing.md,
  },
  throttleBannerText: {
    color: Colors.action,
    fontSize: 12,
    lineHeight: 16,
    letterSpacing: 0.5,
  },

  // Ping countdown
  pingCard: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    marginTop: Spacing.lg,
  },
  pingCardUrgent: { borderColor: Colors.action },
  pingLabel:      { color: Colors.muted, fontSize: 11, letterSpacing: 3 },
  pingValue:      { fontFamily: 'monospace', color: Colors.base, fontSize: 36, marginVertical: Spacing.xs },
  pingValueUrgent:{ color: Colors.action },
  pingNote:       { color: Colors.muted, fontSize: 11, letterSpacing: 2 },

  // Action grid
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: '92%',
    gap: Spacing.md,
    marginTop: Spacing.lg,
  },
  tile: {
    width: '47%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    gap: Spacing.sm,
  },
  tileIcon:  { fontSize: 28 },
  tileLabel: { color: Colors.base, fontSize: 12, letterSpacing: 3, fontFamily: Fonts.heading },

  // Info card
  infoCard: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg,
    marginTop: Spacing.lg,
    gap: Spacing.sm,
  },
  infoRow:   { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  infoLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 2 },
  infoValue: { color: Colors.base, fontSize: 13, fontFamily: 'monospace' },

  // Clock-out
  clockOutBtn: {
    width: '92%',
    borderWidth: 2, borderColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    marginTop: Spacing.xl,
  },
  clockOutText: { fontFamily: Fonts.heading, color: Colors.action, fontSize: 18, letterSpacing: 4 },
  disabled:     { opacity: 0.4 },

  footer:     { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginTop: Spacing.lg },

  // Error state
  errorText:    { color: Colors.base, fontSize: 16, textAlign: 'center', marginBottom: Spacing.xl },
  backBtn:      { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  backBtnText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
