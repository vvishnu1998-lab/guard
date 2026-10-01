/**
 * Root layout — handles:
 *   - Session restoration on cold start
 *   - Force-change-password routing
 *   - Push-notification foreground display + tap routing
 *   - Auto-refresh of the Expo push token whenever the guard is authenticated
 *     (covers the case where a returning user gets in via persisted refresh token
 *     and never goes through the login button handler).
 *   - Tab-bar badge counts (notifications + chat) via the unread store —
 *     refreshed on auth, on incoming push, and on tab focus.
 *
 * Guards stay logged in until they explicitly log out (no auto-lock).
 */
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { Stack, router, useSegments } from 'expo-router';
import { useFonts, BarlowCondensed_500Medium, BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';
import { useAuthStore } from '../store/authStore';
import { useUnreadStore } from '../store/unreadStore';
import { useShiftStore, syncShiftEndMirror, refreshIfActiveShiftEdited } from '../store/shiftStore';
import { apiClient } from '../lib/apiClient';
import { navigateForNotification } from '../lib/navigateForNotification';
import { startBackgroundLocation, stopBackgroundLocation } from '../tasks/locationBackground';
import { shouldRearmAfterWindowChange } from '../lib/activeShiftReconcile';
import { initSentry } from '../lib/sentry';
import { setupAndroidChannels } from '../lib/notifications';
import { syncTrayAndBadge, syncBadge } from '../lib/notificationSync';

/**
 * Notification-response identifiers already routed, shared between the
 * response listener and the cold-start handler below.
 *
 * A launch-from-tap can surface through BOTH — the listener fires if it
 * happens to be registered in time, and getLastNotificationResponseAsync
 * always returns it — and routing twice would push the same screen onto the
 * stack twice, leaving the guard a back button that goes nowhere useful.
 * Module scope rather than a ref because the two consumers are separate
 * effects with separate lifetimes.
 */
const handledResponses = new Set<string>();

function routeOnce(resp: Notifications.NotificationResponse | null): void {
  if (!resp) return;
  const id = resp.notification.request.identifier;
  if (handledResponses.has(id)) return;
  handledResponses.add(id);
  const data = resp.notification.request.content.data as Record<string, any> | undefined;
  navigateForNotification(data?.type, data);
}

// Initialize at module load — before any component mounts — so early native
// crashes during startup are captured.
initSentry();

// Register Android notification channels at module load so channels exist
// before any push arrives (Android 8+ suppresses pushes without a channel).
// Fire-and-forget — iOS early-returns; channel setup is idempotent.
setupAndroidChannels().catch((err) => {
  Sentry.captureException(err, { tags: { flow: 'android_channel_setup' } });
});

const EAS_PROJECT_ID = '5fd28125-2461-4165-b9df-7f34ced8b194';

// Foreground display: show banner + sound + badge when a push arrives while app is open.
// Without this, expo-notifications silently drops foreground notifications by default.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList:   true,
    shouldPlaySound:  true,
    shouldSetBadge:   true,
    shouldShowAlert:  true, // legacy field for older expo-notifications builds
  }),
});

export default function RootLayout() {
  const { status, mustChangePassword, loadSession } = useAuthStore();
  const segments = useSegments();
  const refreshUnread = useUnreadStore((s) => s.refresh);
  const bumpNotifications = useUnreadStore((s) => s.bumpNotifications);
  const bumpChat = useUnreadStore((s) => s.bumpChat);

  const [fontsLoaded] = useFonts({ BarlowCondensed_500Medium, BarlowCondensed_700Bold });

  // Restore session on cold start
  useEffect(() => { loadSession(); }, []);

  // Route guard — only runs once fonts are loaded and Stack is mounted
  useEffect(() => {
    if (!fontsLoaded || status === 'unknown') return;
    const inAuth = segments[0] === '(auth)';

    if (status === 'unauthenticated' && !inAuth) {
      router.replace('/(auth)/login');
    } else if (status === 'authenticated') {
      if (mustChangePassword) {
        // Force the user through change-password before any other route
        router.replace('/(auth)/change-password');
      } else if ((inAuth && !segments.includes('change-password')) || !segments.length) {
        // Bounce authenticated users out of login/forgot-password — but NOT
        // out of change-password, which is also reachable voluntarily from
        // the drawer/profile while signed in (dead since April otherwise).
        router.replace('/(tabs)/home');
      }
    }
  }, [fontsLoaded, status, mustChangePassword, segments]);

  // Auto-register / refresh the Expo push token + load unread counts whenever
  // the guard is authenticated. This is the durable path; the login button
  // handler also captures it as a fast path, but this effect covers auto-login
  // via refresh token (no login handler fires).
  useEffect(() => {
    if (status !== 'authenticated' || mustChangePassword) return;
    (async () => {
      try {
        const { status: permStatus } = await Notifications.requestPermissionsAsync();
        if (permStatus === 'granted') {
          const t = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
          await apiClient.post('/auth/guard/fcm-token', { fcm_token: t.data });
          Sentry.addBreadcrumb({
            category: 'auth',
            message: 'fcm-token register success',
            level: 'info',
          });
        } else {
          Sentry.addBreadcrumb({
            category: 'auth',
            message: 'fcm-token register skipped — permission not granted',
            level: 'info',
            data: { perm_status: permStatus },
          });
        }
      } catch (err) {
        console.warn('[push] Failed to register push token:', err);
        Sentry.addBreadcrumb({
          category: 'auth',
          message: 'fcm-token register failed',
          level: 'warning',
          data: { message: (err as Error)?.message },
        });
        Sentry.captureException(err, {
          tags: { flow: 'fcm_token_register' },
        });
      }
      // Always pull the latest unread counts so the badge isn't stale on launch.
      refreshUnread();
    })();
  }, [status, mustChangePassword, refreshUnread]);

  // Request location permissions up front on first authenticated launch — both
  // foreground ("While Using") and background ("Always"). iOS prompts the
  // user in sequence and silently no-ops on subsequent calls when already
  // granted. Without this, the "Always" prompt would only appear once the
  // guard clocks into their first shift, which left existing installs without
  // background geofencing (the bug james hit on 2026-05-15).
  useEffect(() => {
    if (status !== 'authenticated' || mustChangePassword) return;
    (async () => {
      try {
        const fg = await Location.requestForegroundPermissionsAsync();
        if (fg.status === 'granted') {
          await Location.requestBackgroundPermissionsAsync();
        }
      } catch (err) {
        console.warn('[location] permission request failed:', err);
        Sentry.captureException(err, { tags: { flow: 'geofence_perm_request' } });
      }
    })();
  }, [status, mustChangePassword]);

  // Tap routing — open the right screen when the user taps a push notification.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener(routeOnce);
    return () => sub.remove();
  }, []);

  // Cold-start tap routing. A tap that LAUNCHES the app is delivered before
  // the listener above exists, so until now it opened the app on the home tab
  // and silently dropped the destination — the guard tapped "you're 15 min
  // late" and landed nowhere in particular.
  //
  // Gated on authenticated + fonts, because this component renders null until
  // both are settled and a push before the Stack mounts has nothing to
  // navigate. routeOnce dedupes against the listener.
  useEffect(() => {
    if (status !== 'authenticated' || mustChangePassword || !fontsLoaded) return;
    Notifications.getLastNotificationResponseAsync()
      .then(routeOnce)
      .catch((err) => console.warn('[push] cold-start response lookup failed:', err));
  }, [status, mustChangePassword, fontsLoaded]);

  // Foreground reception — bump the appropriate badge counter optimistically,
  // then re-sync against the server so we self-correct if the optimistic bump
  // drifted (e.g. push arrived while the user was actively in the chat room).
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener((notif) => {
      const data = notif.request.content.data as Record<string, any> | undefined;
      // Walk-test 2026-07-09 BUG C: swap/handoff request pushes should
      // bump the ALERTS badge (they route to the alerts tab, and the
      // pending row shows up there). unreadStore.refresh() also counts
      // inbound-swap-requests, so the server-side reconciliation lands
      // the exact count on the followup fetch below. Explicit branch
      // exists so a Sentry crumb can capture the routing.
      const swapType = data?.type === 'swap_request_received'
                    || data?.type === 'handoff_request_received';
      if (data?.type === 'chat') {
        bumpChat(1);
      } else if (data?.type) {
        bumpNotifications(1);
      }
      if (data?.type) {
        Sentry.addBreadcrumb({
          category: 'push_foreground',
          message: `received type=${data.type}`,
          level: 'info',
          data: { type: data.type, swap_related: swapType },
        });
      }
      // Walk-test 2026-07-09 BUG H: when the recipient physically clocks
      // in via handoff-clock-in, the server closes A's session and rotates
      // shifts.guard_id. Without this, A's app still shows SHIFT ACTIVE +
      // CLOCK OUT from cached state and the guard hits "Active session
      // not found" on their next tap. Nuking the store forces home's
      // existing useEffect(!isOnShift → restoreOrFetchShift) to fire and
      // the app naturally transitions to NEXT SHIFT / empty state.
      // The OS push notification already told the guard, so no extra
      // Alert is fired here.
      if (data?.type === 'handoff_complete') {
        useShiftStore.getState().clearSession();
      }
      // U3 (N146): an admin moved or closed this guard's ACTIVE shift (D20).
      // Re-read it now, not at the next cold start — an extend or shorten
      // rewrites the cached window (Time Left, SCHEDULED END, the background
      // task's expiry gate), a close in the past clears the session. The
      // push itself already told the guard, so no Alert here either.
      if (data?.type === 'shift_schedule_edited') {
        refreshIfActiveShiftEdited(data);
      }
      // Requester-side outbound handoff refresh — accepted/declined/
      // cancelled arriving in the foreground should update the home
      // PENDING HANDOFF card faster than its 30s poll. Home reads from
      // /shifts/outbound-swap-requests which we can't invalidate directly,
      // but the refreshUnread below already re-fetches
      // /shifts/inbound-swap-requests; a companion outbound refresh would
      // require a store or event bus. For now the 30s tick + useFocusEffect
      // are the guarantees. Sentry crumb makes the drift diagnosable.
      // Re-sync from server shortly after — the new notification row
      // should be visible, and (BUG C) any pending swap/handoff should
      // land in the inbound-swap-requests count too.
      //
      // syncBadge() rather than refreshUnread(): it calls the same
      // unreadStore.refresh() and then stamps the OS app-icon badge with the
      // result. Calling both would double the fetch for one count.
      setTimeout(() => { void syncBadge(); }, 500);
    });
    return () => sub.remove();
  }, [bumpChat, bumpNotifications, refreshUnread]);

  // Walk-test 2026-07-10 BUG H tail — foreground reconciliation on
  // AppState 'active' transition. Covers the drift path the Build-30 fix
  // missed: handoff_complete push arrived while backgrounded → banner
  // dismissed or ignored → user opens app via icon → neither the receive
  // listener nor the tap listener fires → cached activeSession stays true
  // → home shows SHIFT ACTIVE + CLOCK OUT for a session that no longer
  // exists.
  //
  // useRef instead of state so mutating the last-fire timestamp doesn't
  // trigger a re-render. AppState.currentState starts as 'active' on
  // cold start; the first transition into 'active' is guarded on
  // prevAppState !== 'active' so we don't false-fire during initial
  // launch (loadSession + home's mount effect already fetch state at
  // T=0). 2s throttle absorbs iOS Control Center swipes / Notification
  // Center swipes that fire background↔active transitions on every pane
  // change — without it we'd hammer /shifts/active-session and
  // /shifts/inbound-swap-requests on trivial gestures.
  const prevAppState = useRef<AppStateStatus>(AppState.currentState);
  const lastRefreshAt = useRef<number>(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      const from = prevAppState.current;
      prevAppState.current = next;
      if (next !== 'active' || from === 'active') return;
      if (useAuthStore.getState().status !== 'authenticated') return;
      const now = Date.now();
      if (now - lastRefreshAt.current < 2000) {
        Sentry.addBreadcrumb({
          category: 'session_refresh',
          message: 'AppState active — throttled (<2s since last)',
          level: 'info',
          data: { from, gap_ms: now - lastRefreshAt.current },
        });
        return;
      }
      lastRefreshAt.current = now;
      Sentry.addBreadcrumb({
        category: 'session_refresh',
        message: 'AppState active — refetching',
        level: 'info',
        data: { from },
      });
      useShiftStore.getState().refreshFromServer();
      // Same 2s throttle, deliberately: foregrounding is the moment a guard
      // sees their tray, and anything they resolved while the app was
      // backgrounded (or that a cron auto-erased) should already be gone.
      // Not awaited — this handler must not block the AppState callback.
      void syncTrayAndBadge();
    });
    return () => sub.remove();
  }, []);

  // Background geofence monitoring — start when a shift goes active with a
  // known geofence, stop on clock-out. Build 34: native geofencing via
  // Location.startGeofencingAsync (event-driven Enter/Exit; near-zero
  // battery). The task itself reads only sessionId + accessToken from
  // SecureStore now — the geofence region is passed in as an argument
  // to startBackgroundLocation, no longer needs a SecureStore round-trip.
  const activeSession = useShiftStore((s) => s.activeSession);
  const activeShift   = useShiftStore((s) => s.activeShift);
  useEffect(() => {
    let cancelled = false;

    // Build 37 defense-in-depth against the Build 34 cold-restart bug.
    // The bug: /shifts/active-session used to omit the geofence field,
    // so on app cold-start with an in-progress shift, activeShift.geofence
    // was undefined and this gate unregistered the native region silently.
    // Server fix (cb4cbb4 on main) adds the field back, but keep this
    // guard so a future regression in the API — or a transient store
    // rehydration — cannot kill offsite detection mid-shift.
    if (!activeSession) {
      Sentry.addBreadcrumb({
        category: 'geofence',
        message: 'gate: stop (no active session)',
        level: 'info',
        data: { hasGeofence: !!activeShift?.geofence, hasActiveShift: !!activeShift },
      });
      stopBackgroundLocation().catch((err) => console.warn('[bg-loc] stop failed:', err));
      SecureStore.deleteItemAsync('active_session_id').catch(() => {});
      // A stale shift end is its own hazard — it would let the task judge a
      // NEW session against a PREVIOUS shift's clock. Always cleared with the
      // session id it belongs to. Through the same serial queue as every
      // write of the key, so a write still in flight cannot land after this
      // and resurrect it: this turn reads "no session" and deletes.
      void syncShiftEndMirror();
      // Break mirror dies with the session (lib/breakState.ts).
      SecureStore.deleteItemAsync('active_break_until').catch(() => {});
      // Legacy keys — safe to delete even when unused so a downgrade to
      // an older build doesn't rehydrate stale state.
      SecureStore.deleteItemAsync('active_geofence').catch(() => {});
      SecureStore.deleteItemAsync('geofence_state').catch(() => {});
      return;
    }
    if (!activeShift?.geofence) {
      // Active shift but geofence data is missing (server omitted it or
      // store hasn't hydrated yet). Do NOT stop the existing region —
      // that would silently kill offsite detection until clock-out.
      Sentry.addBreadcrumb({
        category: 'geofence',
        message: 'gate: skip (no geofence on active shift)',
        level: 'warning',
        data: { hasActiveShift: !!activeShift, shiftId: activeShift?.id ?? null },
      });
      return;
    }

    Sentry.addBreadcrumb({
      category: 'geofence',
      message: 'gate: register',
      level: 'info',
      data: {
        hasGeofence: true,
        hasActiveShift: true,
        center_lat: activeShift.geofence.center_lat,
        radius_meters: activeShift.geofence.radius_meters,
      },
    });
    (async () => {
      try {
        await SecureStore.setItemAsync('active_session_id', activeSession.id, {
          keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
        });
        // Persist the shift's end so the background task can decide, with no
        // network and on an app the OS has killed, that a shift is over — see
        // lib/shiftExpiry.ts. Written right after the session id and cleared
        // with it, so the two can never describe different shifts.
        //
        // syncShiftEndMirror reads the store when its turn comes, not the
        // activeShift this effect captured, and deletes rather than writes an
        // unusable window (clock-in/step4's fallback shape sets end === start;
        // persisting that would silence real breaches mid-shift). A later end
        // edit is written by the window effect below; this effect does not
        // re-run for one, because it depends on the geofence's identity.
        await syncShiftEndMirror();
        if (cancelled) return;
        await startBackgroundLocation(activeShift.geofence);
      } catch (err) {
        console.warn('[bg-loc] start failed:', err);
        Sentry.captureException(err, { tags: { flow: 'geofence_register' } });
      }
    })();

    return () => { cancelled = true; };
  }, [activeSession?.id, activeShift?.geofence]);

  // U3 (N146) — the shift's WINDOW changed under an open session: an admin
  // moved its end (D20) and refreshFromServer rewrote scheduled_start/end in
  // place. The geofence effect above does not re-run for that (it depends on
  // the geofence's identity, which the rewrite keeps on purpose), so this
  // effect owns the follow-up:
  //
  //   1. Rewrite 'active_shift_end', so the background task's expiry gate
  //      judges the NEW end from its next event.
  //   2. Re-register the region, but ONLY when the OLD end had already run
  //      out (and the new one has not) by the time the change arrived. In
  //      that gap the gate dropped every event without recording it in
  //      geofence_state, so the record can be wrong — it says inside while
  //      the guard left during the gap. Re-registering makes the OS report
  //      the current inside/outside state (a synthetic Enter or Exit), which
  //      corrects the record and alerts on a real exit. Otherwise the region
  //      is left alone: nothing was dropped, and a restart would only cost a
  //      synthetic event.
  //
  // The first render of a session belongs to the geofence effect: it writes
  // the session id and then the end, and that order is what keeps the two
  // keys describing the same shift.
  const lastWindowRef = useRef<{ sessionId: string; start: string; end: string; rearm: boolean } | null>(null);
  useEffect(() => {
    if (!activeSession || !activeShift) {
      lastWindowRef.current = null;
      return;
    }
    const sessionId = activeSession.id;
    const prev = lastWindowRef.current;
    const next = {
      sessionId,
      start: activeShift.scheduled_start,
      end:   activeShift.scheduled_end,
      rearm: false,
    };
    lastWindowRef.current = next;
    if (!prev || prev.sessionId !== sessionId) return;
    if (prev.start === next.start && prev.end === next.end) return;

    // prev.rearm carries a re-arm that a second, quicker edit cancelled (its
    // cleanup below) before it ran.
    next.rearm = shouldRearmAfterWindowChange(prev.rearm, prev.end, next.end, Date.now());
    Sentry.addBreadcrumb({
      category: 'geofence',
      message: 'shift window changed — syncing active_shift_end',
      level: 'info',
      data: { session_id: sessionId, old_end: prev.end, new_end: next.end, rearm: next.rearm },
    });

    let cancelled = false;
    (async () => {
      await syncShiftEndMirror();
      if (cancelled || !next.rearm) return;
      const st = useShiftStore.getState();
      if (st.activeSession?.id !== sessionId || !st.activeShift?.geofence) return;
      // The task needs the session id as much as the end; rewrite it too so
      // the re-armed region can never fire against a missing key.
      await SecureStore.setItemAsync('active_session_id', sessionId, {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
      });
      if (cancelled) return;
      await startBackgroundLocation(st.activeShift.geofence);
      next.rearm = false;
    })().catch((err) => {
      console.warn('[bg-loc] re-arm after end edit failed:', err);
      Sentry.captureException(err, { tags: { flow: 'geofence_rearm_end_edit' } });
    });

    return () => { cancelled = true; };
  }, [activeSession?.id, activeShift?.scheduled_start, activeShift?.scheduled_end]);

  if (!fontsLoaded || status === 'unknown') return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
