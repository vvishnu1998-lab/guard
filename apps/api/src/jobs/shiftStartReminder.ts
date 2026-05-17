/**
 * Shift-start push reminder — runs every 5 minutes.
 *
 * Fires a "Your shift starts now" push for any scheduled shift whose
 * scheduled_start fell within the last 5 minutes and is still in
 * 'scheduled' status (i.e. guard hasn't clocked in yet). The 5-min
 * window means each shift sees exactly one tick of opportunity.
 *
 * Companion to missedShiftAlert.ts, which fires email to admins at T+10
 * min. This push fires at T+0..5 min to the guard themselves, hoping
 * they're just a few minutes late and can still clock in before the
 * missed-shift escalation.
 *
 * Skip + mark semantics are identical to preShiftReminder.ts.
 */
import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';

interface CandidateRow {
  shift_id: string;
  site_name: string;
  guard_id: string | null;
  guard_name: string | null;
  fcm_token: string | null;
}

cron.schedule('*/5 * * * *', async () => {
  let candidates = 0;
  let successes = 0;
  let failures = 0;

  try {
    const { rows } = await pool.query<CandidateRow>(
      `SELECT s.id AS shift_id,
              st.name AS site_name,
              g.id AS guard_id, g.name AS guard_name, g.fcm_token
       FROM shifts s
       JOIN sites  st ON st.id = s.site_id
       LEFT JOIN guards g ON g.id = s.guard_id
       WHERE s.status = 'scheduled'
         AND s.scheduled_start <= NOW()
         AND s.scheduled_start > NOW() - INTERVAL '5 minutes'
         AND s.start_reminder_sent_at IS NULL`,
    );

    candidates = rows.length;
    if (!candidates) return;

    for (const row of rows) {
      if (!row.guard_id || !row.fcm_token) {
        console.warn(`[shiftStartReminder] Skipping shift ${row.shift_id} — ${row.guard_id ? 'no fcm_token' : 'unassigned'}`);
        continue;
      }

      try {
        await sendPushNotification({
          token: row.fcm_token,
          title: 'Your shift starts now',
          body:  `Clock in at ${row.site_name}`,
          data:  { shift_id: row.shift_id, type: 'shift_start_reminder' },
        });
        await pool.query(
          `UPDATE shifts SET start_reminder_sent_at = NOW() WHERE id = $1`,
          [row.shift_id],
        );
        successes += 1;
      } catch (err) {
        failures += 1;
        console.error(`[shiftStartReminder] FCM failed for shift ${row.shift_id}:`, err);
      }
    }
  } catch (err) {
    console.error('[shiftStartReminder] Cron error:', err);
  } finally {
    console.log(`[shiftStartReminder] candidates=${candidates} success=${successes} failure=${failures}`);
  }
});
