/**
 * Local, network-free expiry check for the background geofence task.
 *
 * The problem it solves: autoCompleteShifts closes a shift_session
 * server-side at scheduled_end. While the app is backgrounded or killed it has
 * no channel to learn that, so the OS geofence region stays armed and an Exit
 * event fires a "You've left the permitted radius" alert for a shift that
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
 * A guard legitimately working past scheduled_end is real and common — a late
 * relief, an incident that runs long, a handover that drags. The failure mode
 * of too SHORT a grace is suppressing a GENUINE breach on an overrun shift,
 * which is strictly worse than the false alert this whole mechanism exists to
 * prevent. 30 minutes covers a late clock-out without reopening the window
 * much further.
 *
 * Be honest about what this does and does not buy: the 2026-08-06 exits landed
 * at +3 and +29 minutes, so a 30-minute grace would NOT have suppressed either
 * of them. This check bounds how long a forgotten armed region can keep
 * alerting; it is not what fixes that specific incident. The 409 teardown is.
 */
export const SHIFT_EXPIRY_GRACE_MS = 30 * 60 * 1000;

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
 * genuine breaches half an hour into a shift. A real shift always ends after
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
