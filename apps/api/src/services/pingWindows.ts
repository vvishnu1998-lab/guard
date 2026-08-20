/**
 * Ping window arithmetic — the single definition of which 30-minute windows
 * a shift session is accountable for.
 *
 * Extracted verbatim from jobs/missedPingCron.ts (2026-08-17) so the daily
 * client report can state "N of M pings" using the SAME rule that decides
 * whether a missed_pings row gets written. Two implementations of this would
 * be two different numbers the moment either drifted, and the number is
 * going in front of a paying customer.
 *
 * The cron now imports from here; its local copy is gone. Behaviour is
 * unchanged — the function body below is the original, moved.
 *
 * Window rules (SD-D + R3 + R4):
 *   * Windows are 30 min slots starting at scheduled_start.
 *   * A window [ws, we] is TRACKED only if we <= scheduled_end
 *     (R3 — no partial window at the end of the shift).
 *   * Windows whose ws < clocked_in_at are SKIPPED (R4 — the guard
 *     was never late for a window that started before their clock-in).
 *     Windows whose ws >= clocked_in_at count with NO first-ping grace.
 *
 * Note there is deliberately no 5-minute post-clock-in grace here. That
 * grace lives in jobs/pingReminder.ts and governs whether a PUSH goes out,
 * not whether a window counts against the guard.
 */

import { pool } from '../db/pool';

export const PING_WINDOW_MS = 30 * 60 * 1000;

/**
 * Break-time quiet policy (locked 2026-08-20): a ping window is WAIVED when
 * a break overlaps any part of [windowStart, windowEnd) — no reminder push,
 * no missed_pings flag; duty resumes with the next full window.
 *
 * Overlap predicate: break_start < windowEnd AND
 * COALESCE(break_end, NOW()) > windowStart — covers closed breaks and a
 * still-open one (which extends to NOW). The SINGLE definition shared by
 * jobs/pingReminder.ts (skip the reminder) and jobs/missedPingCron.ts
 * (skip the flag); two copies of this predicate would be two policies the
 * moment either drifted.
 */
export async function breakOverlapsWindow(
  shiftSessionId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const { rows } = await pool.query<{ overlaps: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM break_sessions
       WHERE shift_session_id = $1
         AND break_start < $3
         AND COALESCE(break_end, NOW()) > $2
     ) AS overlaps`,
    [shiftSessionId, windowStart, windowEnd],
  );
  return rows[0]?.overlaps === true;
}

/**
 * Enumerate the [window_start, window_end] pairs for a session that
 * have COMPLETED as of `now` and that pass the window fit + clock-in
 * rules (R3 + R4). Returns oldest → newest.
 */
export function completedTrackableWindows(
  scheduledStart: Date,
  scheduledEnd:   Date,
  clockedInAt:    Date,
  now:            Date,
): Array<{ windowStart: Date; windowEnd: Date }> {
  const ssMs = scheduledStart.getTime();
  const seMs = scheduledEnd.getTime();
  const ciMs = clockedInAt.getTime();
  const nowMs = now.getTime();

  const out: Array<{ windowStart: Date; windowEnd: Date }> = [];
  // We only inspect windows whose window_end has already passed.
  // Cap the loop with a safety bound so a bad row (say, a
  // scheduled_start way in the past) can't spin forever.
  for (let n = 0; n < 250; n += 1) {
    const wsMs = ssMs + n * PING_WINDOW_MS;
    const weMs = wsMs + PING_WINDOW_MS;
    if (weMs > seMs) break;             // R3 — end must fit within shift
    if (weMs > nowMs) break;            // window hasn't closed yet
    if (wsMs < ciMs) continue;          // R4/SD-D — skip pre-clock-in windows
    out.push({ windowStart: new Date(wsMs), windowEnd: new Date(weMs) });
  }
  return out;
}
