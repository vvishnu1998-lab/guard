/**
 * "Failed to send" — the review screen for the dead-letter bucket.
 *
 * Every item here is a write the guard was told had been saved and which
 * never reached the server. Before 2026-08-22 there was no such screen and
 * no other way to learn any of this had happened.
 *
 * ── TWO RULES THIS SCREEN ENFORCES ──────────────────────────────────────
 *
 * 1. RETRY IS OFFERED ONLY WHERE IT CAN WORK. A payload is frozen in
 *    storage at enqueue time and cannot change, so an item the server
 *    already refused with a 4xx will be refused identically forever.
 *    Offering "Retry" there is theatre that costs the guard time and
 *    teaches them the button does nothing.
 *
 * 2. DISMISS HIDES, IT DOES NOT DELETE. The item stays on the device and
 *    stays eligible for reporting to the server. A guard can silence the
 *    banner; they cannot erase a loss before anyone upstream knows about
 *    it. Permanent deletion unlocks only once the server has the record.
 *
 * Copy here stays deliberately plain — what was lost, roughly when, and
 * whether it can be resent. The diagnostic detail (status codes, error
 * strings, the payload) goes to the server, not onto this screen.
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert } from 'react-native';
import { router, useFocusEffect, Stack } from 'expo-router';
import {
  getDeadLetterItems, acknowledgeDeadLetter, retryDeadLetter,
  type QueuedAction, type QueueActionType, type DeadReason,
} from '../../lib/offlineQueue';
import { useOfflineStore } from '../../store/offlineStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const TYPE_LABEL: Record<QueueActionType, string> = {
  report_submit:   'Report',
  checkpoint_scan: 'Checkpoint scan',
  task_complete:   'Task completion',
  violation_post:  'Off-post alert',
};

/** Guard-facing reason. No status codes, no error strings — those go to
 *  the server where someone can act on them. */
const REASON_COPY: Record<DeadReason, string> = {
  permanent_4xx: 'The server would not accept this. It cannot be sent.',
  max_attempts:  "Couldn't reach the server after several tries.",
  unknown_type:  'Saved by an older version of the app and can no longer be sent.',
};

function whenText(iso?: string): string {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown time';
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export default function FailedWritesScreen() {
  const [items, setItems] = useState<QueuedAction[] | null>(null);
  const refreshCounts = useOfflineStore((s) => s.refreshCounts);

  const load = useCallback(async () => {
    setItems(await getDeadLetterItems());
    await refreshCounts();
  }, [refreshCounts]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function onRetry(item: QueuedAction) {
    await retryDeadLetter(item.localId);
    await load();
    Alert.alert('Retrying', 'It will be sent again in the background. This screen will update if it fails once more.');
  }

  function onDismiss(item: QueuedAction) {
    Alert.alert(
      'Dismiss this?',
      'It stays on record and your supervisor can still be told. This only removes the warning from your screen.',
      [
        { text: 'Keep showing', style: 'cancel' },
        {
          text: 'Dismiss',
          style: 'destructive',
          onPress: async () => { await acknowledgeDeadLetter(item.localId); await load(); },
        },
      ],
    );
  }

  const visible = items ?? [];
  const active  = visible.filter((i) => !i.acknowledgedAt);

  return (
    <>
      <Stack.Screen options={{ title: 'FAILED TO SEND' }} />
      <ScrollView style={styles.bg} contentContainerStyle={styles.scroll}>
        <Text style={styles.intro}>
          These were saved on your phone but never reached the server, so they were
          not recorded. Tell your supervisor about anything important here.
        </Text>

        {items !== null && visible.length === 0 && (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyTitle}>NOTHING FAILED</Text>
            <Text style={styles.emptySub}>Everything you have submitted reached the server.</Text>
          </View>
        )}

        {visible.map((item) => {
          const reason    = item.deadReason ?? 'max_attempts';
          const canRetry  = reason === 'max_attempts';
          const dismissed = !!item.acknowledgedAt;
          return (
            <View key={item.localId} style={[styles.card, dismissed && styles.cardDismissed]}>
              <Text style={styles.cardTitle}>{TYPE_LABEL[item.type] ?? 'Unsent item'}</Text>
              <Text style={styles.cardWhen}>Captured {whenText(item.queuedAt)}</Text>
              <Text style={styles.cardReason}>{REASON_COPY[reason]}</Text>

              <Text style={styles.cardRecord}>
                {item.reportedAt
                  ? '✓ Your supervisor’s team has a record of this.'
                  : 'Not yet reported to your supervisor’s team — this phone will keep trying.'}
              </Text>

              <View style={styles.actions}>
                {canRetry && !dismissed && (
                  <TouchableOpacity style={styles.btnPrimary} onPress={() => onRetry(item)}>
                    <Text style={styles.btnPrimaryText}>TRY AGAIN</Text>
                  </TouchableOpacity>
                )}
                {!dismissed ? (
                  <TouchableOpacity style={styles.btnGhost} onPress={() => onDismiss(item)}>
                    <Text style={styles.btnGhostText}>DISMISS</Text>
                  </TouchableOpacity>
                ) : (
                  <Text style={styles.dismissedTag}>DISMISSED</Text>
                )}
              </View>
            </View>
          );
        })}

        {active.length === 0 && visible.length > 0 && (
          <Text style={styles.footNote}>
            All dismissed. They stay on record here until your supervisor’s team has them.
          </Text>
        )}

        <TouchableOpacity style={styles.backBtn} onPress={() => router.back()}>
          <Text style={styles.backBtnText}>BACK</Text>
        </TouchableOpacity>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: Spacing.md, paddingBottom: Spacing.xxl },
  intro:  { fontFamily: Fonts.body, fontSize: 14, color: Colors.muted, lineHeight: 20, marginBottom: Spacing.md },

  emptyCard:  { backgroundColor: Colors.surface, borderRadius: Radius.md, padding: Spacing.lg, alignItems: 'center' },
  emptyTitle: { fontFamily: Fonts.heading, fontSize: 16, color: Colors.success, letterSpacing: 0.5 },
  emptySub:   { fontFamily: Fonts.body, fontSize: 13, color: Colors.muted, marginTop: Spacing.xs, textAlign: 'center' },

  card: {
    backgroundColor: Colors.surface,
    borderLeftWidth: 3,
    borderLeftColor: Colors.warning,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  cardDismissed: { borderLeftColor: Colors.border, opacity: 0.6 },
  cardTitle:  { fontFamily: Fonts.heading, fontSize: 16, color: Colors.textPrimary, letterSpacing: 0.5 },
  cardWhen:   { fontFamily: Fonts.body, fontSize: 12, color: Colors.muted, marginTop: 2 },
  cardReason: { fontFamily: Fonts.body, fontSize: 14, color: Colors.textPrimary, marginTop: Spacing.sm, lineHeight: 20 },
  cardRecord: { fontFamily: Fonts.body, fontSize: 12, color: Colors.muted, marginTop: Spacing.sm, lineHeight: 17 },

  actions: { flexDirection: 'row', alignItems: 'center', marginTop: Spacing.md, gap: Spacing.sm },
  btnPrimary: {
    backgroundColor: Colors.action, borderRadius: Radius.sm,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  btnPrimaryText: { fontFamily: Fonts.heading, fontSize: 13, color: Colors.black, letterSpacing: 0.5 },
  btnGhost: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.sm,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  btnGhostText: { fontFamily: Fonts.heading, fontSize: 13, color: Colors.muted, letterSpacing: 0.5 },
  dismissedTag: { fontFamily: Fonts.heading, fontSize: 12, color: Colors.muted, letterSpacing: 0.5 },

  footNote: { fontFamily: Fonts.body, fontSize: 12, color: Colors.muted, marginTop: Spacing.sm, lineHeight: 17 },

  backBtn: { marginTop: Spacing.lg, alignItems: 'center', paddingVertical: Spacing.md },
  backBtnText: { fontFamily: Fonts.heading, fontSize: 14, color: Colors.action, letterSpacing: 1 },
});
