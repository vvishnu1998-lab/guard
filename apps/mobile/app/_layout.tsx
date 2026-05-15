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
import { useEffect } from 'react';
import { Stack, router, useSegments } from 'expo-router';
import { useFonts, BarlowCondensed_500Medium, BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed';
import * as Notifications from 'expo-notifications';
import { useAuthStore } from '../store/authStore';
import { useUnreadStore } from '../store/unreadStore';
import { apiClient } from '../lib/apiClient';
import { navigateForNotification } from '../lib/navigateForNotification';

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
        }
      } catch (err) {
        console.warn('[push] Failed to register push token:', err);
      }
      // Always pull the latest unread counts so the badge isn't stale on launch.
      refreshUnread();
    })();
  }, [status, mustChangePassword, refreshUnread]);

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
      if (data?.type === 'chat') {
        bumpChat(1);
      } else if (data?.type) {
        bumpNotifications(1);
      }
      // Re-sync from server shortly after — the new notification row should be visible.
      setTimeout(() => refreshUnread(), 500);
    });
    return () => sub.remove();
  }, [bumpChat, bumpNotifications, refreshUnread]);

  if (!fontsLoaded || status === 'unknown') return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
