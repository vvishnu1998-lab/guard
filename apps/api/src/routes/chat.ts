/**
 * Chat routes — real-time admin ↔ guard messaging per site
 * GET    /api/chat/rooms                       list rooms (admin: all in company; guard: their rooms)
 * POST   /api/chat/rooms                       create room (admin only, idempotent)
 * GET    /api/chat/rooms/:roomId/messages      paginated messages (cursor via ?before=messageId)
 * POST   /api/chat/rooms/:roomId/messages      send message + push + notification log
 * POST   /api/chat/rooms/:roomId/mark-read     mark every message in this room read for the caller
 *
 * unread_count on GET /rooms is derived from chat_room_reads.last_read_at, so
 * "guard opens room → POST mark-read" actually resets the badge. New admin
 * messages after that timestamp count as unread again.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { insertNotification } from '../services/notifications';

const router = Router();

// ── GET /api/chat/rooms ───────────────────────────────────────────────────
// unread_count = count(messages from the OTHER party newer than my last_read_at).
// last_read_at defaults to epoch when no row exists, so unread starts at "all of them".
router.get('/rooms', requireAuth('company_admin', 'guard'), async (req, res) => {
  const { user } = req;

  if (user!.role === 'company_admin') {
    const result = await pool.query(
      `SELECT
         cr.id,
         cr.site_id,
         s.name   AS site_name,
         cr.guard_id,
         g.name   AS guard_name,
         cr.created_at,
         (SELECT cm.message    FROM chat_messages cm WHERE cm.room_id = cr.id ORDER BY cm.created_at DESC LIMIT 1) AS last_message,
         (SELECT cm.created_at FROM chat_messages cm WHERE cm.room_id = cr.id ORDER BY cm.created_at DESC LIMIT 1) AS last_message_at,
         (SELECT COUNT(*)::int FROM chat_messages cm
            WHERE cm.room_id = cr.id
              AND cm.sender_role = 'guard'
              AND cm.created_at > COALESCE(
                (SELECT last_read_at FROM chat_room_reads
                  WHERE room_id = cr.id AND user_id = $2 AND user_role = 'admin'),
                'epoch'::timestamptz
              )
         ) AS unread_count
       FROM chat_rooms cr
       JOIN sites  s ON s.id = cr.site_id
       JOIN guards g ON g.id = cr.guard_id
       WHERE cr.company_id = $1
       ORDER BY last_message_at DESC NULLS LAST`,
      [user!.company_id, user!.sub],
    );
    return res.json(result.rows);
  }

  // Guard role
  const result = await pool.query(
    `SELECT
       cr.id,
       cr.site_id,
       s.name   AS site_name,
       cr.guard_id,
       g.name   AS guard_name,
       cr.created_at,
       (SELECT cm.message    FROM chat_messages cm WHERE cm.room_id = cr.id ORDER BY cm.created_at DESC LIMIT 1) AS last_message,
       (SELECT cm.created_at FROM chat_messages cm WHERE cm.room_id = cr.id ORDER BY cm.created_at DESC LIMIT 1) AS last_message_at,
       (SELECT COUNT(*)::int FROM chat_messages cm
          WHERE cm.room_id = cr.id
            AND cm.sender_role = 'admin'
            AND cm.created_at > COALESCE(
              (SELECT last_read_at FROM chat_room_reads
                WHERE room_id = cr.id AND user_id = $1 AND user_role = 'guard'),
              'epoch'::timestamptz
            )
       ) AS unread_count
     FROM chat_rooms cr
     JOIN sites  s ON s.id = cr.site_id
     JOIN guards g ON g.id = cr.guard_id
     WHERE cr.guard_id = $1
     ORDER BY last_message_at DESC NULLS LAST`,
    [user!.sub],
  );
  res.json(result.rows);
});

// ── POST /api/chat/rooms ──────────────────────────────────────────────────
router.post('/rooms', requireAuth('company_admin'), async (req, res) => {
  const { site_id, guard_id } = req.body;
  if (!site_id || !guard_id) return res.status(400).json({ error: 'site_id and guard_id are required' });

  // Verify site belongs to company
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(400).json({ error: 'Site not found' });

  // Verify guard belongs to company
  const guardCheck = await pool.query(
    'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
    [guard_id, req.user!.company_id]
  );
  if (!guardCheck.rows[0]) return res.status(400).json({ error: 'Guard not found' });

  // Upsert — idempotent
  const result = await pool.query(
    `INSERT INTO chat_rooms (company_id, site_id, guard_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (site_id, guard_id) DO UPDATE SET site_id = EXCLUDED.site_id
     RETURNING *`,
    [req.user!.company_id, site_id, guard_id]
  );
  res.status(201).json(result.rows[0]);
});

// ── GET /api/chat/rooms/:roomId/messages ─────────────────────────────────
router.get('/rooms/:roomId/messages', requireAuth('company_admin', 'guard'), async (req, res) => {
  const { user } = req;
  const { roomId } = req.params;
  const { before } = req.query;

  // Verify access
  const room = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [roomId]);
  if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });
  const r = room.rows[0];
  if (user!.role === 'company_admin' && r.company_id !== user!.company_id)
    return res.status(403).json({ error: 'Access denied' });
  if (user!.role === 'guard' && r.guard_id !== user!.sub)
    return res.status(403).json({ error: 'Access denied' });

  let query: string;
  let params: (string | number)[];

  if (before) {
    const cursor = await pool.query('SELECT created_at FROM chat_messages WHERE id = $1', [before]);
    if (!cursor.rows[0]) return res.status(400).json({ error: 'Invalid cursor' });
    query = `SELECT * FROM chat_messages WHERE room_id = $1 AND created_at < $2 ORDER BY created_at ASC LIMIT 50`;
    params = [roomId, cursor.rows[0].created_at];
  } else {
    query = `SELECT * FROM chat_messages WHERE room_id = $1 ORDER BY created_at ASC LIMIT 50`;
    params = [roomId];
  }

  const result = await pool.query(query, params);
  res.json(result.rows);
});

// ── POST /api/chat/rooms/:roomId/messages ────────────────────────────────
router.post('/rooms/:roomId/messages', requireAuth('company_admin', 'guard'), async (req, res) => {
  const { user } = req;
  const { roomId } = req.params;
  const { message } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'message is required' });

  // Verify access
  const room = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [roomId]);
  if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });
  const r = room.rows[0];
  if (user!.role === 'company_admin' && r.company_id !== user!.company_id)
    return res.status(403).json({ error: 'Access denied' });
  if (user!.role === 'guard' && r.guard_id !== user!.sub)
    return res.status(403).json({ error: 'Access denied' });

  const senderRole = user!.role === 'company_admin' ? 'admin' : 'guard';

  const saved = await pool.query(
    `INSERT INTO chat_messages (room_id, sender_role, sender_id, message)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [roomId, senderRole, user!.sub, message.trim()]
  );

  // ── FCM push + notification log ──────────────────────────────────────
  const preview = message.trim().slice(0, 50);

  if (senderRole === 'admin') {
    // Push + log to guard
    try {
      const guardRow = await pool.query('SELECT name, fcm_token FROM guards WHERE id = $1', [r.guard_id]);
      const g = guardRow.rows[0];
      const adminRow = await pool.query('SELECT name FROM company_admins WHERE id = $1', [user!.sub]);
      const senderName = adminRow.rows[0]?.name ?? 'Admin';
      const title = `New message from ${senderName}`;
      if (g?.fcm_token) {
        await sendPushNotification({
          token: g.fcm_token,
          title,
          body: preview,
          data: { type: 'chat', roomId },
        });
      }
      await insertNotification({
        guardId: r.guard_id,
        type:    'chat',
        title,
        body:    preview,
        data:    { roomId },
      });
    } catch { /* skip silently */ }
  } else {
    // Push to all company admins (no notification-log persistence for admins yet)
    try {
      const guardRow = await pool.query('SELECT name FROM guards WHERE id = $1', [user!.sub]);
      const senderName = guardRow.rows[0]?.name ?? 'Guard';
      const adminRows = await pool.query(
        'SELECT fcm_token FROM company_admins WHERE company_id = $1 AND is_active = true AND fcm_token IS NOT NULL',
        [r.company_id]
      );
      await Promise.allSettled(
        adminRows.rows.map((a: { fcm_token: string }) =>
          sendPushNotification({
            token: a.fcm_token,
            title: `New message from ${senderName}`,
            body: preview,
            data: { type: 'chat', roomId },
          })
        )
      );
    } catch { /* skip silently */ }
  }

  res.status(201).json(saved.rows[0]);
});

// ── POST /api/chat/rooms/:roomId/mark-read ────────────────────────────────
// Resets unread_count for the caller in this room. Called by mobile/web when
// the user enters the room. New messages from the other party after this
// timestamp will count toward unread again.
router.post('/rooms/:roomId/mark-read', requireAuth('company_admin', 'guard'), async (req, res) => {
  const { user } = req;
  const { roomId } = req.params;

  // Verify access
  const room = await pool.query('SELECT * FROM chat_rooms WHERE id = $1', [roomId]);
  if (!room.rows[0]) return res.status(404).json({ error: 'Room not found' });
  const r = room.rows[0];
  if (user!.role === 'company_admin' && r.company_id !== user!.company_id)
    return res.status(403).json({ error: 'Access denied' });
  if (user!.role === 'guard' && r.guard_id !== user!.sub)
    return res.status(403).json({ error: 'Access denied' });

  const userRole = user!.role === 'company_admin' ? 'admin' : 'guard';

  await pool.query(
    `INSERT INTO chat_room_reads (room_id, user_id, user_role, last_read_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (room_id, user_id, user_role)
     DO UPDATE SET last_read_at = NOW()`,
    [roomId, user!.sub, userRole],
  );

  res.json({ ok: true });
});

export default router;
