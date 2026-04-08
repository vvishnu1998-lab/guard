/**
 * Active Shift Screen (Section 5.3)
 * Shown after successful clock-in. Stays active until clock-out.
 * - Elapsed timer strip (updates every second)
 * - Next ping countdown (30-min alternating schedule)
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
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

// How long between pings (ms)
const PING_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

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

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [nextPingMs,     setNextPingMs]     = useState(PING_INTERVAL_MS);
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
      const timeInCycle = elapsedMs % PING_INTERVAL_MS;
      return PING_INTERVAL_MS - timeInCycle;
    }

    // Set immediately so there's no 1 s delay on mount
    setNextPingMs(computeRemaining());

    pingRef.current = setInterval(() => {
      const remaining = computeRemaining();
      setNextPingMs(remaining);

      // When the cycle rolls over, prompt the guard to ping
      if (remaining >= PING_INTERVAL_MS - 2000) {
        const snoozed = Date.now() < pingSnoozedUntilRef.current;
        if (!pingAlertShownRef.current && !snoozed) {
          pingAlertShownRef.current = true;
          Alert.alert(
            'PING DUE',
            'Your 30-minute check-in is due. Submit your location now.',
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

      {/* ── Ping countdown ──────────────────────────────────────────── */}
      <View style={[styles.pingCard, pingUrgent && styles.pingCardUrgent]}>
        <Text style={styles.pingLabel}>NEXT PING IN</Text>
        <Text style={[styles.pingValue, pingUrgent && styles.pingValueUrgent]}>
          {formatCountdown(nextPingMs)}
        </Text>
        <Text style={styles.pingNote}>
          {Math.floor(elapsedSeconds / 1800) % 2 === 0
            ? 'NEXT: GPS + PHOTO'
            : 'NEXT: GPS ONLY'}
        </Text>
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
