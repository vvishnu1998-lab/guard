import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendIncidentAlert } from '../services/email';
import { getS3ObjectHead, s3KeyFromPublicUrl } from '../services/s3';
import { isAllowedContentType, magicMatches, describeMagic } from '../services/imageMagic';

const router = Router();

// GET /api/reports — scoped by role
// CRITICAL: always filters by site_id or company_id (see Section 11.5)
router.get('/', requireAuth('guard', 'company_admin', 'client'), async (req, res) => {
  const { user } = req;
  const { type, severity, site_id: filter_site_id, date_from, date_to } = req.query;
  let query: string;
  let params: unknown[];

  if (user!.role === 'client') {
    // Client: strictly scoped to their site_id only
    query = `SELECT r.*, array_agg(rp.storage_url ORDER BY rp.photo_index) FILTER (WHERE rp.id IS NOT NULL) as photos
             FROM reports r LEFT JOIN report_photos rp ON rp.report_id = r.id
             WHERE r.site_id = $1`;
    params = [user!.site_id];
  } else if (user!.role === 'guard') {
    query = `SELECT r.* FROM reports r
             JOIN shift_sessions ss ON ss.id = r.shift_session_id
             WHERE ss.guard_id = $1`;
    params = [user!.sub];
  } else {
    // company_admin: scoped to company
    query = `SELECT r.*, g.name as guard_name, si.name as site_name
             FROM reports r
             JOIN sites si ON si.id = r.site_id
             JOIN shift_sessions ss ON ss.id = r.shift_session_id
             JOIN guards g ON g.id = ss.guard_id
             WHERE si.company_id = $1`;
    params = [user!.company_id];
  }

  if (type)           { query += ` AND r.report_type = $${params.length + 1}`; params.push(type); }
  if (severity)       { query += ` AND r.severity = $${params.length + 1}`; params.push(severity); }
  if (filter_site_id && user!.role === 'company_admin') {
    query += ` AND r.site_id = $${params.length + 1}`; params.push(filter_site_id);
  }
  if (date_from)      { query += ` AND r.reported_at >= $${params.length + 1}`; params.push(date_from); }
  if (date_to)        { query += ` AND r.reported_at <= $${params.length + 1}`; params.push(date_to); }

  if (user!.role === 'client') query += ' GROUP BY r.id';
  query += ' ORDER BY r.reported_at DESC LIMIT 100';

  const result = await pool.query(query, params);
  res.json(result.rows);
});

// GET /api/reports/:id — single report with photos (scoped by role)
// Used by the photo-detail page (open photos in a new tab from the activity log).
router.get('/:id', requireAuth('guard', 'company_admin', 'client'), async (req, res) => {
  const { user } = req;
  const { id } = req.params;

  const result = await pool.query(
    `SELECT r.id, r.shift_session_id, r.site_id, r.report_type, r.description,
            r.severity, r.reported_at,
            si.name AS site_name, si.company_id,
            g.name  AS guard_name,
            array_agg(rp.storage_url ORDER BY rp.photo_index)
              FILTER (WHERE rp.id IS NOT NULL) AS photos
     FROM reports r
     JOIN sites si          ON si.id = r.site_id
     JOIN shift_sessions ss ON ss.id = r.shift_session_id
     JOIN guards g          ON g.id  = ss.guard_id
     LEFT JOIN report_photos rp ON rp.report_id = r.id
     WHERE r.id = $1
     GROUP BY r.id, si.name, si.company_id, g.name`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return res.status(404).json({ error: 'Report not found' });

  // Authorization: client → site_id match; guard → submitted by this guard; admin → company_id match.
  if (user!.role === 'client' && row.site_id !== user!.site_id) {
    return res.status(403).json({ error: 'Access denied' });
  }
  if (user!.role === 'guard') {
    const own = await pool.query(
      'SELECT 1 FROM shift_sessions WHERE id = $1 AND guard_id = $2',
      [row.shift_session_id, user!.sub],
    );
    if (!own.rows[0]) return res.status(403).json({ error: 'Access denied' });
  }
  if (user!.role === 'company_admin' && row.company_id !== user!.company_id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  res.json({
    id:          row.id,
    report_type: row.report_type,
    severity:    row.severity,
    description: row.description,
    reported_at: row.reported_at,
    site_name:   row.site_name,
    guard_name:  row.guard_name,
    photos:      row.photos ?? [],
  });
});

// POST /api/reports — guard submits a report
router.post('/', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, report_type, description, severity, photo_urls, latitude, longitude } = req.body;

  if (!['activity', 'incident', 'maintenance'].includes(report_type)) {
    return res.status(400).json({ error: 'report_type must be activity, incident, or maintenance' });
  }
  if (!description?.trim()) {
    return res.status(400).json({ error: 'description is required' });
  }
  // Severity is optional for all report types — incidents no longer require it
  // (UX simplification 2026-05-15; was previously incident-only mandatory).
  // The DB column stays nullable so historical incidents keep their severity.

  // V5 / audit/WEEK1.md §C6 — incident reports must carry at least one
  // chain-of-custody photo.  The mobile form already enforces this client-
  // side (apps/mobile/app/reports/new/incident.tsx), but we reject here
  // too so direct API hits can't bypass the rule (see B1: 4 legacy seed
  // rows landed in prod this way during the 2026-04-07..09 test window).
  if (
    report_type === 'incident' &&
    (!Array.isArray(photo_urls) || photo_urls.length === 0)
  ) {
    return res.status(400).json({
      error: 'Incident reports require at least one photo (camera-only, chain-of-custody).',
    });
  }

  // Verify session belongs to guard and is still open
  const sessionResult = await pool.query(
    'SELECT site_id FROM shift_sessions WHERE id = $1 AND guard_id = $2 AND clocked_out_at IS NULL',
    [shift_session_id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Active session not found' });
  const { site_id } = sessionResult.rows[0];

  // D2 / audit/WEEK1.md §D2 — magic-byte validation for every photo URL.
  // D1 closed the size and MIME-pin gaps via the presigned POST policy,
  // but the bytes themselves are still client-controlled.  Here we GET
  // the first 16 bytes of each S3 object and confirm they match the
  // declared MIME (FF D8 FF for JPEG, 89 50 4E 47 for PNG, RIFF…WEBP).
  // Mismatch → quarantine row + 400; the report and its photos are
  // never INSERTed, so the corrupt object never enters the data plane.
  if (Array.isArray(photo_urls) && photo_urls.length > 0) {
    for (const p of photo_urls as Array<{ url: string; content_type?: string }>) {
      const key = s3KeyFromPublicUrl(p.url);
      if (!key) {
        return res.status(400).json({
          error: 'photo_urls must point at the configured S3 bucket (validated by signed URL)',
        });
      }
      // The presigned POST policy pins Content-Type per upload; the mobile
      // client always sends image/jpeg today.  We accept an optional
      // per-photo content_type override for forward-compat (PNG/WEBP) but
      // default to image/jpeg.
      const declared = (p.content_type ?? 'image/jpeg') as string;
      if (!isAllowedContentType(declared)) {
        return res.status(400).json({
          error: `unsupported content_type ${declared} (allowed: image/jpeg, image/png, image/webp)`,
        });
      }
      let head: Buffer;
      try {
        head = await getS3ObjectHead(key, 16);
      } catch (err: any) {
        // S3 returned NoSuchKey or AccessDenied — treat as upload failure
        return res.status(400).json({
          error: `Photo not found in storage (key=${key}); please re-upload before submitting.`,
        });
      }
      if (!magicMatches(declared, head)) {
        const detected = describeMagic(head);
        // Forensics row — keep going only after the INSERT in case of DB
        // failure we still don't accept the report.
        await pool.query(
          `INSERT INTO quarantined_uploads
             (s3_key, declared_content_type, detected_magic,
              guard_id, company_id, shift_session_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [key, declared, detected, req.user!.sub, req.user!.company_id, shift_session_id]
        );
        return res.status(400).json({
          error: `Uploaded file is not a valid ${declared} (detected: ${detected}). The upload has been quarantined; please re-take the photo.`,
        });
      }
    }
  }

  // Geofence validation — block submission if guard has an unresolved violation
  const violationResult = await pool.query(
    `SELECT id FROM geofence_violations
     WHERE shift_session_id = $1 AND resolved_at IS NULL
     LIMIT 1`,
    [shift_session_id]
  );
  if (violationResult.rows[0]) {
    return res.status(403).json({ error: 'Cannot submit report while a geofence violation is unresolved' });
  }

  // Get site contract_end for delete_at calculation
  const siteResult = await pool.query('SELECT contract_end FROM sites WHERE id = $1', [site_id]);
  const deleteAt = new Date(siteResult.rows[0].contract_end);
  deleteAt.setDate(deleteAt.getDate() + 150);

  const reportResult = await pool.query(
    `INSERT INTO reports (shift_session_id, site_id, report_type, description, severity, delete_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [shift_session_id, site_id, report_type, description, severity || null, deleteAt]
  );
  const report = reportResult.rows[0];

  // Insert photos (pre-signed S3 upload URLs already processed by client)
  if (photo_urls?.length) {
    for (let i = 0; i < photo_urls.length; i++) {
      await pool.query(
        `INSERT INTO report_photos (report_id, storage_url, file_size_kb, photo_index, delete_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [report.id, photo_urls[i].url, photo_urls[i].size_kb, i + 1, deleteAt]
      );
    }
  }

  // Email: only incident reports trigger immediate alert (Section 4)
  if (report_type === 'incident') {
    sendIncidentAlert(report, site_id).catch(console.error);
  }

  res.status(201).json(report);
});

export default router;
