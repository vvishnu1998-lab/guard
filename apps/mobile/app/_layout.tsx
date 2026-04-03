/**
 * Root layout — handles session restoration and auto-lock.
 * Redirects to login if unauthenticated, to change-password if first login.
 */
import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { Stack, router, useSegments } from 'expo-router';
import { useFonts, BarlowCondensed_500Medium, BarlowCondensed_700Bold } from '@expo-google-fonts/barlow-condensed';
import { useAuthStore, AuthStatus } from '../store/authStore';
import { isInactivityLockDue } from '../lib/apiClient';

export default function RootLayout() {
  const { status, mustChangePassword, isLocked, lockApp, loadSession } = useAuthStore();
  const segments = useSegments();
  const appState = useRef(AppState.currentState);

  const [fontsLoaded] = useFonts({ BarlowCondensed_500Medium, BarlowCondensed_700Bold });

  // Restore session on cold start
  useEffect(() => { loadSession(); }, []);

  // Auto-lock when app returns from background after 5 min inactivity (Section 7)
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (appState.current.match(/inactive|background/) && next === 'active') {
        if (isInactivityLockDue() && status === 'authenticated') {
          lockApp();
        }
      }
      appState.current = next;
    });
    return () => sub.remove();
  }, [status]);

  // Route guard — only runs once fonts are loaded and Stack is mounted
  useEffect(() => {
    if (!fontsLoaded || status === 'unknown') return;
    const inAuth = segments[0] === '(auth)';
    const onLock = segments[0] === 'lock';

    if (isLocked && !onLock) {
      router.replace('/lock');
      return;
    }

    if (status === 'unauthenticated' && !inAuth) {
      router.replace('/(auth)/login');
    } else if (status === 'authenticated' && !isLocked) {
      if (mustChangePassword) {
        router.replace('/(auth)/change-password');
      } else if (inAuth) {
        router.replace('/(tabs)/home');
      }
    }
  }, [fontsLoaded, status, mustChangePassword, isLocked, segments]);

  if (!fontsLoaded || status === 'unknown') return null;

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(auth)" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="clock-in" />
      <Stack.Screen name="reports" />
      <Stack.Screen name="break" />
      <Stack.Screen name="lock" />
    </Stack>
  );
}
