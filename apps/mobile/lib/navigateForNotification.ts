/**
 * Single source of truth for routing notification taps.
 * Used by:
 *   - addNotificationResponseReceivedListener (push tap from OS)
 *   - In-app tap inside the Notifications tab list
 *
 * Build 34 M3 — extended to cover all 6 notification types emitted by
 * the Phase 1A/A2 server (Commit A + A2). Each type routes to the
 * screen that lets the guard TAKE THE NEXT ACTION for the alert;
 * geofence_breach and off_post_* land on the relevant detail/list
 * screens; missed_ping / missed_report / late_clock_in deep-link
 * into the submission or clock-in flow with the window pre-filled.
 *
 * Every route emits a Sentry breadcrumb tagged with the notification
 * type so we can trace "guard tapped alert X → landed on screen Y"
 * in the crash-free session context.
 */
import { router } from 'expo-router';
import * as Sentry from '@sentry/react-native';

type NotificationData = Record<string, any> | undefined;

function breadcrumb(type: string, target: string, data?: NotificationData): void {
  Sentry.addBreadcrumb({
    category: 'notification',
    message: `deep-link tap ${type} → ${target}`,
    level: 'info',
    data: data ? { ...data } : undefined,
  });
}

export function navigateForNotification(type: string | undefined, data: NotificationData): void {
  switch (type) {
    case 'ping_reminder': {
      const window = typeof data?.window_label === 'string' ? data.window_label : undefined;
      const target = window ? `/ping?window_label=${encodeURIComponent(window)}` : '/ping';
      breadcrumb(type, target, data);
      router.push(target);
      break;
    }
    case 'activity_report_reminder':
      breadcrumb(type, '/(tabs)/reports', data);
      router.push('/(tabs)/reports');
      break;
    case 'task_reminder':
      breadcrumb(type, '/(tabs)/tasks', data);
      router.push('/(tabs)/tasks');
      break;
    case 'chat':
      if (typeof data?.roomId === 'string') {
        breadcrumb(type, `/chat/${data.roomId}`, data);
        router.push(`/chat/${data.roomId}`);
      }
      break;

    // ── Phase 1A / A2 additions ───────────────────────────────────────────
    case 'geofence_breach':
      // The existing /violation screen already polls GPS every 10s and
      // clears when the guard is back inside — it's the correct
      // "here's what's active right now" surface. No dynamic id
      // scaffold is needed on the mobile side (server-side
      // notifications.data.violationId is used by the tab feed's
      // auto-erase, not the deep-link target).
      breadcrumb(type, '/violation', data);
      router.push('/violation');
      break;

    case 'off_post_report':
      // No /report/[id] detail screen exists on mobile (only admin +
      // client portal have one). Land on the guard reports list so
      // they can see the row they just filed. Adding a detail screen
      // is tracked as a follow-up.
      breadcrumb(type, '/(tabs)/reports', data);
      router.push('/(tabs)/reports');
      break;

    case 'off_post_task':
      // The completed-task detail screen exists at /tasks/complete/[id].
      // Use taskInstanceId from the notification data payload.
      if (typeof data?.taskInstanceId === 'string') {
        const target = `/tasks/complete/${data.taskInstanceId}`;
        breadcrumb(type, target, data);
        router.push(target);
      } else {
        breadcrumb(type, '/(tabs)/tasks', data);
        router.push('/(tabs)/tasks');
      }
      break;

    case 'missed_ping': {
      const window = typeof data?.windowLabel === 'string' ? data.windowLabel : undefined;
      const target = window ? `/ping?window_label=${encodeURIComponent(window)}` : '/ping';
      breadcrumb(type, target, data);
      router.push(target);
      break;
    }

    case 'missed_report': {
      // Reuses the create-report form; window_label + report_type=activity
      // pre-fill it as a "here's the window you missed" backfill flow.
      // report_type defaults to activity because the missed_report cron
      // is looking for ANY report type (activity/incident/maintenance);
      // activity is the most common and safest default.
      const params = new URLSearchParams();
      if (typeof data?.windowLabel === 'string') params.set('window_label', data.windowLabel);
      params.set('type', 'activity');
      const target = `/reports/new?${params.toString()}`;
      breadcrumb(type, target, data);
      router.push(target);
      break;
    }

    case 'late_clock_in':
      breadcrumb(type, '/clock-in/step1', data);
      router.push('/clock-in/step1');
      break;
  }
}
