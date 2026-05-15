/**
 * Ping / activity-report reminder cron job (F2 + F3)
 *
 * Runs every minute but only sends pushes at :00 and :30 past the hour (UTC).
 *  :00 → ping reminder + hourly activity report reminder
 *  :30 → ping reminder only
 *
 * Sends FCM push to each guard's fcm_token.
 */
import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';

cron.schedule('* * * * *', async () => {
  const minute = new Date().getUTCMinutes();
  const isHour = minute === 0;
  const isHalfHour = minute === 30;

  if (!isHour && !isHalfHour) return;

  try {
    // Select all guards with an open shift session
    const { rows } = await pool.query<{
      guard_id: string;
      guard_name: string;
      fcm_token: string | null;
      shift_session_id: string;
    }>(
      `SELECT ss.id AS shift_session_id,
              g.id AS guard_id,
              g.name AS guard_name,
              g.fcm_token
       FROM shift_sessions ss
       JOIN guards g ON g.id = ss.guard_id
       WHERE ss.clocked_out_at IS NULL
         AND g.fcm_token IS NOT NULL`
    );

    if (!rows.length) return;

    const pingPromises = rows.map((row) =>
      sendPushNotification({
        token: row.fcm_token!,
        title: 'Location ping',
        body:  'Open the app to confirm your location.',
        data:  { type: 'ping_reminder' },
      }).catch((err) =>
        console.error(`[pingReminder] FCM send failed for guard ${row.guard_id}:`, err)
      )
    );

    await Promise.allSettled(pingPromises);
    console.log(`[pingReminder] Sent ping reminder to ${rows.length} active guards`);

    // Hourly: also send activity-report reminder (F3)
    if (isHour) {
      const reportPromises = rows.map((row) =>
        sendPushNotification({
          token: row.fcm_token!,
          title: 'Activity report',
          body:  'Time to submit your hourly activity report.',
          data:  { type: 'activity_report_reminder' },
        }).catch((err) =>
          console.error(`[pingReminder] Activity report FCM failed for guard ${row.guard_id}:`, err)
        )
      );

      await Promise.allSettled(reportPromises);
      console.log(`[pingReminder] Sent activity report reminder to ${rows.length} active guards`);
    }
  } catch (err) {
    console.error('[pingReminder] Cron error:', err);
  }
});
