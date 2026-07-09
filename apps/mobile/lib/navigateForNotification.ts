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
    case 'pre_shift_reminder':
    case 'shift_start_reminder':
      // Home tab renders the upcoming-shift card with the CLOCK IN button.
      // Clock-in flow itself is not deep-linkable — it reads pendingShift
      // from useShiftStore which home.tsx's handleClockIn() populates.
      router.push('/(tabs)/home');
      break;
    case 'chat':
      if (typeof data?.roomId === 'string') router.push(`/chat/${data.roomId}`);
      break;
    case 'geofence_breach':
      // Takeover screen at /violation/[violationId] (T1-E). The server
      // (routes/locations.ts fireBreachAlerts) puts violationId in the
      // push data payload. Without the id we can't deep-link to the
      // specific violation, so fall through to dismiss in that case.
      if (typeof data?.violationId === 'string' && data.violationId.length > 0) {
        router.push(`/violation/${data.violationId}`);
      }
      break;
    case 'shifts_assigned':
      // Aggregated push emitted by the API when POST /shifts creates one
      // or more shifts for this guard. Data payload carries shift_ids,
      // count, first_date, last_date — mobile just routes to the schedule
      // tab which will refetch and show the new rows.
      router.push('/(tabs)/schedule');
      break;
    case 'shift_cancelled':
      // Emitted by PATCH /api/shifts/:id/cancel. Data payload carries
      // shift_id — mobile just routes to the schedule tab which will
      // refetch and show the row with its new CANCELLED status.
      router.push('/(tabs)/schedule');
      break;
  }
}
