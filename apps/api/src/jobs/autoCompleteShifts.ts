/**
 * Auto-Complete Overdue Shifts — runs every 5 minutes
 *
 * If a shift's scheduled_end has passed and status is still 'active' or 'scheduled':
 * 1. Close any open shift_sessions first (set clocked_out_at = NOW())
 * 2. Mark the shift as 'completed'
 *
 * Both steps are needed — the cron only updates shifts.status, but if the guard
 * never clicked Clock Out the shift_session stays open forever, causing the
 * dashboard to show them as "on duty" with an ever-growing hours counter.
 */

import cron from 'node-cron';
import { pool } from '../db/pool';

cron.schedule('*/5 * * * *', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Step 1: Close any open sessions belonging to overdue shifts
    const sessions = await client.query(
      `UPDATE shift_sessions
       SET clocked_out_at = NOW()
       WHERE clocked_out_at IS NULL
         AND shift_id IN (
           SELECT id FROM shifts
           WHERE scheduled_end <= NOW()
             AND status IN ('active', 'scheduled')
         )
       RETURNING id`
    );

    // Step 2: Mark the overdue shifts as completed
    const shifts = await client.query(
      `UPDATE shifts
       SET status = 'completed'
       WHERE scheduled_end <= NOW()
         AND status IN ('active', 'scheduled')
       RETURNING id`
    );

    await client.query('COMMIT');

    if (shifts.rowCount && shifts.rowCount > 0) {
      console.log(
        `[autoCompleteShifts] Auto-completed ${shifts.rowCount} shift(s), ` +
        `closed ${sessions.rowCount ?? 0} open session(s)`
      );
    }
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[autoCompleteShifts] Error:', err);
  } finally {
    client.release();
  }
});
