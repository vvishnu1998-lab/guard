import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Sentry from '@sentry/react-native';
import { registerPushToken } from '../lib/pushRegistration';
import type { NotifPermission } from '../lib/notificationsBanner';

/**
 * This phone's notification permission, re-read every time the app returns
 * to the foreground — the guard may have just changed it in Settings.
 *
 * When it turns ON, the push token is registered right then. The launch-time
 * registration in app/_layout.tsx runs once per cold start, so without this a
 * guard who fixed the setting would stay unreachable until the app happened
 * to be killed and reopened.
 *
 * The state also goes on every Sentry event as the `notif_perm` tag, which is
 * how the fleet's reachability can be counted without an API change.
 */
export function useNotificationPermission(): {
  permission: NotifPermission | null;
  resolve: (action: 'request' | 'settings') => Promise<void>;
} {
  const [permission, setPermission] = useState<NotifPermission | null>(null);
  const lastStatus = useRef<NotifPermission['status'] | null>(null);

  const read = useCallback(async () => {
    try {
      const p = await Notifications.getPermissionsAsync();
      const next: NotifPermission = {
        status: p.status === 'granted' ? 'granted' : p.status === 'denied' ? 'denied' : 'undetermined',
        canAskAgain: p.canAskAgain,
      };
      Sentry.setTag('notif_perm', next.status);
      if (lastStatus.current !== null && lastStatus.current !== 'granted' && next.status === 'granted') {
        void registerPushToken();
      }
      lastStatus.current = next.status;
      setPermission(next);
    } catch {
      // Unknown: render no banner rather than one we cannot back up.
    }
  }, []);

  useEffect(() => {
    void read();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void read();
    });
    return () => sub.remove();
  }, [read]);

  const resolve = useCallback(async (action: 'request' | 'settings') => {
    if (action === 'settings') {
      // The re-read happens on the way back, via the AppState listener.
      await Linking.openSettings().catch(() => {});
      return;
    }
    await Notifications.requestPermissionsAsync().catch(() => null);
    await read();
  }, [read]);

  return { permission, resolve };
}
