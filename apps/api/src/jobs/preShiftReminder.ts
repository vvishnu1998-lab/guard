/**
 * Pre-shift push reminder — runs every 5 minutes.
 *
 * Fires a "Shift in 1 hour" push to the assigned guard for any scheduled
 * shift whose scheduled_start falls in the 55-65 min ahead window. The
 * 10-min-wide window means each shift sees up to 2 ticks of opportunity;
 * a `pre_shift_reminder_sent_at` stamp prevents the second tick from
 * re-pushing once the first succeeds.
 *
 * Skip behavior (no DB write — next tick may retry):
 *   - shift.guard_id IS NULL (unassigned)
 *   - guard.fcm_token IS NULL (no device)
 *   - FCM dispatch rejects (network / Expo error)
 *
 * Mark sent behavior (DB write — no further attempts):
 *   - FCM dispatch resolves successfully
 */
import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';

interface CandidateRow {
  shift_id: string;
  scheduled_start: Date;
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
      `SELECT s.id AS shift_id, s.scheduled_start,
              st.name AS site_name,
              g.id AS guard_id, g.name AS guard_name, g.fcm_token
       FROM shifts s
       JOIN sites  st ON st.id = s.site_id
       LEFT JOIN guards g ON g.id = s.guard_id
       WHERE s.status = 'scheduled'
         AND s.scheduled_start BETWEEN NOW() + INTERVAL '55 minutes' AND NOW() + INTERVAL '65 minutes'
         AND s.pre_shift_reminder_sent_at IS NULL`,
    );

    candidates = rows.length;
    if (!candidates) return;

    for (const row of rows) {
      if (!row.guard_id || !row.fcm_token) {
        console.warn(`[preShiftReminder] Skipping shift ${row.shift_id} — ${row.guard_id ? 'no fcm_token' : 'unassigned'}`);
        continue;
      }

      try {
        await sendPushNotification({
          token: row.fcm_token,
          title: 'Shift in 1 hour',
          body:  row.site_name,
          data:  { shift_id: row.shift_id, type: 'pre_shift_reminder' },
        });
        await pool.query(
          `UPDATE shifts SET pre_shift_reminder_sent_at = NOW() WHERE id = $1`,
          [row.shift_id],
        );
        successes += 1;
      } catch (err) {
        failures += 1;
        console.error(`[preShiftReminder] FCM failed for shift ${row.shift_id}:`, err);
      }
    }
  } catch (err) {
    console.error('[preShiftReminder] Cron error:', err);
  } finally {
    console.log(`[preShiftReminder] candidates=${candidates} success=${successes} failure=${failures}`);
  }
});
