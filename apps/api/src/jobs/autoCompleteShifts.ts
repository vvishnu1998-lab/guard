/**
 * Auto-Complete Overdue Shifts — runs every 5 minutes
 *
 * ── THE GRACE WINDOW ─────────────────────────────────────────────────────
 *
 * The sweep fires at scheduled_end + 30 MINUTES, not at scheduled_end. The
 * clock-out redesign gives the guard a push 5 minutes before the end and a
 * window to close the shift themselves with a photo and coordinates; this
 * job is the fallback for when they do not. Sweeping at scheduled_end would
 * close the session out from under a guard who is walking to the gate.
 *
 * ── WHAT THE SWEEP RECORDS: THE ANCHOR, NOT THE SWEEP TIME ───────────────
 *
 * The grace decides WHEN the sweep runs. It does not decide what the sweep
 * writes. An auto-closed session is recorded as ending at
 *
 *     anchor = GREATEST(clocked_in_at, scheduled_end)
 *
 * (AUTO_CLOSE_ANCHOR_SQL below), never at NOW(). Until 2026-09-26 this job
 * stamped NOW(), so every auto-close carried 30-35 minutes nobody worked
 * (census that day: 206 sessions, all +30.00..+35.01 past scheduled_end,
 * 103.14 h across tenants). The guard never clocked out, so nothing after
 * the scheduled end is evidenced.
 * GREATEST covers a clock-in after scheduled_end (the clock-in route has
 * no end-side gate): that session is zero-length, 0 hours.
 *
 * One anchor, used by every step that closes something:
 *   - clocked_out_at and total_hours (step 2). total_hours needs the anchor
 *     spelled out too: SET reads the pre-update row, so it cannot refer to
 *     the new clocked_out_at, and a NOW() there would make the row disagree
 *     with itself.
 *   - open breaks (step 1) end at GREATEST(break_start, anchor). A break
 *     started during the grace is closed zero-length at its own start —
 *     break_end never precedes break_start, and nothing after the anchor
 *     counts.
 *   - open violations resolve against the new clocked_out_at (the step
 *     after step 2), so one born during the grace resolves at its own
 *     occurred_at with 0 minutes.
 *
 * Events the guard files during the grace (reports, pings, task
 * completions, scans) keep their real timestamps, which now fall after the
 * recorded clocked_out_at. Nothing here rewrites them.
 *
 * ALL THREE predicates below move together and MUST stay in lockstep. If the
 * shifts-status flip (step 3) fired at scheduled_end while the session close
 * (step 2) waited for +30min, the shift would already be 'completed' when
 * step 2 ran, its `status IN ('active','scheduled')` guard would not match,
 * and the session would be orphaned FOREVER — the exact state
 * jobs/orphanedSessionCheck.ts exists to detect.
 *
 * Checked against every consumer of the status flip before moving it:
 *   - lateClockInReminder is self-bounding on its three *_sent_at sentinels,
 *     not on the flip (its comment claims otherwise; the sentinels are what
 *     actually stop it).
 *   - missedShiftAlert is bounded by missed_alert_sent_at, fires once.
 *   - dailyShiftEmail requires scheduled_end < NOW() - 1 hour, well past +30.
 *   - missedPingCron / missedReportCron bound their windows by scheduled_end
 *     itself (services/pingWindows.ts:215, and missedReportCron's own grid —
 *     a window is tracked only if its END fits inside scheduled_end), so a
 *     longer-open session produces no extra missed-window flags. Every
 *     window has closed by scheduled_end and is judged on the ticks inside
 *     the grace, while the session is still open.
 *   - pingReminder's ping leg is bounded the same way (pingWindows.ts:275).
 *     Its activity-report leg (fires at UTC minute 0) and its task leg do
 *     NOT look at scheduled_end, so they keep reminding an open session
 *     through the grace. So does taskDueCron. The grace is not silent.
 *
 * ── WHY 'cancelled' IS DELIBERATELY NOT IN THE SWEEP SET ─────────────────
 *
 * A shift cancelled while a session is open would never be swept, and the
 * guard stays locked out by idx_shift_sessions_one_open_per_guard. Widening
 * the predicate to include 'cancelled' looks like the fix. It is not, for
 * two reasons that the code makes concrete:
 *
 *   1. IT WOULD INVENT BILLABLE HOURS. The total_hours expression below is
 *      anchor - GREATEST(clocked_in_at, scheduled_start). Run against
 *      a cancelled shift it produces paid hours for a shift the admin
 *      explicitly cancelled, and stamps clock_out_reason = 'auto', which is
 *      indistinguishable from an ordinary overrun. The payroll artifact would
 *      be both wrong and unlabelled. A cancelled-shift close is a different
 *      event from an overrun close and would need its own reason value and
 *      its own hours rule — this path is the pay path, and reusing it for a
 *      non-pay event is the wrong tool.
 *
 *   2. NO LIVE PATH CAN PRODUCE THE STATE, AND IT NEVER HAS. Exactly two
 *      writers set shifts.status = 'cancelled':
 *        - routes/shifts.ts PATCH /:id/cancel, which since 4eb5e09 refuses
 *          with 409 SHIFT_HAS_OPEN_SESSION when an open shift_sessions row
 *          exists. It tests the invariant directly, not a status proxy, so
 *          it holds however status got where it is.
 *        - routes/sites.ts site deactivation, gated
 *          `scheduled_start > NOW() AND status = 'scheduled'` — a shift with
 *          an open session has a PAST scheduled_start and status 'active',
 *          so it is doubly excluded.
 *      Every other `SET status` in the codebase targets shift_swap_requests
 *      or task_instances, not shifts. Production has 0 such rows.
 *
 * So the answer is detection, not auto-remediation:
 * jobs/orphanedSessionCheck.ts already scans hourly for exactly this state
 * (open session AND status NOT IN ('active','scheduled')) and pages via
 * Sentry. A human closing one such session — and DECIDING its hours — is
 * strictly better than a cron silently billing a cancelled shift. Should one
 * ever appear, that alert is the signal to build a deliberate close path,
 * not to widen this predicate.
 *
 * If a shift's scheduled_end + 30 minutes has passed and status is still
 * 'active' or 'scheduled':
 *   1. Close any open break_sessions inside the affected shift_sessions
 *      (set break_end = GREATEST(break_start, anchor), compute
 *      duration_minutes).
 *   2. Close any open shift_sessions (set clocked_out_at = anchor,
 *      compute total_hours = gross hours from the pay start to the anchor).
 *      Then resolve open geofence violations against the new clocked_out_at.
 *   3. Mark the shift 'completed' (or 'missed' when it has no session).
 *
 * Step 1 still runs and still computes duration_minutes even though step 2
 * no longer subtracts it: breaks became PAID on 2026-08-29, and break_hours
 * is still displayed on every admin surface. Recording is unchanged; only
 * the pay arithmetic changed.
 *
 * Sessions closed here are stamped clock_out_reason = 'auto'. Before this
 * they were left NULL, and NULL was the only thing distinguishing an
 * auto-close from a manual one (the manual path writes clock_out_lat/lng/
 * accuracy while this one does not). That discriminator was an accident of
 * omission; the reason column now says it outright, and neither path leaves
 * NULL behind.
 *
 * History — CB1 in audit/REPORT.md: until 2026-04-19 this job set
 * `clocked_out_at` but never `total_hours`, so the daily-report email and
 * the CSV export both showed "—" for any shift the guard didn't clock
 * out of manually. The fix mirrors the math the manual clock-out
 * endpoint uses (routes/shifts.ts POST /:id/clock-out, the payStartMs /
 * netHours lines): clock-out minus GREATEST(clock-in, scheduled_start).
 * The shape is still identical; only the clock-out differs — the manual
 * path has an observed clock-out, this path has the anchor.
 *
 * Exporting the worker function makes it testable from
 * apps/api/scripts/test-auto-complete-shifts.ts.
 */

import { runJob } from './_run';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { Sentry } from '../services/sentry';

/**
 * The recorded end of an auto-closed session — see the header. Aliases are
 * fixed: `ss` = shift_sessions, `s` = shifts, in both statements that use it.
 */
const AUTO_CLOSE_ANCHOR_SQL = 'GREATEST(ss.clocked_in_at, s.scheduled_end)';

export async function autoCompleteOverdueShifts(client: PoolClient): Promise<{
  shiftsClosed: number;
  sessionsClosed: number;
  breaksClosed: number;
  violationsResolved: number;
}> {
  await client.query('BEGIN');
  try {
    // Step 1: Close any open break_sessions belonging to shift_sessions
    //         that are about to be auto-closed, at the session's anchor.
    //         GREATEST(break_start, anchor): a break started before the
    //         anchor ends there; one started during the grace (the break
    //         allowance does not block post-end starts) ends zero-length at
    //         its own start, so break_end never precedes break_start.
    //         In practice breakExpiryCron closes a break at break_start +
    //         plan (every plan is 30 min, it runs every minute), so what
    //         reaches this step is almost always a grace-time break.
    const breaks = await client.query(
      `UPDATE break_sessions b
       SET break_end = GREATEST(b.break_start, due.anchor),
           duration_minutes = LEAST(
             GREATEST(
               0,
               ROUND(EXTRACT(EPOCH FROM (GREATEST(b.break_start, due.anchor) - b.break_start)) / 60.0)::INT
             ),
             b.planned_duration_minutes
           ),
           ended_by = 'auto_complete'
       FROM (
         SELECT ss.id, ${AUTO_CLOSE_ANCHOR_SQL} AS anchor
           FROM shift_sessions ss
           JOIN shifts s ON s.id = ss.shift_id
          WHERE ss.clocked_out_at IS NULL
            AND s.scheduled_end + INTERVAL '30 minutes' <= NOW()
            AND s.status IN ('active', 'scheduled')
       ) due
       WHERE b.shift_session_id = due.id
         AND b.break_end IS NULL
       RETURNING b.id`
    );

    // Step 2: Close any open shift_sessions at the anchor, computing
    //         total_hours as anchor − MAX(clock_in, scheduled_start)
    //         (option C: early arrivals not paid). A late stay is paid only
    //         when a guard clocks out manually — an auto-close has no
    //         evidence of work past scheduled_end, so it records none.
    //         Same shape as the manual clock-out math in routes/shifts.ts.
    //
    //         Breaks are PAID from 2026-08-29 — the break-minutes
    //         subtraction that used to follow the gross term is gone. Step 1
    //         above still closes open breaks and still computes their
    //         duration_minutes, because break_hours remains a display field
    //         on every admin surface; it simply no longer reduces pay.
    //         The pay-start anchor is deliberately left as
    //         MAX(clocked_in_at, scheduled_start) and is NOT aligned with
    //         services/shiftHours.ts's actual_hours, which uses raw
    //         clocked_in_at. That divergence is intentional and locked.
    const sessions = await client.query(
      `UPDATE shift_sessions ss
       SET clocked_out_at = ${AUTO_CLOSE_ANCHOR_SQL},
           clock_out_reason = 'auto',
           total_hours = GREATEST(
             0,
             EXTRACT(EPOCH FROM (${AUTO_CLOSE_ANCHOR_SQL} - GREATEST(ss.clocked_in_at, s.scheduled_start))) / 3600.0
           )
       FROM shifts s
       WHERE ss.shift_id = s.id
         AND ss.clocked_out_at IS NULL
         AND s.scheduled_end + INTERVAL '30 minutes' <= NOW()
         AND s.status IN ('active', 'scheduled')
       RETURNING ss.id`
    );
    const closedThisTick: string[] = sessions.rows.map((r: { id: string }) => r.id);

    // Walk-test 2026-07-09 BUG I: resolve lingering open geofence violations
    // on any session that has closed. Uses clocked_out_at as the resolution
    // timestamp for parity with the manual clock-out path. For a session
    // step 2 just closed, clocked_out_at is the anchor.
    //
    // ── WHY THERE IS NO RECENCY BOUND ────────────────────────────────────
    //
    // This predicate used to carry `AND ss.clocked_out_at > NOW() - INTERVAL
    // '10 minutes'`, which made the sweep structurally incapable of catching
    // the rows that need it most. A violation is written by the guard's
    // device, and the device does not learn that the server auto-closed the
    // session — its geofence region stays armed. On 2026-08-06 that produced
    // two boundary reports 3 and 28 minutes after clock-out. The 28-minute
    // one (0633b82b) was already OUTSIDE the ten-minute window on the tick it
    // was born, so no later tick could ever match it either. It stayed open
    // for 18 days and, read by an unbounded COALESCE(resolved_at, NOW()),
    // reported 405 h of off-post against a 3.09 h shift in the billing export
    // — growing an hour every hour. locations.ts now rejects post-clock-out
    // boundary reports with 409 SESSION_CLOSED, so this is defence in depth:
    // the ingress is closed, and if anything ever reopens it the row is no
    // longer permanent.
    //
    // The file header argues for detection over auto-remediation, and that
    // still holds — it is an argument about orphaned SESSIONS, where an
    // auto-close invents billable hours. A violation carries no money and no
    // total_hours; leaving one open is what caused the defect above. Widening
    // here does not widen the session predicate.
    //
    // ── THE RESOLUTION RULE ──────────────────────────────────────────────
    //
    //   occurred_at >= clocked_out_at  →  resolved_at = occurred_at
    //   otherwise                      →  resolved_at = clocked_out_at
    //
    // The first branch is the post-clock-out birth: a zero-length interval,
    // which is exactly the correction approved for 0633b82b on 2026-08-25.
    // Resolving those to clocked_out_at instead would put resolved_at BEFORE
    // occurred_at and recreate the negative duration_minutes this same
    // expression already wrote onto cf48688b (-3) and ffce3372 (-1). The
    // second branch is the ordinary case and is unchanged.
    //
    // duration_minutes collapses to one expression because clocked_out_at -
    // occurred_at is negative in exactly the first branch: GREATEST(0, ...)
    // yields the 0 that branch requires and is a no-op in the second. A
    // negative can no longer be written from here.
    //
    // With the anchor, the first branch has two causes, and the log must
    // not confuse them:
    //   - a violation born during the grace on a session THIS tick closed.
    //     The session was open when it was written, so the ingress gate did
    //     its job; it simply post-dates the recorded end. Expected, routine.
    //   - a violation born after the session was closed by an EARLIER tick
    //     (or manually). Only that one means locations.ts let a post-close
    //     boundary report through.
    // closed_this_tick tells them apart: $1 is step 2's RETURNING set.
    const violations = await client.query<{
      id:                   string;
      shift_session_id:     string;
      resolved_at:          Date;
      post_clock_out_birth: boolean;
      closed_this_tick:     boolean;
    }>(
      `UPDATE geofence_violations gv
          SET resolved_at = CASE WHEN gv.occurred_at >= ss.clocked_out_at
                                 THEN gv.occurred_at
                                 ELSE ss.clocked_out_at
                            END,
              duration_minutes = GREATEST(0, ROUND(
                EXTRACT(EPOCH FROM (ss.clocked_out_at - gv.occurred_at)) / 60
              ))::INT
         FROM shift_sessions ss
        WHERE gv.shift_session_id = ss.id
          AND gv.resolved_at IS NULL
          AND ss.clocked_out_at IS NOT NULL
        RETURNING gv.id,
                  gv.shift_session_id,
                  gv.resolved_at,
                  (gv.occurred_at >= ss.clocked_out_at) AS post_clock_out_birth,
                  (ss.id = ANY($1::uuid[]))             AS closed_this_tick`,
      [closedThisTick],
    );

    // Step 3: Mark the overdue shifts. Shifts with at least one
    //         shift_sessions row → 'completed' (guard worked, may or may
    //         not have clocked out). Shifts with zero session rows →
    //         'missed' (no-show: guard never clocked in).
    //         Previously this flipped everything to 'completed', which
    //         silently rolled no-shows into the completed bucket and made
    //         them indistinguishable from worked shifts in admin views,
    //         the daily client email, and the mobile profile rollups.
    const shifts = await client.query(
      `UPDATE shifts s
       SET status = CASE
         WHEN EXISTS (SELECT 1 FROM shift_sessions ss WHERE ss.shift_id = s.id)
           THEN 'completed'
         ELSE 'missed'
       END
       WHERE s.scheduled_end + INTERVAL '30 minutes' <= NOW()
         AND s.status IN ('active', 'scheduled')
       RETURNING id, status`
    );

    await client.query('COMMIT');

    // One line per resolved row, after COMMIT so a rolled-back tick never
    // reports a resolution that did not happen. `branch` names what fired:
    //   'clocked_out_at' — born before the recorded end; resolved there.
    //   'grace'          — born after the anchor on a session this tick
    //                      closed; resolved at occurred_at, 0 minutes.
    //                      Expected on every auto-close with a grace exit.
    //   'occurred_at'    — born after a session closed by an earlier tick.
    //                      Seeing this means the ingress gate in
    //                      routes/locations.ts let one through.
    for (const v of violations.rows) {
      console.info('[auto_complete_shifts.violation_resolved]', {
        violation_id:     v.id,
        shift_session_id: v.shift_session_id,
        branch:           !v.post_clock_out_birth ? 'clocked_out_at'
                        : v.closed_this_tick      ? 'grace'
                        :                           'occurred_at',
        resolved_at:      v.resolved_at instanceof Date ? v.resolved_at.toISOString() : v.resolved_at,
      });
    }

    return {
      shiftsClosed:       shifts.rowCount ?? 0,
      sessionsClosed:     sessions.rowCount ?? 0,
      breaksClosed:       breaks.rowCount ?? 0,
      violationsResolved: violations.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

runJob('autoCompleteShifts', '*/5 * * * *', async () => {
  const tickStart = Date.now();
  const client = await pool.connect();
  try {
    const r = await autoCompleteOverdueShifts(client);
    if (r.shiftsClosed > 0) {
      console.log(
        `[autoCompleteShifts] Auto-completed ${r.shiftsClosed} shift(s), ` +
        `closed ${r.sessionsClosed} open session(s), ` +
        `${r.breaksClosed} open break(s)`
      );
    }
    // Finding #4 heartbeat — structured, EVERY tick (even zero-activity) so a
    // silently wedged cron is detectable via "no heartbeat for N hours".
    console.info('[auto_complete_shifts.tick]', {
      shifts_closed:       r.shiftsClosed,
      sessions_closed:     r.sessionsClosed,
      breaks_closed:       r.breaksClosed,
      violations_resolved: r.violationsResolved,
      duration_ms:         Date.now() - tickStart,
    });
  } catch (err) {
    console.error('[autoCompleteShifts] Error:', err);
    // Finding #4 — surface the throw (was console.error-only, which defeated
    // the global unhandled-rejection net). Fingerprint dedups the 5-min tick
    // so a persistent failure is one grouped issue, not 288 events/day.
    Sentry.captureException(err, {
      tags: { flow: 'auto_complete_shifts' },
      fingerprint: ['auto_complete_shifts', 'tick_error'],
      extra: { tick_start: new Date(tickStart).toISOString() },
    });
  } finally {
    client.release();
  }
}, { sentryMonitor: false });
