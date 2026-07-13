/**
 * Single source of truth for routing notification taps.
 * Used by:
 *   - addNotificationResponseReceivedListener (push tap from OS)
 *   - In-app tap inside the Notifications tab list
 *
 * Merged 2026-07-13: batch/mobile-3 handoff + swap + release-push
 * routes grafted into the Build 34 M3 rewrite for the 6 Phase 1A/A2
 * notification types. Every route emits a Sentry breadcrumb tagged
 * with the notification type so we can trace "guard tapped alert X →
 * landed on screen Y" in the crash-free session context.
 */
import { router } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import { useShiftStore } from '../store/shiftStore';

type NotificationData = Record<string, any> | undefined;

function breadcrumb(type: string, target: string, data?: NotificationData): void {
  Sentry.addBreadcrumb({
    category: 'notification',
    message: `deep-link tap ${type} → ${target}`,
    level: 'info',
    data: data ? { ...data } : undefined,
  });
}

/** Shared "route to shift detail, fall back to schedule" helper for the
 *  swap/handoff family — every one of them carries shift_id in the
 *  server push data payload (swapPush.ts). */
function shiftDetailOrSchedule(type: string, data: NotificationData): void {
  if (typeof data?.shift_id === 'string' && data.shift_id.length > 0) {
    const target = `/shifts/${data.shift_id}`;
    breadcrumb(type, target, data);
    router.push(target);
  } else {
    breadcrumb(type, '/(tabs)/schedule', data);
    router.push('/(tabs)/schedule');
  }
}

export function navigateForNotification(type: string | undefined, data: NotificationData): void {
  // Walk-test 2026-07-09 BUG H — tap-from-background handoff_complete
  // needs to clear the cached activeSession too. The foreground handler
  // in _layout.tsx already does this on receive; this covers the case
  // where the guard's device delivered the push in the background and
  // they tapped the notification.
  if (type === 'handoff_complete') {
    useShiftStore.getState().clearSession();
  }

  switch (type) {
    // ── Core reminders (M3 unchanged) ────────────────────────────────
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

    // ── Phase 1A / A2 additions (M3) ─────────────────────────────────
    case 'geofence_breach':
      // Takeover screen at /violation/[violationId] (T1-E, batch/mobile-3).
      // The server (fireBreachAlerts) puts violationId in the data payload.
      // Without the id we can't deep-link to the specific violation; fall
      // back to the notifications tab in that case.
      if (typeof data?.violationId === 'string' && data.violationId.length > 0) {
        const target = `/violation/${data.violationId}`;
        breadcrumb(type, target, data);
        router.push(target);
      } else {
        breadcrumb(type, '/(tabs)/notifications', data);
        router.push('/(tabs)/notifications');
      }
      break;

    case 'off_post_report':
      // No /report/[id] detail screen exists on mobile (only admin +
      // client portal have one). Land on the guard reports list so the
      // guard can see the row they just filed.
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

    // ── Schedule pushes (batch/mobile-3) ─────────────────────────────
    case 'pre_shift_reminder':
    case 'shift_start_reminder':
      // Home tab renders the upcoming-shift card with the CLOCK IN
      // button. Clock-in flow isn't deep-linkable — it reads
      // pendingShift from useShiftStore which home.tsx populates via
      // handleClockIn().
      breadcrumb(type, '/(tabs)/home', data);
      router.push('/(tabs)/home');
      break;

    case 'shifts_assigned':
    case 'shift_cancelled':
      breadcrumb(type, '/(tabs)/schedule', data);
      router.push('/(tabs)/schedule');
      break;

    // ── Swap family (batch/mobile-3) ─────────────────────────────────
    // Unified-feed model (Build 34 option B): the swap invite row now
    // lives in the notifications feed with a 🔄 icon; tap routes to
    // shift detail where the guard's accept/decline card renders.
    case 'swap_request_received':
    case 'swap_request_sent':
    case 'swap_accepted':
    case 'swap_declined':
    case 'swap_expired':
      shiftDetailOrSchedule(type, data);
      break;

    // ── Handoff family (batch/mobile-3 Phase 2b) ─────────────────────
    // Same unified-feed model as swap. HandoffRequestModal is invoked
    // by the guard INITIATING the handoff (from home.tsx or shift
    // detail) — the RECEIVER guard tap here lands on shift detail
    // which renders the pending-invite state with accept/decline.
    case 'handoff_request_received':
    case 'handoff_request_sent':
    case 'handoff_accepted':
    case 'handoff_declined':
    case 'handoff_cancelled':
    case 'handoff_nudge':
    case 'handoff_expired':
      shiftDetailOrSchedule(type, data);
      break;

    case 'handoff_complete':
      // Ownership just flipped. Schedule tab shows the transferred
      // shift under B (from A's view: gone from active). activeSession
      // was already cleared above.
      breadcrumb(type, '/(tabs)/schedule', data);
      router.push('/(tabs)/schedule');
      break;
  }
}
