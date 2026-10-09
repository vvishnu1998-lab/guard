import * as Notifications from 'expo-notifications';
import * as Sentry from '@sentry/react-native';
import { apiClient } from './apiClient';

/** EAS project the Expo push token is issued for. */
export const EAS_PROJECT_ID = '5fd28125-2461-4165-b9df-7f34ced8b194';

let inFlight: Promise<'registered' | 'skipped' | 'failed'> | null = null;

/**
 * Register this device's Expo push token with the API — the post that
 * creates the guard_devices row ping reminders are sent to. Asks for
 * notification permission first (iOS shows nothing once the guard has
 * decided).
 *
 * Moved verbatim from app/_layout.tsx, which still calls it on every
 * authenticated launch, so the notifications-off banner (N173) can register
 * the moment permission turns on instead of at the next cold start. A call
 * made while one is in flight joins it rather than posting twice. Never
 * throws.
 */
export function registerPushToken(): Promise<'registered' | 'skipped' | 'failed'> {
  if (!inFlight) inFlight = register().finally(() => { inFlight = null; });
  return inFlight;
}

async function register(): Promise<'registered' | 'skipped' | 'failed'> {
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
      return 'registered';
    }
    Sentry.addBreadcrumb({
      category: 'auth',
      message: 'fcm-token register skipped — permission not granted',
      level: 'info',
      data: { perm_status: permStatus },
    });
    return 'skipped';
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
    return 'failed';
  }
}
