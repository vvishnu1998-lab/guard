import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { sendIncidentAlert } from '../services/email';
import { getS3ObjectHead, s3KeyFromPublicUrl } from '../services/s3';
import { isAllowedContentType, magicMatches, describeMagic } from '../services/imageMagic';
import { validateAtSite } from '../services/geofence';
import { presignAll } from '../services/s3';
import { expiresAtFor, expiresAtForReport } from '../services/retention';
import { fireBreachAlerts } from './locations';
import { Sentry } from '../services/sentry';
import { readShadowSignals } from '../services/shadowSignals';
import { checkMockLocation, MOCK_LOCATION_ERROR } from '../services/mockLocation';

const router = Router();

// ── Input bounds for POST / ───────────────────────────────────────────────
//
// Each of these mirrors a schema constraint. Where a bound duplicates one
// that already exists in SQL, the SQL stays authoritative and this is the
// gate that keeps a violation from surfacing as a 500 — see the note on the
// input gate in POST / for why a 500 here is a duplicate-storm trigger.

/** report_photos.chk_photo_index — CHECK (photo_index BETWEEN 1 AND 5). */
const MAX_PHOTOS_PER_REPORT = 5;

/** report_photos.storage_url — character varying(1000). */
const MAX_STORAGE_URL_CHARS = 1000;

/**
 * Matches the client's own counter (maxLength={3000} in
 * apps/mobile/app/reports/new.tsx:344). reports.description is TEXT and has
 * no SQL bound, so this is the only place the stated limit is real.
 */
const MAX_DESCRIPTION_CHARS = 3000;

/** reports CHECK (severity IN ('low','medium','high','critical')). */
const ALLOWED_SEVERITIES = ['low', 'medium', 'high', 'critical'];

/** shift_session_id lands in `WHERE id = $1` against a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // Mobile Reports tab is scoped to the guard's currently-active shift
    // session only (no history view). If they're not clocked in, the
    // subquery returns NULL and no rows match — an empty list is correct.
    query = `SELECT r.* FROM reports r
             JOIN shift_sessions ss ON ss.id = r.shift_session_id
             WHERE ss.guard_id = $1
               AND r.shift_session_id = (
                 SELECT id FROM shift_sessions
                 WHERE guard_id = $1 AND clocked_out_at IS NULL
                 LIMIT 1
               )`;
    params = [user!.sub];
  } else {
    // company_admin: scoped to company. Includes reports from deactivated
    // sites — history stays visible; UI renders [INACTIVE] badge via
    // site_is_active.
    query = `SELECT r.*, g.name as guard_name, si.name as site_name,
                    si.is_active AS site_is_active
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
  // S3 lockdown (PR2): the `photos[]` aggregate column is present on the
  // client + admin shapes (the guard shape skips the array_agg).
  for (const row of result.rows) {
    if (Array.isArray(row.photos)) {
      row.photos = await presignAll(row.photos);
    }
  }
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
            si.name      AS site_name,
            si.is_active AS site_is_active,
            si.company_id,
            g.name       AS guard_name,
            array_agg(rp.storage_url ORDER BY rp.photo_index)
              FILTER (WHERE rp.id IS NOT NULL) AS photos
     FROM reports r
     JOIN sites si          ON si.id = r.site_id
     JOIN shift_sessions ss ON ss.id = r.shift_session_id
     JOIN guards g          ON g.id  = ss.guard_id
     LEFT JOIN report_photos rp ON rp.report_id = r.id
     WHERE r.id = $1
     GROUP BY r.id, si.name, si.is_active, si.company_id, g.name`,
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
    photos:      await presignAll(row.photos),
  });
});

// POST /api/reports — guard submits a report
//
// Phase 1A hybrid policy (2026-07-12 walk-test rebuild, Q8):
//   * INCIDENT report from offsite → 201 accept + is_within_geofence=false
//     flag + off_post_report alert (guard notification + admin email).
//     Rationale: emergencies must never be blocked; the flag makes the
//     off-post nature auditable.
//   * ACTIVITY report from offsite → 422 reject (activity is routine, has
//     to happen at the post to be meaningful).
//   * MAINTENANCE report from offsite → 422 reject (same reasoning).
//
// The alert dispatch always calls fireBreachAlerts even when the
// ON CONFLICT DO NOTHING skips the geofence_violations INSERT — Phase 1A
// moves dedup from "skip alert on conflict" to a 5-min per-session,
// per-eventType rate limit inside fireBreachAlerts (Q3, SD-C). An
// incident report while a ping-boundary breach is already open still
// fires the off_post_report alert because they're different event
// types with independent 5-min buckets.
router.post('/', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, report_type, description, severity, photo_urls, latitude, longitude, accuracy, window_label } = req.body;

  if (!['activity', 'incident', 'maintenance'].includes(report_type)) {
    return res.status(400).json({ error: 'report_type must be activity, incident, or maintenance' });
  }

  // ── INPUT TYPE + BOUND GATE ───────────────────────────────────────────
  //
  // Everything below this block may assume its inputs are well-typed and
  // within the bounds the schema will accept. Nothing here touches the DB
  // or S3, so every rejection is a clean 4xx with no partial write.
  //
  // WHY IT EXISTS. A 500 is not a 4xx, and the mobile offline queue treats
  // a 5xx as transient: it re-queues the report and replays it, and every
  // replay writes a NEW report row. That is what produced six duplicate
  // reports in STARNET's compliance record on 2026-08-22 (see the size-gate
  // note below). Any unhandled throw on client input is therefore a
  // duplicate-storm trigger, not just an ugly error — so the rule is that
  // no client-supplied value may reach a throw.
  //
  // Codes follow the house convention: a stable SCREAMING_SNAKE code in
  // `error` and the human sentence in `message`, so clients branch on
  // status PLUS code and never on prose.
  if (typeof shift_session_id !== 'string' || !UUID_RE.test(shift_session_id)) {
    // A malformed id reaches Postgres as `WHERE id = $1` against a uuid
    // column and raises 22P02 invalid_text_representation — a 500 on the
    // very first DB call in the route.
    return res.status(400).json({
      error:   'INVALID_SESSION_ID',
      message: 'shift_session_id must be a UUID.',
    });
  }

  if (typeof description !== 'string') {
    // `description?.trim()` only guards null/undefined. A number or object
    // gets past `?.` and then throws "description.trim is not a function".
    return res.status(400).json({
      error:   'INVALID_DESCRIPTION',
      message: 'description must be text.',
    });
  }
  if (!description.trim()) {
    return res.status(400).json({
      error:   'DESCRIPTION_REQUIRED',
      message: 'description is required.',
    });
  }
  // reports.description is TEXT, so an oversized value does not throw — it
  // is stored. The bound matches the client counter (maxLength={3000} in
  // apps/mobile/app/reports/new.tsx:344) so the server enforces the same
  // contract the guard is shown rather than silently accepting more.
  // express.json() defaults to a 100 kB body, which already 413s well
  // above this; this makes the real limit the stated one.
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return res.status(422).json({
      error:   'DESCRIPTION_TOO_LONG',
      message: `Description is too long (${description.length} characters; the limit is ${MAX_DESCRIPTION_CHARS}).`,
      length:  description.length,
      limit:   MAX_DESCRIPTION_CHARS,
    });
  }

  // reports.severity is varchar(20) with CHECK severity IN
  // ('low','medium','high','critical'). Nothing validated it before, so any
  // other string raised 23514 (or 22001 past 20 chars) at the INSERT —
  // after nothing had been written, but still a 500 the queue would replay.
  if (severity !== undefined && severity !== null && severity !== '') {
    if (typeof severity !== 'string' || !ALLOWED_SEVERITIES.includes(severity)) {
      return res.status(400).json({
        error:   'INVALID_SEVERITY',
        message: `severity must be one of ${ALLOWED_SEVERITIES.join(', ')}.`,
      });
    }
  }

  if (photo_urls !== undefined && photo_urls !== null && !Array.isArray(photo_urls)) {
    return res.status(400).json({
      error:   'INVALID_PHOTO_URLS',
      message: 'photo_urls must be an array.',
    });
  }
  if (Array.isArray(photo_urls)) {
    // report_photos.chk_photo_index is CHECK (photo_index BETWEEN 1 AND 5)
    // and photo_index is assigned i + 1 in the insert loop. Nothing checked
    // the array length, so a 6-photo POST committed the report row and the
    // first five photos and THEN raised 23514 — walking straight around the
    // size gate below and leaving a half-written report behind.
    if (photo_urls.length > MAX_PHOTOS_PER_REPORT) {
      return res.status(422).json({
        error:   'TOO_MANY_PHOTOS',
        message: `A report can carry at most ${MAX_PHOTOS_PER_REPORT} photos (${photo_urls.length} were sent).`,
        count:   photo_urls.length,
        limit:   MAX_PHOTOS_PER_REPORT,
      });
    }
    for (let i = 0; i < photo_urls.length; i++) {
      const p = photo_urls[i];
      // A null or primitive element makes the `p.url` read in the
      // magic-byte loop throw a TypeError before any validation runs.
      if (p === null || typeof p !== 'object' || Array.isArray(p)) {
        return res.status(400).json({
          error:       'INVALID_PHOTO_ENTRY',
          message:     `Photo ${i + 1} is not a valid photo object.`,
          photo_index: i + 1,
        });
      }
      const url = (p as { url?: unknown }).url;
      // storage_url is varchar(1000); a longer value raises 22001 at the
      // insert. s3KeyFromPublicUrl below still decides whether the host is
      // ours — this only guarantees the value is storable at all.
      if (typeof url !== 'string' || url.length === 0 || url.length > MAX_STORAGE_URL_CHARS) {
        return res.status(400).json({
          error:       'INVALID_PHOTO_URL',
          message:     `Photo ${i + 1} has a missing or unusable url.`,
          photo_index: i + 1,
        });
      }
    }
  }

  // Commit A2 — optional late-report backfill. Same shape and semantics
  // as POST /api/locations/ping's window_label param: cheap HH:MM regex
  // guard now, matched against an open missed_reports row inside the
  // insert transaction below.
  const windowLabel: string | null =
    typeof window_label === 'string' && /^\d{2}:\d{2}$/.test(window_label)
      ? window_label
      : null;
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

  // Mock-location gate. This route has NO transaction (plain pool.query
  // throughout), so a reject is a plain early return with nothing to unwind.
  // site_id resolves above, so the log line carries a real site.
  // Fails open on NULL, absent, non-boolean, and any thrown error.
  const reportSignals = readShadowSignals(req.body, 'report');
  {
    const mockCheck = checkMockLocation(reportSignals.locationMocked, 'report', {
      guardId: req.user!.sub, siteId: site_id,
      accuracyM: reportSignals.accuracyMeters, fixAgeMs: reportSignals.fixAgeMs,
    });
    if (mockCheck.reject) return res.status(422).json(MOCK_LOCATION_ERROR);
  }

  // D2 / audit/WEEK1.md §D2 — magic-byte validation for every photo URL.
  // D1 closed the size and MIME-pin gaps via the presigned POST policy,
  // but the bytes themselves are still client-controlled.  Here we GET
  // the first 16 bytes of each S3 object and confirm they match the
  // declared MIME (FF D8 FF for JPEG, 89 50 4E 47 for PNG, RIFF…WEBP).
  // Mismatch → quarantine row + 400; the report and its photos are
  // never INSERTed, so the corrupt object never enters the data plane.
  // ── PHOTO SIZE GATE — mirrors report_photos.chk_file_size ─────────────
  //
  // WHY THIS EXISTS. S3 accepts up to MAX_UPLOAD_BYTES (5 MiB, services/s3.ts)
  // but report_photos.chk_file_size caps a row at 800 KB — a 6.4x mismatch.
  // A photo between the two uploads fine and is then REJECTED BY POSTGRES
  // at the INSERT below, AFTER the report row and the earlier photos have
  // already been committed (that loop uses pool.query, no transaction). The
  // request then 500s with the report half-written.
  //
  // A 500 is not a 4xx, so the mobile offline queue treats it as transient,
  // queues the report and replays it — AND EVERY REPLAY WRITES A NEW REPORT
  // ROW. On 2026-08-22 one guard's four-photo activity report became SIX
  // duplicate reports in a live customer's compliance record inside fifteen
  // minutes, each holding three of the four photos, and the fourth photo
  // was lost every time.
  //
  // Validating BEFORE any insert turns that into one clean 422 the guard can
  // act on, and a 4xx is surfaced by the client instead of queued.
  //
  // THIS IS A STOP-GAP. It does not fix the limit mismatch, the missing
  // transaction, or the fact that a constraint violation can surface as a
  // 500. Raising chk_file_size is a separate decision — 800 KB may be
  // load-bearing for S3 cost or for PDF generation.
  //
  // MUST equal report_photos.chk_file_size. Changing one without the other
  // reopens exactly this hole.
  const MAX_PHOTO_KB = 800;

  if (Array.isArray(photo_urls) && photo_urls.length > 0) {
    for (let i = 0; i < photo_urls.length; i++) {
      const sizeKb = (photo_urls[i] as { size_kb?: unknown })?.size_kb;

      // file_size_kb is NOT NULL, so an absent value is also a 500 waiting
      // to happen — same storm, different constraint.
      //
      // Number.isInteger is load-bearing, not belt-and-braces: file_size_kb
      // is `integer`, and node-pg sends a JS number as its text form, so
      // 500.5 arrives as '500.5' and Postgres raises 22P02 invalid_text_
      // representation. A fractional value under the cap passed every other
      // check here and only failed at the INSERT — after the report row had
      // committed. Same half-write, same replay, same storm.
      if (typeof sizeKb !== 'number' || !Number.isInteger(sizeKb) || sizeKb < 0) {
        return res.status(422).json({
          error: 'PHOTO_SIZE_MISSING',
          message: `Photo ${i + 1} could not be measured, so the report was not saved. `
                 + 'Remove that photo and submit the rest, then tell your supervisor.',
          photo_index: i + 1,
        });
      }

      if (sizeKb > MAX_PHOTO_KB) {
        // The guard has done nothing wrong: the app already compresses to
        // 1080px JPEG q0.8, so retaking is not reliable advice. Name the
        // photo, name the limit, and give them the one action that works.
        console.log(
          `[reports.photo_too_large] guard=${req.user!.sub} photo_index=${i + 1} ` +
          `size_kb=${sizeKb} limit_kb=${MAX_PHOTO_KB} photos=${photo_urls.length}`,
        );
        return res.status(422).json({
          error: 'PHOTO_TOO_LARGE',
          message: `Photo ${i + 1} is too large to save (${sizeKb} KB; the limit is `
                 + `${MAX_PHOTO_KB} KB). Remove that photo and submit the rest, `
                 + 'then tell your supervisor.',
          photo_index: i + 1,
          size_kb: sizeKb,
          limit_kb: MAX_PHOTO_KB,
        });
      }
    }
  }

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
        // Forensics row. The rejection below is the load-bearing part — the
        // quarantine row is evidence, not a gate — so a failure to record it
        // must NOT turn a clean 400 into a 500 the offline queue will replay.
        // Log to Sentry instead and still refuse the report.
        try {
          await pool.query(
            `INSERT INTO quarantined_uploads
               (s3_key, declared_content_type, detected_magic,
                guard_id, company_id, shift_session_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [key, declared, detected, req.user!.sub, req.user!.company_id, shift_session_id]
          );
        } catch (err) {
          console.error('[reports] quarantine INSERT failed:', err);
          Sentry.captureException(err, {
            tags:  { flow: 'report_quarantine' },
            extra: { s3_key: key, declared, detected, shift_session_id },
          } as unknown as Parameters<typeof Sentry.captureException>[1]);
        }
        return res.status(400).json({
          error: `Uploaded file is not a valid ${declared} (detected: ${detected}). The upload has been quarantined; please re-take the photo.`,
        });
      }
    }
  }

  // Q8 hybrid policy — compute the fence result before INSERT, then
  // decide accept-or-reject by report_type. When coords are missing we
  // can't decide; per Wave A convention we allow the report through
  // with is_within_geofence NULL (older clients did this and we don't
  // want a silent regression for a client that stops sending coords).
  const haveCoords =
    typeof latitude === 'number' && Number.isFinite(latitude) &&
    typeof longitude === 'number' && Number.isFinite(longitude) &&
    typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0;
  let isWithin: boolean | null = null;
  let fenceDistance: number | null = null;
  let fenceReason: string | null = null;
  if (haveCoords) {
    // Fail OPEN on a validator error, matching the missing-coords branch
    // above: when we cannot decide, the report goes through with
    // is_within_geofence NULL rather than 500ing. A malformed or absent
    // site_geofence row is an admin data problem, and making the guard's
    // report bounce (and the offline queue replay it) is the wrong end to
    // punish. The failure is surfaced to Sentry so it is not silent.
    try {
      const fence = await validateAtSite(
        { lat: latitude, lng: longitude, accuracy_m: accuracy },
        site_id,
        pool,
      );
      isWithin = fence.allowed;
      fenceDistance = fence.distance_m;
      fenceReason = fence.reason;
    } catch (err) {
      console.error('[reports] validateAtSite failed:', err);
      Sentry.captureException(err, {
        tags:  { flow: 'report_geofence' },
        extra: { site_id, shift_session_id, latitude, longitude, accuracy },
      } as unknown as Parameters<typeof Sentry.captureException>[1]);
      // isWithin stays null → treated as "could not decide", same as a
      // client that sent no coords.
    }
  }

  // Non-incident reports MUST be at the post. Incidents are always
  // accepted (with the off-post flag if applicable) — emergencies
  // trump the routine-report rule.
  if (isWithin === false && report_type !== 'incident') {
    console.log(
      `[report.reject] session=${shift_session_id} type=${report_type} ` +
      `distance=${fenceDistance?.toFixed(1) ?? 'null'}m accuracy=${accuracy}m reason=${fenceReason}`,
    );
    return res.status(422).json({
      error: 'REPORT_OFF_POST',
      message: `${report_type.charAt(0).toUpperCase() + report_type.slice(1)} reports must be filed from the post. Return to the site and try again.`,
      distance_m: fenceDistance,
      accuracy_m: accuracy,
      reason: fenceReason,
    });
  }

  const expiresAt = expiresAtForReport(report_type);

  // ── THE WRITE, AS ONE UNIT ────────────────────────────────────────────
  //
  // The report and its photos are one record or they are neither. Before
  // this, the reports row committed on its own and each report_photos row
  // committed separately after it, so any failure in the photo loop left a
  // report standing with a partial photo set — and the 5xx that failure
  // produced was replayed by the mobile offline queue, writing the whole
  // partial record again. That is the 2026-08-22 duplicate storm.
  //
  // What is INSIDE the transaction, and why — argued from what a failure
  // in each block costs, not from where the code used to sit:
  //
  //   * reports INSERT + report_photos loop — the core unit. Non-negotiable.
  //
  //   * missed_reports lookup — moved in so the read and the resolve below
  //     see one snapshot. Same reasoning as the reassign route sharing its
  //     txn client for read-your-own-writes consistency.
  //
  //   * missed_reports resolve — IN, behind a SAVEPOINT. On failure the
  //     savepoint rolls back and the report still commits, which is exactly
  //     what the old outside-the-txn catch achieved. On SUCCESS it is now
  //     atomic with the report, which the old shape could not offer: two
  //     separate commits leave a window where a crash strands
  //     reports.submitted_late = true against a missed_reports row that
  //     still reads unresolved. That is a permanent contradiction in the
  //     compliance record, and it is the "imbalanced resolve/insert ratio"
  //     the previous comment was worried about. Same failure behaviour,
  //     strictly better success behaviour, so IN wins.
  //
  //   * geofence_violations INSERT — IN, behind a SAVEPOINT, for the same
  //     reason. A failure must never cost us the incident report; a success
  //     should not be separately committable from the report that caused it.
  //
  // What is OUTSIDE, and why it must be:
  //
  //   * fireBreachAlerts — it reads through `pool.query` on a DIFFERENT
  //     pooled connection (routes/locations.ts:102), so inside this
  //     transaction it cannot see the uncommitted violation row at all.
  //     This is a correctness requirement, not a preference. It also does
  //     push + email I/O, which must never hold a transaction open.
  //
  //   * sendIncidentAlert — email I/O, and the failure mode is the worst
  //     available: sending a client an incident alert inside a transaction
  //     that then rolls back means an un-retractable external message about
  //     a report that does not exist. Always after COMMIT.
  //
  // A throw that escapes this transaction is now a genuine server or DB
  // fault, not bad input — Phase 1 turned every client-triggerable failure
  // into a 4xx before we get here. For a real fault a 5xx and a client
  // replay is the correct behaviour, and the ROLLBACK guarantees the replay
  // has nothing partial to collide with.
  const client = await pool.connect();
  let report: any;
  let violationId: string | null = null;
  let missedReportId: string | null = null;
  let submittedLate = false;

  try {
    await client.query('BEGIN');

    // Late-report resolution: look up the matching open missed_reports
    // row BEFORE the report INSERT so we know whether to stamp
    // submitted_late = true and which row to resolve. Same match rule
    // as POST /ping — (shift_session_id, window_label), earliest row
    // if multiple exist (window_label is site-local HH:MM and unique
    // per session in practice).
    if (windowLabel) {
      const mr = await client.query<{ id: string; window_end: Date }>(
        `SELECT id, window_end FROM missed_reports
          WHERE shift_session_id = $1
            AND window_label = $2
            AND resolved_at IS NULL
          ORDER BY window_start ASC
          LIMIT 1`,
        [shift_session_id, windowLabel],
      );
      if (mr.rows[0]) {
        missedReportId = mr.rows[0].id;
        submittedLate  = new Date(mr.rows[0].window_end).getTime() < Date.now();
      }
    }

    const reportResult = await client.query(
      `INSERT INTO reports
         (shift_session_id, site_id, report_type, description, severity, expires_at,
          latitude, longitude, accuracy_meters, is_within_geofence,
          window_label, submitted_late, location_mocked, fix_age_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
      [
        shift_session_id, site_id, report_type, description, severity || null, expiresAt,
        haveCoords ? latitude  : null,
        haveCoords ? longitude : null,
        haveCoords ? accuracy  : null,
        isWithin,
        windowLabel, submittedLate,
        // Shadow capture (Wave 2) — recorded, never evaluated here.
        reportSignals.locationMocked, reportSignals.fixAgeMs,
      ]
    );
    report = reportResult.rows[0];

    if (photo_urls?.length) {
      for (let i = 0; i < photo_urls.length; i++) {
        await client.query(
          `INSERT INTO report_photos (report_id, storage_url, file_size_kb, photo_index)
           VALUES ($1, $2, $3, $4)`,
          [report.id, photo_urls[i].url, photo_urls[i].size_kb, i + 1]
        );
      }
    }

    // Resolve the matched missed_reports row now that we have the new
    // report id. SAVEPOINT so a failure here cannot poison the transaction
    // and cost us the report — same idiom as the clock-out fence check.
    if (missedReportId) {
      await client.query('SAVEPOINT missed_report_resolve');
      try {
        await client.query(
          `UPDATE missed_reports
              SET resolved_at = NOW(),
                  resolved_by_report_id = $1
            WHERE id = $2
              AND resolved_at IS NULL`,
          [report.id, missedReportId],
        );
        await client.query('RELEASE SAVEPOINT missed_report_resolve');
        Sentry.addBreadcrumb({
          category: 'reports',
          message: 'late report resolved missed_reports row',
          level: 'info',
          data: {
            report_id:         report.id,
            missed_report_id:  missedReportId,
            window_label:      windowLabel,
            submitted_late:    submittedLate,
          },
        });
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT missed_report_resolve');
        console.error('[reports] missed_reports resolve failed:', err);
        Sentry.captureException(err, {
          tags: { flow: 'missed_report_resolve' },
          extra: { report_id: report.id, missed_report_id: missedReportId },
        } as unknown as Parameters<typeof Sentry.captureException>[1]);
      }
    }

    // Off-post incident report — INSERT a violation row (still guarded by
    // schema_v18's partial unique index). Even if the INSERT conflicts (an
    // open ping-boundary violation is already on the session), we read the
    // existing row so its id can be passed to fireBreachAlerts AFTER the
    // commit — the 5-min per-type rate limiter inside will decide whether
    // to push+email, and different eventTypes have separate buckets so this
    // ALWAYS wakes the admin even during an active breach.
    // SAVEPOINT: losing the violation row must never cost us the incident
    // report itself.
    if (isWithin === false && report_type === 'incident') {
      await client.query('SAVEPOINT violation_insert');
      try {
        const violationInsert = await client.query(
          `INSERT INTO geofence_violations
             (shift_session_id, guard_id, site_id, violation_lat, violation_lng, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (shift_session_id) WHERE resolved_at IS NULL DO NOTHING
           RETURNING id`,
          [shift_session_id, req.user!.sub, site_id, latitude, longitude, expiresAtFor('geofence_violation')],
        );
        if (violationInsert.rows[0]) {
          violationId = violationInsert.rows[0].id;
        } else {
          const existing = await client.query<{ id: string }>(
            `SELECT id FROM geofence_violations
             WHERE shift_session_id = $1 AND resolved_at IS NULL
             ORDER BY occurred_at DESC LIMIT 1`,
            [shift_session_id],
          );
          violationId = existing.rows[0]?.id ?? null;
        }
        await client.query('RELEASE SAVEPOINT violation_insert');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT violation_insert');
        violationId = null;
        console.error('[report.flag] violation INSERT failed:', err);
        Sentry.captureException(err, {
          tags:  { flow: 'report_violation_insert' },
          extra: { report_id: report.id, shift_session_id, site_id },
        } as unknown as Parameters<typeof Sentry.captureException>[1]);
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // ── Post-commit side effects. Nothing below may abort the report. ──────

  // Email: only incident reports trigger the client-facing incident alert.
  if (report_type === 'incident') {
    sendIncidentAlert(report, site_id).catch(console.error);
  }

  if (isWithin === false && report_type === 'incident') {
    console.log(
      `[report.flag] report=${report.id} session=${shift_session_id} ` +
      `type=incident violation=${violationId ?? 'none'}`,
    );
    if (violationId) {
      fireBreachAlerts({
        shiftSessionId: shift_session_id,
        guardId:        req.user!.sub,
        violationId,
        eventType:      'off_post_report',
        context:        { kind: 'report', reportType: report_type },
        extraData:      { reportId: report.id },
      }).catch((err) => console.error('[report.flag] alert dispatch failed:', err));
    }
  }

  res.status(201).json(report);
});

export default router;
