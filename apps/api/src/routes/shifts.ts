import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { generateTaskInstancesForShift } from '../services/tasks';

const router = Router();

// POST /api/shifts — admin schedules a new shift
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { guard_id, site_id, scheduled_start, scheduled_end } = req.body;
  if (!guard_id || !site_id || !scheduled_start || !scheduled_end) {
    return res.status(400).json({ error: 'guard_id, site_id, scheduled_start, scheduled_end are required' });
  }
  // Verify guard and site belong to this company
  const [guardCheck, siteCheck] = await Promise.all([
    pool.query('SELECT id FROM guards WHERE id = $1 AND company_id = $2 AND is_active = true', [guard_id, req.user!.company_id]),
    pool.query('SELECT id FROM sites WHERE id = $1 AND company_id = $2', [site_id, req.user!.company_id]),
  ]);
  if (!guardCheck.rows[0]) return res.status(400).json({ error: 'Guard not found or inactive' });
  if (!siteCheck.rows[0])  return res.status(400).json({ error: 'Site not found' });

  const result = await pool.query(
    `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [guard_id, site_id, scheduled_start, scheduled_end]
  );
  res.status(201).json(result.rows[0]);
});

// GET /api/shifts  — guard sees their shifts; admin sees all for company
router.get('/', requireAuth('guard', 'company_admin'), async (req, res) => {
  const { user } = req;
  let result;
  if (user!.role === 'guard') {
    result = await pool.query(
      `SELECT s.*, si.name as site_name
       FROM shifts s JOIN sites si ON s.site_id = si.id
       WHERE s.guard_id = $1 ORDER BY s.scheduled_start DESC LIMIT 50`,
      [user!.sub]
    );
  } else {
    result = await pool.query(
      `SELECT s.*, si.name as site_name, g.name as guard_name
       FROM shifts s
       JOIN sites si ON s.site_id = si.id
       JOIN guards g ON s.guard_id = g.id
       WHERE si.company_id = $1 ORDER BY s.scheduled_start DESC LIMIT 100`,
      [user!.company_id]
    );
  }
  res.json(result.rows);
});

// GET /api/shifts/active-session — returns the guard's current active shift+session (for store restoration)
router.get('/active-session', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT s.id as shift_id, s.site_id, s.scheduled_start, s.scheduled_end,
            si.name as site_name,
            ss.id as session_id, ss.clocked_in_at
     FROM shifts s
     JOIN sites si ON si.id = s.site_id
     JOIN shift_sessions ss ON ss.shift_id = s.id AND ss.guard_id = $1 AND ss.clocked_out_at IS NULL
     WHERE s.guard_id = $1 AND s.status = 'active'
     ORDER BY ss.clocked_in_at DESC LIMIT 1`,
    [req.user!.sub]
  );
  if (!result.rows[0]) return res.json(null);
  const r = result.rows[0];
  res.json({
    shift:   { id: r.shift_id, site_id: r.site_id, site_name: r.site_name, scheduled_start: r.scheduled_start, scheduled_end: r.scheduled_end },
    session: { id: r.session_id, shift_id: r.shift_id, clocked_in_at: r.clocked_in_at },
  });
});

// POST /api/shifts/:id/clock-in  — creates shift_session + triggers task instance generation
router.post('/:id/clock-in', requireAuth('guard'), async (req, res) => {
  const { id } = req.params;
  const { clock_in_coords } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftResult = await client.query(
      'SELECT * FROM shifts WHERE id = $1 AND guard_id = $2 AND status = $3',
      [id, req.user!.sub, 'scheduled']
    );
    if (!shiftResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found or not schedulable' });
    }
    const shift = shiftResult.rows[0];
    const sessionResult = await client.query(
      `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords)
       VALUES ($1, $2, $3, NOW(), $4) RETURNING *`,
      [id, req.user!.sub, shift.site_id, clock_in_coords]
    );
    await client.query('UPDATE shifts SET status = $1 WHERE id = $2', ['active', id]);
    const session = sessionResult.rows[0];
    await client.query('COMMIT');
    // Generate task instances outside transaction (non-critical)
    generateTaskInstancesForShift(id, shift.site_id, session.clocked_in_at).catch(console.error);
    res.status(201).json(session);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/shifts/:id/clock-out
router.post('/:id/clock-out', requireAuth('guard'), async (req, res) => {
  const { id } = req.params;
  const { handover_notes } = req.body;
  const sessionResult = await pool.query(
    `UPDATE shift_sessions SET clocked_out_at = NOW()
     WHERE shift_id = $1 AND guard_id = $2 AND clocked_out_at IS NULL
     RETURNING *`,
    [id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(404).json({ error: 'Active session not found' });
  // Calculate total_hours minus breaks
  const session = sessionResult.rows[0];
  const breaksResult = await pool.query(
    'SELECT COALESCE(SUM(duration_minutes), 0) as total_break_mins FROM break_sessions WHERE shift_session_id = $1',
    [session.id]
  );
  const grossHours = (session.clocked_out_at - session.clocked_in_at) / 3600000;
  const breakHours = breaksResult.rows[0].total_break_mins / 60;
  const netHours = Math.max(0, grossHours - breakHours);
  await pool.query(
    'UPDATE shift_sessions SET total_hours = $1 WHERE id = $2',
    [netHours, session.id]
  );
  await pool.query('UPDATE shifts SET status = $1 WHERE id = $2', ['completed', id]);
  res.json({ ...session, total_hours: netHours, handover_notes });
});

export default router;
