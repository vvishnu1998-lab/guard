/**
 * apps/mobile/lib/notifications.ts
 *
 * Android notification channel setup. Called at module load from _layout.tsx
 * so channels exist before any push arrives. Android 8+ suppresses
 * notifications that arrive without a matching channel — this is the
 * source-of-truth for what channels the app declares.
 *
 * Server-side FCM payloads do not currently set channelId — every incoming
 * push routes to 'default'. The other three channels ('reminders', 'alerts',
 * 'chat') are declared now so a future server change to set channelId per
 * type doesn't require an app update.
 *
 * iOS ignores channel setup (channels are Android-only) — early no-op.
 */
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

interface ChannelSpec {
  id:          string;
  name:        string;
  description: string;
  importance:  Notifications.AndroidImportance;
}

const CHANNELS: ChannelSpec[] = [
  {
    id:          'alerts',
    name:        'Alerts',
    description: 'Geofence violations, incident acknowledgments, and shift assignments.',
    importance:  Notifications.AndroidImportance.MAX,
  },
  {
    id:          'reminders',
    name:        'Reminders',
    description: 'Location pings, activity reports, task reminders, pre-shift, shift-start, and late clock-in.',
    importance:  Notifications.AndroidImportance.HIGH,
  },
  {
    id:          'chat',
    name:        'Chat',
    description: 'Messages from your admin or teammates.',
    importance:  Notifications.AndroidImportance.HIGH,
  },
  {
    id:          'default',
    name:        'General',
    description: 'General notifications.',
    importance:  Notifications.AndroidImportance.DEFAULT,
  },
];

export async function setupAndroidChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;
  for (const ch of CHANNELS) {
    await Notifications.setNotificationChannelAsync(ch.id, {
      name:                 ch.name,
      description:          ch.description,
      importance:           ch.importance,
      sound:                'default',
      enableVibrate:        true,
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
}
