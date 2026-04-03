/**
 * Daily Shift Report Email — 9:00 AM UTC every day (Email Type 2, Section 4)
 *
 * Picks up all completed shifts that ended in the last 36 hours and haven't
 * had a daily report email sent yet.  The 36-hour window (not just 24 hours)
 * gives a safety margin for shifts that ran past midnight.
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendDailyShiftReport } from '../services/email';

cron.schedule('0 9 * * *', async () => {
  console.log('[daily-email] Starting at', new Date().toISOString());

  const result = await pool.query(
    `SELECT id FROM shifts
     WHERE status = 'completed'
       AND daily_report_email_sent = false
       AND scheduled_end >= NOW() - INTERVAL '36 hours'
       AND scheduled_end  < NOW() - INTERVAL '1 hour'`,
  );

  let sent = 0;
  let failed = 0;
  for (const shift of result.rows) {
    try {
      await sendDailyShiftReport(shift.id);
      sent++;
    } catch (err) {
      console.error('[daily-email] Failed for shift', shift.id, err);
      failed++;
    }
  }

  console.log(`[daily-email] Done — sent: ${sent}, failed: ${failed}`);
});
