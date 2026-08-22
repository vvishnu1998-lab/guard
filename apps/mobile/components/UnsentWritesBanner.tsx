/**
 * Banner shown while the dead-letter bucket holds anything the guard has
 * not dismissed.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * From the day the offline queue shipped until 2026-08-22, an action that
 * could not be delivered was moved to a dead-letter bucket that NOTHING
 * READ. No screen, no badge, no count. The guard had already been told
 * "saved and will sync automatically", so a lost patrol scan, report or
 * task completion simply ceased to exist — silently, and in a system whose
 * entire purpose is producing a defensible record of presence.
 *
 * This banner is the minimum honest fix: while a loss exists and has not
 * been acknowledged, the guard can see it.
 *
 * It renders from LOCAL state only. It must never depend on whether the
 * server has been told, because the losses most worth surfacing are the
 * ones that happened while connectivity was bad.
 */
import { useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { useOfflineStore } from '../store/offlineStore';
import { reportDeadLetters } from '../lib/offlineQueue';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';

export default function UnsentWritesBanner() {
  const deadCount       = useOfflineStore((s) => s.deadCount);
  const storageDegraded = useOfflineStore((s) => s.storageDegraded);
  const refreshCounts   = useOfflineStore((s) => s.refreshCounts);

  // The bucket lives in AsyncStorage, so a cold start has a count of 0
  // until it is read back. Without this the banner would be invisible on
  // exactly the launch after a force-quit.
  //
  // Also nudge the escalation sweep. startQueueSync only runs between
  // clock-in and clock-out, so without this a loss reported at the end of
  // a shift would wait for the NEXT shift before the server heard about
  // it. Fire-and-forget: it never throws and the banner never waits on it.
  useEffect(() => {
    void refreshCounts();
    void reportDeadLetters();
  }, [refreshCounts]);

  // Degraded storage counts as something to show even at zero: a bucket we
  // could not parse may have held writes that never went anywhere, and the
  // count cannot see them precisely because it could not be read.
  if (deadCount < 1 && !storageDegraded) return null;

  const title = deadCount > 0
    ? `⚠ ${deadCount} ${deadCount === 1 ? 'ITEM' : 'ITEMS'} FAILED TO SEND`
    : '⚠ SAVED DATA COULD NOT BE READ';
  const sub = deadCount > 0
    ? (storageDegraded
        ? 'Some saved data was also unreadable. Tap to review, and tell your supervisor.'
        : `${deadCount === 1 ? 'It was' : 'They were'} not recorded. Tap to review.`)
    : 'Some items saved on this phone could not be read and may never have been sent. Tell your supervisor.';

  return (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push('/offline/failed')}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub}`}
    >
      <View style={styles.info}>
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.sub}>{sub}</Text>
      </View>
      <Text style={styles.chevron}>›</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface2,
    borderWidth: 1,
    borderColor: Colors.warning,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  info:  { flex: 1 },
  title: {
    fontFamily: Fonts.heading,
    fontSize: 15,
    letterSpacing: 0.5,
    color: Colors.warning,
    marginBottom: 2,
  },
  sub:   { fontFamily: Fonts.body, fontSize: 13, color: Colors.muted, lineHeight: 18 },
  chevron: { fontSize: 26, color: Colors.warning, marginLeft: Spacing.sm },
});
