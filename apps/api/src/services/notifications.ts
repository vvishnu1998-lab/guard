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
  | 'geofence_breach'
  // Phase 1A additions (2026-07-12 walk-test rebuild):
  //   off_post_report — INCIDENT report accepted from outside the geofence.
  //     Data payload: { reportId, siteName }. Deep-link → report detail.
  //   off_post_task — reserved. Task completions are 422-rejected today
  //     (routes/tasks.ts:98), so nothing emits this yet. Kept in the union
  //     for parity so a future Q8 policy relaxation is a one-line change.
  //   missed_ping — 30-min ping window closed with no ping. Emitted by
  //     jobs/missedPingCron.ts. Data payload: { missedPingId, windowLabel,
  //     windowStart, windowEnd }. Deep-link → ping submission screen with
  //     window_label pre-filled.
  //   late_clock_in — guard hasn't clocked in by T+10 / T+15 of scheduled
  //     start. Data payload: { shiftId, minutesLate, siteName }. Deep-link
  //     → clock-in flow.
  | 'off_post_report'
  | 'off_post_task'
  | 'missed_ping'
  | 'late_clock_in'
  // Commit A2 addition:
  //   missed_report — hourly report window closed with no report
  //     submitted. Emitted by jobs/missedReportCron.ts. Data payload:
  //     { missedReportId, windowLabel, windowStart, windowEnd,
  //       siteName }. Deep-link → create-report screen with
  //     window_label pre-filled (mobile-side, Build 34).
  | 'missed_report'
  // Commit A3 addition — swap + handoff family. Emitted by
  // services/swapPush.ts's 13 helpers (each fires one push + one
  // notification row via the always-paired fireOne). Types match
  // the mobile side's VISUAL_BY_TYPE 13 variants exactly (merge
  // commit bd7e4e2). All carry data { shift_id, history_id }; the
  // handoff_nudge variant additionally carries { role: 'from' | 'to' }.
  //
  // Swap family — pre-shift guard-to-guard invitation lifecycle.
  | 'swap_request_received'
  | 'swap_request_sent'
  | 'swap_accepted'
  | 'swap_declined'
  | 'swap_expired'
  // Handoff family — mid-shift transfer lifecycle.
  | 'handoff_request_received'
  | 'handoff_request_sent'
  | 'handoff_accepted'
  | 'handoff_declined'
  | 'handoff_cancelled'
  | 'handoff_complete'
  | 'handoff_nudge'
  | 'handoff_expired';

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
  // Shift-scoping (schema v16). NULL is valid and intentional for chat and
  // for events that fire while the guard has no active session.
  shiftSessionId?: string | null;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO notifications (guard_id, type, title, body, data, shift_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        params.guardId,
        params.type,
        params.title,
        params.body,
        params.data ?? {},
        params.shiftSessionId ?? null,
      ],
    );
  } catch (err) {
    console.error('[notifications] insert failed:', err);
  }
}
