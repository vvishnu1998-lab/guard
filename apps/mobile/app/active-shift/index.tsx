/**
 * Active Shift Screen (Section 5.3)
 * Shown after successful clock-in. Stays active until clock-out.
 * - Elapsed timer strip (updates every second)
 * - Next ping countdown — anchored to the SHIFT's scheduled_start via
 *   lib/pingSchedule.ts, which mirrors apps/api/src/jobs/pingReminder.ts
 *   exactly. It used to floor wall-clock to :00/:30, which agrees with the
 *   server only for shifts starting on :00 or :30.
 * - Action grid: Ping / Report / Tasks / Break. PING NOW is back (Build 34
 *   had removed it, leaving the notification deep-link as the ONLY way to
 *   reach the ping flow — when the push went unseen the guard had no path
 *   to the obligation the server was still marking them down against).
 *   The tile is window-gated: live only while the current window is open
 *   and unanswered, greyed WITH A REASON otherwise, never hidden. The
 *   notification deep-link is untouched and both routes hit /ping with the
 *   same window_label, so they produce identical rows.
 * - Clock-Out button (amber, bottom of scroll)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, Alert, AppState,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { apiClient } from '../../lib/apiClient';
import { useShiftStore } from '../../store/shiftStore';
import { useAuthStore }  from '../../store/authStore';
import { currentPingWindow, remainingMsUntilNextPing, type PingWindowState } from '../../lib/pingSchedule';
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
  const { activeShift, activeSession, lastPingedWindow } = useShiftStore();
  const { guardId } = useAuthStore();

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [nextPingMs,     setNextPingMs]     = useState<number | null>(null);
  const [clockingOut,    setClockingOut]    = useState(false);
  // Recomputed on the same 1s tick as the countdown so the tile flips the
  // instant a window opens or closes — no focus event required.
  const [pingWindow,     setPingWindow]     = useState<PingWindowState | null>(null);

  // ── Checkpoints (C6) ──────────────────────────────────────────────────
  // null = not loaded / fetch failed / site has none → render NOTHING, so
  // guards at sites without checkpoints see zero change to this screen.
  //
  // round_window is the server's authority on WHICH hour the counts describe
  // — date_trunc('hour', NOW() AT TIME ZONE site.timezone) from
  // routes/checkpoints.ts. It has always been in the response and the client
  // used to throw it away, which is what let "5 OF 5 THIS HOUR" survive into
  // an hour in which nothing had been scanned: useFocusEffect keyed on the
  // session id never refires while the screen stays mounted, and a shift
  // spans ten hour boundaries.
  interface CpMine {
    total: number; scanned: number; unlinked: number;
    checkpoints: { id: string }[];
    /** ISO instant of the hour boundary these counts belong to. */
    round_window: string;
  }
  const [cpMine, setCpMine] = useState<CpMine | null>(null);

  const loadCheckpoints = useCallback(async () => {
    if (!activeSession) return;
    try {
      setCpMine(await apiClient.get<CpMine>('/checkpoints/mine'));
    } catch {
      setCpMine(null); // silent — section just hides
    }
  }, [activeSession?.id]);

  useFocusEffect(
    useCallback(() => { void loadCheckpoints(); }, [loadCheckpoints]),
  );

  // Counts describe [round_window, round_window + 1h). Once now is past that
  // they describe a window the guard has left, so they are not shown.
  //
  // Deliberately epoch arithmetic on the server's own value rather than
  // re-deriving the boundary from a local clock: the window is site-local and
  // /shifts/active-session does not carry site_tz, so any client-side
  // date_trunc would be guessing. The length of an hour needs no timezone.
  // The 1s countdown tick already re-renders this component, so the check is
  // live without adding a poller.
  const cpStale =
    cpMine !== null &&
    Date.now() >= new Date(cpMine.round_window).getTime() + 60 * 60 * 1000;

  // Refetch once, on the transition into staleness — not on a schedule.
  useEffect(() => {
    if (cpStale) void loadCheckpoints();
  }, [cpStale, loadCheckpoints]);

  const hasCheckpoints = (cpMine?.checkpoints.length ?? 0) > 0;

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

  // ── Ping countdown + window gate ───────────────────────────────────────
  // Both read the SAME helper, so the number on screen and the state of the
  // PING NOW tile can never disagree with each other — or with the server,
  // which anchors on scheduled_start too.
  useEffect(() => {
    const clockedInAt    = activeSession?.clocked_in_at;
    const scheduledStart = activeShift?.scheduled_start;
    const scheduledEnd   = activeShift?.scheduled_end;
    if (!clockedInAt || !scheduledStart || !scheduledEnd) return;

    // site_tz is not on the /shifts/active-session payload; pingSchedule
    // falls back to the same zone the server does. See its header.
    const args = { scheduledStart, scheduledEnd, clockedInAt };

    const tick = () => {
      const now = new Date();
      setNextPingMs(remainingMsUntilNextPing({ ...args, now }));
      setPingWindow(currentPingWindow({ ...args, now }));
    };

    tick();
    pingRef.current = setInterval(tick, 1000);
    return () => { if (pingRef.current) clearInterval(pingRef.current); };
  }, [activeSession?.clocked_in_at, activeShift?.scheduled_start, activeShift?.scheduled_end]);

  // ── Resume correction when app comes back to foreground ───────────────
  // Also the moment the checkpoint counter is most likely to be wrong: JS is
  // frozen while backgrounded, so a phone pocketed at 20:50 and woken at
  // 21:20 resumes holding the 20:00 window's counts. cpStale catches that on
  // the first render too; this makes the corrected value arrive with it
  // rather than a round-trip later.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const wasBackground = appStateRef.current.match(/inactive|background/);
      appStateRef.current = state;
      if (wasBackground && state === 'active') void loadCheckpoints();
    });
    return () => sub.remove();
  }, [loadCheckpoints]);

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

  const pingUrgent = nextPingMs !== null && nextPingMs < 5 * 60 * 1000; // < 5 min = highlight

  // ── PING NOW gate ──────────────────────────────────────────────────────
  // One rule per disabled state, each with copy that names the reason. The
  // tile is never hidden: a guard who cannot ping right now still needs to
  // see that pinging is a thing this shift expects of them.
  const openWindow = pingWindow?.status === 'open' ? pingWindow.window : null;
  const alreadyPinged =
    openWindow !== null &&
    lastPingedWindow?.sessionId === activeSession.id &&
    lastPingedWindow?.label === openWindow.label;

  const pingTile: { enabled: boolean; label: string; note: string | null } = (() => {
    if (!pingWindow)                          return { enabled: false, label: 'PING',     note: null };
    if (pingWindow.status === 'before_shift')  return { enabled: false, label: 'PING',     note: 'Starts at shift time' };
    if (pingWindow.status === 'shift_ending')  return { enabled: false, label: 'PING',     note: 'Shift ending' };
    if (pingWindow.status === 'before_clock_in') return { enabled: false, label: 'PING',   note: 'Next window' };
    if (alreadyPinged)                        return { enabled: false, label: 'PINGED',   note: `${openWindow!.label} done` };
    return { enabled: true, label: 'PING NOW', note: `${openWindow!.label} window` };
  })();

  // Same route and same query param the notification deep-link uses
  // (lib/navigateForNotification.ts ping_reminder / missed_ping), so the
  // two entry points converge on one flow and write one shape of row.
  function goPing() {
    if (!openWindow) return;
    router.push(`/ping?window_label=${encodeURIComponent(openWindow.label)}`);
  }

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
          {nextPingMs === null ? '—' : formatCountdown(nextPingMs)}
        </Text>
      </View>

      {/* ── Checkpoints (C6) — hidden entirely when the site has none ── */}
      {hasCheckpoints && cpMine && (
        <>
          {cpMine.unlinked > 0 && (
            <TouchableOpacity
              style={styles.cpSetupBanner}
              onPress={() => router.push('/checkpoints/setup')}
            >
              <Text style={styles.cpSetupBannerText}>
                Set up {cpMine.unlinked} checkpoint{cpMine.unlinked === 1 ? '' : 's'} — tap to anchor tags at their positions.
              </Text>
            </TouchableOpacity>
          )}
          <View style={styles.cpCard}>
            <Text style={styles.cpLabel}>
              CHECKPOINTS — {cpStale ? '—' : cpMine.scanned} OF {cpMine.total} THIS HOUR
            </Text>
            <TouchableOpacity
              style={styles.cpScanBtn}
              onPress={() => router.push('/checkpoints/scan')}
            >
              <Text style={styles.cpScanBtnText}>SCAN CHECKPOINT</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* ── Action grid ─────────────────────────────────────────────── */}
      <View style={styles.grid}>
        <ActionTile
          icon="📍"
          label={pingTile.label}
          note={pingTile.note}
          disabled={!pingTile.enabled}
          onPress={goPing}
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

function ActionTile({
  icon, label, onPress, disabled = false, note = null,
}: {
  icon: string; label: string; onPress: () => void;
  disabled?: boolean; note?: string | null;
}) {
  return (
    <TouchableOpacity
      style={[styles.tile, disabled && styles.tileDisabled]}
      onPress={onPress}
      disabled={disabled}
      accessibilityState={{ disabled }}
      accessibilityLabel={note ? `${label} — ${note}` : label}
    >
      <Text style={[styles.tileIcon, disabled && styles.tileIconDisabled]}>{icon}</Text>
      <Text style={[styles.tileLabel, disabled && styles.tileLabelDisabled]}>{label}</Text>
      {note ? <Text style={styles.tileNote}>{note}</Text> : null}
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

  // Checkpoints (C6) — banner and card both mirror pingCard's width + radius.
  cpSetupBanner: {
    width: '92%',
    backgroundColor: '#3A2410',
    borderRadius: Radius.md,
    borderLeftWidth: 4,
    borderLeftColor: Colors.warning,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    marginTop: Spacing.md,
  },
  cpSetupBannerText: { color: Colors.warning, fontSize: 12, lineHeight: 16, letterSpacing: 0.5 },
  cpCard: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center',
    paddingVertical: Spacing.lg,
    marginTop: Spacing.lg,
    gap: Spacing.md,
  },
  cpLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 3 },
  cpScanBtn: {
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.xl,
  },
  cpScanBtnText: { color: Colors.structure, fontFamily: Fonts.heading, fontSize: 15, letterSpacing: 3 },

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
  tileDisabled: { opacity: 0.45, borderColor: Colors.border },
  tileIcon:  { fontSize: 28 },
  tileIconDisabled:  { opacity: 0.6 },
  tileLabel: { color: Colors.base, fontSize: 12, letterSpacing: 3, fontFamily: Fonts.heading },
  tileLabelDisabled: { color: Colors.muted },
  // Reason line under a gated tile — always rendered when present, including
  // on the enabled PING NOW tile where it names the window being answered.
  tileNote:  { color: Colors.muted, fontSize: 10, letterSpacing: 1, marginTop: -2, textAlign: 'center' },

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
