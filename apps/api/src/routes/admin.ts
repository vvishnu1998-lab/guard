import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';
import { validatePassword } from './auth';
import { urlOrPresign } from '../services/s3';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Admin "Preview as client" (Session B / Part C) ───────────────────────────
//
// Mints a short-lived (30-minute) read-only client-role JWT that lets the
// admin open the client portal in a new tab and see exactly what the
// end-client sees. The auth middleware treats scope='preview' tokens as
// read-only: any non-GET is rejected. Every mint is audited in
// admin_client_previews (schema_v29).
//
// Auth:
//   * company_admin  — must own the site (company_id gate below)
//   * vishnu         — allowed across all companies
router.post('/sites/:siteId/preview-client-token', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return res.status(400).json({ error: 'invalid site_id' });

  const isVishnu = req.user!.role === 'vishnu';

  const siteCheck = isVishnu
    ? await pool.query('SELECT 1 FROM sites WHERE id = $1', [siteId])
    : await pool.query('SELECT 1 FROM sites WHERE id = $1 AND company_id = $2', [siteId, req.user!.company_id]);
  if (!siteCheck.rows[0]) return res.status(404).json({ error: 'Site not found' });

  const ttlSeconds = 30 * 60;
  const expiresAt  = new Date(Date.now() + ttlSeconds * 1000);

  const accessToken = jwt.sign(
    { sub: 'admin-preview', role: 'client', site_id: siteId, scope: 'preview' },
    process.env.JWT_SECRET!,
    { expiresIn: ttlSeconds },
  );

  await pool.query(
    `INSERT INTO admin_client_previews (admin_id, site_id, expires_at) VALUES ($1, $2, $3)`,
    [req.user!.sub, siteId, expiresAt],
  );

  res.json({ access_token: accessToken, expires_in: ttlSeconds });
});

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
  const policyErr = validatePassword(password);
  if (policyErr) return res.status(400).json({ error: policyErr });

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
      `SELECT COUNT(*) FROM sites WHERE company_id = $1 AND is_active = true AND contract_end >= NOW()`,
      [cid]
    ),
    pool.query(
      // e2fec53 status filter removed in Week-1 C2: the atomic clock-out +
      // partial unique index (idx_shift_sessions_one_open_per_guard) now
      // enforce that clocked_out_at IS NULL iff the shift is still running.
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
       sh.scheduled_start,
       sh.scheduled_end,
       lp.latitude  AS last_lat,
       lp.longitude AS last_lng,
       lp.pinged_at  AS last_ping_at,
       lp.ping_type  AS last_ping_type,
       EXISTS (
         SELECT 1 FROM geofence_violations gv
         WHERE gv.shift_session_id = ss.id AND gv.resolved_at IS NULL
       ) AS has_violation
     FROM shift_sessions ss
     JOIN guards g ON g.id = ss.guard_id
     JOIN sites  s ON s.id = ss.site_id
     JOIN shifts sh ON sh.id = ss.shift_id
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, lp_inner.pinged_at, ping_type
       FROM location_pings lp_inner
       WHERE lp_inner.shift_session_id = ss.id
       ORDER BY lp_inner.pinged_at DESC LIMIT 1
     ) lp ON true
     -- e2fec53 status filter removed in Week-1 C2 (see /kpis comment above)
     WHERE s.company_id = $1 AND ss.clocked_out_at IS NULL
     ORDER BY s.name, g.name`,
    [req.user!.company_id]
  );
  res.json(result.rows);
});

// GET /api/admin/violations?since=24h|7d|30d&status=all|open|resolved
//                          &site_id=<uuid>&guard_id=<uuid>
//                          &date_from=<iso>&date_to=<iso>&limit=N
//
// Company-scoped geofence breach history for the admin live-status page's
// "RECENT BREACHES" section. Returns one row per geofence_violations row in
// the company's sites, newest first. Defaults: since=24h, status=all, limit=100
// (capped at 500).
//
// Vishnu (super-admin) sees ALL companies' breaches — the company_id
// predicate is dropped when isVishnu, mirroring the pattern in
// GET /api/sites and GET /api/guards. site_id / guard_id filters still
// scope the result set exactly as before.
//
// Precedence: if date_from and/or date_to are present, `since` is ignored.
// date_to alone treats "now" as the upper bound; date_from alone treats
// "beginning of time" as the lower bound (no INTERVAL floor). site_id and
// guard_id filter directly on gv.* (both denormalized on the row).
//
// photo_url is returned as the raw S3 URL stored on the row. The
// guard-media-prod bucket is configured for public read, so no fresh
// presigning is needed at fetch time. URLs MAY be dead in two cases:
//   1. The breach had no photo capture (photo_url is NULL).
//   2. The S3 object was purged by the nightly purge — for ping-attached
//      breach photos, this happens once the violation resolves AND the
//      associated location_pings row's photo_delete_at passes
//      (location_pings keeps its retain_as_evidence flag set while the
//      violation is open).
// The UI handles both cases as "photo unavailable".
router.get('/violations', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const cid      = req.user!.company_id;   // undefined for vishnu
  const sinceQ  = (req.query.since    as string | undefined) ?? '24h';
  const statusQ = (req.query.status   as string | undefined) ?? 'all';
  const limitQ  =  req.query.limit    as string | undefined;
  const siteQ   = (req.query.site_id  as string | undefined)?.trim();
  const guardQ  = (req.query.guard_id as string | undefined)?.trim();
  const fromQ   = (req.query.date_from as string | undefined)?.trim();
  const toQ     = (req.query.date_to   as string | undefined)?.trim();

  // Simple input validation. Errors here become 400s rather than 500s from
  // the DB. Format-only checks — the DB will still reject unknown UUIDs.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ISO_RE  = /^\d{4}-\d{2}-\d{2}(T[\d:.+Z-]+)?$/;
  if (siteQ  && !UUID_RE.test(siteQ))  return res.status(400).json({ error: 'invalid site_id'  });
  if (guardQ && !UUID_RE.test(guardQ)) return res.status(400).json({ error: 'invalid guard_id' });
  if (fromQ  && !ISO_RE.test(fromQ))   return res.status(400).json({ error: 'invalid date_from' });
  if (toQ    && !ISO_RE.test(toQ))     return res.status(400).json({ error: 'invalid date_to'   });

  // Whitelist-only mapping — no user input flows directly into SQL.
  const SINCE_INTERVALS: Record<string, string> = {
    '24h': '24 hours', '7d': '7 days', '30d': '30 days',
  };
  const sinceInterval = SINCE_INTERVALS[sinceQ] ?? SINCE_INTERVALS['24h'];

  const statusVal = (['all', 'open', 'resolved'] as const).includes(statusQ as 'all' | 'open' | 'resolved')
    ? (statusQ as 'all' | 'open' | 'resolved')
    : 'all';
  const statusClause =
    statusVal === 'open'     ? 'AND gv.resolved_at IS NULL'
  : statusVal === 'resolved' ? 'AND gv.resolved_at IS NOT NULL'
  :                            '';

  const limit = Math.min(500, Math.max(1, parseInt(limitQ ?? '100', 10) || 100));

  // Build the dynamic WHERE. All user-supplied values flow through numbered
  // params; sinceInterval is a whitelist lookup so its interpolation is safe.
  // For Vishnu, cidPredicate is 'true' and cid is never pushed — every
  // subsequent $N still resolves correctly because we push then reference by
  // args.length.
  const args: unknown[] = [];
  let cidPredicate: string;
  if (isVishnu) {
    cidPredicate = 'true';
  } else {
    args.push(cid);
    cidPredicate = `s.company_id = $${args.length}`;
  }

  const extraClauses: string[] = [];

  const useExplicitDates = Boolean(fromQ || toQ);
  if (useExplicitDates) {
    if (fromQ) { args.push(fromQ); extraClauses.push(`AND gv.occurred_at >= $${args.length}`); }
    if (toQ)   { args.push(toQ);   extraClauses.push(`AND gv.occurred_at <= $${args.length}`); }
  } else {
    extraClauses.push(`AND gv.occurred_at >= NOW() - INTERVAL '${sinceInterval}'`);
  }

  if (siteQ)  { args.push(siteQ);  extraClauses.push(`AND gv.site_id  = $${args.length}`); }
  if (guardQ) { args.push(guardQ); extraClauses.push(`AND gv.guard_id = $${args.length}`); }

  args.push(limit);
  const limitPos = args.length;

  const result = await pool.query(
    `SELECT gv.id,
            gv.occurred_at,
            gv.resolved_at,
            gv.duration_minutes,
            gv.violation_lat,
            gv.violation_lng,
            gv.photo_url,
            (gv.resolved_at IS NOT NULL) AS is_resolved,
            g.name         AS guard_name,
            g.badge_number,
            s.name         AS site_name
     FROM geofence_violations gv
     JOIN sites  s ON s.id = gv.site_id
     JOIN guards g ON g.id = gv.guard_id
     WHERE ${cidPredicate}
       ${extraClauses.join('\n       ')}
       ${statusClause}
     ORDER BY gv.occurred_at DESC
     LIMIT $${limitPos}`,
    args,
  );
  // S3 lockdown (PR2): re-sign the breach photo URLs.
  for (const row of result.rows) {
    row.photo_url = await urlOrPresign(row.photo_url);
  }
  res.json(result.rows);
});

// GET /api/admin/dashboard-sites — site summary for dashboard table
//
// Cartesian fix (2026-05-17): the previous version LEFT JOINed shift_sessions,
// reports, AND data_retention_log to sites, then summed total_hours across the
// resulting cross-product. SUM had no DISTINCT guard, so each session's hours
// were multiplied by (reports_count × retention_log_count) per site. Symptom:
// William Pen Hotel showed 300.7h (real value 37.6h × 8 reports × 1 retention
// row). guard_count and reports_today were always correct because they used
// COUNT(DISTINCT …).
//
// Fix: pull guard_count and hours_this_week into scalar subqueries against
// shift_sessions directly. The LEFT JOIN on shift_sessions is removed; reports
// and data_retention_log remain joined (DISTINCT keeps reports_today safe,
// data_retention_log is one row per site so days_until_deletion is unaffected).
router.get('/dashboard-sites', requireAuth('company_admin'), async (req, res) => {
  const cid = req.user!.company_id;
  const result = await pool.query(
    `SELECT
       s.id, s.name,
       COALESCE((
         SELECT COUNT(DISTINCT ss2.guard_id) FROM shift_sessions ss2
          WHERE ss2.site_id = s.id AND ss2.clocked_out_at IS NULL
       ), 0) AS guard_count,
       COUNT(DISTINCT r.id) FILTER (WHERE r.reported_at >= CURRENT_DATE) AS reports_today,
       COALESCE((
         SELECT SUM(ss2.total_hours) FROM shift_sessions ss2
          WHERE ss2.site_id = s.id
            AND ss2.clocked_in_at >= DATE_TRUNC('week', NOW())
       ), 0) AS hours_this_week,
       CASE WHEN s.contract_end >= NOW() THEN 'active' ELSE 'inactive' END AS status,
       CEIL(EXTRACT(EPOCH FROM (drl.data_delete_at - NOW())) / 86400)::INT AS days_until_deletion
     FROM sites s
     LEFT JOIN reports r ON r.site_id = s.id
     LEFT JOIN data_retention_log drl ON drl.site_id = s.id
     WHERE s.company_id = $1 AND s.is_active = true
     GROUP BY s.id, s.name, s.contract_end, drl.data_delete_at
     ORDER BY s.name`,
    [cid]
  );
  res.json(result.rows);
});

// GET /api/admin/recent-alerts — geofence violations + missed shifts, merged and sorted
//
// Vishnu (super-admin) sees ALL companies' alerts — the company_id
// predicate becomes `true` in both UNION branches, mirroring the pattern
// in GET /api/sites and GET /api/admin/violations. Response shape unchanged.
router.get('/recent-alerts', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';

  const args: unknown[] = [];
  let cidWhere: string;
  if (isVishnu) {
    cidWhere = 'true';
  } else {
    args.push(req.user!.company_id);
    cidWhere = `s.company_id = $${args.length}`;   // $1, referenced twice below
  }

  const result = await pool.query(
    `SELECT * FROM (

       -- Geofence violations. site_is_active is surfaced so the client
       -- can render an [INACTIVE] badge next to the site name in the
       -- alert list — the alert itself is historical and always shows.
       SELECT
         gv.id::text,
         'geofence_violation'          AS type,
         'Guard left designated area'  AS description,
         s.name                        AS site_name,
         s.is_active                   AS site_is_active,
         g.name                        AS guard_name,
         gv.occurred_at,
         (gv.resolved_at IS NOT NULL)  AS is_resolved
       FROM geofence_violations gv
       JOIN shift_sessions ss ON ss.id = gv.shift_session_id
       JOIN guards         g  ON g.id  = ss.guard_id
       JOIN sites          s  ON s.id  = gv.site_id
       WHERE ${cidWhere}
         AND gv.occurred_at >= NOW() - INTERVAL '24 hours'

       UNION ALL

       -- Missed shifts — scheduled but no clock-in 15 min after start.
       -- Status filter accepts both 'scheduled' (alert fired, shift still
       -- before scheduled_end) and 'missed' (auto-complete cron has since
       -- flipped the status because scheduled_end passed with zero
       -- sessions). The 24-hour cap on missed_alert_sent_at keeps the
       -- alert visible on the dashboard the morning after, then drops it.
       SELECT
         sh.id::text,
         'missed_shift'                                          AS type,
         'No guard clocked in 15+ minutes after scheduled start' AS description,
         s.name                                                  AS site_name,
         s.is_active                                             AS site_is_active,
         g.name                                                  AS guard_name,
         sh.scheduled_start                                      AS occurred_at,
         false                                                   AS is_resolved
       FROM shifts sh
       JOIN sites  s ON s.id = sh.site_id
       JOIN guards g ON g.id = sh.guard_id
       WHERE ${cidWhere}
         AND sh.status IN ('scheduled', 'missed')
         AND sh.scheduled_start + INTERVAL '15 minutes' <= NOW()
         AND sh.missed_alert_sent_at IS NOT NULL
         AND sh.missed_alert_sent_at >= NOW() - INTERVAL '24 hours'

     ) combined
     ORDER BY occurred_at DESC
     LIMIT 15`,
    args
  );
  res.json(result.rows);
});

// GET /api/admin/recent-swaps?hours=24 — accepted guard-initiated swaps
// in the last N hours (default 24). Powers the dashboard FYI card.
// Tenant-scoped; empty array is a valid response (no card shown).
router.get('/recent-swaps', requireAuth('company_admin'), async (req, res) => {
  const rawHours = typeof req.query.hours === 'string' ? parseInt(req.query.hours, 10) : 24;
  const hours = Number.isFinite(rawHours) && rawHours > 0 && rawHours <= 168 ? rawHours : 24;

  const result = await pool.query(
    `SELECT ssr.id                   AS history_id,
            ssr.shift_id,
            ssr.accepted_at,
            ssr.reason,
            fg.name                  AS from_guard_name,
            tg.name                  AS to_guard_name,
            si.name                  AS site_name,
            sh.scheduled_start,
            si.timezone              AS site_tz,
            EXISTS (
              SELECT 1 FROM guard_site_assignments gsa
              WHERE gsa.guard_id = ssr.to_guard_id
                AND gsa.site_id  = sh.site_id
                AND gsa.assigned_from <= (sh.scheduled_start AT TIME ZONE si.timezone)::date
                AND (gsa.assigned_until IS NULL
                     OR gsa.assigned_until >= (sh.scheduled_start AT TIME ZONE si.timezone)::date)
            ) AS is_same_site
       FROM shift_swap_requests ssr
       JOIN shifts sh ON sh.id = ssr.shift_id
       JOIN sites  si ON si.id = sh.site_id
       LEFT JOIN guards fg ON fg.id = ssr.from_guard_id
       LEFT JOIN guards tg ON tg.id = ssr.to_guard_id
      WHERE si.company_id = $1
        AND ssr.status = 'accepted'
        AND ssr.accepted_at >= NOW() - ($2 * INTERVAL '1 hour')
      ORDER BY ssr.accepted_at DESC
      LIMIT 20`,
    [req.user!.company_id, hours],
  );
  res.json(result.rows);
});

// Star primary admin: add company admin
router.post('/company-admins', requireAuth('company_admin'), async (req, res) => {
  const { name, email, password } = req.body;
  // B2: password policy enforcement
  const policyErr = validatePassword(password);
  if (policyErr) return res.status(400).json({ error: policyErr });

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

// GET /api/admin/sites/:site_id/sessions — recent shift sessions at a site,
// for populating the "shift" dropdown on the activity log page.
// Returns the most recent 50, newest first.
router.get('/sites/:site_id/sessions', requireAuth('company_admin'), async (req, res) => {
  const verify = await pool.query(
    'SELECT 1 FROM sites WHERE id = $1 AND company_id = $2',
    [req.params.site_id, req.user!.company_id],
  );
  if (!verify.rows[0]) return res.status(404).json({ error: 'Site not found' });

  const result = await pool.query(
    `SELECT ss.id, ss.clocked_in_at, ss.clocked_out_at, g.name AS guard_name
     FROM shift_sessions ss
     JOIN guards g ON g.id = ss.guard_id
     WHERE ss.site_id = $1
     ORDER BY ss.clocked_in_at DESC
     LIMIT 50`,
    [req.params.site_id],
  );
  res.json(result.rows);
});

export default router;
