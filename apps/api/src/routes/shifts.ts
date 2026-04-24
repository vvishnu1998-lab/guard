import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { generateTaskInstancesForShift } from '../services/tasks';

const router = Router();

// POST /api/shifts — admin schedules a new shift (guard_id is optional)
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { guard_id, site_id, scheduled_start, scheduled_end, repeat_days } = req.body;
  if (!site_id || !scheduled_start || !scheduled_end) {
    return res.status(400).json({ error: 'site_id, scheduled_start, scheduled_end are required' });
  }

  // Verify site belongs to this company
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(400).json({ error: 'Site not found' });

  // If guard_id provided, verify it
  if (guard_id) {
    const guardCheck = await pool.query(
      'SELECT id FROM guards WHERE id = $1 AND company_id = $2 AND is_active = true',
      [guard_id, req.user!.company_id]
    );
    if (!guardCheck.rows[0]) return res.status(400).json({ error: 'Guard not found or inactive' });
  }

  const status = guard_id ? 'scheduled' : 'unassigned';

  // If repeat_days provided, create one shift per selected day within 4 weeks
  if (Array.isArray(repeat_days) && repeat_days.length > 0) {
    const baseStart = new Date(scheduled_start);
    const baseEnd   = new Date(scheduled_end);
    const durationMs = baseEnd.getTime() - baseStart.getTime();

    // Collect all dates within 4 weeks from base start
    const created: object[] = [];
    const horizon = new Date(baseStart);
    horizon.setDate(horizon.getDate() + 28); // 4 weeks

    const cur = new Date(baseStart);
    // Start from the base date and iterate each day for 28 days
    while (cur <= horizon) {
      const dow = cur.getDay(); // 0=Sun..6=Sat
      if (repeat_days.includes(dow)) {
        const shiftStart = new Date(cur);
        // preserve time-of-day from baseStart
        shiftStart.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds(), 0);
        const shiftEnd = new Date(shiftStart.getTime() + durationMs);
        const r = await pool.query(
          `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [guard_id || null, site_id, shiftStart.toISOString(), shiftEnd.toISOString(), status]
        );
        created.push(r.rows[0]);
      }
      cur.setDate(cur.getDate() + 1);
    }
    return res.status(201).json(created);
  }

  // Single shift
  const result = await pool.query(
    `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [guard_id || null, site_id, scheduled_start, scheduled_end, status]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /api/admin/shifts/:id/assign-guard
router.patch('/:id/assign-guard', requireAuth('company_admin'), async (req, res) => {
  const { guard_id } = req.body;
  if (!guard_id) return res.status(400).json({ error: 'guard_id is required' });

  // Verify guard and shift belong to this company
  const [guardCheck, shiftCheck] = await Promise.all([
    pool.query(
      'SELECT id FROM guards WHERE id = $1 AND company_id = $2 AND is_active = true',
      [guard_id, req.user!.company_id]
    ),
    pool.query(
      `SELECT s.id FROM shifts s
       JOIN sites si ON si.id = s.site_id
       WHERE s.id = $1 AND si.company_id = $2`,
      [req.params.id, req.user!.company_id]
    ),
  ]);
  if (!guardCheck.rows[0]) return res.status(400).json({ error: 'Guard not found or inactive' });
  if (!shiftCheck.rows[0]) return res.status(404).json({ error: 'Shift not found' });

  const result = await pool.query(
    `UPDATE shifts SET guard_id = $1, status = 'scheduled'
     WHERE id = $2 RETURNING *`,
    [guard_id, req.params.id]
  );
  res.json(result.rows[0]);
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
       LEFT JOIN guards g ON s.guard_id = g.id
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
       AND s.scheduled_end > NOW() - INTERVAL '2 hours'
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

// POST /api/shifts/break-start — guard starts a break
router.post('/break-start', requireAuth('guard'), async (req, res) => {
  const { session_id, break_type } = req.body;
  if (!session_id || !break_type) {
    return res.status(400).json({ error: 'session_id and break_type are required' });
  }
  try {
    // Verify session belongs to this guard and is open
    const sessionResult = await pool.query(
      'SELECT site_id FROM shift_sessions WHERE id = $1 AND guard_id = $2 AND clocked_out_at IS NULL',
      [session_id, req.user!.sub]
    );
    if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Active session not found' });
    const { site_id } = sessionResult.rows[0];

    const result = await pool.query(
      `INSERT INTO break_sessions (shift_session_id, guard_id, site_id, break_start, break_type)
       VALUES ($1, $2, $3, NOW(), $4) RETURNING id`,
      [session_id, req.user!.sub, site_id, break_type]
    );
    res.status(201).json({ break_id: result.rows[0].id });
  } catch (err: any) {
    console.error('break-start error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to start break' });
  }
});

// POST /api/shifts/break-end — guard ends a break
router.post('/break-end', requireAuth('guard'), async (req, res) => {
  const { break_id } = req.body;
  if (!break_id) return res.status(400).json({ error: 'break_id is required' });

  try {
    const result = await pool.query(
      `UPDATE break_sessions
       SET break_end = NOW(),
           duration_minutes = EXTRACT(EPOCH FROM (NOW() - break_start)) / 60
       WHERE id = $1 AND guard_id = $2 AND break_end IS NULL
       RETURNING *`,
      [break_id, req.user!.sub]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Break not found or already ended' });
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error('break-end error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to end break' });
  }
});

// POST /api/shifts/:id/clock-in — creates shift_session + triggers task instance generation
//
// Concurrency model (CB2/CB3, audit/WEEK1.md C2):
//   - SELECT … FOR UPDATE locks the `shifts` row so two near-simultaneous
//     clock-in attempts from two devices serialise here.
//   - The partial unique index `idx_shift_sessions_one_open_per_guard`
//     (schema_v9.sql) is the last-line backstop: if the FOR UPDATE check
//     races past somehow, the INSERT raises 23505 and we return 409.
router.post('/:id/clock-in', requireAuth('guard'), async (req, res) => {
  const { id } = req.params;
  const { clock_in_coords } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftResult = await client.query(
      'SELECT * FROM shifts WHERE id = $1 AND guard_id = $2 AND status = $3 FOR UPDATE',
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
  } catch (err: any) {
    await client.query('ROLLBACK');
    // 23505 = unique_violation on idx_shift_sessions_one_open_per_guard
    if (err?.code === '23505' && err?.constraint === 'idx_shift_sessions_one_open_per_guard') {
      return res.status(409).json({
        error: 'Already clocked in on another device. Clock out first.',
      });
    }
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/shifts/:id/clock-out
//
// Wrapped in an explicit transaction (CB2/CB3): previously four independent
// queries fired outside any transaction, so a crash between them could leave
// total_hours NULL or shifts.status stuck on 'active'.  Now closes the open
// session, sets total_hours = gross − breaks, and completes the shift in one
// atomic unit.
router.post('/:id/clock-out', requireAuth('guard'), async (req, res) => {
  const { id } = req.params;
  const { handover_notes } = req.body;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Close the session and grab the existing clocked_in_at for math
    const sessionResult = await client.query(
      `UPDATE shift_sessions SET clocked_out_at = NOW()
       WHERE shift_id = $1 AND guard_id = $2 AND clocked_out_at IS NULL
       RETURNING id, clocked_in_at, clocked_out_at`,
      [id, req.user!.sub]
    );
    if (!sessionResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active session not found' });
    }
    const session = sessionResult.rows[0];

    // Close any break that was still open when the guard clocked out
    await client.query(
      `UPDATE break_sessions
       SET break_end = NOW(),
           duration_minutes = GREATEST(
             0,
             ROUND(EXTRACT(EPOCH FROM (NOW() - break_start)) / 60.0)::INT
           )
       WHERE shift_session_id = $1 AND break_end IS NULL`,
      [session.id]
    );

    // Compute total_hours = gross − breaks (matches autoCompleteShifts math)
    const breaksResult = await client.query(
      'SELECT COALESCE(SUM(duration_minutes), 0) AS total_break_mins FROM break_sessions WHERE shift_session_id = $1',
      [session.id]
    );
    const grossHours = (new Date(session.clocked_out_at).getTime()
                       - new Date(session.clocked_in_at).getTime()) / 3_600_000;
    const breakHours = Number(breaksResult.rows[0].total_break_mins) / 60;
    const netHours   = Math.max(0, grossHours - breakHours);

    await client.query(
      'UPDATE shift_sessions SET total_hours = $1, handover_notes = $2 WHERE id = $3',
      [netHours, handover_notes ?? null, session.id]
    );
    await client.query('UPDATE shifts SET status = $1 WHERE id = $2', ['completed', id]);

    await client.query('COMMIT');
    res.json({ ...session, total_hours: netHours, handover_notes: handover_notes ?? null });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('clock-out error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to clock out' });
  } finally {
    client.release();
  }
});

export default router;
