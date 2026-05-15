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
];

// GET /api/notifications — most recent 100 for the authed guard
router.get('/', requireAuth('guard'), async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, type, title, body, data, read_at, created_at
     FROM notifications
     WHERE guard_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [req.user!.sub],
  );
  res.json(result.rows);
});

// GET /api/notifications/unread-count — count for the home-tab badge
router.get('/unread-count', requireAuth('guard'), async (req: Request, res: Response) => {
  const result = await pool.query(
    'SELECT COUNT(*)::int AS count FROM notifications WHERE guard_id = $1 AND read_at IS NULL',
    [req.user!.sub],
  );
  res.json({ count: result.rows[0]?.count ?? 0 });
});

// POST /api/notifications — mobile self-reports an event (eg geofence breach detected on-device)
router.post('/', requireAuth('guard'), async (req: Request, res: Response) => {
  const { type, title, body, data } = req.body;
  if (typeof type !== 'string' || !VALID_TYPES.includes(type as NotificationType)) {
    return res.status(400).json({ error: 'invalid type' });
  }
  if (typeof title !== 'string' || typeof body !== 'string') {
    return res.status(400).json({ error: 'title and body are required' });
  }
  await insertNotification({
    guardId: req.user!.sub,
    type: type as NotificationType,
    title,
    body,
    data: data ?? {},
  });
  res.status(201).json({ ok: true });
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
