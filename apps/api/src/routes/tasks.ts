import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';

const router = Router();

// GET /api/tasks/instances — guard sees tasks for their current shift
// Security: verifies the shift belongs to the requesting guard
router.get('/instances', requireAuth('guard'), async (req, res) => {
  const { shift_id } = req.query;
  if (!shift_id) return res.status(400).json({ error: 'shift_id is required' });

  // Confirm shift belongs to this guard
  const ownerCheck = await pool.query(
    'SELECT id FROM shifts WHERE id = $1 AND guard_id = $2',
    [shift_id, req.user!.sub]
  );
  if (!ownerCheck.rows[0]) return res.status(403).json({ error: 'Shift not found' });

  const result = await pool.query(
    `SELECT ti.*,
            tt.requires_photo,
            tt.description as template_description,
            tc.completed_at,
            tc.photo_url    as completion_photo,
            tc.completion_lat,
            tc.completion_lng
     FROM task_instances ti
     JOIN task_templates tt ON tt.id = ti.template_id
     LEFT JOIN task_completions tc ON tc.task_instance_id = ti.id
     WHERE ti.shift_id = $1
     ORDER BY ti.due_at ASC NULLS LAST`,
    [shift_id]
  );
  res.json(result.rows);
});

// POST /api/tasks/instances/:id/complete
router.post('/instances/:id/complete', requireAuth('guard'), async (req, res) => {
  const { completion_lat, completion_lng, photo_url, shift_session_id } = req.body;

  // Verify task requires_photo constraint
  const taskResult = await pool.query(
    `SELECT ti.id, tt.requires_photo FROM task_instances ti
     JOIN task_templates tt ON tt.id = ti.template_id
     WHERE ti.id = $1 AND ti.status = 'pending'`,
    [req.params.id]
  );
  const task = taskResult.rows[0];
  if (!task) return res.status(404).json({ error: 'Task not found or already completed' });
  if (task.requires_photo && !photo_url) {
    return res.status(400).json({ error: 'Photo required to complete this task' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO task_completions (task_instance_id, shift_session_id, guard_id, completion_lat, completion_lng, photo_url)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [req.params.id, shift_session_id, req.user!.sub, completion_lat, completion_lng, photo_url || null]
    );
    await client.query("UPDATE task_instances SET status = 'completed' WHERE id = $1", [req.params.id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /api/tasks/templates — admin manages templates for their sites
router.get('/templates', requireAuth('company_admin'), async (req, res) => {
  const { site_id } = req.query;
  const result = await pool.query(
    `SELECT tt.* FROM task_templates tt
     JOIN sites s ON s.id = tt.site_id
     WHERE s.company_id = $1 ${site_id ? 'AND tt.site_id = $2' : ''}
     ORDER BY tt.created_at DESC`,
    site_id ? [req.user!.company_id, site_id] : [req.user!.company_id]
  );
  res.json(result.rows);
});

// POST /api/tasks/templates
router.post('/templates', requireAuth('company_admin'), async (req, res) => {
  const { site_id, title, description, scheduled_time, recurrence, requires_photo } = req.body;
  // Verify site belongs to admin's company
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  const result = await pool.query(
    `INSERT INTO task_templates (site_id, created_by_admin, title, description, scheduled_time, recurrence, requires_photo)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [site_id, req.user!.sub, title, description, scheduled_time, recurrence, requires_photo ?? false]
  );
  res.status(201).json(result.rows[0]);

  // F5: push to guards currently on shift at this site — non-blocking
  pool.query<{ fcm_token: string }>(
    `SELECT g.fcm_token
     FROM shift_sessions ss
     JOIN guards g ON g.id = ss.guard_id
     WHERE ss.site_id = $1 AND ss.clocked_out_at IS NULL AND g.fcm_token IS NOT NULL`,
    [site_id]
  ).then(({ rows }) => {
    if (!rows.length) return;
    return Promise.allSettled(
      rows.map((r) =>
        sendPushNotification({
          token: r.fcm_token,
          title: 'New task',
          body:  title ?? 'A new task has been assigned to your site.',
          data:  { type: 'task_assigned', site_id },
        })
      )
    );
  }).catch((err) => console.error('[fcm] task assign push failed:', err));
});

// PATCH /api/tasks/templates/:id — update a template (company-scoped)
router.patch('/templates/:id', requireAuth('company_admin'), async (req, res) => {
  const { title, description, scheduled_time, recurrence, requires_photo, is_active } = req.body;

  // Verify template belongs to this admin's company
  const ownerCheck = await pool.query(
    `SELECT tt.id FROM task_templates tt
     JOIN sites s ON s.id = tt.site_id
     WHERE tt.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Template not found' });

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (title           !== undefined) { fields.push(`title = $${idx++}`);           values.push(title); }
  if (description     !== undefined) { fields.push(`description = $${idx++}`);     values.push(description); }
  if (scheduled_time  !== undefined) { fields.push(`scheduled_time = $${idx++}`);  values.push(scheduled_time); }
  if (recurrence      !== undefined) { fields.push(`recurrence = $${idx++}`);      values.push(recurrence); }
  if (requires_photo  !== undefined) { fields.push(`requires_photo = $${idx++}`);  values.push(requires_photo); }
  if (is_active       !== undefined) { fields.push(`is_active = $${idx++}`);       values.push(is_active); }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(req.params.id);
  const result = await pool.query(
    `UPDATE task_templates SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );
  res.json(result.rows[0]);
});

// DELETE /api/tasks/templates/:id — soft deactivate (is_active = false)
// Hard delete is intentionally not supported; instances already generated must remain.
router.delete('/templates/:id', requireAuth('company_admin'), async (req, res) => {
  const ownerCheck = await pool.query(
    `SELECT tt.id FROM task_templates tt
     JOIN sites s ON s.id = tt.site_id
     WHERE tt.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Template not found' });

  await pool.query(
    'UPDATE task_templates SET is_active = false WHERE id = $1',
    [req.params.id]
  );
  res.json({ success: true });
});

// GET /api/tasks/admin/instances — admin views all task instances for a shift (company-scoped)
router.get('/admin/instances', requireAuth('company_admin'), async (req, res) => {
  const { shift_id, site_id, status } = req.query;

  let query = `
    SELECT ti.*, tt.requires_photo, tt.title as template_title,
           tc.completed_at, tc.photo_url as completion_photo,
           g.name as guard_name
    FROM task_instances ti
    JOIN task_templates tt ON tt.id = ti.template_id
    JOIN sites s ON s.id = ti.site_id
    JOIN shifts sh ON sh.id = ti.shift_id
    JOIN guards g ON g.id = sh.guard_id
    LEFT JOIN task_completions tc ON tc.task_instance_id = ti.id
    WHERE s.company_id = $1`;
  const params: unknown[] = [req.user!.company_id];

  if (shift_id) { query += ` AND ti.shift_id = $${params.length + 1}`;  params.push(shift_id); }
  if (site_id)  { query += ` AND ti.site_id  = $${params.length + 1}`;  params.push(site_id); }
  if (status)   { query += ` AND ti.status   = $${params.length + 1}`;  params.push(status); }

  query += ' ORDER BY ti.due_at ASC NULLS LAST LIMIT 200';

  const result = await pool.query(query, params);
  res.json(result.rows);
});

export default router;
