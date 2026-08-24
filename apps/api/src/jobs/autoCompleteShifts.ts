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
 * ALL THREE predicates below move together and MUST stay in lockstep. If the
 * shifts-status flip (step 4) fired at scheduled_end while the session close
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
 *   - pingReminder / missedPingCron / missedReportCron / taskDueCron all
 *     bound their windows by scheduled_end itself (services/pingWindows.ts:83
 *     — a window is tracked only if its END fits inside scheduled_end), so a
 *     longer-open session produces no extra reminders or flags.
 *
 * ── WHY 'cancelled' IS DELIBERATELY NOT IN THE SWEEP SET ─────────────────
 *
 * A shift cancelled while a session is open would never be swept, and the
 * guard stays locked out by idx_shift_sessions_one_open_per_guard. Widening
 * the predicate to include 'cancelled' looks like the fix. It is not, for
 * two reasons that the code makes concrete:
 *
 *   1. IT WOULD INVENT BILLABLE HOURS. The total_hours expression below is
 *      NOW() - GREATEST(clocked_in_at, scheduled_start) - breaks. Run against
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
 *      (set break_end = NOW(), compute duration_minutes).
 *   2. Close any open shift_sessions (set clocked_out_at = NOW(),
 *      compute total_hours = gross hours minus the break minutes from
 *      step 1).
 *   3. Mark the shift as 'completed'.
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
 * endpoint (apps/api/src/routes/shifts.ts:233) already uses.
 *
 * Exporting the worker function makes it testable from
 * apps/api/scripts/test-auto-complete-shifts.ts.
 */

import cron from 'node-cron';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { Sentry } from '../services/sentry';

export async function autoCompleteOverdueShifts(client: PoolClient): Promise<{
  shiftsClosed: number;
  sessionsClosed: number;
  breaksClosed: number;
  violationsResolved: number;
}> {
  await client.query('BEGIN');
  try {
    // Step 1: Close any open break_sessions belonging to shift_sessions
    //         that are about to be auto-closed.
    const breaks = await client.query(
      `UPDATE break_sessions
       SET break_end = NOW(),
           duration_minutes = LEAST(
             GREATEST(
               0,
               ROUND(EXTRACT(EPOCH FROM (NOW() - break_start)) / 60.0)::INT
             ),
             planned_duration_minutes
           ),
           ended_by = 'auto_complete'
       WHERE break_end IS NULL
         AND shift_session_id IN (
           SELECT ss.id
             FROM shift_sessions ss
             JOIN shifts s ON s.id = ss.shift_id
            WHERE ss.clocked_out_at IS NULL
              AND s.scheduled_end + INTERVAL '30 minutes' <= NOW()
              AND s.status IN ('active', 'scheduled')
         )
       RETURNING id`
    );

    // Step 2: Close any open shift_sessions, computing total_hours as
    //         (clock_out − MAX(clock_in, scheduled_start)) − breaks
    //         (option C: early arrivals not paid, late stays paid).
    //         Matches manual clock-out math in routes/shifts.ts.
    const sessions = await client.query(
      `UPDATE shift_sessions ss
       SET clocked_out_at = NOW(),
           clock_out_reason = 'auto',
           total_hours = GREATEST(
             0,
             EXTRACT(EPOCH FROM (NOW() - GREATEST(ss.clocked_in_at, s.scheduled_start))) / 3600.0
             - COALESCE((
                 SELECT SUM(duration_minutes)
                   FROM break_sessions bs
                  WHERE bs.shift_session_id = ss.id
               ), 0) / 60.0
           )
       FROM shifts s
       WHERE ss.shift_id = s.id
         AND ss.clocked_out_at IS NULL
         AND s.scheduled_end + INTERVAL '30 minutes' <= NOW()
         AND s.status IN ('active', 'scheduled')
       RETURNING ss.id`
    );

    // Walk-test 2026-07-09 BUG I: for every session we just auto-closed,
    // resolve its lingering open geofence violations. Uses the freshly-set
    // clocked_out_at as the resolution timestamp for parity with the
    // manual clock-out path.
    const violations = await client.query(
      `UPDATE geofence_violations gv
          SET resolved_at = ss.clocked_out_at,
              duration_minutes = ROUND(EXTRACT(EPOCH FROM (ss.clocked_out_at - gv.occurred_at)) / 60)::INT
         FROM shift_sessions ss
        WHERE gv.shift_session_id = ss.id
          AND gv.resolved_at IS NULL
          AND ss.clocked_out_at > NOW() - INTERVAL '10 minutes'
        RETURNING gv.id`
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

cron.schedule('*/5 * * * *', async () => {
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
});
