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
    case 'task_reminder': {
      // Build 38: task_reminder is now cron-emitted (jobs/taskDueCron.ts)
      // with data.task_instance_id in the payload. Deep-link to the
      // completion form when the id is present; older payloads that
      // predate the cron fall through to the tab list.
      const taskInstanceId =
        typeof data?.task_instance_id === 'string' ? data.task_instance_id : null;
      const target = taskInstanceId ? `/tasks/complete/${taskInstanceId}` : '/(tabs)/tasks';
      breadcrumb(type, target, data);
      router.push(target);
      break;
    }
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

    // ── Schedule-admin family ────────────────────────────────────────
    // Everything an admin did TO the guard's schedule lands on the schedule
    // tab. None of these is an action the guard performs, so there is no
    // deeper screen to open — the schedule is where the change is visible.
    //
    // 'shifts_assigned' (plural) is the LEGACY spelling and is kept
    // deliberately. services/shiftPush.ts sent it until apps/api b9579bc,
    // which corrected the sender to the singular 'shift_assigned' that
    // matches the row it writes. Between that deploy and this build the
    // singular matched NO case at all, so a batch shift-assignment tap did
    // nothing — it had routed to the schedule tab before. Banners delivered
    // before b9579bc still carry the plural, so both spellings must route.
    case 'shifts_assigned':
    case 'shift_assigned':
    case 'shift_cancelled':
    case 'shift_reassigned_away':
    case 'shift_schedule_edited':
    case 'site_deactivated':
      breadcrumb(type, '/(tabs)/schedule', data);
      router.push('/(tabs)/schedule');
      break;

    // ── Clock-out reminder ───────────────────────────────────────────
    // The clock-out screen posts against activeSession and has no mount
    // gate of its own, so routing there without a session would strand the
    // guard on a screen whose only working control is Back. Home is the
    // honest fallback: it owns the restore path and will show either the
    // on-shift card or the upcoming-shift card, whichever is true.
    case 'clock_out_reminder': {
      const onShift = !!useShiftStore.getState().activeSession;
      const target = onShift ? '/clock-out' : '/(tabs)/home';
      breadcrumb(type, target, data);
      router.push(target);
      break;
    }

    // ── Break family ─────────────────────────────────────────────────
    // /break renders the running break's countdown off currentBreak. With
    // no open break there is nothing for it to count, so the active-shift
    // screen is the target — that is where the guard starts or ends one.
    // With no session either, neither screen has anything to show.
    case 'break_ended':
    case 'break_return_overdue': {
      const st = useShiftStore.getState();
      const target = st.currentBreak ? '/break'
                   : st.activeSession ? '/active-shift'
                   : '/(tabs)/home';
      breadcrumb(type, target, data);
      router.push(target);
      break;
    }

    // ── Task assignment ──────────────────────────────────────────────
    // Site-wide: routes/tasks.ts fires this when a TEMPLATE is created, so
    // there is no task_instance_id to deep-link to (see N88). The tasks tab
    // is the most specific screen that exists for it.
    case 'task_assigned':
      breadcrumb(type, '/(tabs)/tasks', data);
      router.push('/(tabs)/tasks');
      break;

    // ── Swap family (batch/mobile-3) ─────────────────────────────────
    // An INVITE goes to the notifications tab, which renders the
    // accept/decline card. Everything else in the family is an OUTCOME
    // addressed to the requester, whose own shift detail is the right
    // landing spot.
    //
    // The invite used to route here too, under a comment claiming shift
    // detail rendered the accept card. It never did: merge bd7e4e2
    // (2026-07-13) kept M3's deletion of the alerts tab — which owned the
    // real accept/decline UI — while grafting this routing on top of it.
    // GET /shifts/:id 404s for a recipient still in 'pending' (its
    // tenancy exemption requires status='accepted'), and 'accepted' was
    // only reachable through the deleted button. Dead loop, 43 days.
    case 'swap_request_received':
      breadcrumb(type, '/(tabs)/notifications', data);
      router.push('/(tabs)/notifications');
      break;
    case 'swap_request_sent':
    case 'swap_accepted':
    case 'swap_declined':
    case 'swap_expired':
      shiftDetailOrSchedule(type, data);
      break;

    // ── Handoff family (batch/mobile-3 Phase 2b) ─────────────────────
    // Same split as swap, and the same bd7e4e2 history. HandoffRequestModal
    // is invoked by the guard INITIATING the handoff (from home.tsx or
    // shift detail); the RECEIVER lands on the notifications tab, where
    // accepting is one tap and the card then becomes the clock-in entry.
    case 'handoff_request_received':
      breadcrumb(type, '/(tabs)/notifications', data);
      router.push('/(tabs)/notifications');
      break;
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

    // ── Unrouted ─────────────────────────────────────────────────────
    // NAVIGATES NOWHERE, ON PURPOSE. A type this switch does not know is a
    // type whose correct destination is unknown, and guessing one is worse
    // than staying put: pushing the guard to a tab they did not ask for
    // loses whatever they were doing.
    //
    // Until this build the switch had no default at all, so an unknown type
    // fell straight out and left no trace. Eight real NotificationTypes were
    // in exactly that state and nobody could tell from the app that a tap
    // had done nothing — it looks identical to a missed tap. The breadcrumb
    // is the whole point of this arm: it makes the gap observable.
    //
    // A NEW TYPE MUST GET A CASE. scripts/check-notification-routes.ts fails
    // the build when a NotificationType reaches here.
    default:
      Sentry.addBreadcrumb({
        category: 'notification',
        message: `unrouted notification type: ${type ?? '(none)'}`,
        level: 'warning',
        data: data ? { ...data } : undefined,
      });
      break;
  }
}
