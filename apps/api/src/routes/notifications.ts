/**
 * Notification routes — feed the Notifications tab in the mobile app.
 *
 *   GET    /api/notifications              list (most recent 100)
 *   GET    /api/notifications/unread-count badge count for home tab icon
 *   POST   /api/notifications              insert (mobile self-reports, eg geofence)
 *   POST   /api/notifications/:id/read     mark single notification read
 *   POST   /api/notifications/mark-all-read mark all unread for this guard read
 */
import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import { requireAuth } from '../middleware/auth';
import { insertNotification, NotificationType } from '../services/notifications';

const router = Router();

const VALID_TYPES: NotificationType[] = [
  'ping_reminder',
  'activity_report_reminder',
  'task_reminder',
  'chat',
  'geofence_breach',
  'off_post_report',
  'off_post_task',
  'missed_ping',
  'late_clock_in',
  'missed_report',
  // A3 additions — swap + handoff family.
  'swap_request_received',
  'swap_request_sent',
  'swap_accepted',
  'swap_declined',
  'swap_expired',
  'handoff_request_received',
  'handoff_request_sent',
  'handoff_accepted',
  'handoff_declined',
  'handoff_cancelled',
  'handoff_complete',
  'handoff_nudge',
  'handoff_expired',
];

// Shared WHERE fragment for the Notifications tab (GET /) and its badge
// counter (GET /unread-count). Two halves:
//   1. Scope: chat is always shown; everything else must be tied to the
//      guard's currently-active shift session.
//   2. Auto-erase: a per-type completion check hides reminders whose
//      action has been satisfied. The CASE branches mirror the contracts
//      documented in the schema_v16 migration header.
// $1 is the authed guard_id (used twice — once for the outer scope and
// once inside the active-session subquery).
const SHIFT_SCOPED_AND_NOT_COMPLETED = `
  notifications.guard_id = $1
  AND (
    -- chat is always shown across sessions.
    -- late_clock_in fires BEFORE clock-in exists, so it can't link to an
    -- active shift_session_id — allow it through the scope gate and let
    -- the CASE below auto-erase it the moment the guard clocks in.
    -- swap/handoff types (A3) also bypass — recipients typically have
    -- no active session at receive time, and outcome pushes can fire
    -- after the original session ended. Insert-time shift_session_id
    -- is null on these rows by design (see services/swapPush.ts).
    notifications.type IN (
      'chat',
      'late_clock_in',
      'swap_request_received', 'swap_request_sent',
      'swap_accepted', 'swap_declined', 'swap_expired',
      'handoff_request_received', 'handoff_request_sent',
      'handoff_accepted', 'handoff_declined', 'handoff_cancelled',
      'handoff_complete', 'handoff_nudge', 'handoff_expired'
    )
    OR notifications.shift_session_id = (
      SELECT id FROM shift_sessions
      WHERE guard_id = $1 AND clocked_out_at IS NULL
      LIMIT 1
    )
  )
  AND CASE notifications.type
    WHEN 'ping_reminder' THEN NOT EXISTS (
      SELECT 1 FROM location_pings lp
      WHERE lp.shift_session_id = notifications.shift_session_id
        AND lp.pinged_at > notifications.created_at
    )
    WHEN 'activity_report_reminder' THEN NOT EXISTS (
      SELECT 1 FROM reports r
      WHERE r.shift_session_id = notifications.shift_session_id
        AND r.report_type = 'activity'
        AND r.reported_at > notifications.created_at
    )
    WHEN 'task_reminder' THEN EXISTS (
      SELECT 1 FROM task_instances ti
      JOIN shift_sessions ss ON ss.shift_id = ti.shift_id
      WHERE ss.id = notifications.shift_session_id
        AND ti.status = 'pending'
    )
    WHEN 'geofence_breach' THEN NOT (
      notifications.data ? 'violationId' AND EXISTS (
        SELECT 1 FROM geofence_violations gv
        WHERE gv.id = (notifications.data->>'violationId')::uuid
          AND gv.resolved_at IS NOT NULL
      )
    )
    -- Phase 1A auto-erase rules:
    --   missed_ping — hides once the guard submits a late ping that
    --     resolves the referenced missed_pings row (resolved_at set by
    --     POST /api/locations/ping when a window_label body param
    --     matches an open row). Per Q5 the alert STAYS visible until
    --     resolved even when the next window arrives — that's why the
    --     erase is tied to resolved_at, not window_end.
    --   late_clock_in — hides once the guard actually clocks in
    --     (shift_sessions row appears against the referenced shiftId).
    --     The clock-in ends the "you're late" situation regardless of
    --     which of the T+10/T+15 rungs originally fired.
    --   off_post_report / off_post_task — never auto-erase. They are
    --     records of a completed off-post submission, not standing
    --     asks; the guard's Alerts feed keeps them for the shift's
    --     duration for accountability.
    WHEN 'missed_ping' THEN NOT (
      notifications.data ? 'missedPingId' AND EXISTS (
        SELECT 1 FROM missed_pings mp
        WHERE mp.id = (notifications.data->>'missedPingId')::uuid
          AND mp.resolved_at IS NOT NULL
      )
    )
    WHEN 'late_clock_in' THEN NOT (
      notifications.data ? 'shiftId' AND EXISTS (
        SELECT 1 FROM shift_sessions ss
        WHERE ss.shift_id = (notifications.data->>'shiftId')::uuid
          AND ss.clocked_in_at IS NOT NULL
      )
    )
    -- Commit A2: mirror of the missed_ping auto-erase — hide the
    -- alert once a late report submission carrying the matching
    -- window_label resolves the missed_reports row.
    WHEN 'missed_report' THEN NOT (
      notifications.data ? 'missedReportId' AND EXISTS (
        SELECT 1 FROM missed_reports mr
        WHERE mr.id = (notifications.data->>'missedReportId')::uuid
          AND mr.resolved_at IS NOT NULL
      )
    )
    ELSE TRUE
  END
`;

// GET /api/notifications — current shift only, excluding completed actions.
router.get('/', requireAuth('guard'), async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, type, title, body, data, read_at, created_at
     FROM notifications
     WHERE ${SHIFT_SCOPED_AND_NOT_COMPLETED}
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.user!.sub],
  );
  res.json(result.rows);
});

// GET /api/notifications/unread-count — badge for the home tab. Mirrors
// the GET / filter so the badge count and visible list always match.
router.get('/unread-count', requireAuth('guard'), async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM notifications
     WHERE ${SHIFT_SCOPED_AND_NOT_COMPLETED}
       AND read_at IS NULL`,
    [req.user!.sub],
  );
  res.json({ count: result.rows[0]?.count ?? 0 });
});

// POST /api/notifications — mobile self-reports an event (eg geofence
// breach detected on-device). Server derives shift_session_id from the
// guard's active session; if they're off-shift the row is still written
// with shift_session_id = NULL (invisible to the new tab, per design).
router.post('/', requireAuth('guard'), async (req: Request, res: Response) => {
  const { type, title, body, data } = req.body;
  if (typeof type !== 'string' || !VALID_TYPES.includes(type as NotificationType)) {
    return res.status(400).json({ error: 'invalid type' });
  }
  if (typeof title !== 'string' || typeof body !== 'string') {
    return res.status(400).json({ error: 'title and body are required' });
  }
  const sessionResult = await pool.query<{ id: string }>(
    `SELECT id FROM shift_sessions
     WHERE guard_id = $1 AND clocked_out_at IS NULL
     LIMIT 1`,
    [req.user!.sub],
  );
  await insertNotification({
    guardId: req.user!.sub,
    type: type as NotificationType,
    title,
    body,
    data: data ?? {},
    shiftSessionId: sessionResult.rows[0]?.id ?? null,
  });
  res.status(200).json({ ok: true });
});

// POST /api/notifications/:id/read — mark a single notification read
router.post('/:id/read', requireAuth('guard'), async (req: Request, res: Response) => {
  const result = await pool.query(
    `UPDATE notifications
     SET read_at = NOW()
     WHERE id = $1 AND guard_id = $2 AND read_at IS NULL
     RETURNING id`,
    [req.params.id, req.user!.sub],
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// POST /api/notifications/mark-all-read — mark every unread row read for this guard
router.post('/mark-all-read', requireAuth('guard'), async (req: Request, res: Response) => {
  const result = await pool.query(
    `UPDATE notifications SET read_at = NOW()
     WHERE guard_id = $1 AND read_at IS NULL
     RETURNING id`,
    [req.user!.sub],
  );
  res.json({ ok: true, marked: result.rowCount });
});

export default router;
