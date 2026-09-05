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
 * Commit 2 semantics (c) — identical to preShiftReminder.ts:
 *   1. Always write shift_start_reminder notification row.
 *   2. Best-effort FCM push (throw does not skip stamp).
 *   3. Stamp start_reminder_sent_at unconditionally.
 * Skip only when shift.guard_id IS NULL.
 */
import { runJob } from './_run';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { ACTIVE_PUSH_TOKEN_SQL } from '../services/deviceRegistry';
import { insertNotification } from '../services/notifications';
import { Sentry } from '../services/sentry';

interface CandidateRow {
  shift_id: string;
  scheduled_start: Date;
  site_name: string;
  guard_id: string | null;
  guard_name: string | null;
  fcm_token: string | null;
}

runJob('shiftStartReminder', '*/5 * * * *', async () => {
  let candidates = 0;
  let successes = 0;
  let failures = 0;

  try {
    const { rows } = await pool.query<CandidateRow>(
      `SELECT s.id AS shift_id,
              s.scheduled_start,
              st.name AS site_name,
              g.id AS guard_id, g.name AS guard_name, ${ACTIVE_PUSH_TOKEN_SQL('g')}
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
      if (!row.guard_id) {
        console.warn(`[shiftStartReminder] Skipping shift ${row.shift_id} — unassigned`);
        continue;
      }

      try {
        const title = 'Your shift starts now';
        const body  = `Clock in at ${row.site_name}`;

        // 1. Always write the Alerts-tab row first — source of truth for
        //    the guard even when their fcm_token is null.
        await insertNotification({
          guardId:        row.guard_id,
          type:           'shift_start_reminder',
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
              data:  { shift_id: row.shift_id, type: 'shift_start_reminder' },
            });
            successes += 1;
          } catch (err) {
            failures += 1;
            console.error(`[shiftStartReminder] FCM failed for shift ${row.shift_id}:`, err);
          }
        } else {
          console.warn(`[shiftStartReminder] shift=${row.shift_id} — no fcm_token; notification row still written`);
          Sentry.captureMessage('push_skip_null_token', {
            level: 'warning',
            tags: { flow: 'shift_start_reminder' },
            extra: {
              guard_id:  row.guard_id,
              shift_id:  row.shift_id,
              site_name: row.site_name,
            },
          });
        }

        // 3. Stamp unconditionally — cron must not retry this row.
        await pool.query(
          `UPDATE shifts SET start_reminder_sent_at = NOW() WHERE id = $1`,
          [row.shift_id],
        );
      } catch (err) {
        console.error(`[shiftStartReminder] row failed for shift ${row.shift_id}:`, err);
      }
    }
  } catch (err) {
    console.error('[shiftStartReminder] Cron error:', err);
  } finally {
    console.log(`[shiftStartReminder] candidates=${candidates} success=${successes} failure=${failures}`);
  }
}, { sentryMonitor: true });
