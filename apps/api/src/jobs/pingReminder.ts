/**
 * Ping / activity-report / task reminder cron job (F2 + F3 + F5)
 *
 * Runs every minute but only sends pushes at :00 and :30 past the hour (UTC).
 *  :30 → ping reminder
 *  :00 → ping reminder + activity-report reminder + task reminder (only if N>0)
 *
 * Every push is mirrored into the `notifications` table so it shows up in
 * the mobile Notifications tab.
 */
import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { insertNotification, NotificationType } from '../services/notifications';

interface ActiveGuardRow {
  guard_id: string;
  guard_name: string;
  fcm_token: string | null;
  shift_session_id: string;
}

async function sendReminder(
  row: ActiveGuardRow,
  type: NotificationType,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const payload = { type, ...data };
  await Promise.allSettled([
    row.fcm_token
      ? sendPushNotification({ token: row.fcm_token, title, body, data: payload as Record<string, string> }).catch(
          (err) => console.error(`[pingReminder] FCM ${type} failed for guard ${row.guard_id}:`, err),
        )
      : Promise.resolve(),
    insertNotification({
      guardId: row.guard_id,
      type,
      title,
      body,
      data,
    }),
  ]);
}

cron.schedule('* * * * *', async () => {
  const minute = new Date().getUTCMinutes();
  const isHour = minute === 0;
  const isHalfHour = minute === 30;

  if (!isHour && !isHalfHour) return;

  try {
    // Select all guards with an open shift session (regardless of fcm_token —
    // notification rows are written even when push can't be delivered, so the
    // user still sees them in the Notifications tab on next foreground).
    const { rows } = await pool.query<ActiveGuardRow>(
      `SELECT ss.id AS shift_session_id,
              g.id  AS guard_id,
              g.name AS guard_name,
              g.fcm_token
       FROM shift_sessions ss
       JOIN guards g ON g.id = ss.guard_id
       WHERE ss.clocked_out_at IS NULL`,
    );

    if (!rows.length) return;

    // ── Ping reminder ────────────────────────────────────────────────────
    await Promise.allSettled(
      rows.map((row) =>
        sendReminder(
          row,
          'ping_reminder',
          'Location ping',
          'Open the app to confirm your location.',
        ),
      ),
    );
    console.log(`[pingReminder] Sent ping reminder to ${rows.length} active guards`);

    if (!isHour) return;

    // ── Activity report reminder (hourly only) ───────────────────────────
    await Promise.allSettled(
      rows.map((row) =>
        sendReminder(
          row,
          'activity_report_reminder',
          'Activity report',
          'Time to submit your hourly activity report.',
        ),
      ),
    );
    console.log(`[pingReminder] Sent activity-report reminder to ${rows.length} active guards`);

    // ── Task reminder (hourly, only if N > 0 for that guard) ─────────────
    for (const row of rows) {
      const taskCount = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM task_instances ti
         JOIN shifts s ON s.id = ti.shift_id
         JOIN shift_sessions ss ON ss.shift_id = s.id
         WHERE ss.id = $1 AND ti.status = 'pending'`,
        [row.shift_session_id],
      );
      const n = taskCount.rows[0]?.count ?? 0;
      if (n <= 0) continue;

      const plural = n === 1 ? 'task' : 'tasks';
      await sendReminder(
        row,
        'task_reminder',
        'Task reminder',
        `You have ${n} pending ${plural}.`,
        { count: n },
      );
    }
  } catch (err) {
    console.error('[pingReminder] Cron error:', err);
  }
});
