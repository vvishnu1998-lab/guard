import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { validateAtSite, GeofenceValidationResult } from '../services/geofence';
import { getS3ObjectHead, s3KeyFromPublicUrl } from '../services/s3';
import { isAllowedContentType, magicMatches, describeMagic } from '../services/imageMagic';
import { insertNotification } from '../services/notifications';
import { sendGeofenceBreachAlert } from '../services/email';

/**
 * Fire guard notification row + admin email for a fresh geofence violation.
 * Shared by POST /ping (audit Tier 1-A) and POST /violation (background-task
 * self-report).
 *
 * Two channels, each with its own error catch so one failure can't block
 * the other:
 *   (1) Guard notification — insertNotification (Notifications tab record)
 *   (2) Admin email        — sendGeofenceBreachAlert (T1-D)
 *
 * Admin FCM mobile push is intentionally NOT wired: company_admins has no
 * fcm_token column and no admin mobile auth flow exists. The original SQL
 * here (and in the pre-Wave-A POST /violation handler) referenced
 * `ca.fcm_token` from `company_admins` and threw "column does not exist"
 * on every call — the .catch() at the call site swallowed the error so
 * the dead channel looked alive in code review but never delivered to a
 * real device. Discovered during the Wave A walk-test (2026-05-17).
 * See project memory: project_admin_notification_surfaces.md.
 *
 * The function as a whole is non-blocking from the caller's perspective:
 * `fireBreachAlerts(...).catch(console.error)`.
 */
async function fireBreachAlerts(params: {
  shiftSessionId: string;
  guardId: string;
  violationId: string;
}): Promise<void> {
  const { rows } = await pool.query(
    `SELECT g.name AS guard_name, s.name AS site_name
     FROM shift_sessions ss
     JOIN guards g ON g.id = ss.guard_id
     JOIN sites  s ON s.id = ss.site_id
     WHERE ss.id = $1`,
    [params.shiftSessionId],
  );
  const r = rows[0];
  if (!r) return;

  await insertNotification({
    guardId:        params.guardId,
    type:           'geofence_breach',
    title:          'Outside post boundary',
    body:           `You're outside the permitted radius at ${r.site_name}. Return to the post.`,
    data:           { violationId: params.violationId, siteName: r.site_name },
    shiftSessionId: params.shiftSessionId,
  });

  // T1-D — durable email channel for admin breach alerts. Best-effort —
  // its own .catch() so an email send failure can't block the guard
  // notification insert (the order here doesn't matter for that anymore,
  // but keep the pattern explicit in case channels are reordered later).
  await sendGeofenceBreachAlert(params.violationId).catch((err) =>
    console.error('[email] breach alert failed:', err),
  );
}

const router = Router();

/**
 * Magic-byte validator for photo URLs on the ping + clock-in-verification
 * endpoints. Item 6 — extends the magic-byte check that reports.ts already
 * performs (D2 / audit/WEEK1.md §D2) to the two remaining photo-bearing
 * paths that previously trusted the client.
 *
 * Skips legacy sentinel values ('pending', null, empty string) so older
 * builds that fall back when S3 isn't configured still go through. Real
 * S3 URLs get the same treatment as reports: Range-GET first 16 bytes,
 * verify magic, quarantine + 400 on mismatch.
 *
 * Sync (not async) by design — the user message above said an async
 * accept-now-reject-later flow would create a worse UX than a 60ms wait.
 */
async function validatePhotoOrQuarantine(
  photoUrl: string | null | undefined,
  ctx: { guardId: string; companyId?: string; shiftSessionId?: string },
): Promise<{ ok: true } | { ok: false; status: number; body: { error: string } }> {
  // TODO(sentinel-removal): null and 'pending' are legacy fallbacks the
  // mobile uses when S3 isn't configured. Deprecated-but-supported. When
  // we remove the fallback path, grep for `sentinel-removal` and tighten
  // this to reject unset photo_urls outright.
  if (!photoUrl || photoUrl === 'pending') return { ok: true };

  // Defense against URL substitution — photo_url is client-supplied and
  // must be validated against our bucket allowlist. A tampered URL pointing
  // at attacker-controlled storage would otherwise let the attacker dictate
  // the bytes we accept as a "verified photo".
  const key = s3KeyFromPublicUrl(photoUrl);
  if (!key) {
    return {
      ok: false,
      status: 400,
      body: { error: 'photo_url must point at the configured S3 bucket' },
    };
  }

  // The presigned POST policy pins Content-Type=image/jpeg per upload,
  // so we treat the declared type as image/jpeg here. (Forward-compat
  // hook: if the client ever uploads PNG/WEBP, add the content_type to
  // the payload and pass it in.)
  const declared = 'image/jpeg';
  if (!isAllowedContentType(declared)) {
    return {
      ok: false,
      status: 400,
      body: { error: `unsupported content_type ${declared}` },
    };
  }

  let head: Buffer;
  try {
    head = await getS3ObjectHead(key, 16);
  } catch {
    return {
      ok: false,
      status: 400,
      body: { error: `Photo not found in storage (key=${key}); please re-upload before submitting.` },
    };
  }

  if (!magicMatches(declared, head)) {
    const detected = describeMagic(head);
    await pool.query(
      `INSERT INTO quarantined_uploads
         (s3_key, declared_content_type, detected_magic,
          guard_id, company_id, shift_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, declared, detected, ctx.guardId, ctx.companyId ?? null, ctx.shiftSessionId ?? null],
    );
    return {
      ok: false,
      status: 400,
      body: {
        error: `Uploaded file is not a valid ${declared} (detected: ${detected}). The upload has been quarantined; please re-take the photo.`,
      },
    };
  }

  return { ok: true };
}

// GET /api/locations/violations — guard's own violation history (mobile alerts tab)
router.get('/violations', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT gv.id, gv.occurred_at, gv.resolved_at, gv.duration_minutes,
            gv.violation_lat, gv.violation_lng, gv.supervisor_override,
            si.name as site_name
     FROM geofence_violations gv
     JOIN sites si ON si.id = gv.site_id
     WHERE gv.guard_id = $1
     ORDER BY gv.occurred_at DESC LIMIT 50`,
    [req.user!.sub]
  );
  res.json(result.rows);
});

// POST /api/locations/ping — guard submits a location ping (audit record)
//
// Audit Tier 1 wiring (2026-05-17 location-services audit):
//   T1-C-server: reject malformed coords + (0,0) before any other processing
//   T1-B:        accept optional `accuracy`, persist to accuracy_meters,
//                feed into the shared validateAtSite helper
//   T1-A:        on off-site (is_within_geofence=false), INSERT a
//                geofence_violations row INSIDE the same transaction
//                (with ON CONFLICT DO NOTHING via the partial unique index
//                from schema_v18), then fire admin push + guard notification
//                via fireBreachAlerts. Same end-user UX (201 + "Ping
//                Submitted") — the breach alert lands separately.
const ALLOWED_THROTTLE_REASONS = new Set(['low_battery', 'low_power_mode']);

router.post('/ping', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, latitude, longitude, ping_type, photo_url, throttle_reason, accuracy } = req.body;

  // T1-C-server (1/2) — type + sanity. Pre-existing handler destructured
  // coords without checks; a payload sending strings would skate past.
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'Invalid coordinates.' });
  }
  // T1-C-server (2/2) — reject the GPS-timeout fallback the old mobile
  // submitted ((0,0) lives in the Gulf of Guinea, ~9000km from any site).
  if (Math.abs(latitude) < 1e-6 && Math.abs(longitude) < 1e-6) {
    return res.status(400).json({ error: 'Invalid coordinates. GPS lock required.' });
  }

  // T1-B — accuracy is optional. Null when missing → validateAtSite
  // receives accuracy_m=0 below, so the only slack is the helper's hardcoded
  // 50m SAFETY_MARGIN. New clients that send a real accuracy get a tighter,
  // accuracy-aware check.
  const accuracyM: number | null =
    typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0
      ? accuracy
      : null;

  // Item 7 — validate throttle_reason against the schema_v14 CHECK enum.
  if (throttle_reason != null && !ALLOWED_THROTTLE_REASONS.has(throttle_reason)) {
    return res.status(400).json({
      error: `throttle_reason must be one of: low_battery, low_power_mode (got: ${throttle_reason})`,
    });
  }

  const sessionResult = await pool.query(
    'SELECT site_id, clocked_in_at FROM shift_sessions WHERE id = $1 AND guard_id = $2',
    [shift_session_id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Session not found' });
  const { site_id } = sessionResult.rows[0];

  // Item 6 — magic-byte validation for the (optional) photo.
  const photoValidation = await validatePhotoOrQuarantine(photo_url, {
    guardId: req.user!.sub,
    companyId: req.user!.company_id,
    shiftSessionId: shift_session_id,
  });
  if (!photoValidation.ok) {
    return res.status(photoValidation.status).json(photoValidation.body);
  }

  // T1-A — transactional ping + (conditional) violation. The partial unique
  // index idx_geofence_violations_one_open_per_session enforces de-dup at the
  // DB layer; ON CONFLICT DO NOTHING + RETURNING id lets us branch the
  // alert-firing on whether a fresh violation actually landed.
  const client = await pool.connect();
  let pingRow: any;
  let freshViolationId: string | null = null;
  let fence: GeofenceValidationResult;
  try {
    await client.query('BEGIN');

    fence = await validateAtSite(
      { lat: latitude, lng: longitude, accuracy_m: accuracyM ?? 0 },
      site_id,
      client,
    );
    const isWithin = fence.allowed;

    const photoDeleteAt = new Date();
    photoDeleteAt.setDate(photoDeleteAt.getDate() + 7);

    const pingInsert = await client.query(
      `INSERT INTO location_pings
         (shift_session_id, guard_id, site_id, latitude, longitude, accuracy_meters,
          is_within_geofence, ping_type, photo_url, photo_delete_at, throttle_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [shift_session_id, req.user!.sub, site_id, latitude, longitude, accuracyM,
       isWithin, ping_type, photo_url || null, photoDeleteAt, throttle_reason ?? null],
    );
    pingRow = pingInsert.rows[0];

    if (!isWithin) {
      const violationInsert = await client.query(
        `INSERT INTO geofence_violations
           (shift_session_id, guard_id, site_id, violation_lat, violation_lng, photo_url)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (shift_session_id) WHERE resolved_at IS NULL DO NOTHING
         RETURNING id`,
        [shift_session_id, req.user!.sub, site_id, latitude, longitude, photo_url || null],
      );
      if (violationInsert.rows[0]) {
        freshViolationId = violationInsert.rows[0].id;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Structured log on breach so T2 follow-ups (accuracy thresholds, mock-loc,
  // etc.) have data. Only on breach to keep the happy-path quiet.
  if (!fence!.allowed) {
    console.log(
      `[ping.breach] session=${shift_session_id} distance=${fence!.distance_m?.toFixed(1) ?? 'null'}m ` +
      `accuracy=${accuracyM ?? 'null'}m photo_present=${!!photo_url} fresh_violation=${!!freshViolationId}`,
    );
  }

  // Fire admin push + guard notification — only on a FRESH violation (de-dup
  // already handled by the unique-index conflict). Non-blocking.
  if (freshViolationId) {
    fireBreachAlerts({
      shiftSessionId: shift_session_id,
      guardId:        req.user!.sub,
      violationId:    freshViolationId,
    }).catch((err) => console.error('[ping.breach] alert dispatch failed:', err));
  }

  res.status(201).json(pingRow);
});

// POST /api/locations/violation — guard device (background task) reports a breach.
//
// Same de-dup + alert plumbing as POST /ping. The partial unique index
// idx_geofence_violations_one_open_per_session (schema_v18) prevents two
// concurrent INSERTs from racing past a SELECT-then-INSERT check; the ON
// CONFLICT DO NOTHING returns no row when an open violation already exists,
// and we skip the duplicate push.
router.post('/violation', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, latitude, longitude, photo_url } = req.body;

  const sessionResult = await pool.query(
    'SELECT site_id FROM shift_sessions WHERE id = $1 AND guard_id = $2',
    [shift_session_id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Session not found' });

  const siteId   = sessionResult.rows[0].site_id;
  const guardId  = req.user!.sub;

  const result = await pool.query(
    `INSERT INTO geofence_violations
       (shift_session_id, guard_id, site_id, violation_lat, violation_lng, photo_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (shift_session_id) WHERE resolved_at IS NULL DO NOTHING
     RETURNING *`,
    [shift_session_id, guardId, siteId, latitude, longitude, photo_url || null]
  );

  // Fresh violation → fire alerts. Duplicate (open violation already exists) →
  // return the existing row, skip the second push.
  if (result.rows[0]) {
    fireBreachAlerts({
      shiftSessionId: shift_session_id,
      guardId,
      violationId:    result.rows[0].id,
    }).catch((err) => console.error('[fcm] violation alert dispatch failed:', err));
    return res.status(201).json(result.rows[0]);
  }

  const existing = await pool.query(
    `SELECT * FROM geofence_violations
     WHERE shift_session_id = $1 AND resolved_at IS NULL
     ORDER BY occurred_at DESC LIMIT 1`,
    [shift_session_id]
  );
  return res.status(201).json(existing.rows[0]);
});

// PATCH /api/locations/violation/:id/resolve
router.patch('/violation/:id/resolve', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `UPDATE geofence_violations
     SET resolved_at = NOW(),
         duration_minutes = EXTRACT(EPOCH FROM (NOW() - occurred_at)) / 60
     WHERE id = $1 AND guard_id = $2 AND resolved_at IS NULL
     RETURNING *`,
    [req.params.id, req.user!.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Open violation not found' });
  res.json(result.rows[0]);
});

// POST /api/locations/clock-in-verification
//
// Geofence validation (Item 3 — closes V6 audit hole):
//   - The client-supplied `is_within_geofence` field is IGNORED. Server
//     computes its own from verified_lat/lng/accuracy via the same helper
//     used by the clock-in transaction, then stores the server-computed
//     value (overriding whatever the client claimed). Older app versions
//     can still send the field — kept for wire compat per Q14 — but its
//     value is never trusted.
router.post('/clock-in-verification', requireAuth('guard'), async (req, res) => {
  const {
    shift_session_id,
    selfie_url,
    site_photo_url,
    verified_lat,
    verified_lng,
    accuracy,
  } = req.body as {
    shift_session_id?: string;
    selfie_url?: string | null;
    site_photo_url?: string | null;
    verified_lat?: number;
    verified_lng?: number;
    accuracy?: number;
    is_within_geofence?: boolean; // accepted on wire but ignored — server overrides
  };

  if (
    !shift_session_id ||
    typeof verified_lat !== 'number' ||
    typeof verified_lng !== 'number' ||
    typeof accuracy !== 'number'
  ) {
    return res.status(400).json({
      error: 'Missing shift_session_id / verified_lat / verified_lng / accuracy. Update the app.',
    });
  }

  // Resolve site_id from the session (NEVER trust a client-supplied site_id —
  // that would be a tampering vector per Q15).
  const sessionRow = await pool.query(
    `SELECT site_id FROM shift_sessions WHERE id = $1 AND guard_id = $2`,
    [shift_session_id, req.user!.sub],
  );
  if (!sessionRow.rows[0]) {
    return res.status(404).json({ error: 'Shift session not found' });
  }
  const siteId = sessionRow.rows[0].site_id;

  // Item 6 — magic-byte validation on the selfie and site photo. Sentinel
  // values ('pending', null) are skipped. Run before geofence + INSERT so
  // bad bytes never link to a verification row.
  for (const url of [selfie_url, site_photo_url]) {
    const v = await validatePhotoOrQuarantine(url, {
      guardId: req.user!.sub,
      companyId: req.user!.company_id,
      shiftSessionId: shift_session_id,
    });
    if (!v.ok) {
      return res.status(v.status).json(v.body);
    }
  }

  const fence = await validateAtSite(
    { lat: verified_lat, lng: verified_lng, accuracy_m: accuracy },
    siteId,
    pool,
  );
  if (!fence.allowed) {
    console.log(
      `geofence.reject site=${siteId} guard=${req.user!.sub} shift=${shift_session_id} ` +
      `distance=${fence.distance_m?.toFixed(1) ?? 'null'} accuracy=${accuracy} reason=${fence.reason}`,
    );
    return res.status(422).json({
      error: 'GEOFENCE_FAILED',
      message: 'You appear to be outside the site post. Move to the post entrance and try again.',
      distance_m: fence.distance_m,
      accuracy_m: accuracy,
      reason: fence.reason,
    });
  }

  const result = await pool.query(
    `INSERT INTO clock_in_verifications
       (shift_session_id, guard_id, site_id, selfie_url, site_photo_url, verified_lat, verified_lng, is_within_geofence)
     SELECT $1, ss.guard_id, ss.site_id, $2, $3, $4, $5, $6
     FROM shift_sessions ss WHERE ss.id = $1
     RETURNING *`,
    [shift_session_id, selfie_url ?? null, site_photo_url ?? null, verified_lat, verified_lng, true],
  );

  res.status(201).json(result.rows[0]);
});

export default router;
