/**
 * Local, network-free expiry check for the background geofence task.
 *
 * The problem it solves: autoCompleteShifts closes an open shift_session
 * server-side once scheduled_end + its grace has passed (AUTO_CLOSE_GRACE_MINUTES,
 * apps/api/src/constants/autoCloseGrace.ts), recording GREATEST(clocked_in_at,
 * scheduled_end) as the clock-out. While the app is backgrounded or killed it
 * has no channel to learn that, so the OS geofence region stays armed and an
 * Exit event fires a "You've left the permitted radius" alert for a shift that
 * already ended. On 2026-08-06 a guard got two of them, 3 and 29 minutes after
 * their 23:00 shift end.
 *
 * The task must be able to make this call with NO network and on an app the OS
 * has killed, which rules out asking the server. The only input available in
 * that state is a timestamp persisted at registration time.
 *
 * Kept in its own module rather than in tasks/locationBackground.ts because
 * that module calls TaskManager.defineTask at import time — importing it to
 * test this function would register a background task as a side effect.
 */

/**
 * How long past scheduled_end the region keeps reporting breaches.
 *
 * A hand-kept copy of the server's auto clock-out grace, AUTO_CLOSE_GRACE_MINUTES
 * = 15 (apps/api/src/constants/autoCloseGrace.ts; 30 before 761d7f5, U4b).
 * Change both together — scripts/check-shift-expiry.ts fails when they differ.
 * Until the grace runs out the session is still open server-side and a breach
 * is genuine. From the first sweep tick at or after it (the sweep runs every 5
 * minutes, so up to ~5 minutes later for an end that is not on a 5-minute
 * mark) the session is closed and /violation answers 409 SESSION_CLOSED.
 *
 * A guard legitimately working past scheduled_end is real and common — a late
 * relief, an incident that runs long, a handover that drags. The failure mode
 * of too SHORT a grace is suppressing a GENUINE breach on an overrun shift,
 * which is strictly worse than the false alert this whole mechanism exists to
 * prevent, so this never goes below the server's grace. The one band it does
 * suppress while the session is still open is that 0-5 minute wait for the
 * sweep tick: an exit there is not posted, so its admin alert is lost.
 *
 * Be honest about what this does and does not buy. Of the 2026-08-06 exits
 * (+3 and +29 minutes), 15 minutes suppresses the +29 one and not the +3 one,
 * and under today's server grace the +3 one is a breach on a still-open
 * session. This check bounds how long a forgotten armed region can keep
 * alerting. The 409 teardown in tasks/locationBackground.ts is the backstop.
 *
 * It judges the end persisted in SecureStore (active_shift_end). When an admin
 * moves an active shift's end (D20) the app rewrites that key as soon as it
 * re-reads the shift — on the edit's push, on foreground, on home focus
 * (store/shiftStore.ts refreshFromServer, then app/_layout.tsx's window
 * effect). A suspended or killed app that is never reopened runs none of
 * that, so until it is, this gate still judges the OLD end.
 *
 * Judged at event DELIVERY, not at the exit itself: Android can deliver an
 * Enter/Exit 30 s - 2 min late, so an exit in the last minute or two before
 * the grace runs out can arrive after it and be suppressed.
 */
export const SHIFT_EXPIRY_GRACE_MS = 15 * 60 * 1000;

/**
 * True only when we are CONFIDENT the shift is over.
 *
 * Fails open by design. A missing, empty, or unparseable timestamp returns
 * false — meaning "notify" — because a bad field must never be the reason a
 * real breach goes unreported. Every uncertain input lands on the side of
 * alerting the guard.
 *
 * @param shiftEndIso  ISO 8601 scheduled_end as persisted at registration,
 *                     or null when it was absent/rejected at write time.
 * @param nowMs        Current epoch ms. Injected so this is testable and so
 *                     the caller decides what "now" means.
 */
export function isPastShiftExpiry(
  shiftEndIso: string | null | undefined,
  nowMs: number,
): boolean {
  if (!shiftEndIso) return false;
  const endMs = Date.parse(shiftEndIso);
  if (!Number.isFinite(endMs)) return false;
  return nowMs > endMs + SHIFT_EXPIRY_GRACE_MS;
}

/**
 * Should this scheduled_end be trusted enough to persist?
 *
 * Guards against clock-in/step4.tsx's fallback shape, which sets both
 * scheduled_start and scheduled_end to clocked_in_at when pendingShift is
 * missing. Persisting that would put expiry at clock-in + grace and silence
 * genuine breaches 15 minutes into a shift. A real shift always ends after
 * it starts, so `end > start` rejects the fallback by construction.
 *
 * Callers must DELETE the stored key when this returns false — leaving a value
 * from a previous session behind is its own hazard.
 */
export function isUsableShiftEnd(
  scheduledStartIso: string | null | undefined,
  scheduledEndIso: string | null | undefined,
): boolean {
  if (!scheduledStartIso || !scheduledEndIso) return false;
  const start = Date.parse(scheduledStartIso);
  const end   = Date.parse(scheduledEndIso);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return end > start;
}
