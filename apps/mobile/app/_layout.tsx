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
import { useShiftStore } from '../store/shiftStore';
import { apiClient } from '../lib/apiClient';
import { navigateForNotification } from '../lib/navigateForNotification';
import { startBackgroundLocation, stopBackgroundLocation } from '../tasks/locationBackground';
import { initSentry } from '../lib/sentry';

// Initialize at module load — before any component mounts — so early native
// crashes during startup are captured.
initSentry();

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
      } else if (inAuth || !segments.length) {
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
      }
    })();
  }, [status, mustChangePassword]);

  // Tap routing — open the right screen when the user taps a push notification.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp.notification.request.content.data as Record<string, any> | undefined;
      navigateForNotification(data?.type, data);
    });
    return () => sub.remove();
  }, []);

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
      setTimeout(() => refreshUnread(), 500);
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
        await SecureStore.setItemAsync('active_session_id', activeSession.id);
        if (cancelled) return;
        await startBackgroundLocation(activeShift.geofence);
      } catch (err) {
        console.warn('[bg-loc] start failed:', err);
      }
    })();

    return () => { cancelled = true; };
  }, [activeSession?.id, activeShift?.geofence]);

  if (!fontsLoaded || status === 'unknown') return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
