/**
 * Break Session Flow — server-truth timer (Phase D Bug A).
 * Step 1: Break type selector (Meal / Rest / Other)
 * Step 2: Circular countdown timer derived from (break_start + duration) − Date.now().
 *
 * Why server-truth:
 *   Prior implementation used a pure setInterval on a decrementing `remaining`
 *   counter with no server reconciliation. When iOS/Android suspended the JS
 *   thread during backgrounding, the interval stopped firing — walk-test
 *   2026-07-15 saw 13-sec decrement across 6 real minutes. The timer looked
 *   frozen, then resumed from a stale value on foreground.
 *   Now: server owns break_start + planned_duration_minutes; client stores
 *   both, ticks a `now` cursor every 1s, and re-derives `remaining` on every
 *   render. Foreground refetches /shifts/active-session so a cold-start /
 *   AppState 'active' picks up the true state regardless of what the JS
 *   thread was allowed to do while backgrounded.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert, Animated, Easing, AppState,
} from 'react-native';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { apiClient }     from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import { BREAK_DURATIONS, BreakType } from '../../constants/breakDurations';

// UI-facing metadata. Numbers pulled from BREAK_DURATIONS so this list
// cannot drift from server / mobile constants file.
const BREAK_OPTIONS: { type: BreakType; label: string; duration: number; icon: string }[] = [
  { type: 'meal',  label: 'MEAL BREAK', duration: BREAK_DURATIONS.meal,  icon: '🍱' },
  { type: 'rest',  label: 'REST BREAK', duration: BREAK_DURATIONS.rest,  icon: '☕' },
  { type: 'other', label: 'OTHER',      duration: BREAK_DURATIONS.other, icon: '⏸' },
];

const LABEL_FOR_TYPE: Record<BreakType, string> =
  Object.fromEntries(BREAK_OPTIONS.map((o) => [o.type, o.label])) as Record<BreakType, string>;

interface BreakStartResponse {
  break_id: string;
  break_start: string;
  break_type: BreakType;
  planned_duration_minutes: number;
}

function pad(n: number) { return String(n).padStart(2, '0'); }

export default function BreakScreen() {
  const [phase,   setPhase]   = useState<'select' | 'timer'>('select');
  const [breakId, setBreakId] = useState<string | null>(null);
  const [breakType,  setBreakType]  = useState<BreakType | null>(null);
  const [breakLabel, setBreakLabel] = useState('');
  /** ms since epoch of the server-authoritative break_start. */
  const [breakStartMs, setBreakStartMs] = useState<number | null>(null);
  /** ms of planned duration; derived from server's planned_duration_minutes. */
  const [durationMs, setDurationMs] = useState<number | null>(null);
  /** Ticks every 1s to drive the countdown re-render. Derived remaining
   *  reads (breakStartMs + durationMs) − now, so a background pause of the
   *  JS thread just skips ticks — the next tick catches up to real time. */
  const [now, setNow] = useState<number>(Date.now());
  const [starting, setStarting] = useState(false);
  const [ending,   setEnding]   = useState(false);

  const { activeSession, currentBreak, setCurrentBreak, refreshFromServer } = useShiftStore();
  const rotAnim = useRef(new Animated.Value(0)).current;
  const hydrated = useRef(false);

  // Derived state — all three values recompute on every render.
  const totalSeconds = durationMs ? Math.floor(durationMs / 1000) : 0;
  const remaining = breakStartMs !== null && durationMs !== null
    ? Math.max(0, Math.floor((breakStartMs + durationMs - now) / 1000))
    : 0;
  const expired = phase === 'timer' && breakStartMs !== null && remaining === 0;
  const pct = totalSeconds > 0 ? (remaining / totalSeconds) * 100 : 0;

  // Hydrate from server on mount. Refresh calls /shifts/active-session; the
  // handler now includes current_break for the active session. If present,
  // we land directly in the timer phase — mounting the /break route no
  // longer resets an in-progress break to the 'select' screen.
  useEffect(() => {
    (async () => {
      await refreshFromServer();
      const cb = useShiftStore.getState().currentBreak;
      applyServerBreak(cb);
      hydrated.current = true;
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Also react to store changes while mounted (e.g. AppState refetch below
  // rewrites currentBreak on foreground). Avoid clobbering a break the user
  // just started locally before the store round-trip caught up.
  useEffect(() => {
    if (!hydrated.current) return;
    applyServerBreak(currentBreak);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBreak?.break_id, currentBreak?.break_start, currentBreak?.planned_duration_minutes]);

  function applyServerBreak(cb: NonNullable<ReturnType<typeof useShiftStore.getState>['currentBreak']> | null) {
    if (!cb) {
      // Server says no open break. If we're already on 'select', nothing to do.
      // If we're on 'timer' but the row is gone (server auto-closed), fall
      // back to select — the guard can start a new one.
      if (phase === 'timer') {
        setPhase('select');
        setBreakId(null);
        setBreakType(null);
        setBreakLabel('');
        setBreakStartMs(null);
        setDurationMs(null);
      }
      return;
    }
    setBreakId(cb.break_id);
    setBreakType(cb.break_type);
    setBreakLabel(LABEL_FOR_TYPE[cb.break_type] ?? cb.break_type.toUpperCase());
    setBreakStartMs(new Date(cb.break_start).getTime());
    setDurationMs(cb.planned_duration_minutes * 60 * 1000);
    setPhase('timer');
  }

  // AppState listener — foreground triggers a server refetch so a break
  // that expired (or was ended from another surface, e.g. clock-out
  // auto-close) is reflected immediately. Also updates `now` so the
  // countdown snaps to reality without waiting for the next 1s tick.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next !== 'active') return;
      setNow(Date.now());
      refreshFromServer();
    });
    return () => sub.remove();
  }, [refreshFromServer]);

  // Circular arc animation driven by remaining/total
  useEffect(() => {
    if (phase !== 'timer' || totalSeconds === 0) return;
    const progress = totalSeconds > 0 ? remaining / totalSeconds : 0;
    Animated.timing(rotAnim, {
      toValue: progress,
      duration: 800,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [remaining, totalSeconds, phase, rotAnim]);

  // Countdown ticker — nudges `now` every 1s. `remaining` is derived.
  useEffect(() => {
    if (phase !== 'timer') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [phase]);

  async function startBreak(option: typeof BREAK_OPTIONS[0]) {
    if (!activeSession) {
      Alert.alert('No Active Shift', 'You must be clocked in to take a break.');
      return;
    }
    setStarting(true);
    try {
      const data = await apiClient.post<BreakStartResponse>('/shifts/break-start', {
        session_id: activeSession.id,
        break_type: option.type,
      });
      const cb = {
        break_id: data.break_id,
        break_start: data.break_start,
        break_type: data.break_type,
        planned_duration_minutes: data.planned_duration_minutes,
      };
      setCurrentBreak(cb);
      applyServerBreak(cb);
      setNow(Date.now());
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not start break.');
    } finally {
      setStarting(false);
    }
  }

  async function endBreak() {
    setEnding(true);
    try {
      if (breakId) {
        await apiClient.post('/shifts/break-end', { break_id: breakId });
      }
      setCurrentBreak(null);
      router.replace('/active-shift');
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not end break. Please try again.');
      setEnding(false);
    }
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;

  // ── Phase 1: Select break type ────────────────────────────────────────
  if (phase === 'select') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>START BREAK</Text>
        <Text style={styles.subtitle}>Select break type</Text>

        <View style={styles.optionList}>
          {BREAK_OPTIONS.map((opt) => (
            <TouchableOpacity
              key={opt.type}
              style={[styles.optionCard, starting && styles.disabled]}
              onPress={() => startBreak(opt)}
              disabled={starting}
            >
              <Text style={styles.optionIcon}>{opt.icon}</Text>
              <View style={styles.optionInfo}>
                <Text style={styles.optionLabel}>{opt.label}</Text>
                <Text style={styles.optionDuration}>{opt.duration} MINUTES</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
          <Text style={styles.cancelText}>CANCEL</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Phase 2: Timer ────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Text style={styles.breakTypeLabel}>{breakLabel}</Text>
      <Text style={styles.breakTypeSub}>BREAK IN PROGRESS</Text>

      {/* Circular timer */}
      <View style={styles.ringOuter}>
        <View style={[
          styles.ringFill,
          { borderColor: expired ? '#EF4444' : (pct > 25 ? Colors.action : '#EF4444') }
        ]} />
        <View style={styles.ringCenter}>
          <Text style={styles.timerValue}>{pad(mins)}:{pad(secs)}</Text>
          <Text style={styles.timerLabel}>REMAINING</Text>
        </View>
      </View>

      {expired && (
        <Text style={styles.expiredText}>BREAK TIME EXPIRED</Text>
      )}

      <TouchableOpacity
        style={[styles.endBtn, ending && styles.disabled]}
        onPress={endBreak}
        disabled={ending}
      >
        <Text style={styles.endBtnText}>{ending ? 'ENDING…' : 'END BREAK'}</Text>
      </TouchableOpacity>

      <Text style={styles.footer}>GPS tracking paused during break</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: Colors.structure,
    alignItems: 'center', justifyContent: 'center',
    padding: Spacing.xl,
  },
  title:    { fontFamily: Fonts.heading, color: Colors.base, fontSize: 28, letterSpacing: 4, marginBottom: Spacing.xs },
  subtitle: { color: Colors.muted, fontSize: 13, letterSpacing: 2, marginBottom: Spacing.xl },

  // Options
  optionList: { width: '100%', gap: Spacing.md, marginBottom: Spacing.xl },
  optionCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg, gap: Spacing.md,
  },
  optionIcon:     { fontSize: 28 },
  optionInfo:     { flex: 1 },
  optionLabel:    { color: Colors.base, fontFamily: Fonts.heading, fontSize: 15, letterSpacing: 2 },
  optionDuration: { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginTop: 2 },
  chevron:        { color: Colors.action, fontSize: 22 },

  cancelBtn:  { padding: Spacing.md },
  cancelText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },

  // Timer ring (simplified — using border radius trick)
  breakTypeLabel: { fontFamily: Fonts.heading, color: Colors.action, fontSize: 18, letterSpacing: 4, marginBottom: 4 },
  breakTypeSub:   { color: Colors.muted, fontSize: 12, letterSpacing: 3, marginBottom: Spacing.xxl },

  ringOuter: {
    width: 220, height: 220, borderRadius: 110,
    borderWidth: 8, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.xl,
  },
  ringFill: {
    position: 'absolute',
    width: 220, height: 220, borderRadius: 110,
    borderWidth: 8, borderColor: Colors.action,
  },
  ringCenter:  { alignItems: 'center' },
  timerValue:  { fontFamily: 'monospace', color: Colors.base, fontSize: 48, letterSpacing: 2 },
  timerLabel:  { color: Colors.muted, fontSize: 11, letterSpacing: 3 },

  expiredText: { color: '#EF4444', fontFamily: Fonts.heading, fontSize: 16, letterSpacing: 3, marginBottom: Spacing.lg },

  endBtn: {
    width: '100%',
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  endBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 4 },
  disabled:   { opacity: 0.4 },

  footer: { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginTop: Spacing.sm },
});
