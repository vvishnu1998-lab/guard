import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { isPointInPolygon } from '../services/geofence';

const router = Router();

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

  const result = await pool.query(
    `INSERT INTO geofence_violations
       (shift_session_id, guard_id, site_id, violation_lat, violation_lng, photo_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [shift_session_id, req.user!.sub, sessionResult.rows[0].site_id, latitude, longitude, photo_url || null]
  );

  // FCM notification to Star admin handled by a separate push service
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
router.post('/clock-in-verification', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, selfie_url, site_photo_url, verified_lat, verified_lng, is_within_geofence } = req.body;

  if (!is_within_geofence) {
    return res.status(400).json({ error: 'Guard is outside geofence — clock-in blocked' });
  }

  const result = await pool.query(
    `INSERT INTO clock_in_verifications
       (shift_session_id, guard_id, site_id, selfie_url, site_photo_url, verified_lat, verified_lng, is_within_geofence)
     SELECT $1, ss.guard_id, ss.site_id, $2, $3, $4, $5, $6
     FROM shift_sessions ss WHERE ss.id = $1
     RETURNING *`,
    [shift_session_id, selfie_url, site_photo_url, verified_lat, verified_lng, is_within_geofence]
  );

  res.status(201).json(result.rows[0]);
});

export default router;
