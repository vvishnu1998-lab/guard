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
 * Site-local HH:MM label for an instant — the string the crons WRITE into
 * missed_pings.window_label and location_pings.window_label, and therefore
 * the string every window lookup joins on.
 *
 * Byte-identical to the private copies in jobs/pingReminder.ts:91,
 * jobs/missedPingCron.ts:56, jobs/missedReportCron.ts:63 and
 * routes/activityLog.ts:281 — same locale, same option bag, same
 * 'America/Los_Angeles' fallback. This is the canonical home; collapsing
 * those four onto it is a separate commit (it touches three crons, and
 * this one is already shipping a constraint).
 */
export function siteLocalLabel(when: Date, siteTz: string | null): string {
  const tz = siteTz ?? 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: tz,
  }).format(when);
}

/**
 * Every label a shift could legitimately carry, mapped to the epoch ms at
 * which that window OPENS: scheduled_start + N*30min for each window whose
 * END fits inside scheduled_end (R3).
 *
 * Deliberately NOT filtered by clocked_in_at (R4), by whether the window
 * has CLOSED, or by break waiver. Those are separate questions with their
 * own rules, and folding them in here would reject legitimate submissions:
 *   * R4 would reject a guard backfilling a window that opened moments
 *     before they clocked in;
 *   * a closed-window filter would reject every late backfill, which is
 *     exactly the flow missed_pings exists to support;
 *   * break waiver would reject a guard who pinged anyway during a break,
 *     which is harmless and worth recording.
 *
 * The window START is returned so callers CAN cheaply reject a label whose
 * window has not opened yet — see the note in routes/locations.ts. That
 * bound is what catches the real production defect; schedule geometry
 * alone does not. STARNET session 1ba93935 ran 19:00→06:00, so '01:30' is
 * a perfectly legal window of that shift — the fault was that the ping
 * carrying it was submitted at 21:49, three hours forty before that window
 * existed to be answered.
 *
 * DST caveat: on a fall-back day a shift can contain the same local label
 * twice (01:30 happens twice). First occurrence wins, which is the
 * permissive choice — the earlier open time makes the not-yet-open check
 * looser, and this validator must never reject a legitimate ping.
 */
export function scheduleWindows(
  scheduledStart: Date,
  scheduledEnd:   Date,
  siteTz:         string | null,
): Map<string, number> {
  const ssMs = scheduledStart.getTime();
  const seMs = scheduledEnd.getTime();
  const out = new Map<string, number>();
  // Same 250-window safety bound as completedTrackableWindows: a bad
  // scheduled_start must not spin forever.
  for (let n = 0; n < 250; n += 1) {
    const wsMs = ssMs + n * PING_WINDOW_MS;
    if (wsMs + PING_WINDOW_MS > seMs) break;   // R3 — end must fit in shift
    const label = siteLocalLabel(new Date(wsMs), siteTz);
    if (!out.has(label)) out.set(label, wsMs);  // first occurrence wins (DST)
  }
  return out;
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
