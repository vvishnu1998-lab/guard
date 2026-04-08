import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendIncidentAlert } from '../services/email';

const router = Router();

// GET /api/reports — scoped by role
// CRITICAL: always filters by site_id or company_id (see Section 11.5)
router.get('/', requireAuth('guard', 'company_admin', 'client'), async (req, res) => {
  const { user } = req;
  const { type, severity, site_id: filter_site_id, date_from, date_to } = req.query;
  let query: string;
  let params: unknown[];

  if (user!.role === 'client') {
    // Client: strictly scoped to their site_id only
    query = `SELECT r.*, array_agg(rp.storage_url ORDER BY rp.photo_index) FILTER (WHERE rp.id IS NOT NULL) as photos
             FROM reports r LEFT JOIN report_photos rp ON rp.report_id = r.id
             WHERE r.site_id = $1`;
    params = [user!.site_id];
  } else if (user!.role === 'guard') {
    query = `SELECT r.* FROM reports r
             JOIN shift_sessions ss ON ss.id = r.shift_session_id
             WHERE ss.guard_id = $1`;
    params = [user!.sub];
  } else {
    // company_admin: scoped to company
    query = `SELECT r.*, g.name as guard_name, si.name as site_name
             FROM reports r
             JOIN sites si ON si.id = r.site_id
             JOIN shift_sessions ss ON ss.id = r.shift_session_id
             JOIN guards g ON g.id = ss.guard_id
             WHERE si.company_id = $1`;
    params = [user!.company_id];
  }

  if (type)           { query += ` AND r.report_type = $${params.length + 1}`; params.push(type); }
  if (severity)       { query += ` AND r.severity = $${params.length + 1}`; params.push(severity); }
  if (filter_site_id && user!.role === 'company_admin') {
    query += ` AND r.site_id = $${params.length + 1}`; params.push(filter_site_id);
  }
  if (date_from)      { query += ` AND r.reported_at >= $${params.length + 1}`; params.push(date_from); }
  if (date_to)        { query += ` AND r.reported_at <= $${params.length + 1}`; params.push(date_to); }

  if (user!.role === 'client') query += ' GROUP BY r.id';
  query += ' ORDER BY r.reported_at DESC LIMIT 100';

  const result = await pool.query(query, params);
  res.json(result.rows);
});

// POST /api/reports — guard submits a report
router.post('/', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, report_type, description, severity, photo_urls, latitude, longitude } = req.body;

  if (!['activity', 'incident', 'maintenance'].includes(report_type)) {
    return res.status(400).json({ error: 'report_type must be activity, incident, or maintenance' });
  }
  if (!description?.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }
  if (report_type === 'incident' && !severity) {
    return res.status(400).json({ error: 'severity is required for incident reports' });
  }

  // Verify session belongs to guard and is still open
  const sessionResult = await pool.query(
    'SELECT site_id FROM shift_sessions WHERE id = $1 AND guard_id = $2 AND clocked_out_at IS NULL',
    [shift_session_id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Active session not found' });
  const { site_id } = sessionResult.rows[0];

  // Geofence validation — block submission if guard has an unresolved violation
  const violationResult = await pool.query(
    `SELECT id FROM geofence_violations
     WHERE shift_session_id = $1 AND resolved_at IS NULL
     LIMIT 1`,
    [shift_session_id]
  );
  if (violationResult.rows[0]) {
    return res.status(403).json({ error: 'Cannot submit report while a geofence violation is unresolved' });
  }

  // Get site contract_end for delete_at calculation
  const siteResult = await pool.query('SELECT contract_end FROM sites WHERE id = $1', [site_id]);
  const deleteAt = new Date(siteResult.rows[0].contract_end);
  deleteAt.setDate(deleteAt.getDate() + 150);

  const reportResult = await pool.query(
    `INSERT INTO reports (shift_session_id, site_id, report_type, description, severity, delete_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [shift_session_id, site_id, report_type, description, severity || null, deleteAt]
  );
  const report = reportResult.rows[0];

  // Insert photos (pre-signed S3 upload URLs already processed by client)
  if (photo_urls?.length) {
    for (let i = 0; i < photo_urls.length; i++) {
      await pool.query(
        `INSERT INTO report_photos (report_id, storage_url, file_size_kb, photo_index, delete_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [report.id, photo_urls[i].url, photo_urls[i].size_kb, i + 1, deleteAt]
      );
    }
  }

  // Email: only incident reports trigger immediate alert (Section 4)
  if (report_type === 'incident') {
    sendIncidentAlert(report, site_id).catch(console.error);
  }

  res.status(201).json(report);
});

export default router;
