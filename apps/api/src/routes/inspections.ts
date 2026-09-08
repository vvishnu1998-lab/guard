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
import { siteLocalDayRange } from '../services/dateRange';

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Same cap the scan-history list uses (routes/checkpoints.ts:225,254) — a
 *  92-day ceiling on the range and a 1000-row ceiling on the response, with
 *  `truncated` telling the caller which one it hit. Deliberately not
 *  offset pagination: the browse surface is a bounded date window, and a
 *  page cursor over a range the user already narrowed buys nothing. */
const MAX_RANGE_DAYS = 92;
const LIST_CAP = 1000;

/**
 * `YYYY-MM-DD`, `daysAgo` calendar days before today **at the site**.
 *
 * The step back runs on a synthetic noon-UTC anchor built from the site's
 * own calendar day: noon sits far enough from midnight that a DST shift on
 * either side cannot move the date, so this is plain arithmetic on a date
 * rather than a conversion of a real instant.
 *
 * Twin of `dateInputValue()` in apps/web/app/admin/sites/[id]/page.tsx:199,
 * kept local because this route is its only caller — promote it into
 * services/dateRange.ts if a second one appears.
 *
 * An invalid `sites.timezone` makes Intl throw, and that throw is left to
 * propagate — same deliberate loud failure as services/siteTime.ts:25.
 */
function siteLocalDateStr(daysAgo: number, timeZone: string, now: Date = new Date()): string {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
  const anchor = new Date(`${today}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - daysAgo);
  return anchor.toISOString().slice(0, 10);
}

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

// GET /api/inspections/site/:siteId — inspection history for ONE site,
// backing the admin site-detail INSPECTIONS tab.
//
// ROLES: company_admin (own company only) and vishnu. **The 'client' role
// cannot reach this**, structurally and in two independent ways: requireAuth
// refuses any role outside its argument list with 403 before a line of this
// handler runs (middleware/auth.ts:75-77), and this router is mounted at
// /api/inspections (index.ts:207) while the client role is served entirely
// from /api/client by clientPortal.ts, which is untouched. That matches the
// admin-only visibility stated in this file's header (:15-19).
//
// SCOPING: 404 — never 403 — on a company mismatch, the same shape as
// GET /shift/:shiftId (:277). A 403 would confirm the site exists and turn
// the endpoint into a site-id oracle for a neighbouring tenant.
//
// RANGE: bounds are whole days **at the site** via siteLocalDayRange
// (services/dateRange.ts:82-102), which anchors each bound with
// `AT TIME ZONE s.timezone` per row. Not hardcoded Pacific: every site is
// America/Los_Angeles today, so the two are indistinguishable now, which is
// exactly why the correct one is free to adopt (that file's header, :24-32).
router.get('/site/:siteId', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const siteId = req.params.siteId;
  if (!UUID_RE.test(siteId)) return res.status(400).json({ error: 'invalid siteId' });

  const siteResult = await pool.query(
    'SELECT id, company_id, timezone FROM sites WHERE id = $1',
    [siteId]
  );
  const site = siteResult.rows[0];
  if (!site) return res.status(404).json({ error: 'Site not found' });
  if (req.user!.role === 'company_admin' && site.company_id !== req.user!.company_id) {
    return res.status(404).json({ error: 'Site not found' });
  }

  const { guard_id, vehicle_id } = req.query;
  if (guard_id !== undefined && !UUID_RE.test(String(guard_id))) {
    return res.status(400).json({ error: 'guard_id must be a uuid' });
  }
  if (vehicle_id !== undefined && !UUID_RE.test(String(vehicle_id))) {
    return res.status(400).json({ error: 'vehicle_id must be a uuid' });
  }

  // Default window: the last 30 whole days AT THE SITE, emitted as bare
  // dates so the default takes the identical whole-day-at-the-site path
  // that a caller-supplied range does, rather than a second code path.
  const from = req.query.from !== undefined ? String(req.query.from) : siteLocalDateStr(30, site.timezone);
  const to   = req.query.to   !== undefined ? String(req.query.to)   : siteLocalDateStr(0,  site.timezone);

  // Validation ONLY. Parsing a bare date flattens it to UTC midnight, so
  // these Dates grade NaN / ordering / the 92-day cap and never become the
  // bounds — the raw strings do. Same split as checkpoints.ts:235-239,
  // where a seven-hour difference at the edges is immaterial to all three.
  const fromDate = new Date(from);
  const toDate   = new Date(to);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'from/to must be YYYY-MM-DD or an ISO instant' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'from must be before to' });
  }
  if (toDate.getTime() - fromDate.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: `Range must be ${MAX_RANGE_DAYS} days or less` });
  }

  const args: unknown[] = [siteId];
  // siteLocalDayRange MUTATES args — invoked here so its params land in
  // position before the two filters below push theirs.
  const rangeClauses = siteLocalDayRange({
    column: 'vi.created_at',
    siteAlias: 's',
    from,
    to,
    args,
  });

  const filters: string[] = [];
  if (guard_id !== undefined) {
    args.push(String(guard_id));
    filters.push(`AND ss.guard_id = $${args.length}`);
  }
  if (vehicle_id !== undefined) {
    args.push(String(vehicle_id));
    filters.push(`AND vi.vehicle_id = $${args.length}`);
  }

  // STATUS is three-valued, because "incomplete" conflates two situations
  // that need different handling:
  //   complete   — completed_at stamped by the server (:216-224)
  //   incomplete — session still OPEN, so the guard can still finish it
  //   abandoned  — session CLOSED with completed_at NULL. PATCH 409s after
  //                clock-out (:110-112), so this row is permanently
  //                uncompletable. Two exist in production.
  // Photo URL columns are NOT selected at all — see the mapping below.
  const result = await pool.query(
    `SELECT vi.id, vi.shift_session_id, vi.vehicle_id, vi.odometer_reading,
            vi.completed_at, vi.created_at,
            ss.guard_id, ss.clocked_in_at, ss.clocked_out_at,
            g.name AS guard_name, g.badge_number,
            sv.label AS vehicle_label, sv.plate AS vehicle_plate,
            sv.make_model AS vehicle_make_model, sv.odometer_unit,
            CASE
              WHEN vi.completed_at   IS NOT NULL THEN 'complete'
              WHEN ss.clocked_out_at IS NOT NULL THEN 'abandoned'
              ELSE 'incomplete'
            END AS status,
            ((vi.photo_front_url          IS NOT NULL)::int
           + (vi.photo_rear_url           IS NOT NULL)::int
           + (vi.photo_driver_side_url    IS NOT NULL)::int
           + (vi.photo_passenger_side_url IS NOT NULL)::int
           + (vi.photo_odometer_url       IS NOT NULL)::int) AS photo_count
       FROM vehicle_inspections vi
       JOIN shift_sessions ss ON ss.id = vi.shift_session_id
       JOIN sites s ON s.id = ss.site_id
       LEFT JOIN guards g ON g.id = ss.guard_id
       LEFT JOIN site_vehicles sv ON sv.id = vi.vehicle_id
      WHERE ss.site_id = $1
        ${rangeClauses.join(' ')}
        ${filters.join(' ')}
      ORDER BY vi.created_at DESC
      LIMIT ${LIST_CAP + 1}`,
    args
  );

  const truncated = result.rows.length > LIST_CAP;
  const rows = (truncated ? result.rows.slice(0, LIST_CAP) : result.rows).map((r) => ({
    ...r,
    // PHOTO SLOTS ARE DELIBERATELY NULL, and the SELECT above does not read
    // the columns at all — no stored S3 URL reaches this response even
    // unsigned. Presigning would be five signatures per row (up to 5000 at
    // the cap) that expire in 15 minutes (s3.ts:192), so a list built for
    // browsing would burn almost all of them unviewed. The web renders
    // `photo_count` on the collapsed row and calls
    // GET /api/inspections/session/:sessionId on expand, which presigns the
    // five URLs for that one row at the moment they are actually shown.
    photo_front_url:          null,
    photo_rear_url:           null,
    photo_driver_side_url:    null,
    photo_passenger_side_url: null,
    photo_odometer_url:       null,
  }));

  res.json({ inspections: rows, truncated });
});

export default router;
