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
  // 3.1 — clock_out_reminder has been a NotificationType since the cron
  // shipped but was never added here, so POST /api/notifications rejected
  // it. Only the mobile self-report route is gated by this list (crons call
  // insertNotification directly and bypass it), which is why nothing broke
  // visibly — but the asymmetry is exactly the kind that bites later.
  'clock_out_reminder',
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
      'shift_assigned',
      'pre_shift_reminder',
      'shift_start_reminder',
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
    -- ping_reminder auto-erase is WINDOW-KEYED. It used to hide on "any
    -- ping in this session arrived after this reminder", which is blind to
    -- WHICH window was answered: submitting a late backfill for window
    -- W-1 erased the live, still-unanswered reminder for window W.
    --
    -- Observed on 2026-08-20, session 078abb4d: the 17:30 reminder
    -- (created 17:30:01) was erased at 17:39:59 by a ping labelled
    -- '17:00' — a backfill of the earlier missed window. read_at stayed
    -- NULL throughout, so nothing in the notifications table recorded
    -- that the guard had stopped being told. Had they not happened to
    -- ping 17:30 twenty-six seconds later, they would have missed that
    -- window with no visible prompt.
    --
    -- The reminder's own window lives in data->>'window_label'
    -- (pingReminder writes snake_case). missed_ping writes camelCase
    -- 'windowLabel'; COALESCE covers both so this predicate stays correct
    -- if the keys are ever unified. 2 of 450 legacy ping_reminder rows
    -- carry neither key — those keep the old any-later-ping behaviour
    -- rather than becoming permanently un-erasable.
    --
    -- Indexed by idx_location_pings_session_window
    -- (shift_session_id, window_label) WHERE window_label IS NOT NULL.
    --
    -- The missed_ping arm below is NOT this shape and must not be
    -- "fixed" to match: it keys on missedPingId -> missed_pings
    -- .resolved_at, which is already exact.
    WHEN 'ping_reminder' THEN NOT EXISTS (
      SELECT 1 FROM location_pings lp
      WHERE lp.shift_session_id = notifications.shift_session_id
        AND CASE
              WHEN COALESCE(
                     notifications.data->>'window_label',
                     notifications.data->>'windowLabel'
                   ) IS NOT NULL
              THEN lp.window_label = COALESCE(
                     notifications.data->>'window_label',
                     notifications.data->>'windowLabel'
                   )
              ELSE lp.pinged_at > notifications.created_at
            END
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
    -- Commit 2: Pre-shift and shift-start reminders auto-erase the moment
    -- the guard clocks in for the referenced shift — same shape and
    -- rationale as late_clock_in above. Both crons stamp their respective
    -- *_reminder_sent_at columns so a repeat notification for the same
    -- shift is impossible; auto-erase is what hides yesterday's reminder
    -- from today's Alerts tab.
    WHEN 'pre_shift_reminder' THEN NOT (
      notifications.data ? 'shiftId' AND EXISTS (
        SELECT 1 FROM shift_sessions ss
        WHERE ss.shift_id = (notifications.data->>'shiftId')::uuid
          AND ss.clocked_in_at IS NOT NULL
      )
    )
    WHEN 'shift_start_reminder' THEN NOT (
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
    -- Phase 2 arms. All four follow the established shape above: guard on
    -- the key's presence first, so a row whose payload predates the key
    -- stays VISIBLE rather than becoming un-erasable or throwing on a cast.
    --
    --   break_ended / break_return_overdue — hide once the break they are
    --     about is closed (break_sessions.break_end stamped). break_end is
    --     the end column; "ended_by" is a separate varchar recording WHO
    --     closed it and is NULL for 11 of 35 rows, so it is not a usable
    --     closed-test.
    --     Rows written before Phase 3.4 carry no break_session_id at all —
    --     breakExpiryCron did not send one — so "data ? 'break_session_id'"
    --     is false for them and they stay visible. That is deliberate: a
    --     backlog row we cannot resolve must not be hidden on a guess.
    WHEN 'break_ended' THEN NOT (
      COALESCE(
        notifications.data->>'break_session_id',
        notifications.data->>'break_id'
      ) IS NOT NULL AND EXISTS (
        SELECT 1 FROM break_sessions bs
        WHERE bs.id = COALESCE(
                notifications.data->>'break_session_id',
                notifications.data->>'break_id'
              )::uuid
          AND bs.break_end IS NOT NULL
      )
    )
    WHEN 'break_return_overdue' THEN NOT (
      COALESCE(
        notifications.data->>'break_session_id',
        notifications.data->>'break_id'
      ) IS NOT NULL AND EXISTS (
        SELECT 1 FROM break_sessions bs
        WHERE bs.id = COALESCE(
                notifications.data->>'break_session_id',
                notifications.data->>'break_id'
              )::uuid
          AND bs.break_end IS NOT NULL
      )
    )
    --   clock_out_reminder — hide once the session for the referenced shift
    --     has clocked out. Keyed on shift_id (snake_case: that is what
    --     jobs/clockOutReminder.ts writes, unlike the camelCase 'shiftId'
    --     the three clock-in arms above use — the payloads genuinely
    --     differ and COALESCEing them here would hide that).
    --     Note this erases on EITHER a manual clock-out or the
    --     autoCompleteShifts sweep, since both stamp clocked_out_at. That
    --     is correct: the reminder's ask ("close your own shift") is moot
    --     once the shift is closed by any means.
    WHEN 'clock_out_reminder' THEN NOT (
      notifications.data ? 'shift_id' AND EXISTS (
        SELECT 1 FROM shift_sessions ss
        WHERE ss.shift_id = (notifications.data->>'shift_id')::uuid
          AND ss.clocked_out_at IS NOT NULL
      )
    )
    --   shift_assigned — hide once the guard has actually clocked in for
    --     that shift, or the shift was cancelled out from under them.
    --     Only the SINGULAR shift_id form is erasable. services/shiftPush
    --     writes a batched row carrying "shift_ids" (a JSON array) with no
    --     single shift_id, so "data ? 'shift_id'" is false there and the
    --     batch row stays visible for its whole scope window — correct,
    --     since one clock-in out of five does not make the assignment
    --     notice stale.
    WHEN 'shift_assigned' THEN NOT (
      notifications.data ? 'shift_id' AND (
        EXISTS (
          SELECT 1 FROM shift_sessions ss
          WHERE ss.shift_id = (notifications.data->>'shift_id')::uuid
        )
        OR EXISTS (
          SELECT 1 FROM shifts s
          WHERE s.id = (notifications.data->>'shift_id')::uuid
            AND s.status = 'cancelled'
        )
      )
    )
    -- chat, off_post_report and off_post_task reach ELSE TRUE and that is
    -- INTENTIONAL, not an oversight:
    --   chat — a message is not an obligation with a completion state. It
    --     leaves the feed when the guard dismisses it (read_at), and it
    --     bypasses shift scoping entirely via the IN list above.
    --   off_post_report / off_post_task — records of a completed off-post
    --     submission, kept for the shift's duration for accountability.
    --     Already stated at the Phase 1A comment above; restated here so
    --     the next person to add an arm does not "fix" them.
    ELSE TRUE
  END
  -- The swap/handoff family (13 types) shares ONE predicate, so it lives
  -- here rather than as 13 identical WHEN arms: Postgres' simple CASE takes
  -- exactly one value per WHEN ("WHEN 'a','b' THEN" is a syntax error), and
  -- thirteen copy-pasted six-line arms is how one of them eventually drifts.
  --
  -- Swap and handoff are the SAME table — shift_swap_requests, split by
  -- initiated_by ('guard_pre_shift' | 'guard_handoff' | 'admin') — so one
  -- predicate genuinely covers both families.
  --
  -- Terminal is "status <> 'pending'". The status CHECK admits exactly
  -- five values (pending, accepted, declined, expired, cancelled); there is
  -- no 'complete' status, and a completed handoff sits at 'accepted'. Phrasing
  -- it as "not pending" rather than enumerating the four keeps it correct if
  -- a sixth terminal state is ever added.
  AND (
    notifications.type NOT IN (
      'swap_request_received', 'swap_request_sent',
      'swap_accepted', 'swap_declined', 'swap_expired',
      'handoff_request_received', 'handoff_request_sent',
      'handoff_accepted', 'handoff_declined', 'handoff_cancelled',
      'handoff_complete', 'handoff_nudge', 'handoff_expired'
    )
    OR NOT (
      notifications.data ? 'history_id' AND EXISTS (
        SELECT 1 FROM shift_swap_requests ssr
        WHERE ssr.id = (notifications.data->>'history_id')::uuid
          AND ssr.status <> 'pending'
      )
    )
  )
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
