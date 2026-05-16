/**
 * Auto-Complete Overdue Shifts — runs every 5 minutes
 *
 * If a shift's scheduled_end has passed and status is still 'active' or
 * 'scheduled':
 *   1. Close any open break_sessions inside the affected shift_sessions
 *      (set break_end = NOW(), compute duration_minutes).
 *   2. Close any open shift_sessions (set clocked_out_at = NOW(),
 *      compute total_hours = gross hours minus the break minutes from
 *      step 1).
 *   3. Mark the shift as 'completed'.
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

export async function autoCompleteOverdueShifts(client: PoolClient): Promise<{
  shiftsClosed: number;
  sessionsClosed: number;
  breaksClosed: number;
}> {
  await client.query('BEGIN');
  try {
    // Step 1: Close any open break_sessions belonging to shift_sessions
    //         that are about to be auto-closed.
    const breaks = await client.query(
      `UPDATE break_sessions
       SET break_end = NOW(),
           duration_minutes = GREATEST(
             0,
             ROUND(EXTRACT(EPOCH FROM (NOW() - break_start)) / 60.0)::INT
           )
       WHERE break_end IS NULL
         AND shift_session_id IN (
           SELECT ss.id
             FROM shift_sessions ss
             JOIN shifts s ON s.id = ss.shift_id
            WHERE ss.clocked_out_at IS NULL
              AND s.scheduled_end <= NOW()
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
         AND s.scheduled_end <= NOW()
         AND s.status IN ('active', 'scheduled')
       RETURNING ss.id`
    );

    // Step 3: Mark the overdue shifts as completed.
    const shifts = await client.query(
      `UPDATE shifts
       SET status = 'completed'
       WHERE scheduled_end <= NOW()
         AND status IN ('active', 'scheduled')
       RETURNING id`
    );

    await client.query('COMMIT');

    return {
      shiftsClosed:   shifts.rowCount ?? 0,
      sessionsClosed: sessions.rowCount ?? 0,
      breaksClosed:   breaks.rowCount ?? 0,
    };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

cron.schedule('*/5 * * * *', async () => {
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
  } catch (err) {
    console.error('[autoCompleteShifts] Error:', err);
  } finally {
    client.release();
  }
});
