/**
 * Root layout — handles:
 *   - Session restoration on cold start
 *   - Force-change-password routing
 *   - Push-notification foreground display + tap routing
 *   - Auto-refresh of the Expo push token whenever the guard is authenticated
 *     (covers the case where a returning user gets in via persisted refresh token
 *     and never goes through the login button handler).
 *
 * Guards stay logged in until they explicitly log out (no auto-lock).
 */
import { useEffect } from 'react';
import { Stack, router, useSegments } from 'expo-router';
import { useFonts, BarlowCondensed_500Medium, BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed';
import * as Notifications from 'expo-notifications';
import { useAuthStore } from '../store/authStore';
import { apiClient } from '../lib/apiClient';

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

  // Auto-register / refresh the Expo push token whenever the guard is authenticated.
  // This is the durable path; the login button handler also captures it as a fast path,
  // but this effect covers auto-login via refresh token (no login handler fires).
  useEffect(() => {
    if (status !== 'authenticated' || mustChangePassword) return;
    (async () => {
      try {
        const { status: permStatus } = await Notifications.requestPermissionsAsync();
        if (permStatus !== 'granted') return;
        const t = await Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID });
        await apiClient.post('/auth/guard/fcm-token', { fcm_token: t.data });
      } catch (err) {
        console.warn('[push] Failed to register push token:', err);
      }
    })();
  }, [status, mustChangePassword]);

  // Tap routing — open the right screen when the user taps a push notification.
  // Payloads come from the API: pingReminder.ts (ping_reminder /
  // activity_report_reminder / task_reminder), chat.ts (chat with roomId),
  // and the mobile background geofence task (geofence_breach).
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((resp) => {
      const data = resp.notification.request.content.data as Record<string, any> | undefined;
      if (!data?.type) return;
      switch (data.type) {
        case 'ping_reminder':
          router.push('/ping');                // always photo+GPS capture flow
          break;
        case 'activity_report_reminder':
          router.push('/(tabs)/reports');      // list tab, not the new-report form
          break;
        case 'task_reminder':
          router.push('/(tabs)/tasks');
          break;
        case 'chat':
          if (typeof data.roomId === 'string') router.push(`/chat/${data.roomId}`);
          break;
        case 'geofence_breach':
          router.push('/(tabs)/notifications');
          break;
      }
    });
    return () => sub.remove();
  }, []);

  if (!fontsLoaded || status === 'unknown') return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
