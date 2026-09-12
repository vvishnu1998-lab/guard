/**
 * Pure decision logic for OS tray reconciliation: given what the server still
 * considers outstanding, should a delivered notification be cleared?
 *
 * Extracted from lib/notificationSync.ts for the same reason
 * lib/notificationSections.ts was extracted from the notifications screen —
 * so it can be exercised without the React Native runtime. notificationSync
 * imports expo-notifications, Sentry and the auth'd api client and therefore
 * needs a device; everything here is sets and strings and is proven on a
 * laptop by scripts/check-tray-predicate.ts.
 *
 * That split is not cosmetic. `shouldDismiss` decides whether a guard stops
 * seeing something they were sent, and both failure directions are silent:
 * over-clearing loses a notice nobody logs, under-clearing is the original
 * sticky-tray bug. It is the part that most needs to be testable.
 */

/** A row as `GET /notifications` returns it. */
export interface LiveNotificationRow {
  id:         string;
  type:       string;
  data:       unknown;
  read_at:    string | null;
  created_at: string;
}

/**
 * Ping-family types, whose tray items are additionally window-scoped: two
 * ping_reminder banners can be outstanding at once for different windows, so
 * type-level matching alone would keep both alive until the guard answered
 * every window.
 */
export const PING_TYPES = new Set(['ping_reminder', 'missed_ping']);

/**
 * A ping/missed-ping notification's window, whichever casing the producer
 * used. The API is not consistent: jobs/pingReminder.ts writes snake_case
 * `window_label`, jobs/missedPingCron.ts writes camelCase `windowLabel`.
 * The server-side auto-erase COALESCEs both for the same reason.
 */
export function windowOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const v = d.window_label ?? d.windowLabel;
  return typeof v === 'string' && v ? v : null;
}

/**
 * Every `NotificationType` that is written to the `notifications` table.
 * Verbatim from apps/api/src/services/notifications.ts's union at 3148286.
 *
 * THIS IS A SAFETY GATE, NOT A CONVENIENCE. The API also pushes six types
 * that write NO row — `site_deactivated`, `task_assigned`, `shift_cancelled`,
 * `shift_schedule_edited`, `shift_reassigned_away`, and `shifts_assigned`
 * (whose push `data.type` does not even match the `shift_assigned` row it
 * accompanies). Those can never appear in the live list, so a bare
 * "type not live -> dismiss" rule would clear a shift-cancelled banner the
 * instant the guard next foregrounded the app, possibly before they read it.
 *
 * So the legacy path dismisses only types it can positively account for.
 * Anything unrecognised is left for the guard to swipe — today's behaviour,
 * and the safe direction.
 */
export const ROW_BACKED_TYPES = new Set([
  'activity_report_reminder',
  'break_ended',
  'break_return_overdue',
  'chat',
  'clock_out_reminder',
  'geofence_breach',
  'handoff_accepted',
  'handoff_cancelled',
  'handoff_complete',
  'handoff_declined',
  'handoff_expired',
  'handoff_nudge',
  'handoff_request_received',
  'handoff_request_sent',
  'late_clock_in',
  'missed_ping',
  'missed_report',
  'off_post_report',
  'off_post_task',
  'ping_reminder',
  'pre_shift_reminder',
  'shift_assigned',
  'shift_start_reminder',
  'swap_accepted',
  'swap_declined',
  'swap_expired',
  'swap_request_received',
  'swap_request_sent',
  'task_reminder',
]);

/** The parts of a presented notification the predicate needs. Kept minimal so
 *  the predicate can be exercised without the React Native runtime. */
export interface PresentedLike {
  identifier: string;
  data:       Record<string, unknown> | undefined;
}

/** The live set, indexed three ways so the predicate is all set lookups. */
export interface LiveIndex {
  ids:         Set<string>;
  types:       Set<string>;
  pingWindows: Set<string>;
}

/** Index the rows the guard should still see. Pass the output of
 *  `visibleNotifications()`, not the raw response. */
export function buildLiveIndex(rows: LiveNotificationRow[]): LiveIndex {
  const ids         = new Set<string>();
  const types       = new Set<string>();
  const pingWindows = new Set<string>();
  for (const r of rows) {
    if (r.id) ids.add(r.id);
    if (r.type) types.add(r.type);
    if (PING_TYPES.has(r.type)) {
      const w = windowOf(r.data);
      if (w) pingWindows.add(w);
    }
  }
  return { ids, types, pingWindows };
}

/**
 * Should this delivered tray item be cleared?
 *
 * Two regimes, because the payload contract is mid-migration:
 *
 *   1. `data.notificationId` present — the push names its own row, so the
 *      answer is exact: dismiss iff that row is no longer live. This is the
 *      path the API gains in Dispatch 1; at 3148286 NOTHING sends this field
 *      (`grep -rn notificationId apps/api/src` is empty), so it is inert
 *      until that deploys. Built now so the improvement needs no second OTA.
 *
 *   2. No `notificationId` — every push in the field today. Match by type,
 *      and by window for the ping family. Coarser: with two task_reminders
 *      outstanding, completing one leaves the type live and neither banner
 *      clears. That is a real limitation of the legacy payload and the reason
 *      regime 1 exists; it is strictly better than never clearing anything.
 *
 * `chat` is never dismissed here. A chat banner means an unread message, not
 * an action the guard owes, and it is excluded from shift scoping server-side
 * so it is always live anyway. dismissChatRoom() clears it on room open.
 */
export function shouldDismiss(item: PresentedLike, live: LiveIndex): boolean {
  const type = item.data?.type;
  if (typeof type !== 'string' || !type) return false;   // nothing to reason from
  if (type === 'chat') return false;                     // owned by dismissChatRoom

  const rawId = item.data?.notificationId;
  if (typeof rawId === 'string' && rawId) {
    return !live.ids.has(rawId);                         // regime 1 — exact
  }

  // Regime 2 — legacy payload.
  if (!ROW_BACKED_TYPES.has(type)) return false;         // push-only; see ROW_BACKED_TYPES

  if (PING_TYPES.has(type)) {
    const w = windowOf(item.data);
    if (w) return !live.pingWindows.has(w);
    // No window on the payload — fall through to the type test rather than
    // guess. Under-clearing is the safe direction.
  }

  return !live.types.has(type);
}
