import { Router } from 'express';
import jwt from 'jsonwebtoken';
import PDFDocument from 'pdfkit';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';
import { validatePassword } from './auth';
import { urlOrPresign } from '../services/s3';
import {
  NAVY, WHITE, BLUE, RED, AMBER, GRAY1, GRAY2, TEXT, MUTED,
  PAGE_W, PAGE_H, ML, MR, CW,
  drawHeader, drawFooter, badge,
} from '../services/pdf/theme';
import {
  fetchActivityRows,
  ACTIVITY_PDF_ROW_CAP,
  type ActivityRow,
  type UserScope,
} from './activityLog';

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
// Retention rebuild: dropped `pending_deletions` (data_retention_log
// is gone). Vishnu Portal v2: added `legal_holds` (reports + geofence
// violations held) and `expiring_30d` (records rolling off retention
// in the next 30 days across the 6 retention-eligible tables).
router.get('/vishnu-kpis', requireAuth('vishnu'), async (_req, res) => {
  const [companies, sites, guards, holds, expiring] = await Promise.all([
    pool.query(`SELECT COUNT(*) FROM companies WHERE is_active = true`),
    pool.query(`SELECT COUNT(*) FROM sites    WHERE is_active = true AND (contract_end IS NULL OR contract_end >= NOW())`),
    pool.query(`SELECT COUNT(*) FROM guards   WHERE is_active = true`),
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM reports              WHERE legal_hold) +
         (SELECT COUNT(*) FROM geofence_violations  WHERE legal_hold) AS n`,
    ),
    pool.query(
      `SELECT
         (SELECT COUNT(*) FROM reports              WHERE NOT legal_hold AND expires_at <= NOW() + INTERVAL '30 days') +
         (SELECT COUNT(*) FROM location_pings       WHERE NOT legal_hold AND expires_at <= NOW() + INTERVAL '30 days') +
         (SELECT COUNT(*) FROM task_completions     WHERE NOT legal_hold AND expires_at <= NOW() + INTERVAL '30 days') +
         (SELECT COUNT(*) FROM shift_sessions       WHERE NOT legal_hold AND expires_at <= NOW() + INTERVAL '30 days') +
         (SELECT COUNT(*) FROM shifts               WHERE NOT legal_hold AND expires_at <= NOW() + INTERVAL '30 days') +
         (SELECT COUNT(*) FROM geofence_violations  WHERE NOT legal_hold AND expires_at <= NOW() + INTERVAL '30 days') AS n`,
    ),
  ]);
  res.json({
    total_companies:   parseInt(companies.rows[0].count),
    active_sites:      parseInt(sites.rows[0].count),
    active_guards:     parseInt(guards.rows[0].count),
    legal_holds:       parseInt(holds.rows[0].n),
    expiring_30d:      parseInt(expiring.rows[0].n),
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

// Retention rebuild: GET /api/admin/retention-status removed with
// data_retention_log. Per-row expires_at + legal_hold on individual
// tables replace the site-scoped countdown.

// ── PATCH /api/admin/reports/:id/legal-hold ─────────────────────────────────
//
// Places a report on legal hold (hold=true) or releases the hold
// (hold=false). Cascade rules:
//   hold=true  → also flips shift_sessions, shifts, location_pings,
//                and task_completions belonging to the report's session.
//                Keeps the entire chain of related evidence in the DB past
//                its normal expires_at.
//   hold=false → releases *only* the specific report. Cascaded parents
//                stay held. Vishnu / admin walks back through each layer
//                manually to reduce accidental release surface (RC4).
//
// Auth: company_admin scoped to their company; vishnu bypasses the
// scope check and can hold any report.
router.patch('/reports/:id/legal-hold', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { id } = req.params;
  const { hold } = (req.body ?? {}) as { hold?: unknown };
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid report id' });
  if (typeof hold !== 'boolean') return res.status(400).json({ error: 'hold must be boolean' });

  const isVishnu = req.user!.role === 'vishnu';

  // Scope check + fetch the parent session/shift so the cascade knows
  // which rows to flip.
  const reportQ = isVishnu
    ? await pool.query<{ shift_session_id: string; shift_id: string }>(
        `SELECT r.shift_session_id, ss.shift_id
         FROM reports r
         JOIN shift_sessions ss ON ss.id = r.shift_session_id
         WHERE r.id = $1`,
        [id],
      )
    : await pool.query<{ shift_session_id: string; shift_id: string }>(
        `SELECT r.shift_session_id, ss.shift_id
         FROM reports r
         JOIN shift_sessions ss ON ss.id = r.shift_session_id
         JOIN sites si          ON si.id = r.site_id
         WHERE r.id = $1 AND si.company_id = $2`,
        [id, req.user!.company_id],
      );
  if (!reportQ.rows[0]) return res.status(404).json({ error: 'Report not found' });
  const { shift_session_id, shift_id } = reportQ.rows[0];

  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    // v35: legal_hold_at stamped on hold, cleared on release. Cascade
    // parents keep the boolean only — no *_at columns on them.
    await conn.query(
      `UPDATE reports
       SET legal_hold = $1,
           legal_hold_at = CASE WHEN $1 THEN NOW() ELSE NULL END
       WHERE id = $2`,
      [hold, id],
    );

    if (hold) {
      // Cascade UP + across children of the same session. Release does
      // NOT reverse the cascade (see docstring).
      await conn.query('UPDATE shift_sessions   SET legal_hold = true WHERE id = $1',                [shift_session_id]);
      await conn.query('UPDATE shifts           SET legal_hold = true WHERE id = $1',                [shift_id]);
      await conn.query('UPDATE location_pings   SET legal_hold = true WHERE shift_session_id = $1',  [shift_session_id]);
      await conn.query('UPDATE task_completions SET legal_hold = true WHERE shift_session_id = $1',  [shift_session_id]);
    }

    await conn.query('COMMIT');
    res.json({ success: true, hold });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
});

// ── PATCH /api/admin/violations/:id/legal-hold ──────────────────────────────
//
// Mirror of the reports legal-hold endpoint for geofence_violations
// (Vishnu Portal v2). Same cascade / release semantics:
//   hold=true  → also flips the parent shift_session, shift, and the
//                sibling location_pings + task_completions.
//   hold=false → releases only the specific violation; parents stay held.
//
// Auth: company_admin scoped to their company; vishnu bypasses scope.
router.patch('/violations/:id/legal-hold', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { id } = req.params;
  const { hold } = (req.body ?? {}) as { hold?: unknown };
  if (!UUID_RE.test(id)) return res.status(400).json({ error: 'invalid violation id' });
  if (typeof hold !== 'boolean') return res.status(400).json({ error: 'hold must be boolean' });

  const isVishnu = req.user!.role === 'vishnu';

  const violationQ = isVishnu
    ? await pool.query<{ shift_session_id: string; shift_id: string }>(
        `SELECT gv.shift_session_id, ss.shift_id
         FROM geofence_violations gv
         JOIN shift_sessions ss ON ss.id = gv.shift_session_id
         WHERE gv.id = $1`,
        [id],
      )
    : await pool.query<{ shift_session_id: string; shift_id: string }>(
        `SELECT gv.shift_session_id, ss.shift_id
         FROM geofence_violations gv
         JOIN shift_sessions ss ON ss.id = gv.shift_session_id
         JOIN sites si          ON si.id = gv.site_id
         WHERE gv.id = $1 AND si.company_id = $2`,
        [id, req.user!.company_id],
      );
  if (!violationQ.rows[0]) return res.status(404).json({ error: 'Violation not found' });
  const { shift_session_id, shift_id } = violationQ.rows[0];

  const conn = await pool.connect();
  try {
    await conn.query('BEGIN');
    await conn.query(
      `UPDATE geofence_violations
       SET legal_hold = $1,
           legal_hold_at = CASE WHEN $1 THEN NOW() ELSE NULL END
       WHERE id = $2`,
      [hold, id],
    );

    if (hold) {
      await conn.query('UPDATE shift_sessions   SET legal_hold = true WHERE id = $1',                [shift_session_id]);
      await conn.query('UPDATE shifts           SET legal_hold = true WHERE id = $1',                [shift_id]);
      await conn.query('UPDATE location_pings   SET legal_hold = true WHERE shift_session_id = $1',  [shift_session_id]);
      await conn.query('UPDATE task_completions SET legal_hold = true WHERE shift_session_id = $1',  [shift_session_id]);
    }

    await conn.query('COMMIT');
    res.json({ success: true, hold });
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
});

// ── GET /api/admin/vishnu/legal-holds ───────────────────────────────────────
//
// UNION of reports + geofence_violations currently on legal hold, with
// enough join context to render "COMPANY · SITE · GUARD · TYPE · REPORTED
// AT · HELD SINCE" in the new /vishnu/compliance page. Sort: newest hold
// first (held_since DESC). Empty result is a valid response.
router.get('/vishnu/legal-holds', requireAuth('vishnu'), async (_req, res) => {
  const result = await pool.query(
    `SELECT * FROM (
       SELECT r.id                              AS record_id,
              CASE r.report_type
                WHEN 'incident'    THEN 'Incident Report'
                WHEN 'activity'    THEN 'Activity Report'
                WHEN 'maintenance' THEN 'Maintenance Report'
                ELSE r.report_type
              END                               AS record_type,
              co.id                             AS company_id,
              co.name                           AS company_name,
              s.id                              AS site_id,
              s.name                            AS site_name,
              g.id                              AS guard_id,
              g.name                            AS guard_name,
              r.reported_at,
              r.legal_hold_at                   AS held_since
         FROM reports r
         JOIN shift_sessions ss ON ss.id = r.shift_session_id
         JOIN guards         g  ON g.id  = ss.guard_id
         JOIN sites          s  ON s.id  = r.site_id
         JOIN companies      co ON co.id = s.company_id
        WHERE r.legal_hold = true

       UNION ALL

       SELECT gv.id                             AS record_id,
              'Violation'                       AS record_type,
              co.id                             AS company_id,
              co.name                           AS company_name,
              s.id                              AS site_id,
              s.name                            AS site_name,
              g.id                              AS guard_id,
              g.name                            AS guard_name,
              gv.occurred_at                    AS reported_at,
              gv.legal_hold_at                  AS held_since
         FROM geofence_violations gv
         JOIN guards    g  ON g.id  = gv.guard_id
         JOIN sites     s  ON s.id  = gv.site_id
         JOIN companies co ON co.id = s.company_id
        WHERE gv.legal_hold = true
     ) combined
     ORDER BY held_since DESC NULLS LAST, reported_at DESC`,
  );
  res.json(result.rows);
});

// ── GET /api/admin/vishnu/upcoming-expiry?days=7|30|90&include_held=false ───
//
// UNION over the 6 retention-eligible tables of records whose expires_at
// falls in the next N days. `include_held=false` (default) excludes rows
// where legal_hold=true. Sort: expires_at ASC (soonest first). Rows are
// returned raw — the frontend caps display at 10 with "View all N".
router.get('/vishnu/upcoming-expiry', requireAuth('vishnu'), async (req, res) => {
  const daysRaw = parseInt((req.query.days as string | undefined) ?? '30', 10);
  const days = [7, 30, 90].includes(daysRaw) ? daysRaw : 30;
  const includeHeld = String(req.query.include_held ?? 'false') === 'true';
  const heldClause = includeHeld ? '' : 'AND NOT legal_hold';

  const result = await pool.query(
    `SELECT * FROM (
       SELECT r.id AS record_id,
              CASE r.report_type
                WHEN 'incident'    THEN 'Incident Report'
                WHEN 'activity'    THEN 'Activity Report'
                WHEN 'maintenance' THEN 'Maintenance Report'
                ELSE r.report_type
              END AS record_type,
              co.id AS company_id, co.name AS company_name,
              s.id  AS site_id,    s.name  AS site_name,
              r.expires_at
         FROM reports r
         JOIN sites     s  ON s.id  = r.site_id
         JOIN companies co ON co.id = s.company_id
        WHERE r.expires_at IS NOT NULL
          AND r.expires_at <= NOW() + ($1 || ' days')::INTERVAL
          ${heldClause}

       UNION ALL

       SELECT lp.id AS record_id, 'Ping' AS record_type,
              co.id AS company_id, co.name AS company_name,
              s.id  AS site_id,    s.name  AS site_name,
              lp.expires_at
         FROM location_pings lp
         JOIN shift_sessions ss ON ss.id = lp.shift_session_id
         JOIN sites     s  ON s.id  = ss.site_id
         JOIN companies co ON co.id = s.company_id
        WHERE lp.expires_at IS NOT NULL
          AND lp.expires_at <= NOW() + ($1 || ' days')::INTERVAL
          ${heldClause.replace('legal_hold', 'lp.legal_hold')}

       UNION ALL

       SELECT tc.id AS record_id, 'Task Completion' AS record_type,
              co.id AS company_id, co.name AS company_name,
              s.id  AS site_id,    s.name  AS site_name,
              tc.expires_at
         FROM task_completions tc
         JOIN shift_sessions ss ON ss.id = tc.shift_session_id
         JOIN sites     s  ON s.id  = ss.site_id
         JOIN companies co ON co.id = s.company_id
        WHERE tc.expires_at IS NOT NULL
          AND tc.expires_at <= NOW() + ($1 || ' days')::INTERVAL
          ${heldClause.replace('legal_hold', 'tc.legal_hold')}

       UNION ALL

       SELECT ss.id AS record_id, 'Session' AS record_type,
              co.id AS company_id, co.name AS company_name,
              s.id  AS site_id,    s.name  AS site_name,
              ss.expires_at
         FROM shift_sessions ss
         JOIN sites     s  ON s.id  = ss.site_id
         JOIN companies co ON co.id = s.company_id
        WHERE ss.expires_at IS NOT NULL
          AND ss.expires_at <= NOW() + ($1 || ' days')::INTERVAL
          ${heldClause.replace('legal_hold', 'ss.legal_hold')}

       UNION ALL

       SELECT sh.id AS record_id, 'Shift' AS record_type,
              co.id AS company_id, co.name AS company_name,
              s.id  AS site_id,    s.name  AS site_name,
              sh.expires_at
         FROM shifts sh
         JOIN sites     s  ON s.id  = sh.site_id
         JOIN companies co ON co.id = s.company_id
        WHERE sh.expires_at IS NOT NULL
          AND sh.expires_at <= NOW() + ($1 || ' days')::INTERVAL
          ${heldClause.replace('legal_hold', 'sh.legal_hold')}

       UNION ALL

       SELECT gv.id AS record_id, 'Violation' AS record_type,
              co.id AS company_id, co.name AS company_name,
              s.id  AS site_id,    s.name  AS site_name,
              gv.expires_at
         FROM geofence_violations gv
         JOIN sites     s  ON s.id  = gv.site_id
         JOIN companies co ON co.id = s.company_id
        WHERE gv.expires_at IS NOT NULL
          AND gv.expires_at <= NOW() + ($1 || ' days')::INTERVAL
          ${heldClause.replace('legal_hold', 'gv.legal_hold')}
     ) combined
     ORDER BY expires_at ASC`,
    [days],
  );
  res.json(result.rows);
});

// ── GET /api/admin/vishnu/audit-log?limit=20&offset=0 ───────────────────────
//
// Recent admin actions. v1 sources: admin_client_previews (preview-as-
// client mints) + guard_assignment_audit (assignment lifecycle writes).
// Vishnu is detected by the sentinel UUID prefix 00000000-aaaa-… — see
// schema_v29 comment ("vishnu has no persistent user row").
//
// `target` is derived per source: previews → site name; assignment audit
// → guard name pulled from the before/after jsonb snapshot.
router.get('/vishnu/audit-log', requireAuth('vishnu'), async (req, res) => {
  const limitRaw  = parseInt((req.query.limit  as string | undefined) ?? '20', 10);
  const offsetRaw = parseInt((req.query.offset as string | undefined) ?? '0',  10);
  const limit  = Math.min(100, Math.max(1, Number.isFinite(limitRaw)  ? limitRaw  : 20));
  const offset = Math.max(0,           Number.isFinite(offsetRaw) ? offsetRaw : 0);

  const VISHNU_PREFIX = '00000000-aaaa-%';

  const result = await pool.query(
    `SELECT * FROM (
       SELECT acp.previewed_at            AS timestamp,
              acp.admin_id                AS actor_id,
              CASE WHEN acp.admin_id::text LIKE $1 THEN 'Vishnu'
                   ELSE COALESCE(ca.name, 'Unknown admin')
              END                         AS actor_name,
              co.id                       AS company_id,
              co.name                     AS company_name,
              'Previewed client portal'   AS action,
              s.name                      AS target
         FROM admin_client_previews acp
         JOIN sites     s  ON s.id  = acp.site_id
         JOIN companies co ON co.id = s.company_id
         LEFT JOIN company_admins ca ON ca.id = acp.admin_id

       UNION ALL

       SELECT gaa.changed_at              AS timestamp,
              gaa.changed_by              AS actor_id,
              CASE WHEN gaa.changed_by::text LIKE $1 THEN 'Vishnu'
                   ELSE COALESCE(ca.name, 'Unknown admin')
              END                         AS actor_name,
              co.id                       AS company_id,
              co.name                     AS company_name,
              CASE gaa.action
                WHEN 'guard_assignment_created' THEN 'Assigned guard to site'
                WHEN 'guard_assignment_ended'   THEN 'Ended guard assignment'
                WHEN 'guard_assignment_removed' THEN 'Removed guard assignment'
                ELSE gaa.action
              END                         AS action,
              COALESCE(g.name, 'Unknown guard') AS target
         FROM guard_assignment_audit gaa
         LEFT JOIN company_admins ca ON ca.id = gaa.changed_by
         LEFT JOIN guards         g  ON g.id::text = COALESCE(gaa.after ->> 'guard_id',
                                                              gaa.before ->> 'guard_id')
         LEFT JOIN sites          s  ON s.id::text = COALESCE(gaa.after ->> 'site_id',
                                                              gaa.before ->> 'site_id')
         LEFT JOIN companies      co ON co.id = s.company_id
     ) combined
     ORDER BY timestamp DESC
     LIMIT $2 OFFSET $3`,
    [VISHNU_PREFIX, limit, offset],
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
       lr.reported_at AS last_report_at,
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
     LEFT JOIN LATERAL (
       SELECT reported_at
       FROM reports r
       WHERE r.shift_session_id = ss.id
       ORDER BY reported_at DESC LIMIT 1
     ) lr ON true
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
// Retention rebuild: dropped `days_until_deletion` and the DRL JOIN with
// it. Per-row expires_at on child tables replaces site-scoped countdown.
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
       CASE WHEN s.contract_end >= NOW() THEN 'active' ELSE 'inactive' END AS status
     FROM sites s
     LEFT JOIN reports r ON r.site_id = s.id
     WHERE s.company_id = $1 AND s.is_active = true
     GROUP BY s.id, s.name, s.contract_end
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

// ── GET /api/admin/sessions?from=&to= ─────────────────────────────────────────
//
// Company-wide shift_sessions in a date range, joined with the parent
// shift for schedule times. Powers the activity-logs SHIFT dropdown
// once we lift the "must pick a site first" gate (D3): the frontend
// fetches the full list on date-range change and filters client-side
// when the SITE dropdown changes.
router.get('/sessions', requireAuth('company_admin'), async (req, res) => {
  const { from, to } = req.query;
  const fromIso = (from as string) || new Date(Date.now() - 7 * 86_400_000).toISOString();
  const toIso   = (to   as string) || new Date().toISOString();

  const result = await pool.query(
    `SELECT
       ss.id,
       g.name             AS guard_name,
       si.name            AS site_name,
       si.id              AS site_id,
       ss.clocked_in_at,
       ss.clocked_out_at,
       sh.scheduled_start,
       sh.scheduled_end
     FROM shift_sessions ss
     JOIN guards g  ON g.id  = ss.guard_id
     JOIN sites  si ON si.id = ss.site_id
     JOIN shifts sh ON sh.id = ss.shift_id
     WHERE si.company_id = $1
       AND ss.clocked_in_at < $2
       AND COALESCE(ss.clocked_out_at, NOW()) > $3
     ORDER BY ss.clocked_in_at DESC
     LIMIT 500`,
    [req.user!.company_id, toIso, fromIso],
  );
  res.json(result.rows);
});

// ── POST /api/admin/activity-log/pdf ──────────────────────────────────────────
//
// Streams application/pdf of the current activity feed, filtered by the
// same params as GET /api/activity-log but read from the request body so
// the admin can fetch-to-blob from the DOWNLOAD PDF button. company_admin
// only. Media policy: filenames + counts, no embedded images (keeps PDF
// size predictable — a 5-photo incident weighs the same as a bare ping).
router.post('/activity-log/pdf', requireAuth('company_admin'), async (req, res) => {
  const { from, to, guard_id, site_id, session_id } = (req.body ?? {}) as Record<string, string | undefined>;

  const fromIso = from || new Date(Date.now() - 7 * 86_400_000).toISOString();
  const toIso   = to   || new Date().toISOString();

  const scope: UserScope = {
    role:       'company_admin',
    company_id: req.user!.company_id,
  };

  const rows = await fetchActivityRows(scope, {
    fromIso, toIso,
    guardId:   guard_id,
    siteId:    site_id,
    sessionId: session_id,
  });

  // Newest first (matches on-screen order)
  rows.sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));

  const truncated = rows.length > ACTIVITY_PDF_ROW_CAP;
  const eventRows = rows.slice(0, ACTIVITY_PDF_ROW_CAP);

  // Optional filter-summary lookups. When a site_id / guard_id is present
  // we look up its display name so the PDF header reads "Sunset Tower"
  // instead of a UUID.
  let siteLabel  = 'All sites';
  let guardLabel = 'All guards';
  if (site_id) {
    const r = await pool.query('SELECT name FROM sites WHERE id = $1 AND company_id = $2',
                               [site_id, req.user!.company_id]);
    if (r.rows[0]) siteLabel = r.rows[0].name;
  }
  if (guard_id) {
    const r = await pool.query('SELECT name FROM guards WHERE id = $1 AND company_id = $2',
                               [guard_id, req.user!.company_id]);
    if (r.rows[0]) guardLabel = r.rows[0].name;
  }

  const fromDate  = fromIso.slice(0, 10);
  const toDate    = toIso.slice(0, 10);
  const filename  = `activity-logs-${fromDate}_${toDate}.pdf`;
  const periodStr = `${new Date(fromIso).toLocaleDateString('en-GB')} → ${new Date(toIso).toLocaleDateString('en-GB')}`;

  // Group by Pacific-time day for the on-page sections.
  const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles',
  });
  const DAY_HEADER = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Los_Angeles',
  });
  const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  });

  const byDay = new Map<string, ActivityRow[]>();
  for (const r of eventRows) {
    const key = DAY_KEY.format(new Date(r.event_time));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(r);
  }
  const dayKeys = Array.from(byDay.keys()).sort().reverse();
  for (const key of dayKeys) byDay.get(key)!.sort((a, b) => Date.parse(a.event_time) - Date.parse(b.event_time));

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
  doc.pipe(res);

  const STATUS_COLOR: Record<string, string> = {
    on_time:            NAVY,
    late:               AMBER,
    missed:             RED,
    activity_report:    BLUE,
    incident_report:    RED,
    maintenance_report: AMBER,
  };
  const STATUS_LABEL: Record<string, string> = {
    on_time:            'PING',
    late:               'LATE PING',
    missed:             'MISSED PING',
    activity_report:    'ACTIVITY',
    incident_report:    'INCIDENT',
    maintenance_report: 'MAINTENANCE',
  };

  // We don't know the true page total until the stream drains, so
  // estimate: cover + ~20 rows/page. Header shows "n / estimate".
  const estRowsPerPage = 20;
  const estPages       = 1 + Math.max(1, Math.ceil(eventRows.length / estRowsPerPage));
  let pageNum = 1;

  // ── Page 1 — Cover / filter summary ─────────────────────────────────────
  drawHeader(doc, 'ACTIVITY LOGS', pageNum, estPages);
  let y = 90;

  doc.fontSize(22).fillColor(TEXT).font('Helvetica-Bold').text('Activity Logs', ML, y);
  y += 30;

  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text(`Period      ${periodStr}`, ML, y);
  y += 15;
  doc.text(`Site        ${siteLabel}`, ML, y);
  y += 15;
  doc.text(`Guard       ${guardLabel}`, ML, y);
  y += 15;
  doc.text(`Generated   ${new Date().toLocaleString('en-GB', { timeZone: 'America/Los_Angeles' })} PT`, ML, y);
  y += 22;

  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(0.5).stroke();
  y += 18;

  // Summary tile row
  const totalRows        = rows.length;
  const missedCount      = eventRows.filter((r) => r.status_kind === 'missed').length;
  const incidentCount    = eventRows.filter((r) => r.status_kind === 'incident_report').length;
  const activityCount    = eventRows.filter((r) => r.status_kind === 'activity_report').length;
  const maintenanceCount = eventRows.filter((r) => r.status_kind === 'maintenance_report').length;
  const pingCount        = eventRows.filter((r) => r.status_kind === 'on_time' || r.status_kind === 'late').length;

  const stats = [
    { label: 'TOTAL EVENTS', value: totalRows,        color: TEXT  },
    { label: 'PINGS',        value: pingCount,        color: NAVY  },
    { label: 'MISSED',       value: missedCount,      color: RED   },
    { label: 'ACTIVITY',     value: activityCount,    color: BLUE  },
    { label: 'INCIDENT',     value: incidentCount,    color: RED   },
    { label: 'MAINTENANCE',  value: maintenanceCount, color: AMBER },
  ];
  const statW = CW / stats.length;
  for (let i = 0; i < stats.length; i++) {
    const sx = ML + i * statW;
    doc.rect(sx + 2, y, statW - 4, 56).fill(GRAY1).stroke();
    doc.rect(sx + 2, y, 3, 56).fill(stats[i].color);
    doc.fontSize(22).fillColor(stats[i].color).font('Helvetica-Bold')
       .text(String(stats[i].value), sx + 10, y + 8, { width: statW - 16, lineBreak: false });
    doc.fontSize(7).fillColor(MUTED).font('Helvetica')
       .text(stats[i].label, sx + 10, y + 40, { width: statW - 16 });
  }
  y += 70;

  if (truncated) {
    doc.rect(ML, y, CW, 18).fill('#FEF3C7');
    doc.fontSize(8).fillColor('#92400E').font('Helvetica-Bold')
       .text(`Truncated: ${totalRows} total events, showing first ${ACTIVITY_PDF_ROW_CAP}. Narrow the filter to see more.`,
             ML + 8, y + 5, { width: CW - 16, lineBreak: false });
    y += 24;
  }

  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(0.5).stroke();
  y += 14;

  drawFooter(doc, siteLabel, periodStr);

  // ── Timeline: per-day sections ──────────────────────────────────────────
  const COL_TIME_X   = ML + 8;
  const COL_STATUS_X = ML + 60;
  const COL_GUARD_X  = ML + 170;
  const COL_SITE_X   = ML + 300;
  const COL_DESC_X   = ML + 8;
  const ROW_H        = 18;
  const ROW_DESC_H   = 26;

  function ensureRoom(needed: number) {
    if (y + needed > PAGE_H - 40) {
      drawFooter(doc, siteLabel, periodStr);
      doc.addPage();
      pageNum += 1;
      drawHeader(doc, 'ACTIVITY LOGS', pageNum, estPages);
      y = 90;
    }
  }

  if (eventRows.length === 0) {
    doc.fontSize(12).fillColor(MUTED).font('Helvetica')
       .text('No events in this range.', ML, y, { width: CW, align: 'center' });
  }

  for (const key of dayKeys) {
    ensureRoom(30);
    const dayRows = byDay.get(key)!;
    const dayDate = new Date(dayRows[0].event_time);

    // Day header bar
    doc.rect(ML, y, CW, 20).fill(NAVY);
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
       .text(DAY_HEADER.format(dayDate).toUpperCase(), ML + 8, y + 6, { lineBreak: false });
    doc.fontSize(8).fillColor('#94A3B8').font('Helvetica')
       .text(`${dayRows.length} event${dayRows.length !== 1 ? 's' : ''}`,
             0, y + 6, { align: 'right', width: PAGE_W - ML });
    y += 26;

    for (const r of dayRows) {
      const descLen = r.description ? Math.min(r.description.length, 180) : 0;
      const rowHeight = descLen > 0 ? ROW_DESC_H : ROW_H;
      ensureRoom(rowHeight + 4);

      const color   = STATUS_COLOR[r.status_kind] ?? MUTED;
      const label   = STATUS_LABEL[r.status_kind] ?? r.status.toUpperCase();
      const timeStr = r.log_time ? TIME_FMT.format(new Date(r.log_time)) : '—';

      doc.fontSize(8).fillColor(MUTED).font('Helvetica')
         .text(timeStr, COL_TIME_X, y + 3, { lineBreak: false, width: 50 });
      badge(doc, COL_STATUS_X, y + 1, label, color);
      doc.fontSize(8).fillColor(TEXT).font('Helvetica')
         .text(r.guard_name, COL_GUARD_X, y + 3, { lineBreak: false, width: 120 });
      doc.fontSize(8).fillColor(MUTED).font('Helvetica')
         .text(r.site_name, COL_SITE_X, y + 3, { lineBreak: false, width: 200 });

      if (descLen > 0) {
        const snippet = (r.description ?? '').length > 180
          ? (r.description ?? '').slice(0, 180) + '…'
          : (r.description ?? '');
        doc.fontSize(8).fillColor('#374151').font('Helvetica')
           .text(snippet, COL_DESC_X, y + 15, { width: CW - 16, height: 10 });
      }

      const mediaCount = r.log_media_urls?.length ?? 0;
      if (mediaCount > 0) {
        doc.fontSize(7).fillColor(MUTED).font('Helvetica')
           .text(`${mediaCount} photo${mediaCount === 1 ? '' : 's'}`,
                 0, y + 3, { align: 'right', width: PAGE_W - ML - 10 });
      }

      y += rowHeight;
      doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(0.3).stroke();
      y += 2;
    }
    y += 8;
  }

  drawFooter(doc, siteLabel, periodStr);
  doc.end();
});

export default router;
