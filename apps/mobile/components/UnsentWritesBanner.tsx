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
  const deadUnreported  = useOfflineStore((s) => s.deadUnreported);
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

  // Three states, in descending urgency.
  //
  // LOUD      something failed and the guard has not acknowledged it.
  // DEGRADED  a bucket would not parse; it may have held writes that went
  //           nowhere, and the count cannot see them precisely because it
  //           could not be read. Shown even at zero.
  // QUIET     everything is dismissed, but the SERVER still does not know
  //           about at least one of them. A dismissed loss nobody upstream
  //           has heard of is not resolved — it is just off this guard's
  //           screen. Silence there would be wrong; shouting would be too,
  //           since they have already acknowledged it.
  //
  // deadCount 0 with deadUnreported > 0 necessarily means the unreported
  // items are dismissed ones, so no fourth counter is needed.
  const loud     = deadCount > 0;
  const quiet    = !loud && !storageDegraded && deadUnreported > 0;
  if (!loud && !storageDegraded && !quiet) return null;

  const title = loud
    ? `⚠ ${deadCount} ${deadCount === 1 ? 'ITEM' : 'ITEMS'} FAILED TO SEND`
    : storageDegraded
      ? '⚠ SAVED DATA COULD NOT BE READ'
      : `${deadUnreported} ${deadUnreported === 1 ? 'ITEM IS' : 'ITEMS ARE'} SAVED ONLY ON THIS PHONE`;
  const sub = loud
    ? (storageDegraded
        ? 'Some saved data was also unreadable. Tap to review, and tell your supervisor.'
        : `${deadCount === 1 ? 'It was' : 'They were'} not recorded. Tap to review.`)
    : storageDegraded
      ? 'Some items saved on this phone could not be read and may never have been sent. Tell your supervisor.'
      : 'Your supervisor’s team has not been told yet. Tap to review.';

  return (
    <TouchableOpacity
      style={[styles.card, quiet && styles.cardQuiet]}
      onPress={() => router.push('/offline/failed')}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${sub}`}
    >
      <View style={styles.info}>
        <Text style={[styles.title, quiet && styles.titleQuiet]}>{title}</Text>
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
    // Vertical spacing lives HERE, not on the host's wrapper, so it
    // disappears with the banner. A wrapper with paddingTop leaves dead
    // space above the map on every launch where nothing has failed.
    marginTop: Spacing.md,
    marginBottom: Spacing.md,
  },
  // Dismissed-but-unreported: present, but visibly de-escalated. The guard
  // has already acknowledged it; the point is only that it has not left the
  // device yet.
  cardQuiet:  { borderColor: Colors.border, backgroundColor: Colors.surface },
  titleQuiet: { color: Colors.muted },
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
