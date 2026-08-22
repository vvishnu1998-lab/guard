import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { validateAtCheckpoint } from '../services/geofence';
import { readShadowSignals } from '../services/shadowSignals';
import { checkMockLocation, MOCK_LOCATION_ERROR } from '../services/mockLocation';

const router = Router();

// Admin-facing checkpoint CRUD + scan history (C3a). Guard-facing scan
// and link endpoints are C3b — not in this file yet.
//
// Checkpoints are created UNLINKED (label only). code_value / code_type /
// lat / lng / link_accuracy_m / linked_at / linked_by_guard_id are set
// exclusively by a guard's link scan, so every admin write path here
// refuses them. Unlink clears them; past scans are kept — they remain
// valid history of where the guard actually was.

const LINK_ONLY_FIELDS = [
  'code_value', 'code_type', 'lat', 'lng',
  'link_accuracy_m', 'linked_at', 'linked_by_guard_id',
] as const;

function validLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  return trimmed.length >= 1 && trimmed.length <= 120 ? trimmed : null;
}

function validRadius(radius: unknown): boolean {
  return typeof radius === 'number' && Number.isInteger(radius) && radius >= 10 && radius <= 500;
}

// GET /api/checkpoints?site_id=<uuid> — all checkpoints for a site,
// inactive included (the UI filters). 404 when the site isn't ours.
router.get('/', requireAuth('company_admin'), async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(404).json({ error: 'Site not found' });

  const result = await pool.query(
    `SELECT sc.*, (sc.code_value IS NOT NULL) AS linked
     FROM site_checkpoints sc
     WHERE sc.site_id = $1
     ORDER BY sc.sort_order ASC, sc.created_at ASC`,
    [site_id]
  );
  res.json(result.rows);
});

// POST /api/checkpoints — create an UNLINKED checkpoint (label only).
// Link fields from the client are ignored by construction: only
// site_id / label / radius_meters are ever read from the body.
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { site_id, label, radius_meters } = req.body;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  const cleanLabel = validLabel(label);
  if (cleanLabel === null) {
    return res.status(400).json({ error: 'label is required (1-120 characters)' });
  }
  if (radius_meters !== undefined && !validRadius(radius_meters)) {
    return res.status(400).json({ error: 'radius_meters must be an integer between 10 and 500' });
  }

  // Verify site belongs to admin's company
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  const result = await pool.query(
    `INSERT INTO site_checkpoints (site_id, label, radius_meters, sort_order)
     VALUES ($1, $2, $3,
             COALESCE((SELECT MAX(sort_order) + 1 FROM site_checkpoints WHERE site_id = $1), 0))
     RETURNING *, (code_value IS NOT NULL) AS linked`,
    [site_id, cleanLabel, radius_meters ?? 50]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /api/checkpoints/:id — label / radius_meters / sort_order /
// is_active only. Any link-state key in the body at all → 400.
router.patch('/:id', requireAuth('company_admin'), async (req, res) => {
  const forbidden = LINK_ONLY_FIELDS.filter((k) => k in req.body);
  if (forbidden.length > 0) {
    return res.status(400).json({
      error: `Fields set only by a guard's link scan: ${forbidden.join(', ')}. Use /unlink to clear them.`,
    });
  }

  const { label, radius_meters, sort_order, is_active } = req.body;

  const ownerCheck = await pool.query(
    `SELECT sc.id FROM site_checkpoints sc
     JOIN sites s ON s.id = sc.site_id
     WHERE sc.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Checkpoint not found' });

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (label !== undefined) {
    const cleanLabel = validLabel(label);
    if (cleanLabel === null) {
      return res.status(400).json({ error: 'label must be 1-120 characters' });
    }
    fields.push(`label = $${idx++}`);
    values.push(cleanLabel);
  }
  if (radius_meters !== undefined) {
    if (!validRadius(radius_meters)) {
      return res.status(400).json({ error: 'radius_meters must be an integer between 10 and 500' });
    }
    fields.push(`radius_meters = $${idx++}`);
    values.push(radius_meters);
  }
  if (sort_order !== undefined) {
    if (typeof sort_order !== 'number' || !Number.isInteger(sort_order)) {
      return res.status(400).json({ error: 'sort_order must be an integer' });
    }
    fields.push(`sort_order = $${idx++}`);
    values.push(sort_order);
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }
    fields.push(`is_active = $${idx++}`);
    values.push(is_active);
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(req.params.id);
  const result = await pool.query(
    `UPDATE site_checkpoints SET ${fields.join(', ')} WHERE id = $${idx}
     RETURNING *, (code_value IS NOT NULL) AS linked`,
    values
  );
  res.json(result.rows[0]);
});

// POST /api/checkpoints/:id/unlink — clear the link state so a guard can
// re-anchor a checkpoint that was linked at the wrong position. Past
// scans are intentionally kept.
router.post('/:id/unlink', requireAuth('company_admin'), async (req, res) => {
  const ownerCheck = await pool.query(
    `SELECT sc.id FROM site_checkpoints sc
     JOIN sites s ON s.id = sc.site_id
     WHERE sc.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Checkpoint not found' });

  const result = await pool.query(
    `UPDATE site_checkpoints
     SET code_value = NULL, code_type = NULL, lat = NULL, lng = NULL,
         link_accuracy_m = NULL, linked_at = NULL, linked_by_guard_id = NULL
     WHERE id = $1
     RETURNING *, (code_value IS NOT NULL) AS linked`,
    [req.params.id]
  );
  res.json(result.rows[0]);
});

// DELETE /api/checkpoints/:id?confirm=delete_scans — hard delete.
// checkpoint_scans has ON DELETE CASCADE (schema_v44), so this destroys
// scan history; without the explicit confirm param, 409 with the count.
// Prefer PATCH is_active=false.
router.delete('/:id', requireAuth('company_admin'), async (req, res) => {
  const ownerCheck = await pool.query(
    `SELECT sc.id FROM site_checkpoints sc
     JOIN sites s ON s.id = sc.site_id
     WHERE sc.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Checkpoint not found' });

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS scan_count FROM checkpoint_scans WHERE checkpoint_id = $1',
    [req.params.id]
  );
  const scanCount = countResult.rows[0].scan_count;

  if (req.query.confirm !== 'delete_scans') {
    return res.status(409).json({
      error: `Deleting this checkpoint destroys ${scanCount} scan record(s). ` +
        `Repeat with ?confirm=delete_scans to proceed, or set is_active=false to hide it instead.`,
      scan_count: scanCount,
    });
  }

  await pool.query('DELETE FROM site_checkpoints WHERE id = $1', [req.params.id]);
  res.json({ success: true, scans_deleted: scanCount });
});

// GET /api/checkpoints/scans?site_id=<uuid>&from=<ISO>&to=<ISO> — scan
// history for a site. Defaults to the last 7 days; range capped at 92
// days; result capped at 1000 rows with a `truncated` flag.
router.get('/scans', requireAuth('company_admin'), async (req, res) => {
  const { site_id, from, to } = req.query;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  const toDate = to !== undefined ? new Date(String(to)) : new Date();
  const fromDate = from !== undefined
    ? new Date(String(from))
    : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'from/to must be valid ISO timestamps' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'from must be before to' });
  }
  if (toDate.getTime() - fromDate.getTime() > 92 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'Range must be 92 days or less' });
  }

  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(404).json({ error: 'Site not found' });

  const CAP = 1000;
  const result = await pool.query(
    `SELECT cs.*, sc.label AS checkpoint_label, g.name AS guard_name
     FROM checkpoint_scans cs
     JOIN site_checkpoints sc ON sc.id = cs.checkpoint_id
     JOIN guards g ON g.id = cs.guard_id
     WHERE cs.site_id = $1 AND cs.scanned_at >= $2 AND cs.scanned_at <= $3
     ORDER BY cs.scanned_at DESC
     LIMIT ${CAP + 1}`,
    [site_id, fromDate.toISOString(), toDate.toISOString()]
  );

  const truncated = result.rows.length > CAP;
  res.json({
    scans: truncated ? result.rows.slice(0, CAP) : result.rows,
    truncated,
  });
});

// ── Guard-facing routes (C3b) ───────────────────────────────────────────────
//
// No client-supplied session id: the active session is resolved server-side
// (reports.ts / notifications.ts convention — guard_id + clocked_out_at IS
// NULL) and site_id comes from the session row, never the body.
//
// round_window is computed SERVER-SIDE, in SQL, per site: the current
// instant floored to the hour in the site's own timezone (sites.timezone,
// v21), stored as the UTC instant of that boundary — v40's double
// AT TIME ZONE form. The INSERT computes it inline so there is no
// read-then-write race, and the counter queries use the identical
// expression so both always agree.

const ROUND_WINDOW_SQL = `date_trunc('hour', NOW() AT TIME ZONE s.timezone) AT TIME ZONE s.timezone`;

async function activeSession(guardId: string): Promise<{ id: string; site_id: string } | null> {
  const r = await pool.query(
    'SELECT id, site_id FROM shift_sessions WHERE guard_id = $1 AND clocked_out_at IS NULL LIMIT 1',
    [guardId]
  );
  return r.rows[0] ?? null;
}

/** { total, scanned, round_window } for a session's current window.
 *  total = active LINKED checkpoints (the scannable set); scanned =
 *  distinct ones scanned this window. */
async function windowCounter(siteId: string, sessionId: string) {
  const r = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM site_checkpoints sc
         WHERE sc.site_id = s.id AND sc.is_active = true AND sc.code_value IS NOT NULL) AS total,
       (SELECT COUNT(DISTINCT cs.checkpoint_id)::int FROM checkpoint_scans cs
         JOIN site_checkpoints sc2 ON sc2.id = cs.checkpoint_id
         WHERE cs.shift_session_id = $2 AND sc2.is_active = true
           AND cs.round_window = ${ROUND_WINDOW_SQL}) AS scanned,
       ${ROUND_WINDOW_SQL} AS round_window
     FROM sites s WHERE s.id = $1`,
    [siteId, sessionId]
  );
  return r.rows[0] as { total: number; scanned: number; round_window: Date };
}

// GET /api/checkpoints/mine — active checkpoints at the guard's current
// site, with per-checkpoint scanned_this_window and the window counter.
router.get('/mine', requireAuth('guard'), async (req, res) => {
  const session = await activeSession(req.user!.sub);
  if (!session) return res.status(403).json({ error: 'Active session not found' });

  const result = await pool.query(
    `SELECT sc.id, sc.label, sc.sort_order,
            (sc.code_value IS NOT NULL) AS linked,
            EXISTS (
              SELECT 1 FROM checkpoint_scans cs
              WHERE cs.checkpoint_id = sc.id
                AND cs.shift_session_id = $2
                AND cs.round_window = ${ROUND_WINDOW_SQL}
            ) AS scanned_this_window
     FROM site_checkpoints sc
     JOIN sites s ON s.id = sc.site_id
     WHERE sc.site_id = $1 AND sc.is_active = true
     ORDER BY sc.sort_order ASC, sc.created_at ASC`,
    [session.site_id, session.id]
  );

  const counter = await windowCounter(session.site_id, session.id);
  res.json({
    site_id: session.site_id,
    round_window: counter.round_window,
    total: counter.total,
    scanned: counter.scanned,
    unlinked: result.rows.filter((r) => !r.linked).length,
    checkpoints: result.rows,
  });
});

// POST /api/checkpoints/link — anchor an unlinked checkpoint at the
// guard's current position. Link fields are set here and nowhere else.
router.post('/link', requireAuth('guard'), async (req, res) => {
  const { checkpoint_id, code_value, code_type, latitude, longitude, accuracy } = req.body;

  const session = await activeSession(req.user!.sub);
  if (!session) return res.status(403).json({ error: 'Active session not found' });

  const cpResult = await pool.query(
    `SELECT id, code_value FROM site_checkpoints
     WHERE id = $1 AND site_id = $2 AND is_active = true`,
    [checkpoint_id, session.site_id]
  );
  const cp = cpResult.rows[0];
  if (!cp) return res.status(404).json({ error: 'Checkpoint not found' });
  if (cp.code_value !== null) return res.status(409).json({ error: 'Checkpoint already linked' });

  if (typeof code_value !== 'string' || code_value.length < 1 || code_value.length > 512) {
    return res.status(400).json({ error: 'code_value is required (1-512 characters)' });
  }
  if (typeof code_type !== 'string' || code_type.length < 1 || code_type.length > 20) {
    return res.status(400).json({ error: 'code_type is required (1-20 characters)' });
  }
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'Invalid coordinates.' });
  }
  if (Math.abs(latitude) < 1e-6 && Math.abs(longitude) < 1e-6) {
    return res.status(400).json({ error: 'Invalid coordinates. GPS lock required.' });
  }
  // Mock-location gate — /link. No transaction on this route (plain
  // pool.query), so a reject is a plain early return. session.site_id
  // resolves above, so the log carries a real site.
  //
  // WHY THIS ROUTE MATTERS MOST: it does not record where a guard claimed
  // to be, it DEFINES the anchor every future scan is measured against
  // (validateAtCheckpoint reads site_checkpoints.lat/lng and budgets with
  // link_accuracy_m). A simulated fix here silently relocates the
  // checkpoint permanently, and no downstream row can tell.
  {
    const linkSignals = readShadowSignals(req.body, 'checkpoint-link');
    const mockCheck = checkMockLocation(linkSignals.locationMocked, 'checkpoint-link', {
      guardId: req.user!.sub, siteId: session.site_id,
      accuracyM: linkSignals.accuracyMeters, fixAgeMs: linkSignals.fixAgeMs,
    });
    if (mockCheck.reject) return res.status(422).json(MOCK_LOCATION_ERROR);
  }

  if (!Number.isFinite(accuracy) || accuracy < 0 || accuracy > 30) {
    // `error` is a CODE, `message` is the copy. Every other guard route
    // already does this (PING_OFF_POST, REPORT_OFF_POST, TASK_OFF_POST,
    // GEOFENCE_FAILED…); these two were the last sending a sentence in the
    // code field, which is why the scanner screen had nothing to branch on
    // and keyed on HTTP status instead. Since Wave 2 both /link and /scan
    // return two distinct 422s, so status is no longer a usable
    // discriminator. `message` is byte-identical to the old `error`, so
    // pre-OTA clients that surface err.message read exactly as before.
    return res.status(422).json({
      error: 'CHECKPOINT_LINK_GPS_WEAK',
      message: 'GPS signal too weak to anchor this checkpoint',
      accuracy_m: Number.isFinite(accuracy) ? accuracy : null,
      required_m: 30,
    });
  }

  try {
    // `AND code_value IS NULL` re-checks linkage inside the UPDATE so a
    // concurrent link can't be overwritten; rowCount 0 = the race lost.
    const updated = await pool.query(
      `UPDATE site_checkpoints
       SET code_value = $1, code_type = $2, lat = $3, lng = $4,
           link_accuracy_m = $5, linked_at = NOW(), linked_by_guard_id = $6
       WHERE id = $7 AND code_value IS NULL
       RETURNING *, (code_value IS NOT NULL) AS linked`,
      [code_value, code_type, latitude, longitude, accuracy, req.user!.sub, checkpoint_id]
    );
    if (updated.rowCount === 0) {
      return res.status(409).json({ error: 'Checkpoint already linked' });
    }
    res.json(updated.rows[0]);
  } catch (err: any) {
    // uq_site_checkpoints_site_code — this physical tag is already
    // registered to a different checkpoint at this site.
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'This tag is already linked to another checkpoint' });
    }
    throw err;
  }
});

// POST /api/checkpoints/scan — record a scan. The tag identifies itself
// (no checkpoint_id from the client); duplicates within a window are
// absorbed by the uq_checkpoint_scans_round ON CONFLICT, not errored.
router.post('/scan', requireAuth('guard'), async (req, res) => {
  const { code_value, latitude, longitude, accuracy, note } = req.body;

  const session = await activeSession(req.user!.sub);
  if (!session) return res.status(403).json({ error: 'Active session not found' });

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'Invalid coordinates.' });
  }
  if (Math.abs(latitude) < 1e-6 && Math.abs(longitude) < 1e-6) {
    return res.status(400).json({ error: 'Invalid coordinates. GPS lock required.' });
  }

  // Mock-location gate — /scan. No transaction on this route, so a reject
  // is a plain early return. session.site_id resolves above.
  const scanSignals = readShadowSignals(req.body, 'checkpoint-scan');
  {
    const mockCheck = checkMockLocation(scanSignals.locationMocked, 'checkpoint-scan', {
      guardId: req.user!.sub, siteId: session.site_id,
      accuracyM: scanSignals.accuracyMeters, fixAgeMs: scanSignals.fixAgeMs,
    });
    if (mockCheck.reject) return res.status(422).json(MOCK_LOCATION_ERROR);
  }

  const cpResult = await pool.query(
    `SELECT id, label, lat, lng, radius_meters, link_accuracy_m FROM site_checkpoints
     WHERE site_id = $1 AND code_value = $2 AND is_active = true`,
    [session.site_id, code_value ?? null]
  );
  const cp = cpResult.rows[0];
  if (!cp) return res.status(404).json({ error: "This tag isn't registered at this site" });

  const accuracyM: number | null =
    typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null;

  const fence = validateAtCheckpoint(
    { lat: latitude, lng: longitude, accuracy_m: accuracyM ?? 0 },
    { lat: cp.lat, lng: cp.lng, radius_meters: cp.radius_meters, link_accuracy_m: cp.link_accuracy_m }
  );
  if (!fence.allowed) {
    // A 422 writes no row, so this line is the ONLY record of a rejected
    // scan — log every budget component and the reported coordinates or
    // field failures become unfalsifiable (2026-08-04 walk-test lesson).
    console.log(
      `[checkpoint.reject] checkpoint=${cp.id} label=${JSON.stringify(cp.label)} ` +
      `session=${session.id} guard=${req.user!.sub} ` +
      `distance=${fence.distance_m.toFixed(1)}m budget=${fence.budget_m.toFixed(1)}m ` +
      `radius=${fence.radius_m}m scan_accuracy=${fence.scan_accuracy_m.toFixed(1)}m ` +
      `link_accuracy=${fence.link_accuracy_m.toFixed(1)}m ` +
      `scan_lat=${latitude} scan_lng=${longitude}`
    );
    // See the note on CHECKPOINT_LINK_GPS_WEAK above — code in `error`,
    // copy in `message`, old clients unaffected.
    return res.status(422).json({
      error: 'CHECKPOINT_TOO_FAR',
      message: 'You are too far from this checkpoint',
      checkpoint_label: cp.label,
      distance_m: Math.round(fence.distance_m),
      allowed_m: Math.round(fence.budget_m),
    });
  }

  let cleanNote: string | null = null;
  if (note !== undefined && note !== null) {
    if (typeof note !== 'string' || note.trim().length > 500) {
      return res.status(400).json({ error: 'note must be a string of 500 characters or fewer' });
    }
    cleanNote = note.trim() || null;
  }

  // round_window computed inside the INSERT (no read-then-write race);
  // expires_at intentionally omitted — column DEFAULT applies.
  const inserted = await pool.query(
    `INSERT INTO checkpoint_scans
       (checkpoint_id, shift_session_id, guard_id, site_id, round_window,
        scan_lat, scan_lng, accuracy_m, distance_m, note,
        location_mocked, fix_age_ms)
     SELECT $1, $2, $3, $4, ${ROUND_WINDOW_SQL}, $5, $6, $7, $8, $9, $10, $11
     FROM sites s WHERE s.id = $4
     ON CONFLICT (checkpoint_id, shift_session_id, round_window) DO NOTHING
     RETURNING scanned_at`,
    [cp.id, session.id, req.user!.sub, session.site_id,
     latitude, longitude, accuracyM, fence.distance_m, cleanNote,
     // Shadow capture (Wave 2) — recorded, never evaluated here.
     scanSignals.locationMocked, scanSignals.fixAgeMs]
  );

  const duplicate = inserted.rowCount === 0;
  let scannedAt: Date;
  if (duplicate) {
    const existing = await pool.query(
      `SELECT cs.scanned_at FROM checkpoint_scans cs
       JOIN sites s ON s.id = cs.site_id
       WHERE cs.checkpoint_id = $1 AND cs.shift_session_id = $2
         AND cs.round_window = ${ROUND_WINDOW_SQL}`,
      [cp.id, session.id]
    );
    scannedAt = existing.rows[0]?.scanned_at ?? null;
  } else {
    scannedAt = inserted.rows[0].scanned_at;
  }

  const counter = await windowCounter(session.site_id, session.id);
  res.status(duplicate ? 200 : 201).json({
    ok: true,
    duplicate,
    checkpoint_id: cp.id,
    checkpoint_label: cp.label,
    scanned_at: scannedAt,
    distance_m: Math.round(fence.distance_m),
    scanned: counter.scanned,
    total: counter.total,
  });
});

export default router;
