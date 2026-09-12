/**
 * Ping Router — always routes to the photo+GPS capture flow.
 * (Previously alternated between photo and GPS-only every 30 min;
 * product decision moved to "always photo" so admin/client review
 * gets a consistent visual record at every ping.)
 *
 * DEEP-LINK RESTORE. This screen is what a ping_reminder or missed_ping push
 * opens (lib/navigateForNotification.ts routes both to /ping?window_label=…).
 * It used to read activeSession once, on an empty-deps effect, and bounce to
 * home when it was null:
 *
 *     useEffect(() => {
 *       if (!activeSession?.clocked_in_at) { router.replace('/(tabs)/home'); return; }
 *       ...
 *     }, []);                                   // ← never re-evaluated
 *
 * The store is not persisted, so on a cold start activeSession IS null, and
 * the only thing that hydrated it was home.tsx's restoreOrFetchShift — which
 * this screen never reaches, because it has already redirected. A guard who
 * tapped "Submit your 13:30 ping" from a killed app landed on the home tab
 * and had to find PING NOW themselves (session bb3934c9, 2026-09-12 20:30).
 * The empty deps made it permanent rather than a race: when the session did
 * arrive, nothing re-ran.
 *
 * Now the screen asks for the session before deciding. Three outcomes, and
 * only the last one goes home:
 *   session already in the store  → straight to capture
 *   store empty, server has one   → hydrate, then capture
 *   store empty, server has none  → home (genuinely not on shift)
 *
 * window_label survives both hops — it is what makes the submission a
 * backfill the server can match to a missed_pings row.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { Colors, Fonts, Spacing } from '../../constants/theme';

export default function PingRouter() {
  const activeSession = useShiftStore((s) => s.activeSession);
  const restoreSessionIfMissing = useShiftStore((s) => s.restoreSessionIfMissing);
  const { window_label } = useLocalSearchParams<{ window_label?: string }>();

  // Shown only while we are actually asking the server. A store hit routes
  // in the same tick and never renders this.
  const [restoring, setRestoring] = useState(false);

  // One decision per mount. Without this the effect re-enters when
  // setActiveSession lands (activeSession is a dependency, deliberately, so
  // a late hydration is seen) and would fire a second router.replace at a
  // screen that has already navigated away.
  const decided = useRef(false);

  useEffect(() => {
    if (decided.current) return;

    const toCapture = () => {
      decided.current = true;
      // Forward the missed-ping backfill window into the capture screen so
      // the submit body carries it through to the server (server sets
      // submitted_late + resolves the matching missed_pings row).
      router.replace(
        window_label
          ? `/ping/photo?window_label=${encodeURIComponent(window_label)}`
          : '/ping/photo',
      );
    };

    if (activeSession?.clocked_in_at) { toCapture(); return; }

    // Store is empty. Ask the server before concluding the guard is off
    // shift — on a cold start from a notification tap, empty is the normal
    // state, not evidence of anything.
    let cancelled = false;
    setRestoring(true);
    void restoreSessionIfMissing().then((session) => {
      if (cancelled || decided.current) return;
      setRestoring(false);
      if (session?.clocked_in_at) { toCapture(); return; }
      decided.current = true;
      router.replace('/(tabs)/home');
    });
    return () => { cancelled = true; };
    // activeSession IS a dependency on purpose: if home hydrates the store
    // underneath us while our own restore is in flight, this re-runs and
    // takes the fast path above rather than waiting on the network.
  }, [activeSession, restoreSessionIfMissing, window_label]);

  return (
    <View style={styles.center}>
      <ActivityIndicator color={Colors.action} size="large" />
      {restoring && (
        <Text style={styles.note}>RESTORING YOUR SHIFT…</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Colors.structure (#070D1A) — the same token the pre-restore version of
  // this screen used, kept verbatim so the deep-link spinner is visually
  // identical to what it replaced. NOTE the dispatch named #0B1526 as the
  // brand navy; no token in constants/theme.ts holds that value, and
  // structure/bg are both #070D1A. Not changed here — a palette correction
  // is its own decision, not a side effect of a routing fix.
  center: { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center' },
  note: {
    marginTop: Spacing.md,
    color: Colors.muted,
    fontFamily: Fonts.headingMedium,
    fontSize: 13,
    letterSpacing: 2,
  },
});
