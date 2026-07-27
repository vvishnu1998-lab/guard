import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { uploadBufferToS3, urlOrPresign } from '../services/s3';
import { sendPushNotification } from '../services/firebase';

/**
 * Common gate: 409 if the target site has been deactivated. Used on every
 * mutation endpoint below (edit, PDF, geofence, client-access) so an admin
 * can't accidentally reshape a decommissioned site's config. Reactivation
 * flows via PATCH /:id/active — which bypasses this gate by design.
 */
async function assertSiteActive(siteId: string, companyId: string):
  Promise<{ ok: true } | { ok: false; status: number; body: { error: string } }>
{
  const row = await pool.query<{ is_active: boolean }>(
    'SELECT is_active FROM sites WHERE id = $1 AND company_id = $2',
    [siteId, companyId],
  );
  if (!row.rows[0]) return { ok: false, status: 404, body: { error: 'Site not found' } };
  if (!row.rows[0].is_active) {
    return {
      ok: false,
      status: 409,
      body: { error: 'Site is deactivated. Reactivate it before making changes.' },
    };
  }
  return { ok: true };
}

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

// Site-supported timezones. Belt+braces on top of the schema CHECK
// constraint — rejects clearly here instead of letting a garbage
// value through to the DB error path. Keep in sync with the web
// admin site form dropdown (apps/web/app/admin/sites/page.tsx).
const ALLOWED_TIMEZONES = new Set([
  'America/Los_Angeles',
  'America/Denver',
  'America/Phoenix',
  'America/Chicago',
  'America/New_York',
  'Pacific/Honolulu',
  'UTC',
]);

// GET /api/sites
// - Default: hides deactivated sites (is_active = false) for company_admin.
//   Pass ?include_inactive=1 to opt in — used by the sites list page when
//   the admin wants to see + reactivate deactivated sites.
// - Vishnu always sees all sites (audit surface) with a site_is_active
//   flag so the web side can render the [INACTIVE] badge.
// - Fix B (2026-07-08): drl.client_star_access_disabled dropped from the
//   SELECT — was legacy dead read; the write path already only touches
//   sites.client_access_disabled_at.
router.get('/', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const includeInactive = req.query.include_inactive === '1';
  const activeFilter = (isVishnu || includeInactive) ? '' : 'AND s.is_active = true';
  const result = await pool.query(
    `SELECT s.*,
            s.is_active AS site_is_active,
            c.name as company_name,
            sg.center_lat, sg.center_lng, sg.radius_meters,
            sg.polygon_coordinates,
            CASE WHEN sg.site_id IS NOT NULL THEN true ELSE false END AS has_geofence
     FROM sites s
     JOIN companies c ON c.id = s.company_id
     LEFT JOIN site_geofence sg ON sg.site_id = s.id
     WHERE 1=1
       ${isVishnu ? '' : 'AND s.company_id = $1'}
       ${activeFilter}
     ORDER BY s.created_at DESC`,
    isVishnu ? [] : [req.user!.company_id]
  );
  // S3 lockdown (PR2): re-sign the stored PDF URLs.
  for (const row of result.rows) {
    row.instructions_pdf_url = await urlOrPresign(row.instructions_pdf_url);
  }
  res.json(result.rows);
});

// GET /api/sites/:id — direct fetch by id must resolve for both active and
// deactivated sites (so the admin reactivate flow can hydrate the row).
// Retention rebuild: dropped drl.client_star_access_until + data_delete_at.
router.get('/:id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const result = await pool.query(
    `SELECT s.*,
            s.is_active AS site_is_active,
            c.name as company_name,
            sg.center_lat, sg.center_lng, sg.radius_meters, sg.polygon_coordinates,
            CASE WHEN sg.site_id IS NOT NULL THEN true ELSE false END AS has_geofence
     FROM sites s
     JOIN companies c ON c.id = s.company_id
     LEFT JOIN site_geofence sg ON sg.site_id = s.id
     WHERE s.id = $1 ${isVishnu ? '' : 'AND s.company_id = $2'}`,
    isVishnu ? [req.params.id] : [req.params.id, req.user!.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Site not found' });
  result.rows[0].instructions_pdf_url = await urlOrPresign(result.rows[0].instructions_pdf_url);
  res.json(result.rows[0]);
});

// POST /api/sites — admin creates a site and its retention record.
// contract_end is optional (open-ended contract). geocoded_lat/lng are
// optional too; when the admin's NEW SITE modal successfully geocodes
// the address on blur, the client sends the resolved coordinates here
// so they can pre-populate the geofence editor later (schema_v27).
router.post('/', requireAuth('company_admin'), async (req, res) => {
  // Finding #3: instructions_pdf_url is NOT accepted from the body — a
  // client-supplied key would be presigned with server AWS creds on read,
  // enabling cross-tenant object reads. The only legitimate setter is the
  // server-computed key in POST /:id/instructions.
  const {
    name, address, contract_start, contract_end,
    timezone,
    geocoded_lat, geocoded_lng,
  } = req.body;
  if (!name || !address || !contract_start) {
    return res.status(400).json({ error: 'name, address, contract_start are required' });
  }
  if (timezone != null && !ALLOWED_TIMEZONES.has(timezone)) {
    return res.status(400).json({
      error: `timezone must be one of: ${[...ALLOWED_TIMEZONES].join(', ')}`,
    });
  }
  const lat = geocoded_lat != null && !Number.isNaN(Number(geocoded_lat)) ? Number(geocoded_lat) : null;
  const lng = geocoded_lng != null && !Number.isNaN(Number(geocoded_lng)) ? Number(geocoded_lng) : null;
  if (lat != null && (lat < -90  || lat > 90))  return res.status(400).json({ error: 'geocoded_lat out of range' });
  if (lng != null && (lng < -180 || lng > 180)) return res.status(400).json({ error: 'geocoded_lng out of range' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // When the client omits `timezone` we bind the same value the schema
    // DEFAULT would apply. Postgres has no clean way to say "use DEFAULT"
    // via a bound parameter without dynamic SQL, so we spell it out here.
    const siteResult = await client.query(
      `INSERT INTO sites (company_id, name, address, contract_start, contract_end, timezone, geocoded_lat, geocoded_lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [req.user!.company_id, name.trim(), address.trim(), contract_start, contract_end || null, timezone || 'America/Los_Angeles', lat, lng]
    );
    const site = siteResult.rows[0];
    // Retention rebuild: no per-site retention row. Each retention-
    // eligible child table (reports, pings, sessions, etc.) carries its
    // own expires_at populated at INSERT via services/retention.ts.
    await client.query('COMMIT');
    res.status(201).json(site);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// PUT /api/sites/:id — update site fields including instructions_pdf_url
router.put('/:id', requireAuth('company_admin'), async (req, res) => {
  // Finding #3: instructions_pdf_url is NOT accepted from the body (see
  // POST handler). It is settable only via the server-computed key in
  // POST /:id/instructions.
  const { name, address, contract_start, contract_end, timezone } = req.body;
  const gate = await assertSiteActive(req.params.id, req.user!.company_id!);
  if (!gate.ok) return res.status(gate.status).json(gate.body);
  if (timezone != null && !ALLOWED_TIMEZONES.has(timezone)) {
    return res.status(400).json({
      error: `timezone must be one of: ${[...ALLOWED_TIMEZONES].join(', ')}`,
    });
  }

  const result = await pool.query(
    `UPDATE sites SET
       name = COALESCE($1, name),
       address = COALESCE($2, address),
       contract_start = COALESCE($3, contract_start),
       contract_end = COALESCE($4, contract_end),
       timezone = COALESCE($5, timezone)
     WHERE id = $6 RETURNING *`,
    [name?.trim() || null, address?.trim() || null, contract_start || null, contract_end || null, timezone || null, req.params.id]
  );
  res.json(result.rows[0]);
});

// POST /api/sites/:id/instructions — server-side PDF upload with magic bytes validation
router.post('/:id/instructions', requireAuth('company_admin'), upload.single('file'), async (req, res) => {
  const gate = await assertSiteActive(req.params.id, req.user!.company_id!);
  if (!gate.ok) return res.status(gate.status).json(gate.body);

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const buf = req.file.buffer;
  if (buf.length < 4 || !buf.slice(0, 4).equals(PDF_MAGIC)) {
    return res.status(400).json({ error: 'File is not a valid PDF (magic bytes check failed)' });
  }

  const key = `site-instructions/${req.params.id}/instructions.pdf`;
  const url = await uploadBufferToS3(key, buf, 'application/pdf');

  await pool.query(
    'UPDATE sites SET instructions_pdf_url = $1 WHERE id = $2',
    [url, req.params.id]
  );

  res.json({ url, key });
});

// PATCH /api/sites/:id/geofence
router.patch('/:id/geofence', requireAuth('company_admin'), async (req, res) => {
  const { polygon_coordinates, center_lat, center_lng, radius_meters } = req.body;
  const gate = await assertSiteActive(req.params.id, req.user!.company_id!);
  if (!gate.ok) return res.status(gate.status).json(gate.body);

  const result = await pool.query(
    `INSERT INTO site_geofence (site_id, polygon_coordinates, center_lat, center_lng, radius_meters, created_by_admin)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id) DO UPDATE SET
       polygon_coordinates = EXCLUDED.polygon_coordinates,
       center_lat = EXCLUDED.center_lat,
       center_lng = EXCLUDED.center_lng,
       radius_meters = EXCLUDED.radius_meters,
       updated_at = NOW()
     RETURNING *`,
    [req.params.id, JSON.stringify(polygon_coordinates), center_lat, center_lng, radius_meters, req.user!.sub]
  );
  res.json(result.rows[0]);
});

// PATCH /api/sites/:id/client-access — admin enables/disables client portal.
//
// Body: { enabled: boolean }. Retention rebuild dropped the
// client_star_access_until + data_delete_at date-override fields; the
// portal gate flipped to sites.client_access_disabled_at (see
// routes/auth.ts). Kicks any live client session by bumping
// clients.tokens_not_before so the auth middleware rejects any JWT
// minted before the toggle flip.
router.patch('/:id/client-access', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const { enabled } = req.body ?? {};

  // Retention rebuild: the client_star_access_until + data_delete_at
  // date-input params are gone. The endpoint now toggles the portal
  // enable/disable state only. Portal gating flipped to
  // sites.client_access_disabled_at in routes/auth.ts.
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be boolean' });
  }

  const siteRow = isVishnu
    ? await pool.query<{ is_active: boolean }>('SELECT is_active FROM sites WHERE id = $1', [req.params.id])
    : await pool.query<{ is_active: boolean }>(
        'SELECT is_active FROM sites WHERE id = $1 AND company_id = $2',
        [req.params.id, req.user!.company_id]
      );
  if (!siteRow.rows[0]) return res.status(404).json({ error: 'Site not found' });
  if (!siteRow.rows[0].is_active) return res.status(409).json({ error: 'Site is deactivated. Reactivate it before making changes.' });

  await Promise.all([
    // v36 multi-site: don't touch clients.is_active (that's a per-client
    // global) — just kick any live JWT whose baked-in site_id was this
    // site by bumping tokens_not_before. Filter to clients actually
    // linked to this site via the junction; login re-derives access
    // from the client_sites + sites.client_access_disabled_at gate.
    pool.query(
      `UPDATE clients
          SET tokens_not_before = NOW()
        WHERE id IN (SELECT client_id FROM client_sites WHERE site_id = $1)`,
      [req.params.id],
    ),
    pool.query(
      `UPDATE sites SET client_access_disabled_at = ${enabled ? 'NULL' : 'NOW()'} WHERE id = $1`,
      [req.params.id],
    ),
  ]);

  res.json({ success: true });
});

// GET /api/sites/:id/deactivate-preview
// Returns future-state counts the admin should see before confirming a
// site deactivation. Reads only — no writes. Powers the "here's what
// will happen if you deactivate this site" modal in the sites page.
router.get('/:id/deactivate-preview', requireAuth('company_admin'), async (req, res) => {
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(404).json({ error: 'Site not found' });

  const preview = await pool.query<{
    scheduled_shifts: string;
    active_sessions: string;
    open_assignments: string;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM shifts
          WHERE site_id = $1
            AND status = 'scheduled'
            AND scheduled_start > NOW()) AS scheduled_shifts,
       (SELECT COUNT(*) FROM shift_sessions
          WHERE site_id = $1
            AND clocked_out_at IS NULL) AS active_sessions,
       (SELECT COUNT(*) FROM guard_site_assignments
          WHERE site_id = $1
            AND (assigned_until IS NULL OR assigned_until >= CURRENT_DATE)) AS open_assignments`,
    [req.params.id],
  );
  const row = preview.rows[0];
  res.json({
    scheduled_shifts:   parseInt(row.scheduled_shifts, 10),
    active_sessions:    parseInt(row.active_sessions, 10),
    open_assignments:   parseInt(row.open_assignments, 10),
  });
});

// PATCH /api/sites/:id/active — toggle site is_active + cascade side-effects.
//
// Deactivation (active=false):
//   Single transaction —
//     sites.is_active = false
//     sites.client_access_disabled_at = NOW()
//     clients.tokens_not_before = NOW() (only for clients LINKED to this
//       site via client_sites — the client row itself stays is_active=true
//       so a multi-site client keeps access to their other sites)
//     shifts.status = 'cancelled' + cancellation_reason = 'site_deactivated'
//       for FUTURE scheduled shifts only (scheduled_start > NOW()
//       AND status = 'scheduled'). NEVER touches active/completed/missed.
//     guard_site_assignments.assigned_until = CURRENT_DATE
//       for currently-open assignments only.
//   After commit: best-effort FCM push to each affected guard.
//   Historical rows (shift_sessions, reports, task_completions,
//   geofence_violations, clock_in_verifications, guard_assignment_audit)
//   are never touched.
//
// Reactivation (active=true):
//   Just flips sites.is_active back on. Per policy the previously
//   cancelled shifts stay cancelled and the client portal stays
//   disabled — admin re-enables the portal manually if desired.
router.patch('/:id/active', requireAuth('company_admin'), async (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active must be boolean' });
  }
  const siteRow = await pool.query<{ id: string; name: string; is_active: boolean }>(
    'SELECT id, name, is_active FROM sites WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id],
  );
  if (!siteRow.rows[0]) return res.status(404).json({ error: 'Site not found' });
  const site = siteRow.rows[0];

  // Idempotent no-op if already at target state.
  if (site.is_active === active) {
    return res.json({ success: true, cascaded: null });
  }

  // Reactivation branch — single flag update per policy.
  if (active) {
    await pool.query(
      'UPDATE sites SET is_active = true WHERE id = $1',
      [req.params.id],
    );
    return res.json({ success: true, cascaded: null });
  }

  // Deactivation cascade transaction.
  const client = await pool.connect();
  const affectedGuardIds = new Set<string>();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE sites SET is_active = false, client_access_disabled_at = NOW() WHERE id = $1',
      [req.params.id],
    );
    // v36 multi-site: kick any live client session whose JWT baked in
    // this site_id. Don't touch clients.is_active — a client covering
    // sites A, B, C shouldn't lose global access just because B was
    // deactivated. Login re-derives access from client_sites + the
    // site's is_active flag.
    await client.query(
      `UPDATE clients
          SET tokens_not_before = NOW()
        WHERE id IN (SELECT client_id FROM client_sites WHERE site_id = $1)`,
      [req.params.id],
    );
    const cancelled = await client.query<{ id: string; guard_id: string | null }>(
      `UPDATE shifts
          SET status = 'cancelled', cancellation_reason = 'site_deactivated'
        WHERE site_id = $1
          AND scheduled_start > NOW()
          AND status = 'scheduled'
        RETURNING id, guard_id`,
      [req.params.id],
    );
    const closed = await client.query<{ id: string; guard_id: string | null }>(
      `UPDATE guard_site_assignments
          SET assigned_until = CURRENT_DATE
        WHERE site_id = $1
          AND (assigned_until IS NULL OR assigned_until > CURRENT_DATE)
        RETURNING id, guard_id`,
      [req.params.id],
    );
    await client.query('COMMIT');

    for (const r of cancelled.rows) if (r.guard_id) affectedGuardIds.add(r.guard_id);
    for (const r of closed.rows)    if (r.guard_id) affectedGuardIds.add(r.guard_id);

    // Best-effort push to each affected guard — outside the transaction so
    // an FCM hiccup can't roll back a committed deactivation. Same shape
    // as the breach-alert path in routes/locations.ts fireBreachAlerts:
    // null out fcm_token on Expo `DeviceNotRegistered` /
    // FCM `registration-token-not-registered` (via sendPushNotification's
    // {staleToken} return).
    (async () => {
      for (const guardId of affectedGuardIds) {
        try {
          const tokRow = await pool.query<{ fcm_token: string | null }>(
            'SELECT fcm_token FROM guards WHERE id = $1',
            [guardId],
          );
          const token = tokRow.rows[0]?.fcm_token;
          if (!token) continue;
          const { staleToken } = await sendPushNotification({
            token,
            title: `Site closed — ${site.name}`,
            body:  `Your upcoming shifts at ${site.name} were cancelled because the site was deactivated. Check your schedule.`,
            data:  { type: 'site_deactivated', site_id: req.params.id },
          });
          if (staleToken) {
            await pool.query(
              'UPDATE guards SET fcm_token = NULL WHERE id = $1 AND fcm_token = $2',
              [guardId, token],
            );
          }
        } catch (err) {
          console.error('[sites.deactivate] push failed for guard', guardId, err);
        }
      }
    })().catch((err) => console.error('[sites.deactivate] push loop failed:', err));

    res.json({
      success: true,
      cascaded: {
        shifts_cancelled:   cancelled.rowCount ?? 0,
        assignments_closed: closed.rowCount ?? 0,
        guards_notified:    affectedGuardIds.size,
      },
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
});

export default router;
