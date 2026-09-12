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

/**
 * The ping cadence, and the anchor unit for every window in the system.
 *
 * ── THIS ANCHOR RULE IS ALSO WRITTEN IN SQL ─────────────────────────────
 *
 * services/shiftHours.ts's VIOLATION_HOURS_ROW_SQL enumerates the same grid
 * (scheduled_start + n * PING_WINDOW_MS) as a generate_series, because a SQL
 * fragment cannot call a TypeScript function. Interpolating this constant
 * shares the NUMBER but not the EXPRESSION, so the two can still drift on the
 * anchor, the FLOOR direction, or the half-open boundary convention.
 *
 * scripts/check-window-anchor.ts executes both and asserts identical boundary
 * lists. If you change the grid here, change it there — the check will fail
 * the build if you forget. Do not rely on this comment alone; a
 * keep-in-sync comment is precisely what failed for the break constants.
 *
 * ── THE INTERVAL COMES FROM THE SESSION, NEVER FROM sites ───────────────
 *
 * This block used to record a trap: sites.ping_interval_minutes existed, was
 * editable, was sent to mobile, and NOTHING on the server read it. That is no
 * longer true — the three window functions below take an optional intervalMs,
 * and every caller passes COALESCE(shift_sessions.ping_interval_minutes, 30).
 *
 * READ IT FROM THE SESSION SNAPSHOT (schema_v68), NOT FROM sites. The two are
 * not interchangeable and the difference is not cosmetic. missedPingCron,
 * pingReminder, services/email.ts and shiftHours.ts's VIOLATION_HOURS_ROW_SQL
 * all re-derive windows LONG after a session closes — the daily client report
 * runs over an hour past scheduled_end, and violation_hours is recomputed on
 * every read of the hours export. A live join to sites would let an admin
 * editing a site at 21:00 retroactively change how many windows a guard was
 * accountable for at 14:00, and change a number already emailed to a paying
 * client. The snapshot is written once at clock-in (routes/shifts.ts) and is
 * immutable thereafter; sites.ping_interval_minutes is only ever its SOURCE.
 *
 * NULL means "session predates schema_v68", which is a different statement
 * from "runs on 30" — hence COALESCE at the call site rather than a default
 * baked in here or a backfill asserting a cadence nobody measured.
 *
 * The parameter is OPTIONAL and defaults to PING_WINDOW_MS so that
 * services/shiftHours.ts — which imports the constant to interpolate into
 * SQL and is frozen until Phase E — keeps compiling untouched.
 */
export const PING_WINDOW_MS = 30 * 60 * 1000;

/**
 * Runaway guard for the grid loops, expressed as a SPAN OF TIME rather than
 * a window count.
 *
 * Both loops used to stop at a literal `n < 250`, which silently meant "125
 * hours" only because the interval happened to be 30 minutes. At interval 15
 * the same literal caps the grid at 62 h — short enough that a long shift
 * would be TRUNCATED rather than rejected, producing a short window list with
 * no error. Bounding the span keeps the guard's meaning constant as the
 * interval varies, and yields exactly 250 iterations at 30 minutes, which is
 * what makes this change a no-op on every session in production.
 */
const MAX_GRID_SPAN_MS = 250 * PING_WINDOW_MS;   // 125 hours

/** Iteration cap for a given cadence. 250 at 30 min; 500 at 15; 83 at 90. */
function maxWindowsFor(intervalMs: number): number {
  return Math.floor(MAX_GRID_SPAN_MS / intervalMs);
}

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
  intervalMs:     number = PING_WINDOW_MS,
): Map<string, number> {
  const ssMs = scheduledStart.getTime();
  const seMs = scheduledEnd.getTime();
  const out = new Map<string, number>();
  // Same span-bounded safety guard as completedTrackableWindows: a bad
  // scheduled_start must not spin forever.
  const maxN = maxWindowsFor(intervalMs);
  for (let n = 0; n < maxN; n += 1) {
    const wsMs = ssMs + n * intervalMs;
    if (wsMs + intervalMs > seMs) break;       // R3 — end must fit in shift
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
  intervalMs:     number = PING_WINDOW_MS,
): Array<{ windowStart: Date; windowEnd: Date }> {
  const ssMs = scheduledStart.getTime();
  const seMs = scheduledEnd.getTime();
  const ciMs = clockedInAt.getTime();
  const nowMs = now.getTime();

  const out: Array<{ windowStart: Date; windowEnd: Date }> = [];
  // We only inspect windows whose window_end has already passed.
  // Cap the loop with a span-bounded safety guard so a bad row (say, a
  // scheduled_start way in the past) can't spin forever.
  const maxN = maxWindowsFor(intervalMs);
  for (let n = 0; n < maxN; n += 1) {
    const wsMs = ssMs + n * intervalMs;
    const weMs = wsMs + intervalMs;
    if (weMs > seMs) break;             // R3 — end must fit within shift
    if (weMs > nowMs) break;            // window hasn't closed yet
    if (wsMs < ciMs) continue;          // R4/SD-D — skip pre-clock-in windows
    out.push({ windowStart: new Date(wsMs), windowEnd: new Date(weMs) });
  }
  return out;
}

/**
 * The window a REMINDER should prompt for: the most recent window that has
 * OPENED, that COUNTS against this guard (R3 + R4), and that opened no
 * longer than `maxAgeMs` ago.
 *
 * WHY THIS REPLACED windowJustClosed AS THE REMINDER'S SOURCE. The at-close
 * reminder and missedPingCron's flag fire in the same second, because both
 * trigger on the window ending. Observed 2026-09-12 on session bb3934c9: the
 * `ping_reminder` row landed at 19:00:00.262 and the `missed_ping` row at
 * 19:00:00.263 — one millisecond apart. The guard was told to submit a ping
 * for a window that had already closed and been marked against them, and the
 * ping they then sent at 19:00:52 could not land inside it. Prompting at OPEN
 * gives the full window to answer in.
 *
 * R3 and R4 are inherited unchanged, and deliberately: a window that opened
 * before the guard clocked in is one they will never be flagged for, so
 * prompting for it is the same defect in the other direction. Do not prompt
 * for what you will not flag.
 *
 * `maxAgeMs` means something DIFFERENT here than it does on the closed side.
 * There it bounded how stale a close could be and still deserve a push — a
 * dropped-tick recovery after the fact. Here it bounds how far INTO an open
 * window a first prompt may still be sent, so a dropped tick is recovered
 * while the window is still answerable. At a 30-minute cadence that is the
 * first 10 minutes of the window; past it the prompt is abandoned and
 * missedPingCron remains the only record, exactly as before.
 *
 * Note the asymmetry with completedTrackableWindows, which this deliberately
 * does NOT reuse: that function enumerates windows whose END has passed, and
 * every window this one returns is by definition still open. Sharing it would
 * mean inverting its central test, so the R3/R4 predicates are restated here
 * rather than parameterised — two callers with opposite closure requirements
 * are clearer apart than behind a flag.
 */
export function windowJustOpened(
  scheduledStart: Date,
  scheduledEnd:   Date,
  clockedInAt:    Date,
  now:            Date,
  maxAgeMs:       number,
  intervalMs:     number = PING_WINDOW_MS,
): { windowStart: Date; windowEnd: Date } | null {
  const ssMs  = scheduledStart.getTime();
  const seMs  = scheduledEnd.getTime();
  const ciMs  = clockedInAt.getTime();
  const nowMs = now.getTime();

  let latest: { windowStart: Date; windowEnd: Date } | null = null;
  const maxN = maxWindowsFor(intervalMs);
  for (let n = 0; n < maxN; n += 1) {
    const wsMs = ssMs + n * intervalMs;
    const weMs = wsMs + intervalMs;
    if (weMs > seMs) break;        // R3 — end must fit within shift
    if (wsMs > nowMs) break;       // window has not opened yet
    if (wsMs < ciMs) continue;     // R4/SD-D — skip pre-clock-in windows
    latest = { windowStart: new Date(wsMs), windowEnd: new Date(weMs) };
  }

  if (!latest) return null;
  // Opened too long ago to still be worth a first prompt. missedPingCron
  // will flag it at close regardless; this only decides whether we nag.
  if (nowMs - latest.windowStart.getTime() > maxAgeMs) return null;
  return latest;
}

/**
 * The window a REMINDER should nag for: the most recent window that has
 * CLOSED, that COUNTS against this guard (R3 + R4), and that closed no
 * longer than `maxAgeMs` ago.
 *
 * @deprecated No longer drives any reminder. jobs/pingReminder.ts moved to
 * windowJustOpened above on 2026-09-12, because prompting at close put the
 * push and missedPingCron's flag in the same second (session bb3934c9:
 * ping_reminder 19:00:00.262, missed_ping 19:00:00.263) and left the guard no
 * time inside the window to answer. Kept exported, unused, and untouched so
 * the at-close behaviour remains readable next to its replacement and the
 * switch can be reversed without archaeology. Delete once at-open has a full
 * shift cycle in production.
 *
 * This exists because jobs/pingReminder.ts used to answer the question
 * itself, with a private `currentBoundary()` that computed
 * `scheduled_start + N*30min` and a private copy of siteLocalLabel. That
 * second implementation was wrong in two ways that only a shared
 * definition prevents:
 *
 *   1. It named the BOUNDARY, not the window that closed. At boundary
 *      18:40 on an 18:10 shift it said "submit your 11:40 ping" when the
 *      window that had just closed was 11:10.
 *   2. It had no R3 check, so it fired for windows that CANNOT EXIST.
 *      Any shift whose length is a multiple of 30 min puts its final
 *      boundary exactly on scheduled_end, and a window opening there
 *      always overruns the shift. 46 of 670 production reminders (6.9%,
 *      11 guards, 14 of them STARNET's) named a window scheduleWindows
 *      would reject — the guard tapped the push, captured and uploaded a
 *      photo, and only then got 422 PING_WINDOW_INVALID.
 *
 * Returning the CLOSED window rather than a boundary makes both faults
 * unrepresentable: there is no boundary to mislabel, and R3/R4 come from
 * completedTrackableWindows, which missedPingCron already uses. The
 * reminder and the flag now answer to one definition, which is the whole
 * reason this module exists.
 *
 * R4 is deliberately inherited: a window that opened before the guard
 * clocked in is one they will never be flagged for, so nagging for it is
 * the same class of defect. Do not nag for what you will not flag.
 *
 * `maxAgeMs` is how stale a close may be and still deserve a push. A
 * value of one minute reproduces the old ±60s firing instant; a larger
 * one lets a dropped cron tick still be recovered.
 */
export function windowJustClosed(
  scheduledStart: Date,
  scheduledEnd:   Date,
  clockedInAt:    Date,
  now:            Date,
  maxAgeMs:       number,
  intervalMs:     number = PING_WINDOW_MS,
): { windowStart: Date; windowEnd: Date } | null {
  const closed = completedTrackableWindows(scheduledStart, scheduledEnd, clockedInAt, now, intervalMs);
  const latest = closed[closed.length - 1];
  if (!latest) return null;
  if (now.getTime() - latest.windowEnd.getTime() > maxAgeMs) return null;
  return latest;
}
