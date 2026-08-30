/**
 * Canonical 4-field shift hours service.
 *
 * A single source of truth for how per-shift hours are computed across
 * every read surface (mobile profile, admin dashboard, client portal,
 * billing XLSX, emails, PDFs). Replaces the four divergent formulas
 * cataloged in the 2026-07-17 audit.
 *
 * That claim lapsed and was restored on 2026-08-25. Between them, routes/
 * admin.ts and routes/shifts.ts had accumulated SEVEN hand-inlined copies
 * of the break/violation arithmetic — so the 2026-08-24 fix to this file
 * would have left the billing export reporting 0.00 h off-post on a shift
 * the admin dashboard, the mobile profile and the shift-detail page were
 * all still reporting at 441 h. Every copy now calls in here.
 *
 * Two fragment shapes are exported, because call sites come in two shapes:
 *   SHIFT_HOURS_SQL_FIELDS      — PER SESSION. One row in, one row out;
 *                                 break/violation via correlated subquery.
 *   SHIFT_HOURS_AGG_SQL_FIELDS  — AGGREGATE. Wraps the same expressions in
 *                                 SUM() for a GROUP BY over sessions
 *                                 (per shift, per site, per guard, per month).
 * Both are built from BREAK_HOURS_ROW_SQL / VIOLATION_HOURS_ROW_SQL, which
 * are the actual definition and are exported for call sites whose join runs
 * the other way (see routes/admin.ts dashboard-sites, where the event table
 * drives and the session is joined in).
 *
 * Contract (per Phase 1 lock-in, D1/D5/D6):
 *   scheduled_hours = shifts.scheduled_end − shifts.scheduled_start
 *   actual_hours    = COALESCE(clocked_out_at, NOW()) − clocked_in_at  (raw, no truncation)
 *   break_hours     = Σ max(0, min(break_end,   NOW(), clocked_out_at) − max(break_start,  clocked_in_at))
 *   violation_hours = Σ over violations of Σ over the ping windows the
 *                     violation spans that received NO ping (judged on
 *                     lp.pinged_at, never window_label), each window
 *                     clamped to the violation and to the session.
 *                     CHANGED 2026-08-30 — it used to be
 *                     min(resolved_at, clocked_out_at) − max(occurred_at, clocked_in_at),
 *                     which measured time-until-the-next-accepted-ping
 *                     rather than time presence went unconfirmed. See
 *                     VIOLATION_HOURS_ROW_SQL for the full reasoning.
 *
 * All values are non-negative decimal hours rounded to 2 places.
 *
 * `actual_hours` uses RAW clocked_in_at per Vishnu's decision (matches the
 * mobile shift timer and the current client PDF). This diverges from the
 * stored shift_sessions.total_hours column, which truncates to
 * MAX(clocked_in, scheduled_start). Existing writers of that column stay
 * in place for rollback safety; new read paths ignore it.
 *
 * Live sessions (clocked_out_at IS NULL) and live intervals inside them
 * (open break_sessions, unresolved geofence_violations) are extended to
 * NOW() so that in-flight shifts show a running total across all four
 * fields — no partial states.
 *
 * break_hours and violation_hours are additionally BOUNDED TO THE SESSION
 * WINDOW and clamped PER ROW (2026-08-25). An unresolved geofence_violations
 * row on a session that has already closed used to accrue against wall-clock
 * forever: one orphan (0633b82b, written 28 min after an auto-close-at-plan)
 * reported 405 h of off-post on a 3.09 h shift in the billing export, and
 * grew by an hour every hour — so two exports of the same closed period
 * never agreed. Bounding the end to clocked_out_at makes a closed session's
 * numbers immutable; bounding the start to clocked_in_at drops intervals
 * lying entirely outside the session.
 *
 * The GREATEST(0, …) sits INSIDE SUM, not around it. A row whose resolved_at
 * was back-stamped to clocked_out_at can precede its own occurred_at (two
 * such rows exist in prod, e.g. ffce3372 at −0.01 h); clamping per row makes
 * it contribute 0 instead of eating a sibling row's hours. actual_hours
 * already had this clamp — these two did not, which is why a negative
 * reached the spreadsheet.
 */

import { pool } from '../db/pool';
import { PING_WINDOW_MS } from './pingWindows';

export interface ShiftHours {
  scheduled_hours: number;
  actual_hours:    number;
  break_hours:     number;
  violation_hours: number;
}

export function emptyShiftHours(): ShiftHours {
  return { scheduled_hours: 0, actual_hours: 0, break_hours: 0, violation_hours: 0 };
}

/**
 * "5.80" → "5h 48m". Small helper for surfaces (emails, PDFs) that
 * prefer HH:MM over decimal. Negative or NaN → "—".
 *
 * Kept in sync with the web-side formatHoursHHMM in
 * apps/web/lib/formatHours.ts. Change both together or the same shift
 * row will read differently in two places.
 */
export function formatHoursHHMM(hours: number | string | null | undefined): string {
  const n = typeof hours === 'string' ? parseFloat(hours) : hours;
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '0h 00m';
  const totalMinutes = Math.round(n * 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

/**
 * violation_hours: 0 → "None" so a clean shift doesn't read as a defect.
 */
export function formatOffPostHours(hours: number | string | null | undefined): string {
  const n = typeof hours === 'string' ? parseFloat(hours) : hours;
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return 'None';
  return formatHoursHHMM(n);
}

/**
 * scheduled_hours defensive: zero should never occur legitimately, so
 * render "—" as a "data error / not applicable" signal. D2 update.
 */
export function formatScheduledHours(hours: number | string | null | undefined): string {
  const n = typeof hours === 'string' ? parseFloat(hours) : hours;
  if (n == null || !Number.isFinite(n) || n === 0 || n < 0) return '—';
  return formatHoursHHMM(n);
}

/**
 * Round to 2 decimals in the same shape Postgres ROUND(NUMERIC, 2) does,
 * so JS-computed and DB-computed values agree bit-for-bit in tests.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * SQL fragment: four correlated expressions that produce the 4 hours
 * fields. Intended for embedding in existing SELECT lists next to the
 * session/shift columns they annotate.
 *
 *   const q = `SELECT ss.id, ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')} FROM shift_sessions ss JOIN shifts sh …`
 *
 * Fixed columns: expects `${sessionAlias}.clocked_in_at`,
 * `.clocked_out_at`, `.id`; `${shiftAlias}.scheduled_start`,
 * `.scheduled_end`. Aliases must be trusted identifiers (never user input).
 *
 * NULL-safe for shifts with no session (all four fields become 0 via
 * COALESCE at the caller's LATERAL/LEFT-JOIN boundary, not inside this
 * fragment).
 */
/**
 * THE definition of a bounded, clamped sub-interval of a shift session.
 * Everything else in this file, and every aggregate call site, is built on
 * these three functions — a route needing a different SQL shape parameterises
 * the aliases instead of re-typing the arithmetic.
 *
 * `endExpr` must arrive already NULL-safe (callers wrap the open end in
 * COALESCE(..., NOW())). Postgres LEAST/GREATEST SKIP nulls rather than
 * propagating them, so a NULL reaching here would silently widen the bound
 * instead of narrowing it — the one failure mode that would look like the
 * original bug returning.
 */
function boundedIntervalHours(startExpr: string, endExpr: string, sessionAlias: string): string {
  return `GREATEST(0, EXTRACT(EPOCH FROM (
             LEAST(${endExpr}, COALESCE(${sessionAlias}.clocked_out_at, NOW()))
           - GREATEST(${startExpr}, ${sessionAlias}.clocked_in_at)
         ))) / 3600.0`;
}

/**
 * One break_sessions row's contribution, bounded to its session and clamped.
 * Aliases must be trusted identifiers (never user input).
 */
export function BREAK_HOURS_ROW_SQL(breakAlias: string, sessionAlias: string): string {
  return boundedIntervalHours(
    `${breakAlias}.break_start`,
    `COALESCE(${breakAlias}.break_end, NOW())`,
    sessionAlias,
  );
}

/**
 * One geofence_violations row's contribution: the summed duration of every
 * ping window it spans that received NO accepted onsite ping.
 *
 * ── WHY THIS IS NOT occurred_at -> resolved_at ──────────────────────────
 *
 * It used to be, and that measured the wrong thing. A violation is closed by
 * exactly two events: an accepted onsite ping (routes/locations.ts:586) or a
 * back-stamp at session close (routes/shifts.ts:3775,
 * jobs/autoCompleteShifts.ts:216). A guard who is standing on post but not
 * pinging keeps the row open, so the old interval measured
 * "time until the next accepted ping", not "time away".
 *
 * Measured on prod 2026-08-30: 21 of 31 violations were closed by the
 * back-stamp, not by a guard returning. reddy's 2026-08-19 session showed
 * 5.35h of "off-post" on a 7.40h shift, of which 4.78h was one row that
 * simply stayed open until a ping finally arrived at 04:50.
 *
 * ── WHAT IT MEASURES NOW ────────────────────────────────────────────────
 *
 * Windows are the same PING_WINDOW_MS slots anchored at scheduled_start that
 * services/pingWindows.ts uses. For each window the violation spans, the
 * window counts if no ping LANDED inside it.
 *
 * PRESENCE IS JUDGED ON lp.pinged_at, NEVER lp.window_label. A guard can
 * backfill six labels in ten minutes — reddy did exactly that on 2026-08-19,
 * submitting labels 19:30 through 22:00 between 04:50 and 05:00. Backfill
 * answers the REPORTING obligation; it cannot retroactively prove someone
 * stood somewhere four hours earlier. Crediting labels would have credited
 * six windows for ten minutes of presence (a 2.35h difference across prod).
 *
 * ── CALLERS MUST STILL SUM OVER VIOLATIONS ──────────────────────────────
 *
 * This returns ONE violation row's hours. A session can carry several — five
 * sessions in prod carry two each, and reddy's 2026-08-19 total of 4.93h is
 * 4.434 + 0.500 from two rows. Every call site therefore still wraps this in
 * SUM(...) over geofence_violations. An earlier draft of this change claimed
 * the outer SUM could be dropped; it cannot, and doing so would silently
 * report only one violation per session.
 *
 * ── WINDOW ANCHOR IS DEFINED TWICE — SEE services/pingWindows.ts:119 ────
 *
 * The anchor rule (scheduled_start + n * PING_WINDOW_MS) lives in TypeScript
 * there and in SQL here. The CONSTANT is shared by interpolation; the
 * EXPRESSION is not, because a SQL fragment cannot call a TS function.
 * scripts/check-window-anchor.ts asserts the two produce identical boundary
 * lists and fails the build if either side moves. If you change the anchor
 * here, change it there, and the test will tell you if you forgot.
 *
 * ── TRAP: sites.ping_interval_minutes IS NOT READ HERE ──────────────────
 *
 * That column exists, is NOT NULL, is editable, and is sent to the mobile app
 * (routes/shifts.ts:2596) — but NO server-side window reads it. pingReminder,
 * missedPingCron and this fragment all hardcode PING_WINDOW_MS (30 min). All
 * 15 prod sites read 30 today so nothing diverges, but set one site to 20 and
 * the guard's countdown, the reminder cron, the missed-ping flags and this
 * number all disagree at once. Deliberately not fixed here.
 *
 * Aliases must be trusted identifiers (never user input).
 */
export function VIOLATION_HOURS_ROW_SQL(
  violationAlias: string, sessionAlias: string, shiftAlias: string,
): string {
  const gv = violationAlias, s = sessionAlias, sh = shiftAlias;
  const WIN = `(INTERVAL '1 millisecond' * ${PING_WINDOW_MS})`;
  // The instant the violation stops counting: its resolve, or session close.
  const effEnd = `LEAST(COALESCE(${gv}.resolved_at, NOW()), COALESCE(${s}.clocked_out_at, NOW()))`;
  // Snap an instant DOWN onto the window grid anchored at scheduled_start.
  const grid = (t: string) =>
    `${sh}.scheduled_start + (FLOOR(EXTRACT(EPOCH FROM (${t} - ${sh}.scheduled_start))
       / (${PING_WINDOW_MS} / 1000.0)) * ${WIN})`;
  return `(
    SELECT COALESCE(SUM(
      GREATEST(0, EXTRACT(EPOCH FROM (
          LEAST(w.ws + ${WIN}, ${effEnd})
        - GREATEST(w.ws, ${gv}.occurred_at, ${s}.clocked_in_at)
      )))/3600.0), 0)
      FROM generate_series(${grid(`${gv}.occurred_at`)}, ${grid(effEnd)}, ${WIN}) AS w(ws)
     WHERE NOT EXISTS (
       SELECT 1 FROM location_pings lp
        WHERE lp.shift_session_id = ${s}.id
          AND lp.pinged_at >= w.ws
          AND lp.pinged_at <  w.ws + ${WIN}))`;
}

export function SHIFT_HOURS_SQL_FIELDS(sessionAlias: string, shiftAlias: string): string {
  const s = sessionAlias;
  const sh = shiftAlias;
  return `
    ROUND(CAST(EXTRACT(EPOCH FROM (${sh}.scheduled_end - ${sh}.scheduled_start)) / 3600.0 AS NUMERIC), 2) AS scheduled_hours,
    ROUND(CAST(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(${s}.clocked_out_at, NOW()) - ${s}.clocked_in_at)) / 3600.0) AS NUMERIC), 2) AS actual_hours,
    ROUND(CAST(COALESCE((
      SELECT SUM(${BREAK_HOURS_ROW_SQL('bs', s)})
        FROM break_sessions bs
       WHERE bs.shift_session_id = ${s}.id
    ), 0) AS NUMERIC), 2) AS break_hours,
    ROUND(CAST(COALESCE((
      SELECT SUM(${VIOLATION_HOURS_ROW_SQL('gv', s, sh)})
        FROM geofence_violations gv
       WHERE gv.shift_session_id = ${s}.id
    ), 0) AS NUMERIC), 2) AS violation_hours
  `.trim();
}

/**
 * SQL fragment — AGGREGATE shape. Same four-field contract as
 * SHIFT_HOURS_SQL_FIELDS, but every field is wrapped in SUM() for a query
 * that GROUPs BY something coarser than a session: per shift (handoffs
 * contribute several sessions), per site, per guard, per month.
 *
 *   const q = `SELECT ss.shift_id, ${SHIFT_HOURS_AGG_SQL_FIELDS('ss')}
 *                FROM shift_sessions ss GROUP BY ss.shift_id`
 *
 * scheduled_hours is deliberately absent — it is a property of the SHIFT,
 * not of the sessions being aggregated, so summing it here would double-count
 * a handoff. Callers select it from the shift row themselves.
 *
 * `naming` picks the output column names, because the two conventions in
 * this codebase disagree: routes/shifts.ts consumes actual_hours/break_hours/
 * violation_hours, routes/admin.ts consumes h_actual/h_break/h_violation.
 *
 * The inner SUM returns NULL for a session with no breaks/violations; the
 * outer SUM skips those NULLs, and COALESCE(...,0) covers the all-NULL group.
 * That is the pre-existing behaviour of all six call sites this replaced.
 */
export function SHIFT_HOURS_AGG_SQL_FIELDS(
  sessionAlias: string,
  naming: 'hours_suffix' | 'h_prefix' = 'hours_suffix',
  shiftAlias = 'sh',
): string {
  const s = sessionAlias;
  const sh = shiftAlias;
  const col = naming === 'h_prefix'
    ? { actual: 'h_actual',     brk: 'h_break',     viol: 'h_violation'     }
    : { actual: 'actual_hours', brk: 'break_hours', viol: 'violation_hours' };
  return `
    ROUND(CAST(COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(${s}.clocked_out_at, NOW()) - ${s}.clocked_in_at)) / 3600.0)), 0) AS NUMERIC), 2) AS ${col.actual},
    ROUND(CAST(COALESCE(SUM((
      SELECT SUM(${BREAK_HOURS_ROW_SQL('bs', s)})
        FROM break_sessions bs
       WHERE bs.shift_session_id = ${s}.id
    )), 0) AS NUMERIC), 2) AS ${col.brk},
    ROUND(CAST(COALESCE(SUM((
      SELECT SUM(${VIOLATION_HOURS_ROW_SQL('gv', s, sh)})
        FROM geofence_violations gv
       WHERE gv.shift_session_id = ${s}.id
    )), 0) AS NUMERIC), 2) AS ${col.viol}
  `.trim();
}

/**
 * SQL fragment: break-overrun review fields for a session (schema_v46
 * package). `overrun_flagged` counts breaks awaiting/needing admin review;
 * `overrun_minutes` totals recorded off-post-after-expiry time. Recorded
 * for human wage review only — deliberately absent from every hours field
 * above (overrun is never auto-deducted).
 */
export function BREAK_OVERRUN_SQL_FIELDS(sessionAlias: string): string {
  const s = sessionAlias;
  return `
    COALESCE((
      SELECT COUNT(*) FROM break_sessions bs
       WHERE bs.shift_session_id = ${s}.id AND bs.overrun_flagged_at IS NOT NULL
    ), 0) AS overrun_flagged,
    COALESCE((
      SELECT SUM(bs.overrun_minutes) FROM break_sessions bs
       WHERE bs.shift_session_id = ${s}.id
    ), 0) AS overrun_minutes
  `.trim();
}

export interface ShiftHoursInput {
  shift_session_id: string;
}

/**
 * Compute the 4-field hours object for one shift session.
 *
 * Returns emptyShiftHours() if the session doesn't exist. Live intervals
 * (open session, open break, unresolved violation) are extended to NOW(),
 * then bounded to the session window — see the contract at the top.
 */
export async function getShiftHours(input: ShiftHoursInput): Promise<ShiftHours> {
  const result = await pool.query<ShiftHours>(
    `SELECT ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')}
       FROM shift_sessions ss
       JOIN shifts sh ON sh.id = ss.shift_id
      WHERE ss.id = $1`,
    [input.shift_session_id],
  );
  const row = result.rows[0];
  if (!row) return emptyShiftHours();
  return {
    scheduled_hours: Number(row.scheduled_hours) || 0,
    actual_hours:    Number(row.actual_hours)    || 0,
    break_hours:     Number(row.break_hours)     || 0,
    violation_hours: Number(row.violation_hours) || 0,
  };
}

/**
 * Batched per-session variant. One SQL round trip regardless of how many
 * session IDs are passed — cheap for endpoints that already have a list
 * of session IDs and want to attach hours per row.
 *
 * Missing IDs are omitted from the returned Map (callers should default
 * to emptyShiftHours()).
 */
export async function getShiftHoursForShifts(
  shiftSessionIds: string[],
): Promise<Map<string, ShiftHours>> {
  const out = new Map<string, ShiftHours>();
  if (shiftSessionIds.length === 0) return out;
  const result = await pool.query<{ id: string } & ShiftHours>(
    `SELECT ss.id, ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')}
       FROM shift_sessions ss
       JOIN shifts sh ON sh.id = ss.shift_id
      WHERE ss.id = ANY($1::uuid[])`,
    [shiftSessionIds],
  );
  for (const row of result.rows) {
    out.set(row.id, {
      scheduled_hours: Number(row.scheduled_hours) || 0,
      actual_hours:    Number(row.actual_hours)    || 0,
      break_hours:     Number(row.break_hours)     || 0,
      violation_hours: Number(row.violation_hours) || 0,
    });
  }
  return out;
}

/**
 * Sum an iterable of ShiftHours into a single aggregate.
 *
 * NOTE on scheduled_hours: this sums it too, which is correct when the
 * caller is aggregating DISTINCT shifts (each shift's scheduled window
 * counts once). If aggregating multiple sessions belonging to the SAME
 * shift (mid-shift handoff), the caller should collapse to one
 * scheduled_hours per shift BEFORE summing — otherwise scheduled time
 * would be double-counted.
 */
export function sumShiftHours(items: Iterable<ShiftHours>): ShiftHours {
  const total = emptyShiftHours();
  for (const h of items) {
    total.scheduled_hours += h.scheduled_hours;
    total.actual_hours    += h.actual_hours;
    total.break_hours     += h.break_hours;
    total.violation_hours += h.violation_hours;
  }
  return {
    scheduled_hours: round2(total.scheduled_hours),
    actual_hours:    round2(total.actual_hours),
    break_hours:     round2(total.break_hours),
    violation_hours: round2(total.violation_hours),
  };
}
