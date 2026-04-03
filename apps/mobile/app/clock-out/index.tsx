/**
 * Clock-Out Confirmation (Section 5.7)
 * Shows shift summary card: total hours, ping count, reports filed.
 * Guard writes optional handover notes before confirming.
 * POSTs to /api/shifts/clock-out → clears session → returns to home.
 */
import { useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  TextInput, ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { apiClient }     from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

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
      const res = await apiClient('/api/shifts/clock-out', {
        method: 'POST',
        body: JSON.stringify({
          session_id:     activeSession!.id,
          handover_notes: notes.trim() || null,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? 'Clock-out failed');
      }

      clearSession();
      router.replace('/(tabs)/home');
    } catch (err: any) {
      Alert.alert('Clock-Out Failed', err?.message ?? 'Could not end shift. Please try again.');
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
