import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { generateTaskInstancesForShift } from '../services/tasks';
import { validateAtSite } from '../services/geofence';
import { idempotent } from '../services/idempotency';
import { sendPushNotification } from '../services/firebase';
import { isPastPacificDate, isPastPacificDateString, pacificDateStr } from '../services/pacificDate';
import { isGuardAssignedToSite } from '../services/guardAssignments';

const router = Router();

/**
 * Phase A enforcement: for a guard + site combo, scan a list of Pacific
 * calendar dates and return the first date the guard isn't assigned to
 * that site on. Returns null if all dates are covered. Caller uses the
 * returned string verbatim in the 422 body, e.g.
 * "Guard is not assigned to this site on 2026-06-18."
 *
 * NB. Same "reject the whole request on first offending date" semantics
 * as B1's past-date guard — no silent partial inserts.
 */
async function firstUnassignedDate(
  guardId: string,
  siteId: string,
  pacificDates: string[],
): Promise<string | null> {
  for (const d of pacificDates) {
    if (!(await isGuardAssignedToSite(guardId, siteId, d))) return d;
  }
  return null;
}

const SPECIFIC_DATES_MAX = 60;
const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{2}:\d{2}$/;

// POST /api/shifts — admin schedules a new shift (guard_id is optional)
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { mode } = req.body as { mode?: string };

  // ── Mode: pick specific dates ───────────────────────────────────────
  // Payload shape (snake_case to match the rest of this file):
  //   { mode: 'specific_dates', site_id, guard_id?,
  //     start_time: 'HH:MM', end_time: 'HH:MM', dates: ['YYYY-MM-DD', …] }
  // One shift per date, all sharing site/guard/start_time/end_time. The
  // batch is inserted in a single transaction — any overlap or insert
  // failure rolls back the whole request.
  if (mode === 'specific_dates') {
    const { site_id, guard_id, start_time, end_time, dates } = req.body as {
      site_id?: string;
      guard_id?: string | null;
      start_time?: string;
      end_time?: string;
      dates?: unknown;
    };

    if (!site_id) return res.status(400).json({ error: 'site_id is required' });
    if (!start_time || !HH_MM.test(start_time)) return res.status(400).json({ error: 'start_time must be HH:MM' });
    if (!end_time   || !HH_MM.test(end_time))   return res.status(400).json({ error: 'end_time must be HH:MM' });
    if (!Array.isArray(dates) || dates.length === 0) {
      return res.status(422).json({ error: 'dates must be a non-empty array' });
    }
    if (dates.length > SPECIFIC_DATES_MAX) {
      return res.status(422).json({ error: `Too many dates — max ${SPECIFIC_DATES_MAX}` });
    }
    const dateList = dates as string[];
    if (!dateList.every(d => typeof d === 'string' && YYYY_MM_DD.test(d))) {
      return res.status(422).json({ error: 'dates must be YYYY-MM-DD strings' });
    }
    // Each date must be a real calendar date — reject e.g. "2026-02-30".
    if (!dateList.every(d => {
      const [y, m, day] = d.split('-').map(Number);
      const parsed = new Date(Date.UTC(y, m - 1, day));
      return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === day;
    })) {
      return res.status(422).json({ error: 'one or more dates are not valid calendar dates' });
    }
    if (new Set(dateList).size !== dateList.length) {
      return res.status(422).json({ error: 'dates must be unique' });
    }
    if (dateList.some(d => isPastPacificDateString(d))) {
      return res.status(422).json({ error: 'Cannot schedule shifts in the past.' });
    }

    // Site + guard belong to caller's company.
    const siteCheck = await pool.query(
      'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
      [site_id, req.user!.company_id]
    );
    if (!siteCheck.rows[0]) return res.status(400).json({ error: 'Site not found' });
    if (guard_id) {
      const guardCheck = await pool.query(
        'SELECT id FROM guards WHERE id = $1 AND company_id = $2 AND is_active = true',
        [guard_id, req.user!.company_id]
      );
      if (!guardCheck.rows[0]) return res.status(400).json({ error: 'Guard not found or inactive' });

      // Phase A — guard must have an assignment covering every emitted date.
      // First offending date wins; rejects the whole request (no partial insert).
      const offending = await firstUnassignedDate(guard_id, site_id, dateList);
      if (offending) {
        return res.status(422).json({ error: `Guard is not assigned to this site on ${offending}.` });
      }
    }

    const status = guard_id ? 'scheduled' : 'unassigned';
    const overnightInterval = start_time > end_time ? '1 day' : '0 day'; // end before start → next day
    // Sort to make rollback messages deterministic and conflict checks predictable.
    const sortedDates = [...dateList].sort();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const ids: string[] = [];
      for (const d of sortedDates) {
        // Overlap check (assigned shifts only — unassigned can stack).
        if (guard_id) {
          const overlap = await client.query(
            `WITH new_window AS (
               SELECT
                 ($1::date + $2::time) AT TIME ZONE 'America/Los_Angeles' AS s,
                 ($1::date + $4::interval + $3::time) AT TIME ZONE 'America/Los_Angeles' AS e
             )
             SELECT 1 FROM shifts, new_window
              WHERE guard_id = $5
                AND status IN ('scheduled','active')
                AND scheduled_start < new_window.e
                AND scheduled_end   > new_window.s
              LIMIT 1`,
            [d, start_time, end_time, overnightInterval, guard_id]
          );
          if (overlap.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: `Conflict on date ${d}` });
          }
        }
        const insert = await client.query(
          `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
           VALUES (
             $1,
             $2,
             ($3::date + $4::time) AT TIME ZONE 'America/Los_Angeles',
             ($3::date + $6::interval + $5::time) AT TIME ZONE 'America/Los_Angeles',
             $7
           ) RETURNING id`,
          [guard_id || null, site_id, d, start_time, end_time, overnightInterval, status]
        );
        ids.push(insert.rows[0].id);
      }
      await client.query('COMMIT');
      return res.status(201).json({ ids });
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[shifts.specific_dates] error:', err);
      return res.status(500).json({ error: err?.message ?? 'Failed to create shifts' });
    } finally {
      client.release();
    }
  }

  // ── Mode: single OR repeat-on-days (existing) ───────────────────────
  const { guard_id, site_id, scheduled_start, scheduled_end, repeat_days } = req.body;
  if (!site_id || !scheduled_start || !scheduled_end) {
    return res.status(400).json({ error: 'site_id, scheduled_start, scheduled_end are required' });
  }

  // Verify site belongs to this company
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(400).json({ error: 'Site not found' });

  // If guard_id provided, verify it
  if (guard_id) {
    const guardCheck = await pool.query(
      'SELECT id FROM guards WHERE id = $1 AND company_id = $2 AND is_active = true',
      [guard_id, req.user!.company_id]
    );
    if (!guardCheck.rows[0]) return res.status(400).json({ error: 'Guard not found or inactive' });
  }

  const status = guard_id ? 'scheduled' : 'unassigned';

  // If repeat_days provided, create one shift per selected day within 4 weeks
  if (Array.isArray(repeat_days) && repeat_days.length > 0) {
    const baseStart = new Date(scheduled_start);
    const baseEnd   = new Date(scheduled_end);
    const durationMs = baseEnd.getTime() - baseStart.getTime();

    // Collect all dates within 4 weeks from base start
    const horizon = new Date(baseStart);
    horizon.setDate(horizon.getDate() + 28); // 4 weeks

    // Expand first into in-memory pairs so we can validate the whole set
    // BEFORE any INSERT — past-date guard rejects the entire request rather
    // than silently dropping past dates.
    const pending: { start: Date; end: Date }[] = [];
    const cur = new Date(baseStart);
    while (cur <= horizon) {
      const dow = cur.getDay(); // 0=Sun..6=Sat
      if (repeat_days.includes(dow)) {
        const shiftStart = new Date(cur);
        shiftStart.setHours(baseStart.getHours(), baseStart.getMinutes(), baseStart.getSeconds(), 0);
        const shiftEnd = new Date(shiftStart.getTime() + durationMs);
        pending.push({ start: shiftStart, end: shiftEnd });
      }
      cur.setDate(cur.getDate() + 1);
    }

    if (pending.some(p => isPastPacificDate(p.start))) {
      return res.status(422).json({ error: 'Cannot schedule shifts in the past.' });
    }

    // Phase A enforcement (repeat_days). Same "first offending date" rule.
    if (guard_id) {
      const offending = await firstUnassignedDate(
        guard_id,
        site_id,
        pending.map(p => pacificDateStr(p.start)),
      );
      if (offending) {
        return res.status(422).json({ error: `Guard is not assigned to this site on ${offending}.` });
      }
    }

    const created: object[] = [];
    for (const p of pending) {
      const r = await pool.query(
        `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [guard_id || null, site_id, p.start.toISOString(), p.end.toISOString(), status]
      );
      created.push(r.rows[0]);
    }
    return res.status(201).json(created);
  }

  // Single shift
  if (isPastPacificDate(scheduled_start)) {
    return res.status(422).json({ error: 'Cannot schedule shifts in the past.' });
  }

  // Phase A enforcement (single). Bypassed for unassigned shifts.
  if (guard_id) {
    const d = pacificDateStr(scheduled_start);
    if (!(await isGuardAssignedToSite(guard_id, site_id, d))) {
      return res.status(422).json({ error: `Guard is not assigned to this site on ${d}.` });
    }
  }

  const result = await pool.query(
    `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [guard_id || null, site_id, scheduled_start, scheduled_end, status]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /api/admin/shifts/:id/assign-guard
router.patch('/:id/assign-guard', requireAuth('company_admin'), async (req, res) => {
  const { guard_id } = req.body;
  if (!guard_id) return res.status(400).json({ error: 'guard_id is required' });

  // Verify guard and shift belong to this company. shiftCheck also pulls
  // scheduled_start + site_id so Phase A can validate the assignment for
  // the shift's actual date — closing the gap left by the original Phase A,
  // which only enforced on POST /api/shifts.
  const [guardCheck, shiftCheck] = await Promise.all([
    pool.query(
      'SELECT id FROM guards WHERE id = $1 AND company_id = $2 AND is_active = true',
      [guard_id, req.user!.company_id]
    ),
    pool.query(
      `SELECT s.id, s.site_id, s.scheduled_start
         FROM shifts s
         JOIN sites si ON si.id = s.site_id
        WHERE s.id = $1 AND si.company_id = $2`,
      [req.params.id, req.user!.company_id]
    ),
  ]);
  if (!guardCheck.rows[0]) return res.status(400).json({ error: 'Guard not found or inactive' });
  if (!shiftCheck.rows[0]) return res.status(404).json({ error: 'Shift not found' });

  // Phase A — gate against guard_site_assignments for the shift's Pacific
  // calendar date. site_id is NOT mutable on this endpoint, so the
  // effective site is always the shift's current site.
  const shiftDate = pacificDateStr(shiftCheck.rows[0].scheduled_start);
  if (!(await isGuardAssignedToSite(guard_id, shiftCheck.rows[0].site_id, shiftDate))) {
    return res.status(422).json({ error: `Guard is not assigned to this site on ${shiftDate}.` });
  }

  const result = await pool.query(
    `UPDATE shifts SET guard_id = $1, status = 'scheduled'
     WHERE id = $2 RETURNING *`,
    [guard_id, req.params.id]
  );
  res.json(result.rows[0]);
});

// PATCH /api/shifts/:id/reassign — admin reassigns a shift to a different guard.
// Writes shifts.guard_id and an audit row in shift_reassignments atomically.
// Sends best-effort FCM notifications to old and new guards after commit;
// push failures are logged but never fail the API call.
router.patch('/:id/reassign', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { user }   = req;
  const { id }     = req.params;
  const { new_guard_id, reason } = req.body as { new_guard_id?: string; reason?: string };

  if (!new_guard_id || typeof new_guard_id !== 'string') {
    return res.status(400).json({ error: 'new_guard_id is required' });
  }
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > 500)) {
    return res.status(400).json({ error: 'reason must be a string up to 500 chars' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load the shift + its company (via site) and lock the row for the txn.
    const shiftRes = await client.query(
      `SELECT sh.id, sh.guard_id AS old_guard_id, sh.site_id, sh.status,
              sh.scheduled_start, sh.scheduled_end,
              si.company_id, si.name AS site_name
         FROM shifts sh
         JOIN sites si ON si.id = sh.site_id
        WHERE sh.id = $1
        FOR UPDATE OF sh`,
      [id],
    );
    if (!shiftRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = shiftRes.rows[0];

    // company_admin can only touch their own company's shifts; vishnu has no
    // company scope.
    if (user!.role === 'company_admin' && shift.company_id !== user!.company_id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found' });
    }

    // Past shifts cannot be reassigned (auto-complete cron has already
    // settled their status as 'completed' or 'missed').
    if (shift.status === 'completed' || shift.status === 'missed') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: 'This shift cannot be reassigned — it has already completed or was marked missed.',
      });
    }

    // New guard must belong to the same company and be active.
    const guardRes = await client.query(
      `SELECT id FROM guards
        WHERE id = $1 AND company_id = $2 AND is_active = true`,
      [new_guard_id, shift.company_id],
    );
    if (!guardRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Guard not found, inactive, or belongs to a different company.' });
    }

    // Phase A — the new guard must be assigned to the shift's site for the
    // shift's Pacific date. site_id isn't mutable on this endpoint, so we
    // gate against the existing site. Sharing the txn client gives this
    // read-your-own-writes consistency with the same transaction.
    const shiftDate = pacificDateStr(shift.scheduled_start);
    if (!(await isGuardAssignedToSite(new_guard_id, shift.site_id, shiftDate, client))) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: `Guard is not assigned to this site on ${shiftDate}.` });
    }

    // Overlap check: any OTHER scheduled/active shift the new guard holds in
    // the same time window. Past shifts (completed/missed) can't overlap a
    // future window in any meaningful sense, but we filter them explicitly
    // for clarity.
    const overlap = await client.query(
      `SELECT 1 FROM shifts
        WHERE guard_id = $1
          AND id      != $2
          AND status IN ('scheduled','active')
          AND scheduled_start < $4
          AND scheduled_end   > $3
        LIMIT 1`,
      [new_guard_id, id, shift.scheduled_start, shift.scheduled_end],
    );
    if (overlap.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Selected guard has an overlapping shift in the same time window.',
      });
    }

    // Atomic update + audit insert. status reset to 'scheduled' covers the
    // case where the shift was already 'scheduled' with a missed-alert sent
    // (clearing the timestamp lets the new guard's own no-show re-trigger).
    const updated = await client.query(
      `UPDATE shifts
          SET guard_id = $1,
              status   = 'scheduled',
              missed_alert_sent_at = NULL
        WHERE id = $2
        RETURNING *`,
      [new_guard_id, id],
    );

    await client.query(
      `INSERT INTO shift_reassignments
         (shift_id, old_guard_id, new_guard_id,
          reassigned_by_admin_id, reassigned_by_role, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, shift.old_guard_id, new_guard_id, user!.sub, user!.role, reason ?? null],
    );

    await client.query('COMMIT');

    // ── Best-effort FCM pushes (Imp 1a will verify e2e on devices) ───────
    // Both wrapped in try/catch so a push failure does NOT undo the
    // committed reassignment. Pulled OUT of the transaction by design.
    const tokensRes = await pool.query(
      `SELECT id, fcm_token FROM guards WHERE id IN ($1, $2) AND fcm_token IS NOT NULL`,
      [new_guard_id, shift.old_guard_id ?? new_guard_id],
    );
    const tokenByGuardId: Record<string, string> = {};
    for (const row of tokensRes.rows) tokenByGuardId[row.id] = row.fcm_token;

    const startIso = new Date(shift.scheduled_start).toISOString();
    const dateLabel = new Date(shift.scheduled_start).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
    });

    const newToken = tokenByGuardId[new_guard_id];
    if (newToken) {
      sendPushNotification({
        token: newToken,
        title: `Shift assigned at ${shift.site_name}`,
        body:  `Starts ${dateLabel}. Tap to view details.`,
        data:  { type: 'shift_assigned', shift_id: id, scheduled_start: startIso },
      }).catch((err) => console.error('[reassign] FCM push to new guard failed:', err));
    }

    const oldToken = shift.old_guard_id ? tokenByGuardId[shift.old_guard_id] : undefined;
    if (oldToken && shift.old_guard_id !== new_guard_id) {
      sendPushNotification({
        token: oldToken,
        title: `Shift reassigned`,
        body:  `Your ${dateLabel} shift at ${shift.site_name} has been reassigned. You no longer need to cover it.`,
        data:  { type: 'shift_reassigned_away', shift_id: id, scheduled_start: startIso },
      }).catch((err) => console.error('[reassign] FCM push to old guard failed:', err));
    }

    res.json(updated.rows[0]);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[reassign] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to reassign shift' });
  } finally {
    client.release();
  }
});

// GET /api/shifts  — guard sees their shifts; admin sees all for company
router.get('/', requireAuth('guard', 'company_admin'), async (req, res) => {
  const { user } = req;
  let result;
  if (user!.role === 'guard') {
    // total_hours_worked: sum of completed shift_sessions.total_hours for this
    // shift, plus live elapsed since clocked_in_at for any still-open session.
    // Replaces the mobile profile's old (scheduled_end - scheduled_start)
    // calculation, which credited no-show shifts with the full scheduled time.
    result = await pool.query(
      `SELECT s.*, si.name as site_name, si.instructions_pdf_url,
              COALESCE(si.photo_limit_override, co.default_photo_limit, 5) AS effective_photo_limit,
              COALESCE(ss_agg.sum_completed_hours, 0)
                + CASE
                    WHEN ss_agg.open_clocked_in_at IS NOT NULL
                      THEN GREATEST(0, EXTRACT(EPOCH FROM (NOW() - ss_agg.open_clocked_in_at)) / 3600.0)
                    ELSE 0
                  END AS total_hours_worked
       FROM shifts s
       JOIN sites si ON s.site_id = si.id
       JOIN companies co ON co.id = si.company_id
       LEFT JOIN (
         SELECT shift_id,
                COALESCE(SUM(total_hours), 0) AS sum_completed_hours,
                MAX(CASE WHEN clocked_out_at IS NULL THEN clocked_in_at END) AS open_clocked_in_at
         FROM shift_sessions
         WHERE guard_id = $1
         GROUP BY shift_id
       ) ss_agg ON ss_agg.shift_id = s.id
       WHERE s.guard_id = $1 ORDER BY s.scheduled_start DESC LIMIT 50`,
      [user!.sub]
    );
  } else {
    result = await pool.query(
      `SELECT s.*, si.name as site_name, si.instructions_pdf_url, g.name as guard_name,
              COALESCE(si.photo_limit_override, co.default_photo_limit, 5) AS effective_photo_limit
       FROM shifts s
       JOIN sites si ON s.site_id = si.id
       JOIN companies co ON co.id = si.company_id
       LEFT JOIN guards g ON s.guard_id = g.id
       WHERE si.company_id = $1 ORDER BY s.scheduled_start DESC LIMIT 100`,
      [user!.company_id]
    );
  }
  res.json(result.rows);
});

// GET /api/shifts/active-session — returns the guard's current active shift+session (for store restoration)
//
// Item 8: now returns sites.ping_interval_minutes so the mobile reads the
// per-site cadence at restore/clock-in time. The value is cached on the
// mobile for the lifetime of the active session — admin edits mid-shift
// do NOT disturb in-flight shifts; the new cadence is picked up at the
// next clock-in (matches Q37 semantics).
router.get('/active-session', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT s.id as shift_id, s.site_id, s.scheduled_start, s.scheduled_end,
            si.name as site_name, si.instructions_pdf_url,
            si.photo_limit_override,
            si.ping_interval_minutes,
            co.default_photo_limit,
            ss.id as session_id, ss.clocked_in_at
     FROM shifts s
     JOIN sites si ON si.id = s.site_id
     JOIN companies co ON co.id = si.company_id
     JOIN shift_sessions ss ON ss.shift_id = s.id AND ss.guard_id = $1 AND ss.clocked_out_at IS NULL
     WHERE s.guard_id = $1 AND s.status = 'active'
       AND s.scheduled_end > NOW() - INTERVAL '2 hours'
     ORDER BY ss.clocked_in_at DESC LIMIT 1`,
    [req.user!.sub]
  );
  if (!result.rows[0]) return res.json(null);
  const r = result.rows[0];
  const effectivePhotoLimit = r.photo_limit_override ?? r.default_photo_limit ?? 5;
  res.json({
    shift:   {
      id: r.shift_id,
      site_id: r.site_id,
      site_name: r.site_name,
      scheduled_start: r.scheduled_start,
      scheduled_end: r.scheduled_end,
      instructions_pdf_url: r.instructions_pdf_url ?? null,
      effective_photo_limit: effectivePhotoLimit,
      ping_interval_minutes: r.ping_interval_minutes,
    },
    session: { id: r.session_id, shift_id: r.shift_id, clocked_in_at: r.clocked_in_at },
  });
});

// GET /api/shifts/:id — admin shift detail with joined site/guard + reassignment history.
// Used by the admin shift detail page (apps/web/app/admin/shifts/[shiftId]).
// company_admin sees only their company's shifts; vishnu sees any.
//
// Placed AFTER /active-session because Express matches routes in declaration
// order: a /:id catch-all defined earlier would shadow the literal /active-session.
router.get('/:id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { user } = req;
  const shiftResult = await pool.query(
    `SELECT sh.id, sh.guard_id, sh.site_id, sh.scheduled_start, sh.scheduled_end,
            sh.status, sh.missed_alert_sent_at, sh.created_at,
            si.name AS site_name, si.address AS site_address, si.company_id,
            g.name AS guard_name, g.badge_number, g.phone_number AS guard_phone
       FROM shifts sh
       JOIN sites  si ON si.id = sh.site_id
       LEFT JOIN guards g ON g.id = sh.guard_id
      WHERE sh.id = $1`,
    [req.params.id],
  );
  if (!shiftResult.rows[0]) return res.status(404).json({ error: 'Shift not found' });
  const shift = shiftResult.rows[0];

  if (user!.role === 'company_admin' && shift.company_id !== user!.company_id) {
    return res.status(404).json({ error: 'Shift not found' });
  }

  const historyResult = await pool.query(
    `SELECT sr.id, sr.created_at, sr.reason,
            sr.reassigned_by_admin_id, sr.reassigned_by_role,
            sr.old_guard_id, og.name AS old_guard_name,
            sr.new_guard_id, ng.name AS new_guard_name,
            ca.name AS reassigned_by_name
       FROM shift_reassignments sr
       LEFT JOIN guards og         ON og.id = sr.old_guard_id
       LEFT JOIN guards ng         ON ng.id = sr.new_guard_id
       LEFT JOIN company_admins ca ON ca.id = sr.reassigned_by_admin_id
      WHERE sr.shift_id = $1
      ORDER BY sr.created_at DESC`,
    [req.params.id],
  );

  res.json({ ...shift, reassignment_history: historyResult.rows });
});

// POST /api/shifts/break-start — guard starts a break
router.post('/break-start', requireAuth('guard'), async (req, res) => {
  const { session_id, break_type } = req.body;
  if (!session_id || !break_type) {
    return res.status(400).json({ error: 'session_id and break_type are required' });
  }
  try {
    // Verify session belongs to this guard and is open
    const sessionResult = await pool.query(
      'SELECT site_id FROM shift_sessions WHERE id = $1 AND guard_id = $2 AND clocked_out_at IS NULL',
      [session_id, req.user!.sub]
    );
    if (!sessionResult.rows[0]) return res.status(403).json({ error: 'Active session not found' });
    const { site_id } = sessionResult.rows[0];

    const result = await pool.query(
      `INSERT INTO break_sessions (shift_session_id, guard_id, site_id, break_start, break_type)
       VALUES ($1, $2, $3, NOW(), $4) RETURNING id`,
      [session_id, req.user!.sub, site_id, break_type]
    );
    res.status(201).json({ break_id: result.rows[0].id });
  } catch (err: any) {
    console.error('break-start error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to start break' });
  }
});

// POST /api/shifts/break-end — guard ends a break
router.post('/break-end', requireAuth('guard'), async (req, res) => {
  const { break_id } = req.body;
  if (!break_id) return res.status(400).json({ error: 'break_id is required' });

  try {
    const result = await pool.query(
      `UPDATE break_sessions
       SET break_end = NOW(),
           duration_minutes = EXTRACT(EPOCH FROM (NOW() - break_start)) / 60
       WHERE id = $1 AND guard_id = $2 AND break_end IS NULL
       RETURNING *`,
      [break_id, req.user!.sub]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Break not found or already ended' });
    res.json(result.rows[0]);
  } catch (err: any) {
    console.error('break-end error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to end break' });
  }
});

// POST /api/shifts/:id/clock-in — creates shift_session + triggers task instance generation
//
// Concurrency model (CB2/CB3, audit/WEEK1.md C2):
//   - SELECT … FOR UPDATE locks the `shifts` row so two near-simultaneous
//     clock-in attempts from two devices serialise here.
//   - The partial unique index `idx_shift_sessions_one_open_per_guard`
//     (schema_v9.sql) is the last-line backstop: if the FOR UPDATE check
//     races past somehow, the INSERT raises 23505 and we return 409.
//
// Geofence validation (Item 3 — closes V6 audit hole):
//   - Mobile sends lat/lng/accuracy (NOT a client-decided boolean).
//   - Server validates via validateAtSite inside the same
//     transaction, so the geofence read is consistent with the session
//     insert. Reject → ROLLBACK + 422 GEOFENCE_FAILED.
router.post('/:id/clock-in', requireAuth('guard'), idempotent('clock-in'), async (req, res) => {
  const { id } = req.params;
  const { clock_in_coords, lat, lng, accuracy } = req.body as {
    clock_in_coords?: string;
    lat?: number;
    lng?: number;
    accuracy?: number;
  };

  // Required for geofence validation. Legacy clients without these fields
  // are blocked — forces a mobile update before they can clock in.
  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    typeof accuracy !== 'number'
  ) {
    return res.status(400).json({
      error: 'Missing lat/lng/accuracy. Update the app to the latest version.',
    });
  }

  const coords = clock_in_coords ?? `(${lat},${lng})`;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftResult = await client.query(
      'SELECT * FROM shifts WHERE id = $1 AND guard_id = $2 AND status = $3 FOR UPDATE',
      [id, req.user!.sub, 'scheduled']
    );
    if (!shiftResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found or not schedulable' });
    }
    const shift = shiftResult.rows[0];

    // Server-side geofence check. Inside the transaction so the fence read
    // is consistent with the session insert (and so we can ROLLBACK on fail
    // without leaving the shift row partially mutated).
    const fence = await validateAtSite(
      { lat, lng, accuracy_m: accuracy },
      shift.site_id,
      client,
    );
    if (!fence.allowed) {
      await client.query('ROLLBACK');
      console.log(
        `geofence.reject site=${shift.site_id} guard=${req.user!.sub} shift=${id} ` +
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

    const sessionResult = await client.query(
      `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords)
       VALUES ($1, $2, $3, NOW(), $4) RETURNING *`,
      [id, req.user!.sub, shift.site_id, coords]
    );
    await client.query('UPDATE shifts SET status = $1 WHERE id = $2', ['active', id]);
    const session = sessionResult.rows[0];
    await client.query('COMMIT');
    // Generate task instances outside transaction (non-critical)
    generateTaskInstancesForShift(id, shift.site_id, session.clocked_in_at).catch(console.error);
    res.status(201).json(session);
  } catch (err: any) {
    await client.query('ROLLBACK');
    // 23505 = unique_violation on idx_shift_sessions_one_open_per_guard
    if (err?.code === '23505' && err?.constraint === 'idx_shift_sessions_one_open_per_guard') {
      return res.status(409).json({
        error: 'Already clocked in on another device. Clock out first.',
      });
    }
    throw err;
  } finally {
    client.release();
  }
});

// POST /api/shifts/:id/clock-out
//
// Wrapped in an explicit transaction (CB2/CB3): previously four independent
// queries fired outside any transaction, so a crash between them could leave
// total_hours NULL or shifts.status stuck on 'active'.  Now closes the open
// session, sets total_hours = gross − breaks, and completes the shift in one
// atomic unit.
//
// T2-A geofence validation (2026-05-17 audit Wave A): when all of
// {lat, lng, accuracy} are present in the body, validateAtSite decides
// the same way clock-in does. Reject → ROLLBACK + 422 CLOCK_OUT_OFF_POST;
// the session stays open so the guard can return to the post and retry.
// Build 24 + older clients that don't send coords skip validation
// entirely (backward compat — tightens once mobile companion ships).
router.post('/:id/clock-out', requireAuth('guard'), async (req, res) => {
  const { id } = req.params;
  const { handover_notes, lat, lng, accuracy } = req.body as {
    handover_notes?: string | null;
    lat?: number;
    lng?: number;
    accuracy?: number;
  };

  const haveCoords =
    typeof lat === 'number' && Number.isFinite(lat) &&
    typeof lng === 'number' && Number.isFinite(lng) &&
    typeof accuracy === 'number' && Number.isFinite(accuracy) && accuracy >= 0;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Close the session and grab the existing clocked_in_at + scheduled_start
    // for math (option C: pay from MAX(clock_in, scheduled_start) onwards).
    // Also pull site_id for the geofence validation below.
    const sessionResult = await client.query(
      `UPDATE shift_sessions ss SET clocked_out_at = NOW()
       FROM shifts s
       WHERE ss.shift_id = s.id
         AND ss.shift_id = $1
         AND ss.guard_id = $2
         AND ss.clocked_out_at IS NULL
       RETURNING ss.id, ss.clocked_in_at, ss.clocked_out_at, s.scheduled_start, ss.site_id`,
      [id, req.user!.sub]
    );
    if (!sessionResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Active session not found' });
    }
    const session = sessionResult.rows[0];

    // T2-A — validate coords against site geofence when present.
    // ROLLBACK on reject so clocked_out_at gets un-set, leaving the
    // session open for retry from on-post.
    if (haveCoords) {
      const fence = await validateAtSite(
        { lat: lat!, lng: lng!, accuracy_m: accuracy! },
        session.site_id,
        client,
      );
      if (!fence.allowed) {
        await client.query('ROLLBACK');
        console.log(
          `[clock-out.reject] session=${session.id} guard=${req.user!.sub} ` +
          `distance=${fence.distance_m?.toFixed(1) ?? 'null'}m accuracy=${accuracy}m reason=${fence.reason}`,
        );
        return res.status(422).json({
          error: 'CLOCK_OUT_OFF_POST',
          message: 'You appear to be outside the post. Return to the site and try again.',
          distance_m: fence.distance_m,
          accuracy_m: accuracy,
          reason: fence.reason,
        });
      }
    }

    // Close any break that was still open when the guard clocked out
    await client.query(
      `UPDATE break_sessions
       SET break_end = NOW(),
           duration_minutes = GREATEST(
             0,
             ROUND(EXTRACT(EPOCH FROM (NOW() - break_start)) / 60.0)::INT
           )
       WHERE shift_session_id = $1 AND break_end IS NULL`,
      [session.id]
    );

    // Compute total_hours = (clock_out − MAX(clock_in, scheduled_start)) − breaks.
    // Early arrivals don't earn pay before scheduled_start; late stays still count.
    // Matches autoCompleteShifts math (kept identical so manual + auto closes agree).
    const breaksResult = await client.query(
      'SELECT COALESCE(SUM(duration_minutes), 0) AS total_break_mins FROM break_sessions WHERE shift_session_id = $1',
      [session.id]
    );
    const clockOutMs    = new Date(session.clocked_out_at).getTime();
    const clockInMs     = new Date(session.clocked_in_at).getTime();
    const scheduledMs   = new Date(session.scheduled_start).getTime();
    const payStartMs    = Math.max(clockInMs, scheduledMs);
    const grossHours    = Math.max(0, (clockOutMs - payStartMs) / 3_600_000);
    const breakHours    = Number(breaksResult.rows[0].total_break_mins) / 60;
    const netHours      = Math.max(0, grossHours - breakHours);

    await client.query(
      `UPDATE shift_sessions
       SET total_hours = $1, handover_notes = $2,
           clock_out_lat = $3, clock_out_lng = $4,
           clock_out_accuracy_meters = $5, clock_out_within_geofence = $6
       WHERE id = $7`,
      [
        netHours,
        handover_notes ?? null,
        haveCoords ? lat  : null,
        haveCoords ? lng  : null,
        haveCoords ? accuracy : null,
        haveCoords ? true : null, // null = "not validated" (old clients); true = "validated, allowed"
        session.id,
      ]
    );
    await client.query('UPDATE shifts SET status = $1 WHERE id = $2', ['completed', id]);

    await client.query('COMMIT');
    res.json({ ...session, total_hours: netHours, handover_notes: handover_notes ?? null });
  } catch (err: any) {
    await client.query('ROLLBACK');
    console.error('clock-out error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to clock out' });
  } finally {
    client.release();
  }
});

export default router;
