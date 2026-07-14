import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { generateTaskInstancesForShift } from '../services/tasks';
import { validateAtSite } from '../services/geofence';
import { idempotent } from '../services/idempotency';
import { sendPushNotification } from '../services/firebase';
import { isPastPacificDate, isPastPacificDateString, pacificDateStr } from '../services/pacificDate';
import { checkShiftEligibility, eligibilityError } from '../services/guardAssignments';
import { expiresAtFor } from '../services/retention';
import { pushShiftAssignments, type CreatedShift } from '../services/shiftPush';
import {
  pushSwapRequestToRecipient,
  pushSwapRequestSentToRequester,
  pushSwapAcceptedToRequester,
  pushSwapDeclinedToRequester,
  pushHandoffRequestToRecipient,
  pushHandoffRequestSentToRequester,
  pushHandoffAcceptedToRequester,
  pushHandoffDeclinedToRequester,
  pushHandoffCancelled,
  pushHandoffCompleteToRequester,
} from '../services/swapPush';
import {
  sendSwapAcceptedFyi,
  sendHandoffAcceptedFyi,
  sendHandoffCompletedFyi,
} from '../services/email';

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
async function firstIneligibleDate(
  guardId: string,
  siteId: string,
  pacificDates: string[],
): Promise<{ date: string; message: string } | null> {
  for (const d of pacificDates) {
    const elig = await checkShiftEligibility(guardId, siteId, d);
    if (!elig.ok) return { date: d, message: eligibilityError(elig, d) };
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

    // Site + guard belong to caller's company. Grab the site's timezone here
    // so every AT TIME ZONE below binds it as a parameter instead of a
    // hardcoded America/Los_Angeles literal.
    const siteCheck = await pool.query(
      'SELECT id, timezone, is_active FROM sites WHERE id = $1 AND company_id = $2',
      [site_id, req.user!.company_id]
    );
    if (!siteCheck.rows[0]) return res.status(400).json({ error: 'Site not found' });
    if (!siteCheck.rows[0].is_active) {
      return res.status(409).json({ error: 'Site is deactivated. Reactivate it before scheduling shifts.' });
    }
    const siteTz = siteCheck.rows[0].timezone as string;
    if (guard_id) {
      const guardCheck = await pool.query(
        'SELECT id FROM guards WHERE id = $1 AND company_id = $2 AND is_active = true',
        [guard_id, req.user!.company_id]
      );
      if (!guardCheck.rows[0]) return res.status(400).json({ error: 'Guard not found or inactive' });

      // Phase A — guard must have an assignment covering every emitted date.
      // First offending date wins; rejects the whole request (no partial insert).
      const offending = await firstIneligibleDate(guard_id, site_id, dateList);
      if (offending) {
        return res.status(422).json({ error: offending.message });
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
      const createdShifts: CreatedShift[] = [];
      for (const d of sortedDates) {
        // Overlap check (assigned shifts only — unassigned can stack).
        if (guard_id) {
          const overlap = await client.query(
            `WITH new_window AS (
               SELECT
                 ($1::date + $2::time) AT TIME ZONE $6 AS s,
                 ($1::date + $4::interval + $3::time) AT TIME ZONE $6 AS e
             )
             SELECT 1 FROM shifts, new_window
              WHERE guard_id = $5
                AND status IN ('scheduled','active')
                AND scheduled_start < new_window.e
                AND scheduled_end   > new_window.s
              LIMIT 1`,
            [d, start_time, end_time, overnightInterval, guard_id, siteTz]
          );
          if (overlap.rows[0]) {
            await client.query('ROLLBACK');
            return res.status(422).json({ error: `Conflict on date ${d}` });
          }
        }
        const insert = await client.query(
          `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, expires_at)
           VALUES (
             $1,
             $2,
             ($3::date + $4::time) AT TIME ZONE $8,
             ($3::date + $6::interval + $5::time) AT TIME ZONE $8,
             $7,
             $9
           ) RETURNING id, guard_id, site_id, scheduled_start, scheduled_end`,
          [guard_id || null, site_id, d, start_time, end_time, overnightInterval, status, siteTz,
           expiresAtFor('shift')]
        );
        const row = insert.rows[0];
        ids.push(row.id);
        createdShifts.push(row);
      }
      await client.query('COMMIT');
      res.status(201).json({ ids });
      // Aggregated per-guard push, fire-and-forget after response.
      pushShiftAssignments(createdShifts).catch((err) =>
        console.error('[shifts.specific_dates] push failed:', err),
      );
      return;
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

  // Verify site belongs to this company. Grab timezone up-front for the
  // repeat_days DOW calc below (server-local getDay() would off-by-one on
  // shifts scheduled near local midnight).
  const siteCheck = await pool.query(
    'SELECT id, timezone FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(400).json({ error: 'Site not found' });
  const siteTz = siteCheck.rows[0].timezone as string;

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
    // Compute DOW in the SITE's timezone so a shift-day computed near
    // midnight isn't off-by-one because the server runs UTC. Same code
    // as before otherwise.
    const DOW_BY_NAME: Record<string, number> = {
      Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
      Thursday: 4, Friday: 5, Saturday: 6,
    };
    const dowInSiteTz = (d: Date): number =>
      DOW_BY_NAME[new Intl.DateTimeFormat('en-US',
        { timeZone: siteTz, weekday: 'long' }).format(d)] ?? d.getDay();
    while (cur <= horizon) {
      const dow = dowInSiteTz(cur);
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
      const offending = await firstIneligibleDate(
        guard_id,
        site_id,
        pending.map(p => pacificDateStr(p.start)),
      );
      if (offending) {
        return res.status(422).json({ error: offending.message });
      }
    }

    const created: Array<Record<string, unknown>> = [];
    for (const p of pending) {
      const r = await pool.query(
        `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [guard_id || null, site_id, p.start.toISOString(), p.end.toISOString(), status, expiresAtFor('shift')]
      );
      created.push(r.rows[0]);
    }
    res.status(201).json(created);
    // Aggregated per-guard push, fire-and-forget after response.
    pushShiftAssignments(
      created.map((r) => ({
        id:              String(r.id),
        guard_id:        (r.guard_id as string | null) ?? null,
        site_id:         String(r.site_id),
        scheduled_start: r.scheduled_start as string | Date,
        scheduled_end:   r.scheduled_end as string | Date,
      })),
    ).catch((err) => console.error('[shifts.repeat_days] push failed:', err));
    return;
  }

  // Single shift
  if (isPastPacificDate(scheduled_start)) {
    return res.status(422).json({ error: 'Cannot schedule shifts in the past.' });
  }

  // Phase A enforcement (single). Bypassed for unassigned shifts.
  if (guard_id) {
    const d = pacificDateStr(scheduled_start);
    const elig = await checkShiftEligibility(guard_id, site_id, d);
    if (!elig.ok) {
      return res.status(422).json({ error: eligibilityError(elig, d) });
    }
  }

  const result = await pool.query(
    `INSERT INTO shifts (guard_id, site_id, scheduled_start, scheduled_end, status, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [guard_id || null, site_id, scheduled_start, scheduled_end, status, expiresAtFor('shift')]
  );
  res.status(201).json(result.rows[0]);
  // Aggregated per-guard push, fire-and-forget after response.
  const row = result.rows[0];
  pushShiftAssignments([{
    id:              row.id,
    guard_id:        row.guard_id,
    site_id:         row.site_id,
    scheduled_start: row.scheduled_start,
    scheduled_end:   row.scheduled_end,
  }]).catch((err) => console.error('[shifts.single] push failed:', err));
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
  const eligAssign = await checkShiftEligibility(guard_id, shiftCheck.rows[0].site_id, shiftDate);
  if (!eligAssign.ok) {
    return res.status(422).json({ error: eligibilityError(eligAssign, shiftDate) });
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
              si.company_id, si.name AS site_name, si.timezone AS site_tz,
              si.is_active AS site_is_active
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

    // Deactivated sites can't accept new work — reassignment is new work.
    if (!shift.site_is_active) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Site is deactivated. Reactivate it before reassigning shifts.' });
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
    const eligReassign = await checkShiftEligibility(new_guard_id, shift.site_id, shiftDate, client);
    if (!eligReassign.ok) {
      await client.query('ROLLBACK');
      return res.status(422).json({ error: eligibilityError(eligReassign, shiftDate) });
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
      month: 'short', day: 'numeric',
      timeZone: (shift.site_tz as string | null) ?? 'America/Los_Angeles',
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

// PATCH /api/shifts/:id/cancel — admin cancels an accidentally-scheduled shift.
//
// Gate: only status='scheduled' is cancellable. Everything else 409s with
// a specific reason so the operator understands why. Unassigned scheduled
// shifts are cancellable too (no guard to notify, push is skipped).
//
// Writes (single txn):
//   shifts.status              = 'cancelled'
//   shifts.cancellation_reason = 'admin_cancelled' (or a body-supplied
//                                reason string, capped at 200 chars)
//
// Post-commit best-effort push to the assigned guard (skipped for
// unassigned). Historical tables (shift_sessions, reports,
// task_completions, geofence_violations, clock_in_verifications) are
// never referenced.
router.patch('/:id/cancel', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { user } = req;
  const { id }   = req.params;
  const rawReason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (rawReason.length > 200) {
    return res.status(400).json({ error: 'reason must be at most 200 characters' });
  }
  const reason = rawReason || 'admin_cancelled';

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const shiftRes = await client.query(
      `SELECT sh.id, sh.guard_id, sh.site_id, sh.status,
              sh.scheduled_start, sh.scheduled_end,
              si.company_id,
              si.name     AS site_name,
              si.timezone AS site_tz,
              g.name      AS guard_name
         FROM shifts sh
         JOIN sites  si ON si.id = sh.site_id
         LEFT JOIN guards g ON g.id = sh.guard_id
        WHERE sh.id = $1
        FOR UPDATE OF sh`,
      [id],
    );
    if (!shiftRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = shiftRes.rows[0];

    // Tenant scope. Mirror reassign's shape (404 on cross-tenant to hide
    // existence rather than 403).
    if (user!.role === 'company_admin' && shift.company_id !== user!.company_id) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found' });
    }

    // Status gate — only 'scheduled' cancellable, everything else gets a
    // specific 409 so the admin knows why.
    switch (shift.status) {
      case 'scheduled':
        break;
      case 'active':
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This shift is in progress (guard clocked in). Cancel is not allowed.',
        });
      case 'completed':
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This shift has already completed and cannot be cancelled.',
        });
      case 'missed':
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This shift was already marked missed.',
        });
      case 'cancelled':
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: 'This shift is already cancelled.',
        });
      default:
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Shift status '${shift.status}' cannot be cancelled.`,
        });
    }

    const updated = await client.query(
      `UPDATE shifts
          SET status              = 'cancelled',
              cancellation_reason = $1
        WHERE id = $2
        RETURNING *`,
      [reason, id],
    );

    await client.query('COMMIT');

    res.json(updated.rows[0]);

    // ── Best-effort FCM push to the assigned guard — skipped if unassigned.
    // Fire-and-forget after the response is written so a push hiccup can't
    // roll back a committed cancellation.
    if (shift.guard_id) {
      (async () => {
        try {
          const tokRow = await pool.query<{ fcm_token: string | null }>(
            'SELECT fcm_token FROM guards WHERE id = $1',
            [shift.guard_id],
          );
          const token = tokRow.rows[0]?.fcm_token;
          if (!token) return;
          const tz = (shift.site_tz as string | null) ?? 'America/Los_Angeles';
          const dayLabel = new Intl.DateTimeFormat('en-US', {
            weekday: 'short', month: 'short', day: 'numeric', timeZone: tz,
          }).format(new Date(shift.scheduled_start));
          const { staleToken } = await sendPushNotification({
            token,
            title: 'Shift cancelled',
            body:  `${dayLabel} at ${shift.site_name}`,
            data:  { type: 'shift_cancelled', shift_id: id },
          });
          if (staleToken) {
            await pool.query(
              'UPDATE guards SET fcm_token = NULL WHERE id = $1 AND fcm_token = $2',
              [shift.guard_id, token],
            );
          }
        } catch (err) {
          console.error('[shifts.cancel] push failed:', err);
        }
      })();
    }
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[shifts.cancel] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to cancel shift' });
  } finally {
    client.release();
  }
});

// ── Guard-to-guard shift swap (Phase 1a: pre-shift) ─────────────────────────
//
// GET /api/shifts/:id/swap-eligible-guards
//   Returns the pool of guards who can accept a swap invitation for this
//   shift. Sorted same-site first. Excludes: the requester, inactive
//   guards, guards with any overlapping active/scheduled shift.
//
// GET /api/shifts/inbound-swap-requests
//   Pending swap requests addressed to the calling guard, so the mobile
//   alerts tab can render inline ACCEPT/DECLINE cards without waiting for
//   a push. Newest first.
//
// POST /api/shifts/:id/swap-request
//   Body: { to_guard_id, reason? } (reason 200 char cap)
//   Creates a pending shift_swap_requests row. Fire-and-forget pushes:
//   B (invitation) + A (confirmation).
//
// POST /api/shifts/:id/swap-response
//   Body: { history_id, accept: boolean }
//   Auth: guard = the row's to_guard_id. Txn-wrapped with FOR UPDATE on
//   both the shift and the history row. On accept: UPDATE shifts.guard_id
//   + mark history 'accepted', fire admin FYI email + push A. On decline:
//   mark 'declined', push A.

// Path-conflict note: this literal route MUST be declared before any of the
// `/:id/…` swap routes below or Express matches "inbound-swap-requests" as
// a shift id and returns a 404 from swap-eligible-guards' shift-lookup.
router.get('/inbound-swap-requests', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    // Phase 2b: mobile alerts.tsx branches card copy + the accept
    // confirmation dialog on initiated_by. Post-walk-test 2026-07-10:
    // ALSO return accepted-but-not-arrived handoff rows so the recipient's
    // PENDING ARRIVAL card survives an app kill / tab reopen (previously
    // this state only lived in an in-memory Set on the alerts screen).
    // status + to_session_id in the SELECT so mobile can render the state.
    `SELECT ssr.id           AS history_id,
            ssr.shift_id,
            ssr.requested_at,
            ssr.accepted_at,
            ssr.status,
            ssr.reason,
            ssr.initiated_by,
            ssr.to_session_id,
            ssr.from_guard_id,
            fg.name          AS from_guard_name,
            sh.scheduled_start,
            sh.scheduled_end,
            si.name          AS site_name,
            si.timezone      AS site_tz
       FROM shift_swap_requests ssr
       JOIN shifts sh ON sh.id = ssr.shift_id
       JOIN sites  si ON si.id = sh.site_id
       LEFT JOIN guards fg ON fg.id = ssr.from_guard_id
      WHERE ssr.to_guard_id = $1
        AND (
          ssr.status = 'pending'
          OR (
            ssr.status = 'accepted'
            AND ssr.initiated_by = 'guard_handoff'
            AND ssr.to_session_id IS NULL
          )
        )
      ORDER BY ssr.requested_at DESC
      LIMIT 50`,
    [req.user!.sub],
  );
  res.json(result.rows);
});

// Symmetric to /inbound-swap-requests but for the requester side. Home
// screen surfaces a "PENDING HANDOFF · Waiting for james…" card so the
// initiator doesn't lose sight of an in-flight request after they navigate
// away from the modal.
//
// Includes both:
//   - pending  — recipient hasn't responded yet
//   - accepted-but-not-arrived — recipient agreed but hasn't clocked in
// Cancelled/declined/expired drop off the list since there's nothing for
// the requester to do at that point (they'll get a push instead).
router.get('/outbound-swap-requests', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT ssr.id           AS history_id,
            ssr.shift_id,
            ssr.requested_at,
            ssr.accepted_at,
            ssr.status,
            ssr.reason,
            ssr.initiated_by,
            ssr.to_session_id,
            ssr.to_guard_id,
            tg.name          AS to_guard_name,
            sh.scheduled_start,
            sh.scheduled_end,
            si.name          AS site_name,
            si.timezone      AS site_tz
       FROM shift_swap_requests ssr
       JOIN shifts sh ON sh.id = ssr.shift_id
       JOIN sites  si ON si.id = sh.site_id
       LEFT JOIN guards tg ON tg.id = ssr.to_guard_id
      WHERE ssr.from_guard_id = $1
        AND (
          ssr.status = 'pending'
          OR (
            ssr.status = 'accepted'
            AND ssr.initiated_by = 'guard_handoff'
            AND ssr.to_session_id IS NULL
          )
        )
      ORDER BY ssr.requested_at DESC
      LIMIT 50`,
    [req.user!.sub],
  );
  res.json(result.rows);
});

router.get('/:id/swap-eligible-guards', requireAuth('guard'), async (req, res) => {
  const { user } = req;
  // Phase 2b: `?context=handoff` applies the stricter eligibility filter
  // used by POST /:id/handoff-request — B must not have an open
  // shift_sessions row (i.e. not currently clocked in anywhere) and any
  // overlap check is against the *remaining* shift window (NOW → end),
  // not the full window (start → end). Default `context=swap` preserves
  // the Phase 1a pre-shift-swap behavior. Invalid values fall through to
  // the default rather than 400 so a mobile with an unknown context can't
  // break itself.
  const context: 'swap' | 'handoff' = req.query.context === 'handoff' ? 'handoff' : 'swap';

  const shiftRes = await pool.query<{
    id: string; guard_id: string | null; site_id: string; status: string;
    scheduled_start: string; scheduled_end: string; company_id: string;
  }>(
    `SELECT sh.id, sh.guard_id, sh.site_id, sh.status,
            sh.scheduled_start, sh.scheduled_end,
            si.company_id
       FROM shifts sh
       JOIN sites  si ON si.id = sh.site_id
      WHERE sh.id = $1`,
    [req.params.id],
  );
  if (!shiftRes.rows[0]) return res.status(404).json({ error: 'Shift not found' });
  const shift = shiftRes.rows[0];

  // Caller must be the shift's currently-assigned guard.
  if (shift.guard_id !== user!.sub) {
    return res.status(403).json({ error: 'You are not assigned to this shift.' });
  }
  // Handoff needs the shift to be active (guard already clocked in); swap
  // needs it scheduled (guard hasn't started). Enforce the right status.
  const requiredStatus = context === 'handoff' ? 'active' : 'scheduled';
  if (shift.status !== requiredStatus) {
    return res.status(409).json({
      error: context === 'handoff'
        ? `Handoff is only available for active shifts (current: ${shift.status}).`
        : `Swap is only available for scheduled shifts (current: ${shift.status}).`,
    });
  }

  const shiftDatePacific = pacificDateStr(shift.scheduled_start);
  // Overlap check varies by context:
  //   swap    — full shift window (start < shift.end AND end > shift.start)
  //   handoff — remaining window only (start < shift.end AND end > NOW),
  //             plus B must not have any open shift_session (already clocked in).
  const eligible = await pool.query(
    `SELECT g.id AS guard_id, g.name, g.badge_number,
       EXISTS (
         SELECT 1 FROM guard_site_assignments gsa
         WHERE gsa.guard_id = g.id
           AND gsa.site_id  = $1
           AND gsa.assigned_from <= $2::date
           AND (gsa.assigned_until IS NULL OR gsa.assigned_until >= $2::date)
       ) AS is_same_site
     FROM guards g
     WHERE g.is_active   = true
       AND g.company_id  = $3
       AND g.id         != $4
       AND ($8::text = 'swap' OR NOT EXISTS (
         SELECT 1 FROM shift_sessions ss
         WHERE ss.guard_id = g.id
           AND ss.clocked_out_at IS NULL
       ))
       AND NOT EXISTS (
         SELECT 1 FROM shifts osh
         WHERE osh.guard_id = g.id
           AND osh.status IN ('scheduled','active')
           AND osh.id != $5
           AND osh.scheduled_start < $6::timestamptz
           AND osh.scheduled_end   > CASE WHEN $8::text = 'handoff' THEN NOW() ELSE $7::timestamptz END
       )
     ORDER BY is_same_site DESC, g.name ASC`,
    [
      shift.site_id, shiftDatePacific,
      shift.company_id, shift.guard_id,
      shift.id,
      shift.scheduled_end, shift.scheduled_start,
      context,
    ],
  );
  res.json({ guards: eligible.rows });
});

router.post('/:id/swap-request', requireAuth('guard'), async (req, res) => {
  const { user } = req;
  const to_guard_id = typeof req.body?.to_guard_id === 'string' ? req.body.to_guard_id : '';
  const rawReason   = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!to_guard_id) return res.status(400).json({ error: 'to_guard_id is required' });
  if (rawReason.length > 200) {
    return res.status(400).json({ error: 'reason must be at most 200 characters' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftRes = await client.query<{
      id: string; guard_id: string | null; site_id: string; status: string;
      scheduled_start: string; scheduled_end: string;
      company_id: string; site_name: string; site_tz: string;
      from_guard_name: string;
    }>(
      `SELECT sh.id, sh.guard_id, sh.site_id, sh.status,
              sh.scheduled_start, sh.scheduled_end,
              si.company_id,
              si.name     AS site_name,
              si.timezone AS site_tz,
              g.name      AS from_guard_name
         FROM shifts sh
         JOIN sites  si ON si.id = sh.site_id
         JOIN guards g  ON g.id  = sh.guard_id
        WHERE sh.id = $1
        FOR UPDATE OF sh`,
      [req.params.id],
    );
    if (!shiftRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = shiftRes.rows[0];

    if (shift.guard_id !== user!.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not assigned to this shift.' });
    }
    if (shift.status !== 'scheduled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Swap is only available for scheduled shifts (current: ${shift.status}).` });
    }
    if (to_guard_id === shift.guard_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cannot request a swap with yourself.' });
    }

    // Verify B is eligible: same company, active, no overlap.
    const overlapRes = await client.query<{
      to_guard_id: string; name: string;
    }>(
      `SELECT g.id AS to_guard_id, g.name
         FROM guards g
        WHERE g.id = $1
          AND g.company_id = $2
          AND g.is_active = true
          AND NOT EXISTS (
            SELECT 1 FROM shifts osh
            WHERE osh.guard_id = g.id
              AND osh.status IN ('scheduled','active')
              AND osh.id != $3
              AND osh.scheduled_start < $4::timestamptz
              AND osh.scheduled_end   > $5::timestamptz
          )`,
      [to_guard_id, shift.company_id, shift.id, shift.scheduled_end, shift.scheduled_start],
    );
    if (!overlapRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Selected guard is not eligible (overlapping shift, inactive, or wrong company).' });
    }
    const toGuardName = overlapRes.rows[0].name;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO shift_swap_requests
         (shift_id, from_guard_id, to_guard_id, initiated_by, reason)
       VALUES ($1, $2, $3, 'guard_pre_shift', $4)
       RETURNING id`,
      [shift.id, shift.guard_id, to_guard_id, rawReason || null],
    );
    const historyId = inserted.rows[0].id;

    await client.query('COMMIT');

    res.status(201).json({ history_id: historyId, status: 'pending' });

    // Fire-and-forget pushes after response.
    pushSwapRequestToRecipient({
      toGuardId:      to_guard_id,
      fromGuardName:  shift.from_guard_name,
      siteName:       shift.site_name,
      siteTz:         shift.site_tz,
      scheduledStart: shift.scheduled_start,
      shiftId:        shift.id,
      historyId,
    }).catch((err) => console.error('[swap-request] push to recipient failed:', err));

    pushSwapRequestSentToRequester({
      fromGuardId: shift.guard_id!,
      toGuardName,
      siteName:    shift.site_name,
      shiftId:     shift.id,
      historyId,
    }).catch((err) => console.error('[swap-request] confirm push failed:', err));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[swap-request] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to create swap request' });
  } finally {
    client.release();
  }
});

router.post('/:id/swap-response', requireAuth('guard'), async (req, res) => {
  const { user } = req;
  const history_id = typeof req.body?.history_id === 'string' ? req.body.history_id : '';
  const accept     = typeof req.body?.accept === 'boolean' ? req.body.accept : null;
  if (!history_id) return res.status(400).json({ error: 'history_id is required' });
  if (accept === null) return res.status(400).json({ error: 'accept (boolean) is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the history row + parent shift together to serialise concurrent
    // responses and any admin reassign in flight.
    const histRes = await client.query<{
      id: string; shift_id: string;
      from_guard_id: string; to_guard_id: string;
      status: string;
    }>(
      `SELECT ssr.id, ssr.shift_id, ssr.from_guard_id, ssr.to_guard_id, ssr.status
         FROM shift_swap_requests ssr
        WHERE ssr.id = $1 AND ssr.shift_id = $2
        FOR UPDATE OF ssr`,
      [history_id, req.params.id],
    );
    if (!histRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Swap request not found' });
    }
    const hist = histRes.rows[0];

    if (hist.to_guard_id !== user!.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This swap request is not addressed to you.' });
    }
    if (hist.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Swap request is already ${hist.status}.` });
    }

    const shiftRes = await client.query<{
      id: string; guard_id: string | null; site_id: string; status: string;
      scheduled_start: string; scheduled_end: string;
      site_name: string; site_tz: string;
      from_guard_name: string; to_guard_name: string;
    }>(
      `SELECT sh.id, sh.guard_id, sh.site_id, sh.status,
              sh.scheduled_start, sh.scheduled_end,
              si.name     AS site_name,
              si.timezone AS site_tz,
              fg.name     AS from_guard_name,
              tg.name     AS to_guard_name
         FROM shifts sh
         JOIN sites  si ON si.id = sh.site_id
         JOIN guards fg ON fg.id = $2
         JOIN guards tg ON tg.id = $3
        WHERE sh.id = $1
        FOR UPDATE OF sh`,
      [hist.shift_id, hist.from_guard_id, hist.to_guard_id],
    );
    if (!shiftRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = shiftRes.rows[0];

    // Decline path — no side effects on the shift itself.
    if (!accept) {
      await client.query(
        `UPDATE shift_swap_requests
            SET status = 'declined', declined_at = NOW()
          WHERE id = $1`,
        [hist.id],
      );
      await client.query('COMMIT');
      res.json({ history_id: hist.id, status: 'declined' });

      pushSwapDeclinedToRequester({
        fromGuardId: hist.from_guard_id,
        toGuardName: shift.to_guard_name,
        shiftId:     shift.id,
        historyId:   hist.id,
      }).catch((err) => console.error('[swap-response] decline push failed:', err));
      return;
    }

    // Accept path — re-verify preconditions inside the txn.
    if (shift.status !== 'scheduled') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Shift is no longer scheduled (current: ${shift.status}).` });
    }
    if (shift.guard_id !== hist.from_guard_id) {
      // Someone else (admin reassign) moved the shift underneath us.
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Shift has been reassigned by an admin; swap is stale.' });
    }
    // Re-check overlap for B — a shift may have landed on them since the
    // invitation was sent.
    const overlap = await client.query(
      `SELECT 1 FROM shifts osh
        WHERE osh.guard_id = $1
          AND osh.status IN ('scheduled','active')
          AND osh.id != $2
          AND osh.scheduled_start < $3::timestamptz
          AND osh.scheduled_end   > $4::timestamptz
        LIMIT 1`,
      [hist.to_guard_id, shift.id, shift.scheduled_end, shift.scheduled_start],
    );
    if (overlap.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You now have an overlapping shift; swap is no longer possible.' });
    }

    await client.query(
      `UPDATE shifts
          SET guard_id = $1
        WHERE id = $2`,
      [hist.to_guard_id, shift.id],
    );
    await client.query(
      `UPDATE shift_swap_requests
          SET status = 'accepted',
              accepted_at = NOW(),
              admin_notified_at = NOW()
        WHERE id = $1`,
      [hist.id],
    );

    await client.query('COMMIT');

    res.json({ history_id: hist.id, status: 'accepted' });

    // Fire-and-forget: admin FYI email + push to requester A.
    // Admin FCM push is intentionally skipped this session — company_admins
    // has no fcm_token column (audit surface memory). Email is the only
    // admin channel we can commit to today.
    sendSwapAcceptedFyi(hist.id).catch((err) =>
      console.error('[swap-response] admin FYI email failed:', err),
    );
    pushSwapAcceptedToRequester({
      fromGuardId: hist.from_guard_id,
      toGuardName: shift.to_guard_name,
      shiftId:     shift.id,
      historyId:   hist.id,
    }).catch((err) => console.error('[swap-response] accept push failed:', err));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[swap-response] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to respond to swap request' });
  } finally {
    client.release();
  }
});

// ── Phase 2: mid-shift handoff ─────────────────────────────────────────────
//
// Four endpoints, one lifecycle:
//
//   handoff-request   A is clocked in and wants B to take over.
//   handoff-response  B accepts (A stays on-post) or declines.
//   handoff-clock-in  B arrives physically — rotates the session + the
//                     shift's guard_id atomically. A becomes clocked out
//                     with clock_out_reason='handed_off_to_<b_id>'.
//   handoff-cancel    Either party bails after accept but before B arrives.
//
// Payroll safety: monthlyHoursReport and exports read
// FROM shift_sessions ss JOIN guards g ON g.id = ss.guard_id — so A's
// closed session (his guard_id) and B's open session (her guard_id) sum
// independently. No adjustment needed downstream.

router.post('/:id/handoff-request', requireAuth('guard'), async (req, res) => {
  const { user } = req;
  const to_guard_id = typeof req.body?.to_guard_id === 'string' ? req.body.to_guard_id : '';
  const rawReason   = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (!to_guard_id) return res.status(400).json({ error: 'to_guard_id is required' });
  if (rawReason.length > 200) {
    return res.status(400).json({ error: 'reason must be at most 200 characters' });
  }
  if (to_guard_id === user!.sub) {
    return res.status(400).json({ error: 'Cannot hand off to yourself.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const shiftRes = await client.query<{
      id: string; guard_id: string | null; site_id: string; status: string;
      scheduled_start: string; scheduled_end: string;
      company_id: string; site_name: string; site_tz: string;
      from_guard_name: string;
      from_session_id: string | null;
    }>(
      `SELECT sh.id, sh.guard_id, sh.site_id, sh.status,
              sh.scheduled_start, sh.scheduled_end,
              si.company_id,
              si.name     AS site_name,
              si.timezone AS site_tz,
              g.name      AS from_guard_name,
              (SELECT ss.id FROM shift_sessions ss
                 WHERE ss.shift_id = sh.id
                   AND ss.guard_id = sh.guard_id
                   AND ss.clocked_out_at IS NULL
                 LIMIT 1) AS from_session_id
         FROM shifts sh
         JOIN sites  si ON si.id = sh.site_id
         JOIN guards g  ON g.id  = sh.guard_id
        WHERE sh.id = $1
        FOR UPDATE OF sh`,
      [req.params.id],
    );
    if (!shiftRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = shiftRes.rows[0];

    if (shift.guard_id !== user!.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not assigned to this shift.' });
    }
    if (shift.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Handoff is only available for active shifts (current: ${shift.status}).` });
    }
    if (!shift.from_session_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'No open session for this shift — cannot hand off.' });
    }

    // Reject if there's already a pending handoff for this shift — no
    // second-request until the first resolves. Prevents A from spamming
    // the whole company.
    const pending = await client.query(
      `SELECT 1 FROM shift_swap_requests
        WHERE shift_id = $1
          AND initiated_by = 'guard_handoff'
          AND status IN ('pending','accepted')
          AND to_session_id IS NULL
        LIMIT 1`,
      [shift.id],
    );
    if (pending.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A handoff for this shift is already in progress.' });
    }

    // B eligibility: same company, active, no open session, no overlap with
    // the remaining shift window. Overlap is checked from NOW forward so
    // B's just-finished morning shift doesn't disqualify them.
    const overlapRes = await client.query<{ to_guard_id: string; name: string }>(
      `SELECT g.id AS to_guard_id, g.name
         FROM guards g
        WHERE g.id = $1
          AND g.company_id = $2
          AND g.is_active = true
          AND NOT EXISTS (
            SELECT 1 FROM shift_sessions ss
             WHERE ss.guard_id = g.id
               AND ss.clocked_out_at IS NULL
          )
          AND NOT EXISTS (
            SELECT 1 FROM shifts osh
             WHERE osh.guard_id = g.id
               AND osh.status IN ('scheduled','active')
               AND osh.id != $3
               AND osh.scheduled_start < $4::timestamptz
               AND osh.scheduled_end   > NOW()
          )`,
      [to_guard_id, shift.company_id, shift.id, shift.scheduled_end],
    );
    if (!overlapRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Selected guard is not eligible (already clocked in, has an overlapping shift, inactive, or wrong company).' });
    }
    const toGuardName = overlapRes.rows[0].name;

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO shift_swap_requests
         (shift_id, from_guard_id, to_guard_id, initiated_by, reason, from_session_id)
       VALUES ($1, $2, $3, 'guard_handoff', $4, $5)
       RETURNING id`,
      [shift.id, shift.guard_id, to_guard_id, rawReason || null, shift.from_session_id],
    );
    const historyId = inserted.rows[0].id;

    await client.query('COMMIT');

    res.status(201).json({ history_id: historyId, status: 'pending' });

    pushHandoffRequestToRecipient({
      toGuardId:      to_guard_id,
      fromGuardName:  shift.from_guard_name,
      siteName:       shift.site_name,
      siteTz:         shift.site_tz,
      scheduledEnd:   shift.scheduled_end,
      shiftId:        shift.id,
      historyId,
    }).catch((err) => console.error('[handoff-request] push to recipient failed:', err));

    pushHandoffRequestSentToRequester({
      fromGuardId: shift.guard_id!,
      toGuardName,
      siteName:    shift.site_name,
      shiftId:     shift.id,
      historyId,
    }).catch((err) => console.error('[handoff-request] confirm push failed:', err));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[handoff-request] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to create handoff request' });
  } finally {
    client.release();
  }
});

router.post('/:id/handoff-response', requireAuth('guard'), async (req, res) => {
  const { user } = req;
  const history_id = typeof req.body?.history_id === 'string' ? req.body.history_id : '';
  const accept     = typeof req.body?.accept === 'boolean' ? req.body.accept : null;
  if (!history_id) return res.status(400).json({ error: 'history_id is required' });
  if (accept === null) return res.status(400).json({ error: 'accept (boolean) is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const histRes = await client.query<{
      id: string; shift_id: string;
      from_guard_id: string; to_guard_id: string;
      status: string; initiated_by: string;
    }>(
      `SELECT ssr.id, ssr.shift_id, ssr.from_guard_id, ssr.to_guard_id,
              ssr.status, ssr.initiated_by
         FROM shift_swap_requests ssr
        WHERE ssr.id = $1 AND ssr.shift_id = $2
        FOR UPDATE OF ssr`,
      [history_id, req.params.id],
    );
    if (!histRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Handoff request not found' });
    }
    const hist = histRes.rows[0];

    if (hist.initiated_by !== 'guard_handoff') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This is not a handoff request — use /swap-response.' });
    }
    if (hist.to_guard_id !== user!.sub) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'This handoff is not addressed to you.' });
    }
    if (hist.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Handoff is already ${hist.status}.` });
    }

    const shiftRes = await client.query<{
      id: string; guard_id: string | null; status: string;
      scheduled_end: string;
      to_guard_name: string;
    }>(
      `SELECT sh.id, sh.guard_id, sh.status, sh.scheduled_end,
              tg.name AS to_guard_name
         FROM shifts sh
         JOIN guards tg ON tg.id = $2
        WHERE sh.id = $1
        FOR UPDATE OF sh`,
      [hist.shift_id, hist.to_guard_id],
    );
    if (!shiftRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Shift not found' });
    }
    const shift = shiftRes.rows[0];

    // Decline path first — no side effects on the shift.
    if (!accept) {
      await client.query(
        `UPDATE shift_swap_requests
            SET status = 'declined', declined_at = NOW()
          WHERE id = $1`,
        [hist.id],
      );
      await client.query('COMMIT');
      res.json({ history_id: hist.id, status: 'declined' });
      pushHandoffDeclinedToRequester({
        fromGuardId: hist.from_guard_id,
        toGuardName: shift.to_guard_name,
        shiftId:     shift.id,
        historyId:   hist.id,
      }).catch((err) => console.error('[handoff-response] decline push failed:', err));
      return;
    }

    // Accept path — re-verify preconditions.
    if (shift.status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Shift is no longer active (current: ${shift.status}).` });
    }
    if (shift.guard_id !== hist.from_guard_id) {
      // Admin reassign got there first.
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Shift has been reassigned by an admin; handoff is stale.' });
    }
    // Re-check B: still not clocked in elsewhere.
    const busy = await client.query(
      `SELECT 1 FROM shift_sessions
        WHERE guard_id = $1 AND clocked_out_at IS NULL LIMIT 1`,
      [hist.to_guard_id],
    );
    if (busy.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'You are already clocked in to another shift.' });
    }

    await client.query(
      `UPDATE shift_swap_requests
          SET status = 'accepted',
              accepted_at = NOW(),
              admin_notified_at = NOW()
        WHERE id = $1`,
      [hist.id],
    );

    await client.query('COMMIT');

    res.json({ history_id: hist.id, status: 'accepted' });

    sendHandoffAcceptedFyi(hist.id).catch((err) =>
      console.error('[handoff-response] admin FYI email failed:', err),
    );
    pushHandoffAcceptedToRequester({
      fromGuardId: hist.from_guard_id,
      toGuardName: shift.to_guard_name,
      shiftId:     shift.id,
      historyId:   hist.id,
    }).catch((err) => console.error('[handoff-response] accept push failed:', err));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[handoff-response] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to respond to handoff' });
  } finally {
    client.release();
  }
});

// Mirror of /clock-in but for the accepted-handoff recipient. Preconditions:
//   * caller has an accepted-but-not-arrived handoff for this shift
//   * caller isn't already clocked in elsewhere
//   * caller is inside the site geofence
// Txn:
//   1. Close A's open session (clock_out_reason='handed_off_to_<b>')
//   2. Insert new session for B
//   3. UPDATE shifts.guard_id = B
//   4. UPDATE shift_swap_requests.to_session_id = new session id
router.post('/:id/handoff-clock-in', requireAuth('guard'), idempotent('handoff-clock-in'), async (req, res) => {
  const { user } = req;
  const { id } = req.params;
  const { clock_in_coords, lat, lng, accuracy } = req.body as {
    clock_in_coords?: string;
    lat?: number;
    lng?: number;
    accuracy?: number;
  };
  if (typeof lat !== 'number' || typeof lng !== 'number' || typeof accuracy !== 'number') {
    return res.status(400).json({ error: 'Missing lat/lng/accuracy. Update the app to the latest version.' });
  }
  const coords = clock_in_coords ?? `(${lat},${lng})`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Load + lock the shift and the caller's accepted handoff row together.
    const histRes = await client.query<{
      history_id: string; from_guard_id: string;
      shift_id: string; site_id: string; site_name: string;
      guard_id: string | null; shift_status: string;
      from_session_id: string | null;
    }>(
      `SELECT ssr.id           AS history_id,
              ssr.from_guard_id,
              ssr.from_session_id,
              sh.id             AS shift_id,
              sh.site_id,
              sh.guard_id,
              sh.status         AS shift_status,
              si.name           AS site_name
         FROM shift_swap_requests ssr
         JOIN shifts sh ON sh.id = ssr.shift_id
         JOIN sites  si ON si.id = sh.site_id
        WHERE ssr.shift_id      = $1
          AND ssr.to_guard_id   = $2
          AND ssr.initiated_by  = 'guard_handoff'
          AND ssr.status        = 'accepted'
          AND ssr.to_session_id IS NULL
        FOR UPDATE OF ssr, sh`,
      [id, user!.sub],
    );
    if (!histRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'No accepted handoff pending clock-in for this shift.' });
    }
    const hist = histRes.rows[0];

    if (hist.shift_status !== 'active') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Shift is no longer active (current: ${hist.shift_status}).` });
    }
    if (hist.guard_id !== hist.from_guard_id) {
      // Admin reassign in-between.
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Shift has been reassigned by an admin; handoff is stale.' });
    }

    // Geofence — same helper as regular clock-in.
    const fence = await validateAtSite(
      { lat, lng, accuracy_m: accuracy },
      hist.site_id,
      client,
    );
    if (!fence.allowed) {
      await client.query('ROLLBACK');
      console.log(
        `handoff-clock-in.geofence.reject site=${hist.site_id} guard=${user!.sub} shift=${id} ` +
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

    // Close A's session with total_hours = (NOW − MAX(clocked_in_at, scheduled_start))
    //                                       − sum(break_sessions.duration_minutes).
    // Matches the manual clock-out math in this file (option C: early
    // arrivals not paid, late stays paid).
    if (!hist.from_session_id) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Original session id missing — cannot close.' });
    }
    // Close any open break on A's session so break-minutes math is consistent.
    await client.query(
      `UPDATE break_sessions
          SET break_end = NOW(),
              duration_minutes = GREATEST(0, ROUND(EXTRACT(EPOCH FROM (NOW() - break_start)) / 60.0)::INT)
        WHERE break_end IS NULL
          AND shift_session_id = $1`,
      [hist.from_session_id],
    );
    const closed = await client.query<{ id: string; total_hours: number | null }>(
      // Walk-test 2026-07-09 mosser towers: reddy clocked in 03:12Z, shift
      // scheduled_start 03:20Z. James's handoff-clock-in fired ~03:19Z —
      // BEFORE scheduled_start. NOW - MAX(clocked_in, scheduled_start) went
      // negative, ROUND yielded -0.02h, chk_total_hours_nonneg rejected the
      // UPDATE. Clamp with GREATEST(0, …) to match the manual clock-out and
      // autoCompleteShifts patterns; option-C accounting still holds because
      // pay only starts at scheduled_start regardless.
      `UPDATE shift_sessions ss
          SET clocked_out_at = NOW(),
              clock_out_reason = $2,
              total_hours = GREATEST(0, ROUND((
                EXTRACT(EPOCH FROM (NOW() - GREATEST(ss.clocked_in_at, (
                  SELECT sh.scheduled_start FROM shifts sh WHERE sh.id = ss.shift_id
                )))) / 3600.0
                - COALESCE((
                    SELECT SUM(bs.duration_minutes) / 60.0
                      FROM break_sessions bs WHERE bs.shift_session_id = ss.id
                  ), 0)
              )::NUMERIC, 2))
        WHERE ss.id = $1
        RETURNING ss.id, ss.total_hours`,
      [hist.from_session_id, `handed_off_to_${user!.sub}`],
    );
    if (!closed.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'Failed to close prior session.' });
    }

    // Insert B's session.
    let newSession;
    try {
      const inserted = await client.query(
        `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords, expires_at)
         VALUES ($1, $2, $3, NOW(), $4, $5) RETURNING *`,
        [id, user!.sub, hist.site_id, coords, expiresAtFor('shift_session')],
      );
      newSession = inserted.rows[0];
    } catch (err: any) {
      if (err?.code === '23505' && err?.constraint === 'idx_shift_sessions_one_open_per_guard') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Already clocked in on another device. Clock out first.' });
      }
      throw err;
    }

    // Rotate the shift's guard_id + fill the swap row's to_session_id.
    await client.query('UPDATE shifts SET guard_id = $1 WHERE id = $2', [user!.sub, id]);
    await client.query(
      `UPDATE shift_swap_requests SET to_session_id = $1 WHERE id = $2`,
      [newSession.id, hist.history_id],
    );

    // Walk-test 2026-07-09 BUG I: auto-resolve any lingering open geofence
    // violations on the outgoing guard's session — same pattern as
    // /clock-out. Symmetric because handoff-clock-in IS a clock-out for A.
    await client.query(
      `UPDATE geofence_violations
          SET resolved_at = NOW(),
              duration_minutes = ROUND(EXTRACT(EPOCH FROM (NOW() - occurred_at)) / 60)::INT
        WHERE shift_session_id = $1
          AND resolved_at IS NULL`,
      [hist.from_session_id],
    );

    await client.query('COMMIT');

    res.status(201).json(newSession);

    // Fire-and-forget after commit.
    sendHandoffCompletedFyi(hist.history_id).catch((err) =>
      console.error('[handoff-clock-in] admin FYI email failed:', err),
    );
    pushHandoffCompleteToRequester({
      fromGuardId: hist.from_guard_id,
      toGuardName: '', // From guard's perspective; blank keeps copy generic
      shiftId:     id,
      historyId:   hist.history_id,
    }).catch((err) => console.error('[handoff-clock-in] complete push failed:', err));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[handoff-clock-in] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to complete handoff clock-in' });
  } finally {
    client.release();
  }
});

// Either party can cancel an accepted-but-not-arrived handoff. After
// cancel: A stays on shift, no session changes.
router.post('/:id/handoff-cancel', requireAuth('guard'), async (req, res) => {
  const { user } = req;
  const history_id = typeof req.body?.history_id === 'string' ? req.body.history_id : '';
  if (!history_id) return res.status(400).json({ error: 'history_id is required' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const histRes = await client.query<{
      id: string; shift_id: string;
      from_guard_id: string; to_guard_id: string;
      status: string; initiated_by: string;
      to_session_id: string | null;
      site_name: string; from_guard_name: string; to_guard_name: string;
    }>(
      `SELECT ssr.id, ssr.shift_id, ssr.from_guard_id, ssr.to_guard_id,
              ssr.status, ssr.initiated_by, ssr.to_session_id,
              si.name    AS site_name,
              fg.name    AS from_guard_name,
              tg.name    AS to_guard_name
         FROM shift_swap_requests ssr
         JOIN shifts sh ON sh.id = ssr.shift_id
         JOIN sites  si ON si.id = sh.site_id
         JOIN guards fg ON fg.id = ssr.from_guard_id
         JOIN guards tg ON tg.id = ssr.to_guard_id
        WHERE ssr.id = $1 AND ssr.shift_id = $2
        FOR UPDATE OF ssr`,
      [history_id, req.params.id],
    );
    if (!histRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Handoff request not found' });
    }
    const hist = histRes.rows[0];

    if (hist.initiated_by !== 'guard_handoff') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This is not a handoff request.' });
    }
    if (user!.sub !== hist.from_guard_id && user!.sub !== hist.to_guard_id) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You are not part of this handoff.' });
    }
    if (hist.status !== 'accepted' || hist.to_session_id !== null) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `Only pre-arrival accepted handoffs can be cancelled (current: ${hist.status}${hist.to_session_id ? ', arrived' : ''}).` });
    }

    await client.query(
      `UPDATE shift_swap_requests
          SET status = 'cancelled', declined_at = NOW()
        WHERE id = $1`,
      [hist.id],
    );

    await client.query('COMMIT');
    res.json({ history_id: hist.id, status: 'cancelled' });

    const cancellerIsFrom = user!.sub === hist.from_guard_id;
    const otherPartyId    = cancellerIsFrom ? hist.to_guard_id : hist.from_guard_id;
    const cancellerName   = cancellerIsFrom ? hist.from_guard_name : hist.to_guard_name;

    pushHandoffCancelled({
      toGuardId:     otherPartyId,
      cancellerName,
      siteName:      hist.site_name,
      shiftId:       hist.shift_id,
      historyId:     hist.id,
    }).catch((err) => console.error('[handoff-cancel] push failed:', err));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[handoff-cancel] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to cancel handoff' });
  } finally {
    client.release();
  }
});

// GET /api/shifts  — guard sees their shifts; company_admin sees their
// company's; vishnu sees every company's (company_name is joined so the
// admin UI can label cross-company rows).
router.get('/', requireAuth('guard', 'company_admin', 'vishnu'), async (req, res) => {
  const { user } = req;
  let result;
  if (user!.role === 'guard') {
    // total_hours_worked: sum of completed shift_sessions.total_hours for this
    // shift, plus live elapsed since clocked_in_at for any still-open session.
    // Replaces the mobile profile's old (scheduled_end - scheduled_start)
    // calculation, which credited no-show shifts with the full scheduled time.
    result = await pool.query(
      `SELECT s.*, si.name as site_name, si.is_active AS site_is_active, si.instructions_pdf_url,
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
    // Company-admin path + vishnu (all-companies) bypass.
    const isVishnu = user!.role === 'vishnu';
    result = await pool.query(
      `SELECT s.*, si.name as site_name, si.is_active AS site_is_active,
              si.instructions_pdf_url, g.name as guard_name,
              co.name AS company_name,
              COALESCE(si.photo_limit_override, co.default_photo_limit, 5) AS effective_photo_limit
       FROM shifts s
       JOIN sites si ON s.site_id = si.id
       JOIN companies co ON co.id = si.company_id
       LEFT JOIN guards g ON s.guard_id = g.id
       ${isVishnu ? '' : 'WHERE si.company_id = $1'}
       ORDER BY s.scheduled_start DESC LIMIT 100`,
      isVishnu ? [] : [user!.company_id]
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
            ss.id as session_id, ss.clocked_in_at,
            sg.polygon_coordinates, sg.center_lat, sg.center_lng, sg.radius_meters
     FROM shifts s
     JOIN sites si ON si.id = s.site_id
     JOIN companies co ON co.id = si.company_id
     JOIN shift_sessions ss ON ss.shift_id = s.id AND ss.guard_id = $1 AND ss.clocked_out_at IS NULL
     LEFT JOIN site_geofence sg ON sg.site_id = s.site_id
     WHERE s.guard_id = $1 AND s.status = 'active'
       AND s.scheduled_end > NOW() - INTERVAL '2 hours'
     ORDER BY ss.clocked_in_at DESC LIMIT 1`,
    [req.user!.sub]
  );
  if (!result.rows[0]) return res.json(null);
  const r = result.rows[0];
  const effectivePhotoLimit = r.photo_limit_override ?? r.default_photo_limit ?? 5;
  const geofence = r.center_lat !== null
    ? {
        polygon_coordinates: r.polygon_coordinates,
        center_lat:          r.center_lat,
        center_lng:          r.center_lng,
        radius_meters:       r.radius_meters,
      }
    : null;
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
      geofence,
    },
    session: { id: r.session_id, shift_id: r.shift_id, clocked_in_at: r.clocked_in_at },
  });
});

// GET /api/shifts/:id — shift detail with joined site/guard + reassign/swap history.
// Serves both the admin shift detail page (apps/web/app/admin/shifts/[shiftId])
// and the guard mobile shift detail screen (apps/mobile/app/shifts/[id]).
// Tenancy rules:
//   - company_admin: only their company's shifts.
//   - vishnu: any shift.
//   - guard: only shifts assigned to themselves.
//
// Placed AFTER /active-session because Express matches routes in declaration
// order: a /:id catch-all defined earlier would shadow the literal /active-session.
router.get('/:id', requireAuth('company_admin', 'vishnu', 'guard'), async (req, res) => {
  const { user } = req;
  const shiftResult = await pool.query(
    `SELECT sh.id, sh.guard_id, sh.site_id, sh.scheduled_start, sh.scheduled_end,
            sh.status, sh.missed_alert_sent_at, sh.created_at,
            si.name AS site_name, si.is_active AS site_is_active,
            si.address AS site_address, si.timezone AS site_tz, si.company_id,
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
  // Guard tenancy: can view either their own shift OR a shift they've
  // accepted a handoff for but haven't clocked in on yet — so the mobile
  // "pending handoff" screen can hydrate before the clock-in txn. 404 on
  // cross-guard so we don't leak which shift ids exist.
  if (user!.role === 'guard' && shift.guard_id !== user!.sub) {
    const pendingArrival = await pool.query(
      `SELECT 1 FROM shift_swap_requests
        WHERE shift_id      = $1
          AND to_guard_id   = $2
          AND initiated_by  = 'guard_handoff'
          AND status        = 'accepted'
          AND to_session_id IS NULL
        LIMIT 1`,
      [req.params.id, user!.sub],
    );
    if (!pendingArrival.rows[0]) {
      return res.status(404).json({ error: 'Shift not found' });
    }
  }

  const [historyResult, swapResult, geofenceResult] = await Promise.all([
    pool.query(
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
    ),
    // Phase 1c — guard-initiated swap history alongside admin-reassign
    // history. Web renders both merged with a source badge.
    pool.query(
      `SELECT ssr.id, ssr.requested_at, ssr.accepted_at, ssr.declined_at,
              ssr.status, ssr.initiated_by, ssr.reason,
              ssr.from_guard_id, fg.name AS from_guard_name,
              ssr.to_guard_id,   tg.name AS to_guard_name
         FROM shift_swap_requests ssr
         LEFT JOIN guards fg ON fg.id = ssr.from_guard_id
         LEFT JOIN guards tg ON tg.id = ssr.to_guard_id
        WHERE ssr.shift_id = $1
        ORDER BY ssr.requested_at DESC`,
      [req.params.id],
    ),
    // Walk-test bug #1: mobile clock-in step 1 used to silently allow
    // clock-in when pendingShift.geofence was missing. Fix requires the
    // mobile app to hydrate geofence before entering the wizard; this is
    // where it comes from. Same shape as validateAtSite in geofence.ts.
    // Legacy sites without a geofence row → geofence: null (mobile treats
    // as "no boundary configured" and refuses to advance).
    pool.query(
      `SELECT polygon_coordinates, center_lat, center_lng, radius_meters
         FROM site_geofence WHERE site_id = $1`,
      [shift.site_id],
    ),
  ]);

  const fence = geofenceResult.rows[0] ?? null;
  const geofence = fence
    ? {
        polygon_coordinates: fence.polygon_coordinates,
        center_lat:          fence.center_lat,
        center_lng:          fence.center_lng,
        radius_meters:       fence.radius_meters,
      }
    : null;

  res.json({
    ...shift,
    geofence,
    reassignment_history: historyResult.rows,
    swap_history:         swapResult.rows,
  });
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
      `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords, expires_at)
       VALUES ($1, $2, $3, NOW(), $4, $5) RETURNING *`,
      [id, req.user!.sub, shift.site_id, coords, expiresAtFor('shift_session')]
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

    // Walk-test 2026-07-09 BUG I: auto-resolve any lingering open geofence
    // violations for this session so the alerts feed doesn't keep flashing
    // them after the shift ends. Uses clocked_out_at (the session's actual
    // end) as the resolution timestamp for semantic accuracy.
    await client.query(
      `UPDATE geofence_violations
          SET resolved_at = ss.clocked_out_at,
              duration_minutes = ROUND(EXTRACT(EPOCH FROM (ss.clocked_out_at - occurred_at)) / 60)::INT
         FROM shift_sessions ss
        WHERE geofence_violations.shift_session_id = ss.id
          AND ss.id = $1
          AND geofence_violations.resolved_at IS NULL`,
      [session.id],
    );

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
