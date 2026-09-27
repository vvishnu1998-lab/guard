/**
 * The auto clock-out grace, in one place (U4b).
 *
 * jobs/autoCompleteShifts.ts closes a session nobody clocked out of once
 * scheduled_end + this many minutes has passed, and records the D18 anchor
 * GREATEST(clocked_in_at, scheduled_end). The grace decides WHEN the sweep
 * runs, never what it writes. 15 minutes since U4b (2026-09-26); it was 30.
 *
 * Every reader imports it rather than restating the number:
 *   jobs/autoCompleteShifts.ts        its three predicates (open breaks,
 *                                     open sessions, the status flip), which
 *                                     must agree — the header there says why.
 *   jobs/clockOutReminder.ts          the upper edge of the reminder window,
 *                                     so the "closes automatically soon" push
 *                                     cannot land on the tick that closes it.
 *   scripts/backfill-stale-shifts.ts  what counts as stale.
 *
 * It lives here, not in the job module, because importing
 * jobs/autoCompleteShifts.ts registers that job's cron. This module imports
 * nothing and registers nothing.
 *
 * The mobile app keeps its own copy for its local expiry gate
 * (apps/mobile/lib/shiftExpiry.ts, SHIFT_EXPIRY_GRACE_MS), which moves with
 * the next mobile OTA, not with this file.
 *
 * Zone-free, like constants/preShiftWindow.ts: scheduled_end is timestamptz
 * and an INTERVAL is an absolute duration, so the predicate means the same at
 * every site and across a DST change.
 */

/** Minutes after scheduled_end at which an open session is auto-closed. */
export const AUTO_CLOSE_GRACE_MINUTES = 15;

/**
 * SQL fragment: `<scheduledEnd> + INTERVAL '15 minutes' <= NOW()`, i.e. the
 * grace has run out. Callers interpolate this instead of writing the interval.
 * The number is the compile-time constant above, never user input.
 *
 * `now` defaults to NOW(). Pass a bound parameter (e.g. `$1::timestamptz`) to
 * judge "due" at a fixed instant — backfill-stale-shifts.ts does, so its
 * after-count is judged at an instant read just before the sweep it runs,
 * never at a later one than the sweep's own NOW().
 */
export function autoCloseDueSql(scheduledEnd: string, now = 'NOW()'): string {
  return `${scheduledEnd} + INTERVAL '${AUTO_CLOSE_GRACE_MINUTES} minutes' <= ${now}`;
}
