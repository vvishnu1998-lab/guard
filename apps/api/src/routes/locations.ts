import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { isPointInPolygon, validateClockInGeofence } from '../services/geofence';
import { getS3ObjectHead, s3KeyFromPublicUrl } from '../services/s3';
import { isAllowedContentType, magicMatches, describeMagic } from '../services/imageMagic';
import { sendGeofenceViolationAlert } from '../services/firebase';
import { insertNotification } from '../services/notifications';

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
router.post('/ping', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, latitude, longitude, ping_type, photo_url } = req.body;

  const sessionResult = await pool.query(
    'SELECT site_id, clocked_in_at FROM shift_sessions WHERE id = $1 AND guard_id = $2',
    [shift_session_id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Session not found' });
  const { site_id } = sessionResult.rows[0];

  // Item 6 — magic-byte validation for the (optional) photo. Skipped when
  // photo_url is absent or the legacy 'pending' sentinel.
  const photoValidation = await validatePhotoOrQuarantine(photo_url, {
    guardId: req.user!.sub,
    companyId: req.user!.company_id,
    shiftSessionId: shift_session_id,
  });
  if (!photoValidation.ok) {
    return res.status(photoValidation.status).json(photoValidation.body);
  }

  // Check geofence
  const geofenceResult = await pool.query(
    'SELECT polygon_coordinates FROM site_geofence WHERE site_id = $1',
    [site_id]
  );
  const isWithin = geofenceResult.rows[0]
    ? isPointInPolygon({ lat: latitude, lng: longitude }, geofenceResult.rows[0].polygon_coordinates)
    : true;

  const photoDeleteAt = new Date();
  photoDeleteAt.setDate(photoDeleteAt.getDate() + 7);

  const result = await pool.query(
    `INSERT INTO location_pings
       (shift_session_id, guard_id, site_id, latitude, longitude, is_within_geofence, ping_type, photo_url, photo_delete_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [shift_session_id, req.user!.sub, site_id, latitude, longitude, isWithin, ping_type, photo_url || null, photoDeleteAt]
  );

  res.status(201).json(result.rows[0]);
});

// POST /api/locations/violation — guard device reports a geofence breach
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
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [shift_session_id, guardId, siteId, latitude, longitude, photo_url || null]
  );
  const violationId = result.rows[0].id;

  // Fire admin push + write a notification row for the guard — non-blocking
  pool.query(
    `SELECT g.name AS guard_name, s.name AS site_name,
            array_agg(ca.fcm_token) FILTER (WHERE ca.fcm_token IS NOT NULL) AS admin_tokens
     FROM shift_sessions ss
     JOIN guards g  ON g.id  = ss.guard_id
     JOIN sites  s  ON s.id  = ss.site_id
     JOIN companies co ON co.id = s.company_id
     JOIN company_admins ca ON ca.company_id = co.id AND ca.is_active = true
     WHERE ss.id = $1
     GROUP BY g.name, s.name`,
    [shift_session_id]
  ).then(({ rows }) => {
    const r = rows[0];
    if (!r) return;
    // Admin push (existing behavior)
    if (r.admin_tokens?.length) {
      sendGeofenceViolationAlert({
        adminFcmTokens: r.admin_tokens,
        guardName:      r.guard_name,
        siteName:       r.site_name,
        sessionId:      shift_session_id,
      }).catch((err) => console.error('[fcm] violation push failed:', err));
    }
    // Persistent log on the Notifications tab for the guard — the mobile app
    // already self-fires a local notification on detection, so we don't double
    // push from here; this row is just the record.
    insertNotification({
      guardId,
      type:  'geofence_breach',
      title: 'Outside post boundary',
      body:  `You're outside the permitted radius at ${r.site_name}. Return to the post.`,
      data:  { violationId, siteName: r.site_name },
    });
  }).catch((err) => console.error('[fcm] admin token lookup failed:', err));

  res.status(201).json(result.rows[0]);
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

  const fence = await validateClockInGeofence(
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
