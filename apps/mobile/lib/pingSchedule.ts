/**
 * Wall-clock ping schedule — shared between home.tsx and active-shift/index.tsx
 * so they stay in lockstep with the server cron.
 *
 * Server fires reminders at wall-clock :00 and :30 (UTC, which matches local
 * because IST and common offsets are 30-min multiples). A guard clocked in
 * within the last 5 min of an aligned slot skips that slot — matches the
 * `clocked_in_at <= NOW() - 5 min` filter in apps/api/src/jobs/pingReminder.ts.
 */

const SAFETY_GUARD_MS = 5 * 60 * 1000;
const SLOT_MS = 30 * 60 * 1000;

export function nextPingAt(clockedInAt: Date, now: Date = new Date()): Date {
  const m = now.getMinutes();
  const minutesToNextSlot = m < 30 ? 30 - m : 60 - m;
  let next = new Date(now.getTime() + minutesToNextSlot * 60_000);
  next.setSeconds(0, 0);
  if (next.getTime() - clockedInAt.getTime() < SAFETY_GUARD_MS) {
    next = new Date(next.getTime() + SLOT_MS);
  }
  return next;
}

export function remainingMsUntilNextPing(clockedInAt: Date, now: Date = new Date()): number {
  return Math.max(0, nextPingAt(clockedInAt, now).getTime() - now.getTime());
}
