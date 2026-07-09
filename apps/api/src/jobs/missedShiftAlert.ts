/**
 * Missed Shift Alert — runs every 5 minutes
 *
 * Finds shifts that:
 *  - are still in 'scheduled' status (no clock-in)
 *  - started more than 10 minutes ago
 *  - haven't had a missed-alert email sent yet
 *
 * Sends an alert to: the company admin only.
 *
 * Status lifecycle for a no-show: 'scheduled' from creation through
 * scheduled_end. This job fires once during that window (after T+10 min).
 * At scheduled_end the auto-complete cron flips the status from
 * 'scheduled' to 'missed' (see jobs/autoCompleteShifts.ts) because the
 * shift has zero shift_sessions rows. The status filter here naturally
 * stops matching after the flip, so no duplicate alert is sent.
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendMissedShiftAlert } from '../services/email';
import { Sentry } from '../services/sentry';

cron.schedule('*/5 * * * *', async () => {
  const result = await pool.query(
    `SELECT id FROM shifts
     WHERE status = 'scheduled'
       AND scheduled_start + INTERVAL '10 minutes' <= NOW()
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
      Sentry.captureException(err, {
        tags: { service: 'sendgrid', flow: 'missed_shift_alert' },
        extra: { shift_id: shift.id },
      });
    }
  }
});
