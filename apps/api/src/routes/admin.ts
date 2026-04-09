import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';

const router = Router();

// ── Vishnu Super Admin routes ────────────────────────────────────────────────

// GET /api/admin/vishnu-kpis — platform-wide summary
router.get('/vishnu-kpis', requireAuth('vishnu'), async (_req, res) => {
  const [companies, sites, guards, pending] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM companies WHERE is_active = true`),
    pool.query(`SELECT COUNT(*) FROM sites    WHERE is_active = true AND contract_end >= NOW()`),
    pool.query(`SELECT COUNT(*) FROM guards   WHERE is_active = true`),
    pool.query(
      `SELECT COUNT(*) FROM data_retention_log
       WHERE data_deleted = false AND data_delete_at < NOW() + INTERVAL '30 days'`
    ),
  ]);
  res.json({
    total_companies:   parseInt(companies.rows[0].count),
    active_sites:      parseInt(sites.rows[0].count),
    active_guards:     parseInt(guards.rows[0].count),
    pending_deletions: parseInt(pending.rows[0].count),
  });
});

// GET /api/admin/companies — list all companies with aggregated stats
router.get('/companies', requireAuth('vishnu'), async (_req, res) => {
  const result = await pool.query(
    `SELECT
       co.id, co.name, co.default_photo_limit, co.is_active, co.created_at,
       COUNT(DISTINCT s.id)  FILTER (WHERE s.is_active = true AND s.contract_end >= NOW()) AS active_sites,
       COUNT(DISTINCT g.id)  FILTER (WHERE g.is_active = true)                             AS active_guards,
       COUNT(DISTINCT ca.id)                                                                AS admin_count
     FROM companies co
     LEFT JOIN sites          s  ON s.company_id  = co.id
     LEFT JOIN guards         g  ON g.company_id  = co.id
     LEFT JOIN company_admins ca ON ca.company_id = co.id
     GROUP BY co.id
     ORDER BY co.created_at DESC`
  );
  res.json(result.rows);
});

// POST /api/admin/companies — create company
router.post('/companies', requireAuth('vishnu'), async (req, res) => {
  const { name, default_photo_limit } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const result = await pool.query(
    'INSERT INTO companies (name, default_photo_limit) VALUES ($1, $2) RETURNING *',
    [name.trim(), default_photo_limit ?? 5]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /api/admin/companies/:id — update company name, photo limit, active status
router.patch('/companies/:id', requireAuth('vishnu'), async (req, res) => {
  const { name, default_photo_limit, is_active } = req.body;
  const sets: string[] = [];
  const params: unknown[] = [];
  if (name !== undefined)               { sets.push(`name = $${params.length + 1}`);                params.push(name.trim()); }
  if (default_photo_limit !== undefined){ sets.push(`default_photo_limit = $${params.length + 1}`); params.push(default_photo_limit); }
  if (is_active !== undefined)          { sets.push(`is_active = $${params.length + 1}`);           params.push(is_active); }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  const result = await pool.query(
    `UPDATE companies SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
    params
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Company not found' });
  res.json(result.rows[0]);
});

// GET /api/admin/companies/:id/admins — list admins for a company
router.get('/companies/:id/admins', requireAuth('vishnu'), async (req, res) => {
  const result = await pool.query(
    `SELECT id, name, email, is_primary, is_active, created_at
     FROM company_admins WHERE company_id = $1 ORDER BY is_primary DESC, created_at ASC`,
    [req.params.id]
  );
  res.json(result.rows);
});

// Vishnu: create a new admin for a company
router.post('/companies/:id/admins', requireAuth('vishnu'), async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email and password are required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const bcrypt = require('bcrypt');
  const password_hash = await bcrypt.hash(password, 10);

  // Check if this is the first admin for this company → make them primary
  const existing = await pool.query('SELECT id FROM company_admins WHERE company_id = $1', [req.params.id]);
  const is_primary = existing.rows.length === 0;

  const result = await pool.query(
    `INSERT INTO company_admins (id, company_id, name, email, password_hash, is_primary, is_active)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, true)
     RETURNING id, name, email, is_primary, is_active, created_at`,
    [req.params.id, name.trim(), email.toLowerCase().trim(), password_hash, is_primary]
  );
  res.status(201).json(result.rows[0]);
});

// Vishnu: override photo limit for a site (custom billing add-on)
router.patch('/sites/:id/photo-limit', requireAuth('vishnu'), async (req, res) => {
  const { photo_limit_override } = req.body;
  const result = await pool.query(
    'UPDATE sites SET photo_limit_override = $1 WHERE id = $2 RETURNING *',
    [photo_limit_override ?? null, req.params.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Site not found' });
  res.json(result.rows[0]);
});

// GET /api/admin/all-sites — every site across all companies (Vishnu view)
router.get('/all-sites', requireAuth('vishnu'), async (_req, res) => {
  const result = await pool.query(
    `SELECT
       s.id, s.name, s.address, s.is_active, s.contract_start, s.contract_end,
       s.photo_limit_override,
       co.id   AS company_id,
       co.name AS company_name,
       co.default_photo_limit,
       COALESCE(s.photo_limit_override, co.default_photo_limit) AS effective_photo_limit,
       COUNT(DISTINCT ss.id) FILTER (WHERE ss.clocked_out_at IS NULL) AS guards_on_duty
     FROM sites s
     JOIN companies co ON co.id = s.company_id
     LEFT JOIN shift_sessions ss ON ss.site_id = s.id
     GROUP BY s.id, co.id
     ORDER BY co.name ASC, s.name ASC`
  );
  res.json(result.rows);
});

// GET /api/admin/retention-status — all sites in or approaching retention window
router.get('/retention-status', requireAuth('vishnu'), async (_req, res) => {
  const result = await pool.query(
    `SELECT
       s.id AS site_id, s.name AS site_name,
       co.name AS company_name,
       drl.client_star_access_until,
       drl.data_delete_at,
       drl.warning_60_sent,
       drl.warning_89_sent,
       drl.warning_140_sent,
       drl.client_star_access_disabled,
       drl.data_deleted,
       EXTRACT(DAY FROM (drl.client_star_access_until - NOW()))::int AS days_to_access_end,
       EXTRACT(DAY FROM (drl.data_delete_at - NOW()))::int           AS days_to_deletion
     FROM data_retention_log drl
     JOIN sites s    ON s.id    = drl.site_id
     JOIN companies co ON co.id = s.company_id
     WHERE drl.data_deleted = false
     ORDER BY drl.data_delete_at ASC`
  );
  res.json(result.rows);
});

// Vishnu: transfer primary admin role
router.patch('/companies/:company_id/primary-admin/:admin_id', requireAuth('vishnu'), async (req, res) => {
  const { company_id, admin_id } = req.params;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE company_admins SET is_primary = false WHERE company_id = $1', [company_id]);
    await client.query('UPDATE company_admins SET is_primary = true WHERE id = $1 AND company_id = $2', [admin_id, company_id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// GET /api/admin/kpis — dashboard summary for company_admin
router.get('/kpis', requireAuth('company_admin'), async (req, res) => {
  const cid = req.user!.company_id;
  const [sites, duty, reports, alerts] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FROM sites WHERE company_id = $1 AND contract_end >= NOW()`,
      [cid]
    ),
    pool.query(
      `SELECT COUNT(DISTINCT ss.guard_id)
       FROM shift_sessions ss
       JOIN sites s ON s.id = ss.site_id
       WHERE s.company_id = $1 AND ss.clocked_out_at IS NULL`,
      [cid]
    ),
    pool.query(
      `SELECT COUNT(*) FROM reports r
       JOIN sites s ON s.id = r.site_id
       WHERE s.company_id = $1 AND r.reported_at >= CURRENT_DATE`,
      [cid]
    ),
    pool.query(
      `SELECT COUNT(*) FROM geofence_violations gv
       JOIN sites s ON s.id = gv.site_id
       WHERE s.company_id = $1 AND gv.resolved_at IS NULL`,
      [cid]
    ),
  ]);
  res.json({
    active_sites:    parseInt(sites.rows[0].count),
    guards_on_duty:  parseInt(duty.rows[0].count),
    reports_today:   parseInt(reports.rows[0].count),
    geofence_alerts: parseInt(alerts.rows[0].count),
  });
});

// GET /api/admin/live-guards — guards currently on shift with last known location
router.get('/live-guards', requireAuth('company_admin'), async (req, res) => {
  const result = await pool.query(
    `SELECT
       g.id, g.name, g.badge_number,
       s.name    AS site_name,
       ss.id     AS session_id,
       ss.clocked_in_at,
       lp.latitude  AS last_lat,
       lp.longitude AS last_lng,
       lp.pinged_at  AS last_ping_at,
       lp.ping_type  AS last_ping_type,
       EXISTS (
         SELECT 1 FROM geofence_violations gv
         WHERE gv.shift_session_id = ss.id AND gv.resolved_at IS NULL
       ) AS has_violation
     FROM shift_sessions ss
     JOIN guards g  ON g.id  = ss.guard_id
     JOIN sites  s  ON s.id  = ss.site_id
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, lp_inner.pinged_at, ping_type
       FROM location_pings lp_inner
       WHERE lp_inner.shift_session_id = ss.id
       ORDER BY lp_inner.pinged_at DESC LIMIT 1
     ) lp ON true
     WHERE s.company_id = $1 AND ss.clocked_out_at IS NULL
     ORDER BY s.name, g.name`,
    [req.user!.company_id]
  );
  res.json(result.rows);
});

// GET /api/admin/dashboard-sites — site summary for dashboard table
router.get('/dashboard-sites', requireAuth('company_admin'), async (req, res) => {
  const cid = req.user!.company_id;
  const result = await pool.query(
    `SELECT
       s.id, s.name,
       COUNT(DISTINCT ss.guard_id) FILTER (WHERE ss.clocked_out_at IS NULL) AS guard_count,
       COUNT(DISTINCT r.id) FILTER (WHERE r.reported_at >= CURRENT_DATE)    AS reports_today,
       COALESCE(SUM(ss.total_hours) FILTER (
         WHERE ss.clocked_in_at >= DATE_TRUNC('week', NOW())
       ), 0) AS hours_this_week,
       CASE WHEN s.contract_end >= NOW() THEN 'active' ELSE 'inactive' END AS status,
       CEIL(EXTRACT(EPOCH FROM (drl.data_delete_at - NOW())) / 86400)::INT AS days_until_deletion
     FROM sites s
     LEFT JOIN shift_sessions ss ON ss.site_id = s.id
     LEFT JOIN reports r ON r.site_id = s.id
     LEFT JOIN data_retention_log drl ON drl.site_id = s.id
     WHERE s.company_id = $1
     GROUP BY s.id, s.name, s.contract_end, drl.data_delete_at
     ORDER BY s.name`,
    [cid]
  );
  res.json(result.rows);
});

// GET /api/admin/recent-alerts — geofence violations + missed shifts, merged and sorted
router.get('/recent-alerts', requireAuth('company_admin'), async (req, res) => {
  const cid = req.user!.company_id;
  const result = await pool.query(
    `SELECT * FROM (

       -- Geofence violations
       SELECT
         gv.id::text,
         'geofence_violation'          AS type,
         'Guard left designated area'  AS description,
         s.name                        AS site_name,
         g.name                        AS guard_name,
         gv.occurred_at,
         (gv.resolved_at IS NOT NULL)  AS is_resolved
       FROM geofence_violations gv
       JOIN shift_sessions ss ON ss.id = gv.shift_session_id
       JOIN guards         g  ON g.id  = ss.guard_id
       JOIN sites          s  ON s.id  = gv.site_id
       WHERE s.company_id = $1

       UNION ALL

       -- Missed shifts — scheduled but no clock-in 15 min after start
       SELECT
         sh.id::text,
         'missed_shift'                                          AS type,
         'No guard clocked in 15+ minutes after scheduled start' AS description,
         s.name                                                  AS site_name,
         g.name                                                  AS guard_name,
         sh.scheduled_start                                      AS occurred_at,
         false                                                   AS is_resolved
       FROM shifts sh
       JOIN sites  s ON s.id = sh.site_id
       JOIN guards g ON g.id = sh.guard_id
       WHERE s.company_id = $1
         AND sh.status = 'scheduled'
         AND sh.scheduled_start + INTERVAL '15 minutes' <= NOW()
         AND sh.missed_alert_sent_at IS NOT NULL

     ) combined
     ORDER BY occurred_at DESC
     LIMIT 15`,
    [cid]
  );
  res.json(result.rows);
});

// Star primary admin: add company admin
router.post('/company-admins', requireAuth('company_admin'), async (req, res) => {
  const { name, email, password } = req.body;
  // Only primary admin can add others
  const callerResult = await pool.query(
    'SELECT is_primary FROM company_admins WHERE id = $1',
    [req.user!.sub]
  );
  if (!callerResult.rows[0]?.is_primary) {
    return res.status(403).json({ error: 'Only primary admin can add admins' });
  }
  const password_hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO company_admins (company_id, name, email, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, company_id, name, email, is_primary, is_active, created_at`,
    [req.user!.company_id, name, email, password_hash]
  );
  res.status(201).json(result.rows[0]);
});

// GET /api/admin/analytics — summary stats for analytics page
router.get('/analytics', requireAuth('company_admin'), async (req, res) => {
  const cid = req.user!.company_id;

  const [hoursResult, reportsByType, incidentBySeverity, guardPerf, monthlyHours] = await Promise.all([
    // Total hours this month
    pool.query(`
      SELECT COALESCE(ROUND(CAST(SUM(ss.total_hours) AS NUMERIC), 1), 0) AS total_hours
      FROM shift_sessions ss
      JOIN sites s ON s.id = ss.site_id
      WHERE s.company_id = $1
        AND ss.clocked_in_at >= DATE_TRUNC('month', NOW())
    `, [cid]),

    // Reports by type (last 30 days)
    pool.query(`
      SELECT r.report_type, COUNT(*) AS count
      FROM reports r
      JOIN sites s ON s.id = r.site_id
      WHERE s.company_id = $1
        AND r.reported_at >= NOW() - INTERVAL '30 days'
      GROUP BY r.report_type
    `, [cid]),

    // Incidents by severity (last 30 days)
    pool.query(`
      SELECT r.severity, COUNT(*) AS count
      FROM reports r
      JOIN sites s ON s.id = r.site_id
      WHERE s.company_id = $1
        AND r.report_type = 'incident'
        AND r.reported_at >= NOW() - INTERVAL '30 days'
      GROUP BY r.severity
    `, [cid]),

    // Top guards by hours (last 30 days)
    pool.query(`
      SELECT g.name, g.badge_number,
             ROUND(CAST(SUM(ss.total_hours) AS NUMERIC), 1) AS total_hours,
             COUNT(DISTINCT ss.id) AS shift_count
      FROM shift_sessions ss
      JOIN guards g ON g.id = ss.guard_id
      JOIN sites s  ON s.id = ss.site_id
      WHERE s.company_id = $1
        AND ss.clocked_in_at >= NOW() - INTERVAL '30 days'
        AND ss.total_hours IS NOT NULL
      GROUP BY g.id, g.name, g.badge_number
      ORDER BY total_hours DESC
      LIMIT 10
    `, [cid]),

    // Monthly hours per site (last 6 months)
    pool.query(`
      SELECT
        TO_CHAR(DATE_TRUNC('month', ss.clocked_in_at), 'Mon YYYY') AS month,
        s.name AS site_name,
        ROUND(CAST(SUM(ss.total_hours) AS NUMERIC), 1) AS hours
      FROM shift_sessions ss
      JOIN sites s ON s.id = ss.site_id
      WHERE s.company_id = $1
        AND ss.clocked_in_at >= DATE_TRUNC('month', NOW()) - INTERVAL '5 months'
        AND ss.total_hours IS NOT NULL
      GROUP BY DATE_TRUNC('month', ss.clocked_in_at), s.name
      ORDER BY DATE_TRUNC('month', ss.clocked_in_at) ASC, s.name
    `, [cid]),
  ]);

  res.json({
    total_hours_this_month: parseFloat(hoursResult.rows[0].total_hours),
    reports_by_type:        reportsByType.rows,
    incidents_by_severity:  incidentBySeverity.rows,
    top_guards:             guardPerf.rows,
    monthly_hours_by_site:  monthlyHours.rows,
  });
});

export default router;
