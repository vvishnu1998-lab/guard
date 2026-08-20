/**
 * Vehicle inspections (schema_v48) — one record per shift session.
 *
 * PROMPTED, NOT BLOCKING: clock-in never depends on this file. The mobile
 * creates the row at vehicle selection (POST, idempotent per session) and
 * fills it progressively — each of the five photos PATCHes its slot as it
 * uploads, and the typed odometer lands the same way. That is what makes
 * partial progress survive an app force-quit: state lives here, not in
 * the app. The server stamps completed_at when all five photos + the
 * reading are present; incomplete ≡ completed_at IS NULL.
 *
 * Angle slots are FIXED: front, rear, driver_side, passenger_side,
 * odometer.
 *
 * ADMIN-ONLY visibility: the read endpoint allows company_admin (own
 * company), vishnu, and the owning guard. The 'client' role can reach
 * nothing here; nothing is mounted under /api/client and clientPortal.ts
 * is untouched. Guard writes are allowed only while the session is OPEN —
 * evidence photos cannot be backfilled after clock-out.
 *
 * Photo URLs get the same D2 magic-byte validation as report photos:
 * bucket-allowlist key check, first-16-bytes magic match, quarantine row
 * on mismatch.
 */
import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { expiresAtFor } from '../services/retention';
import { getS3ObjectHead, s3KeyFromPublicUrl, urlOrPresign } from '../services/s3';
import { isAllowedContentType, magicMatches, describeMagic } from '../services/imageMagic';

const router = Router();

const PHOTO_SLOTS = [
  'photo_front_url',
  'photo_rear_url',
  'photo_driver_side_url',
  'photo_passenger_side_url',
  'photo_odometer_url',
] as const;
type PhotoSlot = (typeof PHOTO_SLOTS)[number];

const ODOMETER_MAX = 9_999_999;

/** Swap the five stored photo URLs for short-lived presigned GETs — same
 *  S3-lockdown path report photos use (services/s3.ts PR1 helpers). Raw
 *  stored URLs never leave the API on read paths. */
async function presignInspectionPhotos<T extends Record<string, unknown>>(row: T): Promise<T> {
  const out: Record<string, unknown> = { ...row };
  for (const slot of PHOTO_SLOTS) {
    out[slot] = await urlOrPresign(row[slot] as string | null);
  }
  return out as T;
}

/** D2 validation for one client-supplied photo URL. Returns an error body
 *  to send, or null when the object is a genuine JPEG in our bucket. */
async function validateInspectionPhoto(
  url: string,
  ctx: { guardId: string; companyId?: string; shiftSessionId: string },
): Promise<{ status: number; body: { error: string } } | null> {
  const key = s3KeyFromPublicUrl(url);
  if (!key) {
    return { status: 400, body: { error: 'photo URLs must point at the configured S3 bucket' } };
  }
  const declared = 'image/jpeg'; // presigned POST policy pins Content-Type per upload
  if (!isAllowedContentType(declared)) {
    return { status: 400, body: { error: `unsupported content_type ${declared}` } };
  }
  let head: Buffer;
  try {
    head = await getS3ObjectHead(key, 16);
  } catch {
    return {
      status: 400,
      body: { error: `Photo not found in storage (key=${key}); please re-upload before submitting.` },
    };
  }
  if (!magicMatches(declared, head)) {
    const detected = describeMagic(head);
    await pool.query(
      `INSERT INTO quarantined_uploads
         (s3_key, declared_content_type, detected_magic, guard_id, company_id, shift_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, declared, detected, ctx.guardId, ctx.companyId ?? null, ctx.shiftSessionId],
    );
    return {
      status: 400,
      body: {
        error: `Uploaded file is not a valid ${declared} (detected: ${detected}). The upload has been quarantined; please re-take the photo.`,
      },
    };
  }
  return null;
}

/** Loads an inspection + its OPEN session for the requesting guard.
 *  404s on wrong owner (don't leak which inspection ids exist);
 *  409s when the session has already closed. */
async function loadOwnOpenInspection(inspectionId: string, guardId: string) {
  const result = await pool.query(
    `SELECT vi.*, ss.guard_id, ss.site_id, ss.clocked_out_at
       FROM vehicle_inspections vi
       JOIN shift_sessions ss ON ss.id = vi.shift_session_id
      WHERE vi.id = $1`,
    [inspectionId]
  );
  const row = result.rows[0];
  if (!row || row.guard_id !== guardId) return { error: { status: 404, body: { error: 'Inspection not found' } } };
  if (row.clocked_out_at !== null) {
    return { error: { status: 409, body: { error: 'Shift has ended — the inspection can no longer be edited.' } } };
  }
  return { row };
}

// POST /api/inspections — create (or return) THE inspection for the
// guard's session. Body: { shift_session_id, vehicle_id }. Idempotent per
// session via the UNIQUE constraint: a restarted app POSTing again gets
// the existing row back with 200 instead of a 409.
router.post('/', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, vehicle_id } = req.body as { shift_session_id?: string; vehicle_id?: string };
  if (!shift_session_id || !vehicle_id) {
    return res.status(400).json({ error: 'shift_session_id and vehicle_id are required' });
  }

  const sessionResult = await pool.query(
    `SELECT id, site_id FROM shift_sessions
      WHERE id = $1 AND guard_id = $2 AND clocked_out_at IS NULL`,
    [shift_session_id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Active session not found' });
  const { site_id } = sessionResult.rows[0];

  const vehicleResult = await pool.query(
    `SELECT id FROM site_vehicles WHERE id = $1 AND site_id = $2 AND is_active = TRUE`,
    [vehicle_id, site_id]
  );
  if (!vehicleResult.rows[0]) return res.status(404).json({ error: 'Vehicle not found at this site' });

  const inserted = await pool.query(
    `INSERT INTO vehicle_inspections (shift_session_id, vehicle_id, expires_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (shift_session_id) DO NOTHING
     RETURNING *`,
    [shift_session_id, vehicle_id, expiresAtFor('vehicle_inspection')]
  );
  if (inserted.rows[0]) return res.status(201).json(inserted.rows[0]);

  const existing = await pool.query(
    `SELECT * FROM vehicle_inspections WHERE shift_session_id = $1`,
    [shift_session_id]
  );
  res.status(200).json(existing.rows[0]);
});

// PATCH /api/inspections/:id — progressive fill: any subset of the five
// photo slots, odometer_reading, and (until completed) vehicle_id.
// Server stamps completed_at when everything is present.
router.patch('/:id', requireAuth('guard'), async (req, res) => {
  const loaded = await loadOwnOpenInspection(req.params.id, req.user!.sub);
  if ('error' in loaded && loaded.error) return res.status(loaded.error.status).json(loaded.error.body);
  const inspection = loaded.row!;

  const body = req.body as Record<string, unknown>;
  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const slot of PHOTO_SLOTS) {
    if (body[slot] === undefined) continue;
    const url = body[slot];
    if (typeof url !== 'string' || url.length === 0) {
      return res.status(400).json({ error: `${slot} must be a non-empty URL string` });
    }
    const photoError = await validateInspectionPhoto(url, {
      guardId: req.user!.sub,
      companyId: req.user!.company_id,
      shiftSessionId: inspection.shift_session_id,
    });
    if (photoError) return res.status(photoError.status).json(photoError.body);
    fields.push(`${slot} = $${idx++}`);
    values.push(url);
  }

  if (body.odometer_reading !== undefined) {
    const reading = body.odometer_reading;
    if (typeof reading !== 'number' || !Number.isInteger(reading) || reading < 0 || reading > ODOMETER_MAX) {
      return res.status(400).json({ error: `odometer_reading must be an integer between 0 and ${ODOMETER_MAX}` });
    }
    fields.push(`odometer_reading = $${idx++}`);
    values.push(reading);
  }

  if (body.vehicle_id !== undefined) {
    if (inspection.completed_at !== null) {
      return res.status(409).json({ error: 'Inspection already completed — the vehicle can no longer change.' });
    }
    const vehicleResult = await pool.query(
      `SELECT id FROM site_vehicles WHERE id = $1 AND site_id = $2 AND is_active = TRUE`,
      [body.vehicle_id, inspection.site_id]
    );
    if (!vehicleResult.rows[0]) return res.status(404).json({ error: 'Vehicle not found at this site' });
    fields.push(`vehicle_id = $${idx++}`);
    values.push(body.vehicle_id);
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(req.params.id);
  await pool.query(
    `UPDATE vehicle_inspections SET ${fields.join(', ')} WHERE id = $${idx}`,
    values
  );

  // Completion stamp — idempotent, server-decided, never client-supplied.
  await pool.query(
    `UPDATE vehicle_inspections SET completed_at = NOW()
      WHERE id = $1 AND completed_at IS NULL
        AND odometer_reading IS NOT NULL
        AND photo_front_url IS NOT NULL AND photo_rear_url IS NOT NULL
        AND photo_driver_side_url IS NOT NULL AND photo_passenger_side_url IS NOT NULL
        AND photo_odometer_url IS NOT NULL`,
    [req.params.id]
  );

  const result = await pool.query(`SELECT * FROM vehicle_inspections WHERE id = $1`, [req.params.id]);
  res.json(await presignInspectionPhotos(result.rows[0]));
});

// GET /api/inspections/session/:sessionId — the inspection for one shift
// session, with vehicle + guard context for the admin viewer. Roles:
//   - company_admin: own company's sessions only (404 otherwise)
//   - vishnu: any
//   - guard: own session only (mobile hydrate on restart)
// The 'client' role is NOT accepted — admin-only visibility (4.5).
router.get('/session/:sessionId', requireAuth('company_admin', 'vishnu', 'guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT vi.*, ss.guard_id, ss.clocked_in_at, si.company_id, si.name AS site_name,
            g.name AS guard_name,
            sv.label AS vehicle_label, sv.plate AS vehicle_plate,
            sv.make_model AS vehicle_make_model, sv.odometer_unit
       FROM vehicle_inspections vi
       JOIN shift_sessions ss ON ss.id = vi.shift_session_id
       JOIN sites si ON si.id = ss.site_id
       JOIN site_vehicles sv ON sv.id = vi.vehicle_id
       LEFT JOIN guards g ON g.id = ss.guard_id
      WHERE vi.shift_session_id = $1`,
    [req.params.sessionId]
  );
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: 'Inspection not found' });

  const { user } = req;
  if (user!.role === 'company_admin' && row.company_id !== user!.company_id) {
    return res.status(404).json({ error: 'Inspection not found' });
  }
  if (user!.role === 'guard' && row.guard_id !== user!.sub) {
    return res.status(404).json({ error: 'Inspection not found' });
  }
  res.json(await presignInspectionPhotos(row));
});

// GET /api/inspections/shift/:shiftId — every inspection across the
// shift's sessions (handoff shifts have several), for the admin shift
// detail viewer. company_admin: own company only; vishnu: any. Photos
// come back presigned. Sessions WITHOUT an inspection row are included
// with inspection fields null so the web can render "not started" rows.
router.get('/shift/:shiftId', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const shiftCheck = await pool.query(
    `SELECT sh.id, si.company_id, si.vehicle_inspection_required
       FROM shifts sh JOIN sites si ON si.id = sh.site_id
      WHERE sh.id = $1`,
    [req.params.shiftId]
  );
  const shiftRow = shiftCheck.rows[0];
  if (!shiftRow) return res.status(404).json({ error: 'Shift not found' });
  if (req.user!.role === 'company_admin' && shiftRow.company_id !== req.user!.company_id) {
    return res.status(404).json({ error: 'Shift not found' });
  }

  const result = await pool.query(
    `SELECT ss.id AS session_id, ss.clocked_in_at, ss.clocked_out_at,
            g.name AS guard_name,
            vi.id, vi.vehicle_id, vi.odometer_reading, vi.completed_at, vi.created_at,
            vi.photo_front_url, vi.photo_rear_url, vi.photo_driver_side_url,
            vi.photo_passenger_side_url, vi.photo_odometer_url,
            sv.label AS vehicle_label, sv.plate AS vehicle_plate,
            sv.make_model AS vehicle_make_model, sv.odometer_unit
       FROM shift_sessions ss
       LEFT JOIN guards g ON g.id = ss.guard_id
       LEFT JOIN vehicle_inspections vi ON vi.shift_session_id = ss.id
       LEFT JOIN site_vehicles sv ON sv.id = vi.vehicle_id
      WHERE ss.shift_id = $1
      ORDER BY ss.clocked_in_at ASC`,
    [req.params.shiftId]
  );
  const rows = await Promise.all(result.rows.map((r) => presignInspectionPhotos(r)));
  res.json({
    vehicle_inspection_required: shiftRow.vehicle_inspection_required,
    sessions: rows,
  });
});

export default router;
