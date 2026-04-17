/**
 * Auto-Complete Overdue Shifts — runs every 5 minutes
 *
 * If a shift's scheduled_end has passed and status is still 'active' or 'scheduled',
 * mark it as 'completed' with a note so it doesn't stay stuck as "active" forever.
 */

import cron from 'node-cron';
import { pool } from '../db/pool';

cron.schedule('*/5 * * * *', async () => {
  try {
    const result = await pool.query(
      `UPDATE shifts
       SET status = 'completed'
       WHERE scheduled_end <= NOW()
         AND status IN ('active', 'scheduled')
       RETURNING id`
    );
    if (result.rowCount && result.rowCount > 0) {
      console.log(`[autoCompleteShifts] Auto-completed ${result.rowCount} overdue shift(s)`);
    }
  } catch (err) {
    console.error('[autoCompleteShifts] Error:', err);
  }
});
