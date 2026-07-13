/**
 * Ping / activity-report / task reminder cron job.
 *
 * Phase 1A rewrite (2026-07-12): the PING half of this job is now
 * schedule-anchored per session (scheduled_start + N * 30 min in the
 * site's local timezone). The old wall-clock UTC :00/:30 gate is gone
 * for pings — a 6:22 PT clock-in for a 6:00 PT shift now gets its next
 * ping reminder at 6:30 PT (T+8min), not at the next arbitrary UTC :30
 * boundary. Per R5, activity-report and task reminders stay on the
 * wall-clock hourly schedule for now.
 *
 * Cron ticks every minute. On each tick we:
 *   1. Fetch every active shift_session with its shift's scheduled_start
 *      and site tz. Skip guards who clocked in less than 5 min ago
 *      (parity with the old rule so a 5:59 clock-in doesn't get the
 *      6:00 ping at 6:00:30).
 *   2. For each session, compute the most recent completed 30-min
 *      window boundary and the next upcoming one. If NOW falls within
 *      the 1-min tolerance of a window BOUNDARY (i.e. scheduled_start
 *      + N*30min) → fire the ping reminder. This is the moment the
 *      guard should ping FOR the window that just closed, not the one
 *      that just opened; the mobile UI treats this as "your 6:30 ping
 *      window is closing — submit now".
 *   3. Send at most one ping reminder per session per boundary — dedup
 *      via the notifications table (an existing ping_reminder row for
 *      this session within 5 min → skip).
 *
 * Activity-report + task reminders still run on the old UTC :00/:30
 * gate below the ping block. Those don't have the same "keyed to
 * scheduled_start" requirement — a wall-clock hourly cadence is fine
 * for the "hey, submit your hourly activity report" nudge.
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
  scheduled_start: Date;
  scheduled_end: Date;
  clocked_in_at: Date;
  site_tz: string | null;
}

async function sendReminder(
  row: Pick<ActiveGuardRow, 'guard_id' | 'fcm_token' | 'shift_session_id'>,
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
      shiftSessionId: row.shift_session_id,
    }),
  ]);
}

/**
 * Site-local HH:MM label for a UTC timestamp. Used as the deep-link
 * payload so the mobile ping screen shows "6:30 window" to the guard.
 */
function siteLocalLabel(when: Date, siteTz: string | null): string {
  const tz = siteTz ?? 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: tz,
  }).format(when);
}

/**
 * Compute the latest window BOUNDARY (scheduled_start + N*30min) that
 * has just closed at NOW. Returns the boundary time and its label.
 * The boundary must lie within a ±1 min tolerance of NOW for the cron
 * to consider this session eligible this tick.
 */
function currentBoundary(
  scheduledStart: Date,
  scheduledEnd: Date,
  now: Date,
  toleranceMs: number,
): { boundary: Date; label: string; siteTz: null } | null {
  const startMs = scheduledStart.getTime();
  const nowMs   = now.getTime();
  const endMs   = scheduledEnd.getTime();
  if (nowMs < startMs || nowMs > endMs + toleranceMs) return null;

  const stepMs = 30 * 60 * 1000;
  // N = the number of complete 30-min steps since scheduled_start.
  const n = Math.round((nowMs - startMs) / stepMs);
  if (n <= 0) return null;
  const boundary = new Date(startMs + n * stepMs);
  if (Math.abs(nowMs - boundary.getTime()) > toleranceMs) return null;

  // Boundary must have actually happened at or before NOW — never
  // fire for a boundary that's still in the future.
  if (boundary.getTime() > nowMs) return null;

  return { boundary, label: '', siteTz: null };
}

async function alreadyRemindedRecently(
  shiftSessionId: string,
  guardId: string,
): Promise<boolean> {
  const { rows } = await pool.query<{ recent: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM notifications
       WHERE guard_id = $1
         AND shift_session_id = $2
         AND type = 'ping_reminder'
         AND created_at > NOW() - INTERVAL '5 minutes'
     ) AS recent`,
    [guardId, shiftSessionId],
  );
  return rows[0]?.recent === true;
}

cron.schedule('* * * * *', async () => {
  const now = new Date();
  const TOLERANCE_MS = 60 * 1000; // 1 minute either side of the boundary

  try {
    // Every active session with the fields we need to compute per-session
    // window boundaries. The 5-min just-clocked-in guard mirrors the old
    // job so a 6:29:30 clock-in doesn't get the 6:30 ping 30 sec later.
    const { rows } = await pool.query<ActiveGuardRow>(
      `SELECT ss.id AS shift_session_id,
              g.id  AS guard_id,
              g.name AS guard_name,
              g.fcm_token,
              s.scheduled_start,
              s.scheduled_end,
              ss.clocked_in_at,
              si.timezone AS site_tz
       FROM shift_sessions ss
       JOIN shifts s  ON s.id  = ss.shift_id
       JOIN sites  si ON si.id = ss.site_id
       JOIN guards g  ON g.id  = ss.guard_id
       WHERE ss.clocked_out_at IS NULL
         AND ss.clocked_in_at <= NOW() - INTERVAL '5 minutes'`,
    );

    // ── Ping reminder — schedule-anchored per session ─────────────────
    let pingsFired = 0;
    for (const row of rows) {
      const boundary = currentBoundary(
        new Date(row.scheduled_start),
        new Date(row.scheduled_end),
        now,
        TOLERANCE_MS,
      );
      if (!boundary) continue;
      if (await alreadyRemindedRecently(row.shift_session_id, row.guard_id)) continue;

      const label = siteLocalLabel(boundary.boundary, row.site_tz);
      await sendReminder(
        row,
        'ping_reminder',
        'Location ping',
        `Submit your ${label} ping now.`,
        { window_label: label, window_boundary: boundary.boundary.toISOString() },
      );
      pingsFired += 1;
    }
    if (pingsFired > 0) {
      console.log(`[pingReminder] schedule-anchored: fired ${pingsFired} ping reminder(s)`);
    }

    // ── Activity-report + task reminders — wall-clock hourly (R5) ─────
    const minute = now.getUTCMinutes();
    if (minute !== 0) return;
    if (!rows.length) return;

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
