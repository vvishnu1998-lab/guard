/**
 * Single source of truth for routing notification taps.
 * Used by both:
 *   - addNotificationResponseReceivedListener (push tap from OS)
 *   - In-app tap inside the Notifications tab list
 */
import { router } from 'expo-router';

type NotificationData = Record<string, any> | undefined;

export function navigateForNotification(type: string | undefined, data: NotificationData): void {
  switch (type) {
    case 'ping_reminder':
      router.push('/ping');                  // always photo+GPS capture
      break;
    case 'activity_report_reminder':
      router.push('/(tabs)/reports');        // list tab, not the new-report form
      break;
    case 'task_reminder':
      router.push('/(tabs)/tasks');
      break;
    case 'chat':
      if (typeof data?.roomId === 'string') router.push(`/chat/${data.roomId}`);
      break;
    case 'geofence_breach':
      // stay on the notifications tab; tapping just dismisses
      break;
  }
}
