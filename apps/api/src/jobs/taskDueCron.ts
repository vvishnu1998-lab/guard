/**
 * Task-due detection cron — Build 38 #2.
 *
 * Runs every 5 minutes. Walks every pending task_instances row whose
 * due_at has passed AND that belongs to a shift with a currently-open
 * session, sends a task_reminder push + persists the notification row,
 * then flips notified_at so the same tick can't fire twice.
 *
 * Session scoping (Phase 0 decision #6): the JOIN to shift_sessions
 * (clocked_out_at IS NULL) guarantees we never push a reminder to a
 * guard who already closed the shift — a task that was left pending
 * at clock-out stays pending in the DB (nothing auto-completes it),
 * so without this join we'd spam guards forever after every shift.
 *
 * Idempotency:
 *   UPDATE task_instances SET notified_at = NOW()
 *   WHERE id = $1 AND notified_at IS NULL RETURNING id
 * The WHERE clause is the gate — a concurrent 5-min tick lands on the
 * same row, RETURNING empty, and skips the push. The partial index
 * idx_task_instances_due_pending (v39) backs the outer scan.
 *
 * NotificationType: reuses the existing 'task_reminder' union member
 * (services/notifications.ts:16) — no server union or mobile
 * VISUAL_BY_TYPE change needed. Data payload carries { task_instance_id }
 * so navigateForNotification.ts can deep-link to
 * /tasks/complete/{task_instance_id}.
 *
 * Failure model:
 *   - Row-level DB error → Sentry.captureException, continue loop.
 *     Sets a new pattern for jobs/*.ts (missedPingCron just
 *     console.errors); accepted for Build 38 (decision #5).
 *   - Outer SELECT error → Sentry.captureException, exit tick.
 *   - FCM push error → console.error (existing pattern) — the
 *     notification row already landed, so mobile still sees it on
 *     the Alerts tab even if the push failed.
 */

import cron from 'node-cron';
import * as Sentry from '@sentry/node';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { insertNotification } from '../services/notifications';

interface DueRow {
  task_instance_id: string;
  title: string;
  due_at: Date;
  shift_id: string;
  guard_id: string;
  fcm_token: string | null;
  session_id: string;
}

cron.schedule('*/5 * * * *', async () => {
  let considered = 0;
  let notified = 0;

  try {
    const { rows } = await pool.query<DueRow>(
      `SELECT ti.id      AS task_instance_id,
              ti.title,
              ti.due_at,
              ti.shift_id,
              s.guard_id,
              g.fcm_token,
              ss.id      AS session_id
       FROM task_instances ti
       JOIN shifts s          ON s.id  = ti.shift_id
       JOIN guards g          ON g.id  = s.guard_id
       JOIN shift_sessions ss ON ss.shift_id = s.id AND ss.clocked_out_at IS NULL
       WHERE ti.status      = 'pending'
         AND ti.due_at      <= NOW()
         AND ti.notified_at IS NULL`,
    );

    considered = rows.length;

    for (const row of rows) {
      try {
        // Idempotency gate — WHERE notified_at IS NULL is the atomic
        // check. Concurrent tick sees RETURNING empty and skips.
        const claim = await pool.query<{ id: string }>(
          `UPDATE task_instances
              SET notified_at = NOW()
            WHERE id = $1 AND notified_at IS NULL
            RETURNING id`,
          [row.task_instance_id],
        );
        if (!claim.rows[0]) continue;
        notified += 1;

        const title = `Task due: ${row.title}`;
        const body  = 'Complete now — tap to log with photo';
        const data  = {
          task_instance_id: row.task_instance_id,
          shift_id:         row.shift_id,
        };

        await insertNotification({
          guardId:        row.guard_id,
          type:           'task_reminder',
          title,
          body,
          data,
          shiftSessionId: row.session_id,
        });

        if (row.fcm_token) {
          try {
            await sendPushNotification({
              token: row.fcm_token,
              title,
              body,
              data: {
                type:             'task_reminder',
                task_instance_id: row.task_instance_id,
                shift_id:         row.shift_id,
              },
            });
          } catch (err) {
            console.error(
              `[taskDueCron] FCM push failed for task ${row.task_instance_id}:`,
              err,
            );
          }
        }

        Sentry.addBreadcrumb({
          category: 'taskDueCron',
          message:  'task_reminder emitted',
          level:    'info',
          data: {
            task_instance_id: row.task_instance_id,
            shift_id:         row.shift_id,
            guard_id:         row.guard_id,
            had_fcm:          !!row.fcm_token,
          },
        });
      } catch (err) {
        // Row-level failure — capture & continue so one bad row can't
        // block the rest of the tick. New pattern for jobs/*.ts.
        Sentry.captureException(err, {
          tags:  { context: 'taskDueCron.row' },
          extra: {
            task_instance_id: row.task_instance_id,
            shift_id:         row.shift_id,
            guard_id:         row.guard_id,
          },
        });
        console.error(
          `[taskDueCron] row failed for task ${row.task_instance_id}:`,
          err,
        );
      }
    }
  } catch (err) {
    Sentry.captureException(err, { tags: { context: 'taskDueCron.tick' } });
    console.error('[taskDueCron] Cron error:', err);
  } finally {
    if (notified > 0 || considered > 20) {
      console.log(`[taskDueCron] considered=${considered} notified=${notified}`);
    }
  }
});
