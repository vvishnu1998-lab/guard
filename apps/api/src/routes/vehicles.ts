/**
 * Vehicle roster (schema_v48) — per-site patrol vehicles.
 *
 * Admin CRUD mirrors routes/checkpoints.ts conventions (site_id query
 * scoping, company tenancy checks on every path). No hard DELETE:
 * vehicles soft-retire via is_active so past inspections keep a valid
 * FK — retiring hides the vehicle from the guard picker only.
 *
 * ADMIN-ONLY visibility: every admin route is requireAuth('company_admin');
 * the guard route serves only the guard's own active-session site. The
 * 'client' role can reach nothing in this file, and nothing here is
 * mounted under /api/client (routes/clientPortal.ts is untouched).
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();

function validLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  return trimmed.length >= 1 && trimmed.length <= 120 ? trimmed : null;
}

/** '' → null (clearing the plate is legitimate — unplated vehicles). */
function validPlate(plate: unknown): { ok: boolean; value: string | null } {
  if (plate === undefined || plate === null) return { ok: true, value: null };
  if (typeof plate !== 'string') return { ok: false, value: null };
  const trimmed = plate.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  return trimmed.length <= 20 ? { ok: true, value: trimmed } : { ok: false, value: null };
}

function validMakeModel(mm: unknown): { ok: boolean; value: string | null } {
  if (mm === undefined || mm === null) return { ok: true, value: null };
  if (typeof mm !== 'string') return { ok: false, value: null };
  const trimmed = mm.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  return trimmed.length <= 120 ? { ok: true, value: trimmed } : { ok: false, value: null };
}

const ODOMETER_UNITS = new Set(['mi', 'km']);

// GET /api/vehicles?site_id=<uuid> — all vehicles for a site, inactive
// included (the UI renders retired rows greyed out). 404 when the site
// isn't ours.
router.get('/', requireAuth('company_admin'), async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(404).json({ error: 'Site not found' });

  const result = await pool.query(
    `SELECT * FROM site_vehicles WHERE site_id = $1 ORDER BY created_at ASC`,
    [site_id]
  );
  res.json(result.rows);
});

// GET /api/vehicles/mine — ACTIVE vehicles at the guard's current
// active-session site (the inspection picker). Empty array when not
// clocked in — the mobile treats that as "nothing to pick".
router.get('/mine', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT sv.id, sv.label, sv.plate, sv.make_model, sv.odometer_unit
       FROM site_vehicles sv
       JOIN shift_sessions ss ON ss.site_id = sv.site_id
      WHERE ss.guard_id = $1 AND ss.clocked_out_at IS NULL
        AND sv.is_active = TRUE
      ORDER BY sv.label ASC`,
    [req.user!.sub]
  );
  res.json(result.rows);
});

// POST /api/vehicles — add a vehicle to a site's roster.
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { site_id, label, plate, make_model, odometer_unit } = req.body;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  const cleanLabel = validLabel(label);
  if (cleanLabel === null) {
    return res.status(400).json({ error: 'label is required (1-120 characters)' });
  }
  const cleanPlate = validPlate(plate);
  if (!cleanPlate.ok) return res.status(400).json({ error: 'plate must be at most 20 characters' });
  const cleanMakeModel = validMakeModel(make_model);
  if (!cleanMakeModel.ok) return res.status(400).json({ error: 'make_model must be at most 120 characters' });
  if (odometer_unit !== undefined && !ODOMETER_UNITS.has(odometer_unit)) {
    return res.status(400).json({ error: "odometer_unit must be 'mi' or 'km'" });
  }

  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  try {
    const result = await pool.query(
      `INSERT INTO site_vehicles (site_id, label, plate, make_model, odometer_unit)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [site_id, cleanLabel, cleanPlate.value, cleanMakeModel.value, odometer_unit ?? 'mi']
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    // 23505 on uq_site_vehicles_active_plate — duplicate ACTIVE plate at this site.
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'An active vehicle with this plate already exists at this site.' });
    }
    throw err;
  }
});

// PATCH /api/vehicles/:id — label / plate / make_model / odometer_unit /
// is_active. Retiring (is_active=false) hides the vehicle from the guard
// picker; existing inspections keep referencing it.
router.patch('/:id', requireAuth('company_admin'), async (req, res) => {
  const { label, plate, make_model, odometer_unit, is_active } = req.body;

  const ownerCheck = await pool.query(
    `SELECT sv.id FROM site_vehicles sv
     JOIN sites s ON s.id = sv.site_id
     WHERE sv.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Vehicle not found' });

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (label !== undefined) {
    const cleanLabel = validLabel(label);
    if (cleanLabel === null) return res.status(400).json({ error: 'label must be 1-120 characters' });
    fields.push(`label = $${idx++}`);
    values.push(cleanLabel);
  }
  if (plate !== undefined) {
    const cleanPlate = validPlate(plate);
    if (!cleanPlate.ok) return res.status(400).json({ error: 'plate must be at most 20 characters' });
    fields.push(`plate = $${idx++}`);
    values.push(cleanPlate.value);
  }
  if (make_model !== undefined) {
    const cleanMakeModel = validMakeModel(make_model);
    if (!cleanMakeModel.ok) return res.status(400).json({ error: 'make_model must be at most 120 characters' });
    fields.push(`make_model = $${idx++}`);
    values.push(cleanMakeModel.value);
  }
  if (odometer_unit !== undefined) {
    if (!ODOMETER_UNITS.has(odometer_unit)) {
      return res.status(400).json({ error: "odometer_unit must be 'mi' or 'km'" });
    }
    fields.push(`odometer_unit = $${idx++}`);
    values.push(odometer_unit);
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be a boolean' });
    fields.push(`is_active = $${idx++}`);
    values.push(is_active);
  }
  if (fields.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE site_vehicles SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
      values
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'An active vehicle with this plate already exists at this site.' });
    }
    throw err;
  }
});

export default router;
