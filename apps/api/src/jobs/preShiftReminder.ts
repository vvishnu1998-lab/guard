/**
 * Pre-shift push reminder — runs every 5 minutes.
 *
 * Fires a "Shift in 1 hour" push to the assigned guard for any scheduled
 * shift whose scheduled_start falls in the 55-65 min ahead window. The
 * 10-min-wide window means each shift sees up to 2 ticks of opportunity;
 * a `pre_shift_reminder_sent_at` stamp prevents the second tick from
 * re-pushing once the first succeeds.
 *
 * Commit 2 semantics (c): Alerts tab is source of truth.
 *
 * For every candidate row with a guard_id we ALWAYS:
 *   1. Write a `pre_shift_reminder` notification row.
 *   2. Attempt FCM push (best-effort; failure logged, not fatal).
 *   3. Stamp pre_shift_reminder_sent_at NOW() so this row is done.
 *
 * Skip only when shift.guard_id IS NULL — nothing to notify.
 * Null fcm_token no longer skips the row: notification is still
 * written, push is skipped, stamp still advances.
 */
import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { insertNotification } from '../services/notifications';

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
      if (!row.guard_id) {
        console.warn(`[preShiftReminder] Skipping shift ${row.shift_id} — unassigned`);
        continue;
      }

      try {
        const title = 'Shift in 1 hour';
        const body  = row.site_name;

        // 1. Always write the Alerts-tab row first — source of truth for
        //    the guard even when their fcm_token is null.
        await insertNotification({
          guardId:        row.guard_id,
          type:           'pre_shift_reminder',
          title,
          body,
          data: {
            shiftId:        row.shift_id,
            siteName:       row.site_name,
            scheduledStart: row.scheduled_start,
          },
          shiftSessionId: null,
        });

        // 2. Best-effort push. Wrapped so a throw doesn't skip the stamp.
        if (row.fcm_token) {
          try {
            await sendPushNotification({
              token: row.fcm_token,
              title,
              body,
              data:  { shift_id: row.shift_id, type: 'pre_shift_reminder' },
            });
            successes += 1;
          } catch (err) {
            failures += 1;
            console.error(`[preShiftReminder] FCM failed for shift ${row.shift_id}:`, err);
          }
        } else {
          console.warn(`[preShiftReminder] shift=${row.shift_id} — no fcm_token; notification row still written`);
        }

        // 3. Stamp unconditionally — cron must not retry this row now
        //    that the notification row is committed.
        await pool.query(
          `UPDATE shifts SET pre_shift_reminder_sent_at = NOW() WHERE id = $1`,
          [row.shift_id],
        );
      } catch (err) {
        // insertNotification is best-effort and never throws; a throw here
        // means the stamp UPDATE failed (DB down / conn dropped). Log and
        // move on so other rows in this tick still get processed.
        console.error(`[preShiftReminder] row failed for shift ${row.shift_id}:`, err);
      }
    }
  } catch (err) {
    console.error('[preShiftReminder] Cron error:', err);
  } finally {
    console.log(`[preShiftReminder] candidates=${candidates} success=${successes} failure=${failures}`);
  }
});
