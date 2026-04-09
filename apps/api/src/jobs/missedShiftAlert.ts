/**
 * Missed Shift Alert — runs every 5 minutes
 *
 * Finds shifts that:
 *  - are still in 'scheduled' status (no clock-in)
 *  - started more than 15 minutes ago
 *  - haven't had a missed-alert email sent yet
 *
 * Sends an alert to: Vishnu (super admin) + company admin + client.
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendMissedShiftAlert } from '../services/email';

cron.schedule('*/5 * * * *', async () => {
  const result = await pool.query(
    `SELECT id FROM shifts
     WHERE status = 'scheduled'
       AND scheduled_start + INTERVAL '15 minutes' <= NOW()
       AND missed_alert_sent_at IS NULL`,
  );

  if (result.rows.length === 0) return;

  console.log(`[missed-shift] ${result.rows.length} missed shift(s) detected`);

  for (const shift of result.rows) {
    try {
      await sendMissedShiftAlert(shift.id);
      console.log('[missed-shift] Alert sent for shift', shift.id);
    } catch (err) {
      console.error('[missed-shift] Failed for shift', shift.id, err);
    }
  }
});
