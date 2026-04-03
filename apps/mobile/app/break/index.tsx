/**
 * Break Session Flow (Section 5.6)
 * Step 1: Break type selector (Meal / Rest / Other)
 * Step 2: Circular countdown timer with End Break button
 * POSTs break_start event to API, then break_end on finish.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  Alert, Animated, Easing, ScrollView,
} from 'react-native';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { apiClient }     from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

type BreakType = 'meal' | 'rest' | 'other';

const BREAK_OPTIONS: { type: BreakType; label: string; duration: number; icon: string }[] = [
  { type: 'meal',  label: 'MEAL BREAK',  duration: 30, icon: '🍱' },
  { type: 'rest',  label: 'REST BREAK',  duration: 15, icon: '☕' },
  { type: 'other', label: 'OTHER',       duration: 10, icon: '⏸' },
];

function pad(n: number) { return String(n).padStart(2, '0'); }

export default function BreakScreen() {
  const [phase,        setPhase]        = useState<'select' | 'timer'>('select');
  const [breakType,    setBreakType]    = useState<BreakType | null>(null);
  const [breakLabel,   setBreakLabel]   = useState('');
  const [totalSeconds, setTotalSeconds] = useState(0);
  const [remaining,    setRemaining]    = useState(0);
  const [starting,     setStarting]     = useState(false);
  const [ending,       setEnding]       = useState(false);
  const [breakId,      setBreakId]      = useState<string | null>(null);

  const { activeSession } = useShiftStore();
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotAnim    = useRef(new Animated.Value(0)).current;

  // Circular arc animation driven by remaining/total
  useEffect(() => {
    if (phase !== 'timer' || totalSeconds === 0) return;
    const progress = remaining / totalSeconds;
    Animated.timing(rotAnim, {
      toValue: progress,
      duration: 800,
      easing: Easing.out(Easing.ease),
      useNativeDriver: false,
    }).start();
  }, [remaining, totalSeconds]);

  // Countdown tick
  useEffect(() => {
    if (phase !== 'timer') return;

    timerRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return r - 1;
      });
    }, 1000);

    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  async function startBreak(option: typeof BREAK_OPTIONS[0]) {
    if (!activeSession) {
      Alert.alert('No Active Shift', 'You must be clocked in to take a break.');
      return;
    }
    setStarting(true);
    try {
      const res = await apiClient('/api/shifts/break-start', {
        method: 'POST',
        body: JSON.stringify({
          session_id: activeSession.id,
          break_type: option.type,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? 'Failed to start break');
      }
      const data = await res.json();
      setBreakId(data.break_id ?? null);
      setBreakType(option.type);
      setBreakLabel(option.label);
      const secs = option.duration * 60;
      setTotalSeconds(secs);
      setRemaining(secs);
      setPhase('timer');
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
        await apiClient('/api/shifts/break-end', {
          method: 'POST',
          body: JSON.stringify({ break_id: breakId }),
        });
      }
      if (timerRef.current) clearInterval(timerRef.current);
      router.replace('/active-shift');
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not end break. Please try again.');
      setEnding(false);
    }
  }

  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const pct  = totalSeconds > 0 ? (remaining / totalSeconds) * 100 : 0;

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
          { borderColor: pct > 25 ? Colors.action : '#EF4444' }
        ]} />
        <View style={styles.ringCenter}>
          <Text style={styles.timerValue}>{pad(mins)}:{pad(secs)}</Text>
          <Text style={styles.timerLabel}>REMAINING</Text>
        </View>
      </View>

      {remaining === 0 && (
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
