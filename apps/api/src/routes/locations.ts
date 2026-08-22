import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { validateAtSite, GeofenceValidationResult } from '../services/geofence';
import { getS3ObjectHead, s3KeyFromPublicUrl } from '../services/s3';
import { isAllowedContentType, magicMatches, describeMagic } from '../services/imageMagic';
import { insertNotification } from '../services/notifications';
import { sendGeofenceBreachAlert, BreachAlertContext } from '../services/email';
import { sendPushNotification } from '../services/firebase';
import { expiresAtFor } from '../services/retention';
import { scheduleWindows } from '../services/pingWindows';
import { readShadowSignals } from '../services/shadowSignals';
import { logClientIdentity } from '../services/clientIdentity';
import { checkMockLocation, MOCK_LOCATION_ERROR } from '../services/mockLocation';

/**
 * Fire guard notification row + admin email for a geofence violation.
 * Shared by POST /violation (bg-task self-report / mobile geofencing
 * enter-exit) and POST /reports off-post flag (INCIDENT-only per Q8).
 *
 * (Phase 1A rewrite, 2026-07-12 walk-test rebuild)
 *
 * Change from Wave A:
 *   * Callers no longer condition on "did the INSERT return a row?" —
 *     they call this ALWAYS. The ON CONFLICT DO NOTHING skip that made
 *     the second offsite event silent (walk-test bug #5) is gone.
 *     Dedup now lives inside this function as a per-session, per-type
 *     5-minute rate limit against the notifications table.
 *   * eventType is required and drives:
 *       (a) the notification row `type` (geofence_breach for bg
 *           boundary events; off_post_report for incident-from-offsite)
 *       (b) the rate-limit key — off_post_report and geofence_breach
 *           are SEPARATE 5-min windows, so an incident report while a
 *           ping-breach is open STILL alerts (Q3).
 *   * insertNotification always fires. FCM push + admin email skip
 *     when rate-limited so the Alerts feed reflects every event even
 *     when we suppress the noisy channels (SD-C).
 *
 * Admin FCM mobile push is intentionally NOT wired: company_admins has
 * no fcm_token column and no admin mobile auth flow. See project
 * memory: project_admin_notification_surfaces.md.
 *
 * Non-blocking from the caller's perspective:
 * `fireBreachAlerts(...).catch(console.error)`.
 */

type BreachEventType = 'geofence_breach' | 'off_post_report' | 'off_post_task';

const RATE_LIMIT_MINUTES = 5;

/**
 * Atomic rate-limit claim. The caller has ALREADY inserted its
 * notifications row (id = notifId); that row is the claim ticket. It wins
 * the push+email channel iff no OTHER row of the same
 * (guard, session, type) bucket within RATE_LIMIT_MINUTES sorts before it
 * by (created_at, id).
 *
 * Why this can't double-fire (the 2026-08-20 incident: two boundary posts
 * 333ms apart both passed the old SELECT-then-insert check and both
 * pushed+emailed): each contender checks AFTER its own insert has
 * committed (pool.query autocommits), so the later row always sees the
 * earlier one and defers; two rows can't both sort first. Rows from
 * earlier fires inside the window — including fires that were themselves
 * rate-limited (every event inserts a row) — block all newcomers, which
 * preserves the original sliding-window semantics exactly.
 */
async function claimAlertChannel(notifId: string): Promise<boolean> {
  const { rows } = await pool.query<{ claimed: boolean }>(
    `SELECT NOT EXISTS (
       SELECT 1
       FROM notifications n, notifications me
       WHERE me.id = $1
         AND n.id <> me.id
         AND n.guard_id = me.guard_id
         AND n.type = me.type
         AND n.shift_session_id IS NOT DISTINCT FROM me.shift_session_id
         AND n.created_at > me.created_at - make_interval(mins => $2)
         AND (n.created_at, n.id) < (me.created_at, me.id)
     ) AS claimed`,
    [notifId, RATE_LIMIT_MINUTES],
  );
  return rows[0]?.claimed === true;
}

export async function fireBreachAlerts(params: {
  shiftSessionId: string;
  guardId: string;
  violationId: string;
  /** Optional context — passed through to the admin email renderer.
   *  For off_post_report, include the reportType so the email subject
   *  renders "…filed activity …". Defaults to `{kind:'ping'}` for
   *  bg-task boundary events. */
  context?: BreachAlertContext;
  /** Drives the notification row `type` AND the per-type rate-limit
   *  bucket. Different event types don't rate-limit each other. */
  eventType: BreachEventType;
  /** Extra deep-link metadata folded into the notification row `data`.
   *  reportId for off_post_report, taskInstanceId for off_post_task. */
  extraData?: Record<string, unknown>;
}): Promise<void> {
  const ctx: BreachAlertContext = params.context ?? { kind: 'ping' };
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

  const notif = params.eventType === 'off_post_report'
    ? {
        title: 'Off-post report saved',
        body:  `Your ${ctx.reportType ?? 'report'} was filed while outside ${r.site_name}. Admin notified.`,
      }
    : params.eventType === 'off_post_task'
    ? {
        title: 'Off-post task saved',
        body:  `Your task completion was recorded while outside ${r.site_name}. Admin notified.`,
      }
    : {
        title: 'Outside post boundary',
        body:  `You're outside the permitted radius at ${r.site_name}. Return to the post.`,
      };

  // The in-app record always lands (SD-C) — and its row id doubles as the
  // atomic rate-limit claim ticket (see claimAlertChannel).
  const notifId = await insertNotification({
    guardId:        params.guardId,
    type:           params.eventType,
    title:          notif.title,
    body:           notif.body,
    data:           {
      violationId: params.violationId,
      siteName:    r.site_name,
      kind:        ctx.kind,
      ...(params.extraData ?? {}),
    },
    shiftSessionId: params.shiftSessionId,
  });

  // notifId null = the insert itself failed (DB error, already logged).
  // Fail OPEN like the old path did: a DB hiccup must not silence a real
  // breach alert; the duplicate-fire risk only exists when rows insert.
  const claimed = notifId ? await claimAlertChannel(notifId) : true;
  if (!claimed) {
    console.log(
      `[breach.rateLimit] skip push+email — session=${params.shiftSessionId} ` +
      `type=${params.eventType} (another event holds the ${RATE_LIMIT_MINUTES}m window)`,
    );
    return;
  }

  // Channel (2) — guard FCM push. Same title/body as the in-app record so a
  // guard whose screen is off still gets the alert. `data` payload matches
  // the notification row for symmetric deep-linking from either surface.
  // On a permanently-stale token (unregistered device), null the column so
  // we stop retrying on every future breach.
  try {
    const guardTok = await pool.query<{ fcm_token: string | null }>(
      'SELECT fcm_token FROM guards WHERE id = $1',
      [params.guardId],
    );
    const token = guardTok.rows[0]?.fcm_token;
    if (token) {
      const { staleToken } = await sendPushNotification({
        token,
        title: notif.title,
        body:  notif.body,
        data:  {
          type:        params.eventType,
          violationId: params.violationId,
          siteName:    r.site_name,
          kind:        ctx.kind,
          ...(Object.fromEntries(
            Object.entries(params.extraData ?? {}).map(([k, v]) => [k, String(v)]),
          )),
        },
      });
      if (staleToken) {
        await pool.query(
          'UPDATE guards SET fcm_token = NULL WHERE id = $1 AND fcm_token = $2',
          [params.guardId, token],
        );
      }
    }
  } catch (err) {
    console.error('[fcm] guard breach push failed:', err);
  }

  // Channel (3) — durable email channel for admin breach alerts. Best-effort —
  // its own .catch() so an email send failure can't block the guard
  // notification insert.
  await sendGeofenceBreachAlert(params.violationId, ctx).catch((err) =>
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
//
// P3 (2026-07-10): auto-archive resolved violations older than 24 hours from
// the mobile view. Guards see:
//   * OPEN violations (resolved_at IS NULL) — safety-relevant, always visible.
//   * RESOLVED violations within the last 24 hours — short retrospective.
// Older resolved rows are hidden from mobile only. Admin surfaces
// (/api/admin/violations, /api/admin/recent-alerts, /api/exports/*, and the
// client portal's /api/client/violations) are unchanged and retain full
// history for audit.
router.get('/violations', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT gv.id, gv.occurred_at, gv.resolved_at, gv.duration_minutes,
            gv.violation_lat, gv.violation_lng, gv.supervisor_override,
            si.name as site_name
     FROM geofence_violations gv
     JOIN sites si ON si.id = gv.site_id
     WHERE gv.guard_id = $1
       AND (gv.resolved_at IS NULL
            OR gv.resolved_at > NOW() - INTERVAL '24 hours')
     ORDER BY gv.occurred_at DESC LIMIT 50`,
    [req.user!.sub]
  );
  res.json(result.rows);
});

// POST /api/locations/ping — guard submits a location ping (audit record)
//
// Phase 1A rewrite (2026-07-12 walk-test rebuild):
//   * Pings PROVE presence. Q8 lifts them out of the "flag and continue"
//     bucket into "reject-if-offsite". Offsite pings return 422 without
//     inserting a location_pings row or a violation. A guard whose GPS
//     drifts them 30m outside sees an error toast and can retake.
//   * Boundary detection now belongs to the mobile-side native
//     geofencing API (Phase 1B) which POSTs to /api/locations/violation.
//     The old ping-inserts-violation code path is gone.
//   * Optional body param `window_label` (e.g. "18:30") backfills a
//     missed_pings row. When set AND the corresponding window has
//     already closed, submitted_late is stamped true on the ping row
//     and the matching missed_pings row is UPDATEd with resolved_at +
//     resolved_by_ping_id.
//   * Onsite ping still auto-resolves any open geofence_violations for
//     this session (2026-07-09 BUG I fix, preserved).
const ALLOWED_THROTTLE_REASONS = new Set(['low_battery', 'low_power_mode']);

router.post('/ping', requireAuth('guard'), async (req, res) => {
  const {
    shift_session_id,
    latitude,
    longitude,
    ping_type,
    photo_url,
    throttle_reason,
    accuracy,
    window_label,
  } = req.body;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'Invalid coordinates.' });
  }
  if (Math.abs(latitude) < 1e-6 && Math.abs(longitude) < 1e-6) {
    return res.status(400).json({ error: 'Invalid coordinates. GPS lock required.' });
  }

  const accuracyM: number | null =
    typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0
      ? accuracy
      : null;

  // Mock-location gate. Evaluated before the transaction opens so a reject
  // is a plain early return. Fails open on NULL, absent, or error.
  {
    const pingSignals = readShadowSignals(req.body, 'ping', accuracyM);
    const mockCheck = checkMockLocation(
      pingSignals.locationMocked,
      'ping',
      // siteId is deliberately omitted: it is resolved from the session at
      // :401, AFTER this gate. Moving the gate below that lookup would
      // reorder operations for a log field, so the log carries
      // site=unknown on this route by design — guard + route + timestamp
      // locate the row, and location_integrity_flags stores site_id anyway.
      { guardId: req.user!.sub, accuracyM, fixAgeMs: pingSignals.fixAgeMs },
    );
    if (mockCheck.reject) return res.status(422).json(MOCK_LOCATION_ERROR);
  }

  if (throttle_reason != null && !ALLOWED_THROTTLE_REASONS.has(throttle_reason)) {
    return res.status(400).json({
      error: `throttle_reason must be one of: low_battery, low_power_mode (got: ${throttle_reason})`,
    });
  }

  // window_label SHAPE check only — HH:MM 24-hour. Cheap regex before we
  // query the DB. Whether the label names a real window of THIS shift is
  // checked below, once the schedule has been loaded.
  const windowLabel: string | null =
    typeof window_label === 'string' && /^\d{2}:\d{2}$/.test(window_label)
      ? window_label
      : null;

  // scheduled_start/end + site_tz come along for the window_label
  // validation below — the schedule is what defines a legal label, and
  // shift_sessions alone cannot answer that.
  const sessionResult = await pool.query<{
    site_id:         string;
    clocked_in_at:   Date;
    clocked_out_at:  Date | null;
    scheduled_start: Date;
    scheduled_end:   Date;
    site_tz:         string | null;
  }>(
    `SELECT ss.site_id, ss.clocked_in_at, ss.clocked_out_at,
            sh.scheduled_start, sh.scheduled_end, si.timezone AS site_tz
       FROM shift_sessions ss
       JOIN shifts sh ON sh.id = ss.shift_id
       JOIN sites  si ON si.id = ss.site_id
      WHERE ss.id = $1 AND ss.guard_id = $2`,
    [shift_session_id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Session not found' });
  const {
    site_id,
    clocked_out_at:  pingClockedOutAt,
    scheduled_start: pingScheduledStart,
    scheduled_end:   pingScheduledEnd,
    site_tz:         pingSiteTz,
  } = sessionResult.rows[0];

  // Liveness gate — same shape as POST /violation (5a6de20). A ping against
  // a closed session is not merely a spurious location_pings row: the
  // transaction below also auto-resolves every open geofence_violations row
  // for the session, stamping resolved_at + duration_minutes for a return to
  // post that never happened. That is evidence corruption in the same table
  // 5a6de20 was protecting, reached through a different door.
  if (pingClockedOutAt) {
    console.warn('[ping.reject.session_closed]', {
      shift_session_id,
      guard_id:       req.user!.sub,
      clocked_out_at: pingClockedOutAt.toISOString(),
      latitude,
      longitude,
    });
    return res.status(409).json({
      error:   'SESSION_CLOSED',
      message: 'This shift has already ended. Pings are only accepted during an open session.',
      clocked_out_at: pingClockedOutAt.toISOString(),
    });
  }

  // window_label must name a REAL window of this shift, and one that has
  // already OPENED. Until now the only check was the HH:MM regex, so the
  // server accepted any well-formed string and wrote it verbatim.
  //
  // Two bounds, because geometry alone is not enough. STARNET session
  // 1ba93935 ran 19:00→06:00, so '01:30' IS a legal window of that shift;
  // the defect was a ping submitted at 21:49:08 carrying it — three hours
  // forty minutes before that window existed to be answered. It then sat
  // in the record as a second answer to a window it had nothing to do
  // with. Only the not-yet-open bound catches that row.
  //
  // Note what is NOT checked: whether the window has closed (every late
  // backfill answers a closed window — that is the entire missed_pings
  // flow), whether it began before clock-in (R4), or whether a break
  // waived it. Those would each reject legitimate submissions.
  //
  // A distinct code, not a bare 400: the client must tell "your label is
  // wrong" apart from "your coordinates are wrong", and `reason` lets the
  // app distinguish a stale label from a clock-skewed one.
  if (windowLabel) {
    const windows    = scheduleWindows(pingScheduledStart, pingScheduledEnd, pingSiteTz);
    const windowOpen = windows.get(windowLabel);
    const reason =
      windowOpen === undefined      ? 'not_in_schedule'
      : windowOpen > Date.now()     ? 'not_yet_open'
      : null;
    if (reason) {
      console.warn('[ping.reject.bad_window_label]', {
        shift_session_id,
        guard_id:        req.user!.sub,
        window_label:    windowLabel,
        reason,
        scheduled_start: pingScheduledStart.toISOString(),
        scheduled_end:   pingScheduledEnd.toISOString(),
        site_tz:         pingSiteTz,
      });
      return res.status(422).json({
        error:   'PING_WINDOW_INVALID',
        reason,
        message: reason === 'not_in_schedule'
          ? 'That ping window is not part of this shift. Reopen the app and try again.'
          : 'That ping window has not started yet. Reopen the app and try again.',
        window_label: windowLabel,
      });
    }
  }

  const photoValidation = await validatePhotoOrQuarantine(photo_url, {
    guardId: req.user!.sub,
    companyId: req.user!.company_id,
    shiftSessionId: shift_session_id,
  });
  if (!photoValidation.ok) {
    return res.status(photoValidation.status).json(photoValidation.body);
  }

  // Server-side geofence decision. Pings are onsite-only per Q8 — reject
  // 422 with the same shape as the clock-in-verification and task-completion
  // paths so mobile error handling stays uniform.
  const fence = await validateAtSite(
    { lat: latitude, lng: longitude, accuracy_m: accuracyM ?? 0 },
    site_id,
    pool,
  );
  if (!fence.allowed) {
    // schema_v46 — persist the rejection as evidence. Until now this
    // console.log was the ONLY trace: a session with repeated off-post
    // ping attempts had zero DB rows unless the device also fired a
    // region-exit event (see session 94906fee — three rejections, no
    // violations). Failure to persist must not block the 422 the guard
    // is waiting on.
    try {
      await pool.query(
        `INSERT INTO off_post_events
           (shift_session_id, guard_id, site_id, source, lat, lng,
            accuracy_m, distance_m, reason, expires_at)
         VALUES ($1, $2, $3, 'ping_reject', $4, $5, $6, $7, $8, $9)`,
        [shift_session_id, req.user!.sub, site_id, latitude, longitude,
         accuracyM, fence.distance_m, fence.reason,
         expiresAtFor('off_post_event')]
      );
    } catch (err) {
      console.error('[ping.reject] off_post_events INSERT failed:', err);
    }
    console.log(
      `[ping.reject] session=${shift_session_id} distance=${fence.distance_m?.toFixed(1) ?? 'null'}m ` +
      `accuracy=${accuracyM ?? 'null'}m reason=${fence.reason}`,
    );
    return res.status(422).json({
      error: 'PING_OFF_POST',
      message: 'You appear to be outside the post. Return to the site and try again.',
      distance_m: fence.distance_m,
      accuracy_m: accuracyM,
      reason: fence.reason,
    });
  }

  // Transactional ping insert + missed-ping resolve + violation auto-resolve.
  // The auto-resolve mirrors the 2026-07-09 BUG I fix: an onsite ping is
  // proof the guard returned, so any open violations for this session close
  // immediately (server-recomputed fence.allowed above, so the client can't
  // spoof a fake resolve).
  const client = await pool.connect();
  let pingRow: any;
  let resolvedMissedPingId: string | null = null;
  // True when the window already had a ping and ON CONFLICT DO NOTHING
  // swallowed this one — drives the 200/"already_recorded" response.
  let alreadyRecorded = false;
  try {
    await client.query('BEGIN');

    const photoDeleteAt = new Date();
    photoDeleteAt.setDate(photoDeleteAt.getDate() + 7);

    // If window_label matches an open missed_pings row AND that window
    // has already ended, this ping is a late backfill. submitted_late
    // is stamped denorm on the ping row so the activity feed's
    // "late ping" filter is a trivial index scan.
    let submittedLate = false;
    if (windowLabel) {
      const mp = await client.query<{ id: string; window_end: Date }>(
        `SELECT id, window_end FROM missed_pings
          WHERE shift_session_id = $1
            AND window_label = $2
            AND resolved_at IS NULL
          ORDER BY window_start ASC
          LIMIT 1`,
        [shift_session_id, windowLabel],
      );
      const mpRow = mp.rows[0];
      if (mpRow) {
        submittedLate = new Date(mpRow.window_end).getTime() < Date.now();
        resolvedMissedPingId = mpRow.id;
      }
    }

    // One ping per window (schema_v49). The ON CONFLICT predicate must
    // restate the partial index's predicate VERBATIM — arbiter inference
    // on a partial index does not happen otherwise, and Postgres raises
    // "no unique or exclusion constraint matching the ON CONFLICT
    // specification" rather than silently falling back. If you change the
    // cutover here, change db/schema_v49.sql too.
    //
    // Pre-cutover rows are outside the index, so a window answered twice
    // back then still does not conflict — deliberate: history is not
    // rewritten, only new writes are constrained.
    logClientIdentity(req, 'ping');
    const pingShadow = readShadowSignals(req.body, 'ping', accuracyM);
    const pingInsert = await client.query(
      `INSERT INTO location_pings
         (shift_session_id, guard_id, site_id, latitude, longitude, accuracy_meters,
          is_within_geofence, ping_type, photo_url, photo_delete_at, throttle_reason, expires_at,
          window_label, submitted_late, location_mocked, fix_age_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       ON CONFLICT (shift_session_id, window_label)
         WHERE window_label IS NOT NULL
           AND pinged_at >= TIMESTAMPTZ '2026-08-21T00:00:00+00'
       DO NOTHING
       RETURNING *`,
      [shift_session_id, req.user!.sub, site_id, latitude, longitude, accuracyM,
       true, ping_type, photo_url || null, photoDeleteAt, throttle_reason ?? null,
       expiresAtFor('ping_metadata'),
       windowLabel, submittedLate,
       // Shadow capture (Wave 1) — recorded, never evaluated. accuracyM is
       // already sanitised above and feeds the fence check, so it is reused
       // rather than re-derived, keeping column and budget identical.
       pingShadow.locationMocked, pingShadow.fixAgeMs],
    );
    pingRow = pingInsert.rows[0];

    // DO NOTHING swallowed the row: this window already has a ping. Load
    // the incumbent so the guard gets the real record back rather than an
    // empty 201, and so the missed-ping resolve below still has an id to
    // point at.
    if (!pingRow) {
      alreadyRecorded = true;
      const existing = await client.query(
        `SELECT * FROM location_pings
          WHERE shift_session_id = $1
            AND window_label = $2
            AND pinged_at >= TIMESTAMPTZ '2026-08-21T00:00:00+00'
          ORDER BY pinged_at ASC
          LIMIT 1`,
        [shift_session_id, windowLabel],
      );
      pingRow = existing.rows[0];
      console.warn('[ping.duplicate_window]', {
        shift_session_id,
        guard_id:     req.user!.sub,
        window_label: windowLabel,
        existing_ping_id: pingRow?.id ?? null,
      });
    }

    // Resolve the matching missed_pings row now that we have a ping id.
    // Runs on the already-recorded path too: a window whose incumbent
    // ping did not resolve its miss would otherwise leave the miss open
    // forever, since every retry now short-circuits here.
    if (resolvedMissedPingId && pingRow) {
      await client.query(
        `UPDATE missed_pings
            SET resolved_at = NOW(),
                resolved_by_ping_id = $1
          WHERE id = $2
            AND resolved_at IS NULL`,
        [pingRow.id, resolvedMissedPingId],
      );
    }

    // Onsite ping auto-resolves open violations for this session (BUG I).
    await client.query(
      `UPDATE geofence_violations
          SET resolved_at = NOW(),
              duration_minutes = ROUND(EXTRACT(EPOCH FROM (NOW() - occurred_at)) / 60)::INT
        WHERE shift_session_id = $1
          AND resolved_at IS NULL`,
      [shift_session_id],
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  // Recorded vs already-recorded must be distinguishable by the client:
  // a duplicate submission is NOT an error (the guard did stand at the
  // post and take a photo) but it is also not a second answer, and the
  // app should say so rather than claim a fresh ping landed.
  //   201 { status: 'recorded',         ping }  — this submission is the record
  //   200 { status: 'already_recorded', ping }  — window already answered;
  //                                               `ping` is the incumbent
  // The 201 body changed shape (was the bare row). Only app/ping/photo.tsx
  // and the dead offlineStore.submitPing call this endpoint, and neither
  // reads the body — checked before changing it.
  if (alreadyRecorded) {
    return res.status(200).json({ status: 'already_recorded', ping: pingRow ?? null });
  }
  res.status(201).json({ status: 'recorded', ping: pingRow });
});

// POST /api/locations/violation — guard device reports a boundary breach.
//
// Phase 1B mobile will drive this from the native iOS/Android geofencing
// API's enter/exit events (startGeofencingAsync); Build 33 still uses the
// periodic-updates bg-task.
//
// Phase 1A rewrite (2026-07-12):
//   * The DB constraint idx_geofence_violations_one_open_per_session still
//     enforces "one open row per session" via ON CONFLICT DO NOTHING —
//     that's the source of truth for the violations model.
//   * BUT we no longer skip fireBreachAlerts when the conflict fires.
//     Every boundary event calls fireBreachAlerts; rate-limiting per Q3
//     (5-min bucket per session per type) now lives inside that function
//     and decides whether to actually push+email. insertNotification
//     always runs so the Alerts feed reflects every event even when we
//     suppress the noisy channels.
router.post('/violation', requireAuth('guard'), async (req, res) => {
  const { shift_session_id, latitude, longitude, photo_url } = req.body;

  const sessionResult = await pool.query<{ site_id: string; clocked_out_at: Date | null }>(
    'SELECT site_id, clocked_out_at FROM shift_sessions WHERE id = $1 AND guard_id = $2',
    [shift_session_id, req.user!.sub]
  );
  if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Session not found' });

  const siteId       = sessionResult.rows[0].site_id;
  const clockedOutAt = sessionResult.rows[0].clocked_out_at;
  const guardId      = req.user!.sub;

  // Liveness gate (2026-08-07). Ownership alone is not enough: the
  // autoCompleteShifts cron closes a session server-side at scheduled_end,
  // and the mobile app has no channel to learn that — its registered
  // geofence region stays armed until the store next transitions. On
  // 2026-08-06 that produced two boundary reports 3 and 28 minutes after
  // clock-out, each writing a violation row + a notifications row + a guard
  // push + an email to every active admin.
  //
  // Distinct from the 403 above so the two failure modes are separable in
  // logs: 403 = not your session / no such session, 409 = your session, but
  // it has ended. Matches the code+message shape of the 422 geofence
  // rejections on the other endpoints in this file.
  //
  // Open violations are unaffected — they stay resolvable via PATCH
  // /violation/:id/resolve, the clock-out sweeps in shifts.ts and
  // jobs/autoCompleteShifts.ts, and the onsite-ping auto-resolve above.
  if (clockedOutAt) {
    console.warn('[violation.reject.session_closed]', {
      shift_session_id,
      guard_id:       guardId,
      clocked_out_at: clockedOutAt.toISOString(),
      latitude,
      longitude,
    });
    return res.status(409).json({
      error:   'SESSION_CLOSED',
      message: 'This shift has already ended. Boundary reports are only accepted during an open session.',
      clocked_out_at: clockedOutAt.toISOString(),
    });
  }

  // Break-time quiet policy (locked 2026-08-20): during an active break
  // there is no ping obligation and no geofence enforcement — a boundary
  // exit is recorded as an off_post_events row ONLY. No violation row, no
  // guard push, no admin email (deepak's 14:12–14:35 meal break produced a
  // 17-min violation + 4 alert cycles ≈ 8 admin emails). The row still
  // feeds breakExpiryCron's return-check, which reads off_post_events as
  // off-post evidence.
  //
  // Coordinate semantics: per the Apple-appeal design the background
  // task's violation POST transmits the SITE's coordinate, not the guard's
  // fix — so break_exit rows may carry site-center lat/lng. The row proves
  // an exit EVENT during a break, not a position; distance_m is left NULL
  // deliberately (computing it from a site-center coordinate would yield a
  // misleading ~0m).
  const openBreak = await pool.query<{ id: string }>(
    'SELECT id FROM break_sessions WHERE shift_session_id = $1 AND break_end IS NULL LIMIT 1',
    [shift_session_id],
  );
  if (openBreak.rows[0]) {
    const haveCoords =
      typeof latitude === 'number' && Number.isFinite(latitude) &&
      typeof longitude === 'number' && Number.isFinite(longitude);
    if (haveCoords) {
      try {
        await pool.query(
          `INSERT INTO off_post_events
             (shift_session_id, guard_id, site_id, source, lat, lng,
              accuracy_m, distance_m, reason, expires_at)
           VALUES ($1, $2, $3, 'break_exit', $4, $5, NULL, NULL, $6, $7)`,
          [shift_session_id, guardId, siteId, latitude, longitude,
           'boundary exit during active break', expiresAtFor('off_post_event')],
        );
      } catch (err) {
        // Evidence write is best-effort; suppression must never 500.
        console.error('[violation.suppressed.on_break] off_post_events INSERT failed:', err);
      }
    }
    console.log('[violation.suppressed.on_break]', {
      shift_session_id,
      guard_id: guardId,
      break_id: openBreak.rows[0].id,
      have_coords: haveCoords,
    });
    return res.status(200).json({
      code:    'ON_BREAK',
      message: 'Boundary exit recorded as an off-post event — guard is on an active break.',
    });
  }

  const insertResult = await pool.query(
    `INSERT INTO geofence_violations
       (shift_session_id, guard_id, site_id, violation_lat, violation_lng, photo_url, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (shift_session_id) WHERE resolved_at IS NULL DO NOTHING
     RETURNING *`,
    [shift_session_id, guardId, siteId, latitude, longitude, photo_url || null,
     expiresAtFor('geofence_violation')]
  );

  // Resolve the row we'll return + the violationId we'll pass to the
  // alert dispatcher. Fresh INSERT → RETURNING row. ON CONFLICT skip →
  // fetch the existing open row.
  let violationRow = insertResult.rows[0];
  if (!violationRow) {
    const existing = await pool.query(
      `SELECT * FROM geofence_violations
       WHERE shift_session_id = $1 AND resolved_at IS NULL
       ORDER BY occurred_at DESC LIMIT 1`,
      [shift_session_id]
    );
    violationRow = existing.rows[0];
  }

  if (violationRow) {
    fireBreachAlerts({
      shiftSessionId: shift_session_id,
      guardId,
      violationId:    violationRow.id,
      eventType:      'geofence_breach',
    }).catch((err) => console.error('[violation] alert dispatch failed:', err));
  }

  return res.status(201).json(violationRow);
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

  // Mock-location gate — see the ping route above. This route uses a plain
  // pool.query rather than a transaction, so a reject is a simple return.
  {
    const verifySignals = readShadowSignals(req.body, 'clock-in-verification');
    const mockCheck = checkMockLocation(
      verifySignals.locationMocked,
      'clock-in-verification',
      { guardId: req.user!.sub, accuracyM: verifySignals.accuracyMeters, fixAgeMs: verifySignals.fixAgeMs },
    );
    if (mockCheck.reject) return res.status(422).json(MOCK_LOCATION_ERROR);
  }

  // Resolve site_id from the session (NEVER trust a client-supplied site_id —
  // that would be a tampering vector per Q15).
  const sessionRow = await pool.query<{ site_id: string; clocked_out_at: Date | null }>(
    `SELECT site_id, clocked_out_at FROM shift_sessions WHERE id = $1 AND guard_id = $2`,
    [shift_session_id, req.user!.sub],
  );
  if (!sessionRow.rows[0]) {
    return res.status(404).json({ error: 'Shift session not found' });
  }
  const siteId = sessionRow.rows[0].site_id;
  const civClockedOutAt = sessionRow.rows[0].clocked_out_at;

  // Liveness gate — same shape as POST /violation (5a6de20). The 404 above
  // is this route's pre-existing ownership shape and is deliberately left
  // alone; only the liveness rejection is normalised across routes.
  if (civClockedOutAt) {
    console.warn('[clock_in_verification.reject.session_closed]', {
      shift_session_id,
      guard_id:       req.user!.sub,
      clocked_out_at: civClockedOutAt.toISOString(),
      latitude:  verified_lat,
      longitude: verified_lng,
    });
    return res.status(409).json({
      error:   'SESSION_CLOSED',
      message: 'This shift has already ended. Clock-in verification is only accepted during an open session.',
      clocked_out_at: civClockedOutAt.toISOString(),
    });
  }

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

  // Shadow capture (Wave 1) — recorded, never evaluated. This route's own
  // guard is a bare `typeof accuracy === 'number'` (see :841), which admits
  // NaN and Infinity, so accuracy is sanitised here rather than stored raw.
  logClientIdentity(req, 'clock-in-verification');
  const verifyShadow = readShadowSignals(req.body, 'clock-in-verification');

  const result = await pool.query(
    `INSERT INTO clock_in_verifications
       (shift_session_id, guard_id, site_id, selfie_url, site_photo_url, verified_lat, verified_lng, is_within_geofence,
        accuracy_meters, location_mocked, fix_age_ms)
     SELECT $1, ss.guard_id, ss.site_id, $2, $3, $4, $5, $6, $7, $8, $9
     FROM shift_sessions ss WHERE ss.id = $1
     RETURNING *`,
    [shift_session_id, selfie_url ?? null, site_photo_url ?? null, verified_lat, verified_lng, true,
     verifyShadow.accuracyMeters, verifyShadow.locationMocked, verifyShadow.fixAgeMs],
  );

  res.status(201).json(result.rows[0]);
});

export default router;
