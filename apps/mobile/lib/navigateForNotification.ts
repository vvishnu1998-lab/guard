/**
 * Single source of truth for routing notification taps.
 * Used by both:
 *   - addNotificationResponseReceivedListener (push tap from OS)
 *   - In-app tap inside the Notifications tab list
 */
import { router } from 'expo-router';
import { useShiftStore } from '../store/shiftStore';

type NotificationData = Record<string, any> | undefined;

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
    case 'swap_request_received':
      // Guard B was invited to take over a shift. The alerts tab renders
      // an inline ACCEPT/DECLINE card, so route there rather than deep
      // linking into the shift (which they haven't accepted yet).
      router.push('/(tabs)/alerts');
      break;
    case 'swap_accepted':
    case 'swap_declined':
      // A's tap: outcome push for a swap A initiated. Land on the shift
      // detail (their shift, either now reassigned or still theirs).
      // Data payload from swapPush carries shift_id — fall back to
      // schedule if it's missing.
      if (typeof data?.shift_id === 'string' && data.shift_id.length > 0) {
        router.push(`/shifts/${data.shift_id}`);
      } else {
        router.push('/(tabs)/schedule');
      }
      break;
    case 'swap_expired':
      // Fired by the expiry cron when a pending request lapses. Bounce
      // to schedule; the shift is still theirs.
      router.push('/(tabs)/schedule');
      break;

    // ── Phase 2b: mid-shift handoff ─────────────────────────────────────
    // Distinct from swap_* variants so mobile can steer handoff recipients
    // into the travel-and-clock-in flow instead of a passive accept card.
    case 'handoff_request_received':
      // B: A wants me to take over an active shift. Alerts renders inline
      // accept/decline — decline is one-tap, accept opens a confirmation
      // dialog since accepting commits me to travel + clock-in.
      router.push('/(tabs)/alerts');
      break;
    case 'handoff_request_sent':
      // A: confirmation that the invite went out. Shift detail shows the
      // pending row in HISTORY. Fallback to schedule if id missing.
      if (typeof data?.shift_id === 'string' && data.shift_id.length > 0) {
        router.push(`/shifts/${data.shift_id}`);
      } else {
        router.push('/(tabs)/schedule');
      }
      break;
    case 'handoff_accepted':
    case 'handoff_declined':
    case 'handoff_cancelled':
      // A's tap: outcome. Shift is still theirs until B physically clocks
      // in (handoff_complete flips ownership). Land on the shift detail
      // so they can see updated HISTORY and — if accepted — track pending
      // arrival.
      if (typeof data?.shift_id === 'string' && data.shift_id.length > 0) {
        router.push(`/shifts/${data.shift_id}`);
      } else {
        router.push('/(tabs)/schedule');
      }
      break;
    case 'handoff_complete':
      // A's tap: B clocked in. A is now clocked out. Schedule tab shows
      // the transferred shift under B (from A's view: gone from active).
      router.push('/(tabs)/schedule');
      break;
    case 'handoff_nudge':
      // Fired by handoffNudge cron to both parties when the accepted-
      // but-not-arrived window drags past 30 min. Shift detail is where
      // both A and B can act (A can wait; B can either clock in or bail).
      if (typeof data?.shift_id === 'string' && data.shift_id.length > 0) {
        router.push(`/shifts/${data.shift_id}`);
      } else {
        router.push('/(tabs)/alerts');
      }
      break;
  }
}
