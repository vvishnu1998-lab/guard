/**
 * Root layout — handles session restoration and force-change-password routing.
 *
 * Guards stay logged in until they explicitly log out (no auto-lock).
 */
import { useEffect } from 'react';
import { Stack, router, useSegments } from 'expo-router';
import { useFonts, BarlowCondensed_500Medium, BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed';
import { useAuthStore } from '../store/authStore';

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

  if (!fontsLoaded || status === 'unknown') return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="(tabs)" />
    </Stack>
  );
}
