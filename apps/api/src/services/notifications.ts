/**
 * Notification service — server-side persistence of every push notification
 * fired at a guard. Each push-sending call site (chat.ts, pingReminder.ts,
 * locations.ts violation) invokes insertNotification(...) alongside the push
 * so the Notifications tab on the mobile app has a record of it.
 *
 * The mobile app also writes a row directly (via POST /api/notifications)
 * for events it self-detects, e.g. geofence breaches triggered by background
 * location updates.
 */
import { pool } from '../db/pool';

export type NotificationType =
  | 'ping_reminder'
  | 'activity_report_reminder'
  | 'task_reminder'
  | 'chat'
  | 'geofence_breach';

export interface NotificationRow {
  id: string;
  guard_id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

/**
 * Insert a notification row for a guard. Best-effort: failures are logged
 * but don't throw, so push-sending sites stay decoupled from the log.
 */
export async function insertNotification(params: {
  guardId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications (guard_id, type, title, body, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [params.guardId, params.type, params.title, params.body, params.data ?? {}],
    );
  } catch (err) {
    console.error('[notifications] insert failed:', err);
  }
}
