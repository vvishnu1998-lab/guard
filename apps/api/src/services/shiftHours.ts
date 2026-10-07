/**
 * Canonical shift hours service — Scheduled, Actual, Payable, Break,
 * Violation.
 *
 * A single source of truth for how per-shift hours are computed across
 * every read surface (mobile profile, admin dashboard, client portal,
 * billing XLSX, emails, PDFs). Replaces the four divergent formulas
 * cataloged in the 2026-07-17 audit. Four hand-typed copies of the raw
 * Actual arithmetic survive on surfaces that stay on Actual —
 * routes/clientPortal.ts (hours_on_duty, and the client PDF's `hours`),
 * services/email.ts (handoff FYI) and routes/shifts.ts
 * (total_hours_worked). They compute the same raw figure; they are not
 * billing numbers. ACTIVE SITES carried a fifth until U6 moved it onto the
 * aggregate fragment below.
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
 * Both are built from PAYABLE_HOURS_ROW_SQL / BREAK_HOURS_ROW_SQL /
 * VIOLATION_HOURS_ROW_SQL, which are the actual definitions and are
 * exported for call sites that need one figure in a different SQL shape.
 *
 * PAYABLE IS OPT-IN (D19). Both fragments emit payable_hours only when the
 * caller passes { payable: true }; without it their output is byte-for-byte
 * what it was before Payable existed. The surfaces that bill — the hours
 * export, admin analytics, ACTIVE SITES, the analytics export — opt in. The
 * surfaces that stay on Actual — the daily client email, the client and
 * guard PDFs, the client portal, mobile — do not, so no Payable figure ever
 * reaches a client or guard payload by accident. PayableShiftHours is the
 * matching type; ShiftHours stays the four Actual-surface fields.
 *
 * Contract (per Phase 1 lock-in, D1/D5/D6; payable per D19, 2026-09-26):
 *   scheduled_hours = shifts.scheduled_end − shifts.scheduled_start
 *   actual_hours    = COALESCE(clocked_out_at, NOW()) − clocked_in_at  (raw, no truncation)
 *   payable_hours   = max(0, min(COALESCE(clocked_out_at, NOW()), scheduled_end)
 *                            − max(clocked_in_at, scheduled_start))
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
 * Values are decimal hours rounded to 2 places. All are non-negative except
 * scheduled_hours, which has no clamp and goes negative on a row whose end
 * precedes its start (payable_hours is 0 there).
 *
 * THREE DIFFERENT HOURS FIGURES — do not read one as another:
 *   * actual_hours — RAW clock-out − clock-in, per Vishnu's decision (matches
 *     the mobile shift timer and the client PDF). Every surface that stays
 *     on Actual shows this, and OVER / OFFPOST_ANOMALY judge against it.
 *   * payable_hours — the clocked-in time INSIDE the scheduled window,
 *     clamped at BOTH ends. It drives totals and billing (D19). Breaks are
 *     not subtracted; break_hours stays its own figure. payable ≤ actual
 *     always, and payable ≤ scheduled whenever end ≥ start.
 *   * shift_sessions.total_hours — the STORED legacy column, clamped at the
 *     START only (MAX(clocked_in, scheduled_start)), and net of breaks on
 *     rows written before 2026-08-29. It is neither of the above and is
 *     never a fallback for either. Its writers stay for rollback safety;
 *     new read paths ignore it.
 *
 * Live sessions (clocked_out_at IS NULL) and live intervals inside them
 * (open break_sessions, unresolved geofence_violations) are extended to
 * NOW() so that in-flight shifts show a running total — no partial states.
 * payable_hours takes the same NOW() and is then capped at scheduled_end, so
 * a live session past its end stops accruing Payable while Actual keeps
 * growing.
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

/**
 * The hours shape on the surfaces that bill (D19): ShiftHours plus
 * payable_hours. A separate type, not a fifth ShiftHours field, so the
 * compiler cannot push a Payable figure into the client portal, mobile or
 * the daily email — surfaces that stay on Actual and build ShiftHours
 * literals of their own.
 */
export interface PayableShiftHours extends ShiftHours {
  payable_hours:   number;
}

export function emptyShiftHours(): ShiftHours {
  return { scheduled_hours: 0, actual_hours: 0, break_hours: 0, violation_hours: 0 };
}

export function emptyPayableShiftHours(): PayableShiftHours {
  return { ...emptyShiftHours(), payable_hours: 0 };
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
 * THE definition of a bounded, clamped sub-interval of a shift session.
 * Payable and break are built on it, and every call site reaches them
 * through the exported row functions below — a route needing a different
 * SQL shape parameterises the aliases instead of re-typing the arithmetic.
 * (actual_hours is not an interval inside the session; it is the session,
 * and its one-line expression lives in the two fragments.)
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
 * THE definition of Payable (D19): one session's clocked-in time inside its
 * shift's scheduled window,
 *
 *   max(0, min(COALESCE(clocked_out_at, NOW()), scheduled_end)
 *          − max(clocked_in_at, scheduled_start))
 *
 * which is exactly boundedIntervalHours with the schedule as the interval:
 * the session bounded to its schedule is the same operation as a break
 * bounded to its session. Per-session and aggregate fragments both call
 * this; nothing re-types the arithmetic.
 *
 * NULL SAFETY RESTS ON THE JOIN. scheduled_start / scheduled_end are
 * TIMESTAMPTZ NOT NULL (schema.sql), so this is NULL-safe for any caller
 * that INNER-joins shifts. A caller that OUTER-joined shifts would hand
 * LEAST/GREATEST a NULL bound, which they skip — Payable would silently
 * equal Actual. Every caller inner-joins today; keep it that way.
 *
 * Zero or negative windows (end ≤ start) give 0 by construction, which is
 * the NO_SCHEDULE rule — no special case is needed anywhere.
 *
 * Aliases must be trusted identifiers (never user input).
 */
export function PAYABLE_HOURS_ROW_SQL(sessionAlias: string, shiftAlias: string): string {
  return boundedIntervalHours(
    `${shiftAlias}.scheduled_start`,
    `${shiftAlias}.scheduled_end`,
    sessionAlias,
  );
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
 * The anchor rule (scheduled_start + n * interval) lives in TypeScript there
 * and in SQL here. The EXPRESSION is not shared, because a SQL fragment
 * cannot call a TS function. scripts/check-window-anchor.ts asserts the two
 * produce identical boundary lists at 15/30/45/60/75/90 and is a required
 * status check, so a divergence in the ANCHOR RULE fails CI.
 *
 * ── BUT THE CHECK DOES NOT EXECUTE THIS FRAGMENT ────────────────────────
 *
 * Know what that guarantee does NOT cover. check-window-anchor.ts compares
 * the TS grid against a HAND-WRITTEN MIRROR of the anchor rule — its own
 * generate_series, starting at scheduled_start and bounded by R3. This
 * fragment starts at the VIOLATION's snapped grid point and is bounded by
 * effEnd. Different shape, different query, never executed by the check.
 *
 * So the check cannot catch a mistake in how the interval is threaded HERE —
 * for instance changing WIN and forgetting the grid divisor, which are the
 * same quantity in two denominations. What covers that is the before/after
 * capture over every production session recorded in the Phase E commit.
 * Executing this fragment in CI would need seeded tables in the throwaway
 * container; it is a real option and it is not what exists today.
 *
 * ── THE CADENCE COMES FROM THE SESSION SNAPSHOT ─────────────────────────
 *
 * This block used to say that this fragment was the last hardcoded grid, and
 * that it interpolated PING_WINDOW_MS as a constant while every TypeScript
 * reader had moved to the session snapshot. That was true from PR #23 until
 * this commit, and it is now false: IVL_MIN below reads
 * shift_sessions.ping_interval_minutes (schema_v68), COALESCEd to 30, the
 * same source missedPingCron, pingReminder, services/email.ts,
 * routes/locations.ts and routes/activityLog.ts use. The grid is defined in
 * one place for the whole platform. PING_WINDOW_MS survives as the COALESCE
 * default, not as the cadence.
 *
 * WHY THE SNAPSHOT AND NOT sites (D16). This fragment is re-evaluated long
 * after a session closes — the daily client report renders over an hour past
 * scheduled_end, and violation_hours is recomputed on every read of the hours
 * export. A live join to sites would let an admin editing a site at 21:00
 * retroactively change a guard's off-post hours at 14:00 and move a number
 * already emailed to a paying client. That is not a display bug; it rewrites
 * a billed figure after the fact with no record that it changed.
 *
 * ── WHAT THIS COMMIT DELIBERATELY DID NOT CHANGE ────────────────────────
 *
 * It is a proven no-op. Every one of the 213 production sessions was
 * evaluated before and after, across all four hours fields and the aggregate
 * shape, and the results are byte-identical — because all 23 sites read 30
 * and every snapshot written so far is 30. That property is what made the
 * change safe to make on a billing number, and it is why NO break waiver was
 * added here: the fragment counts a window the violation spans in which no
 * ping landed, INCLUDING windows inside an authorised break. That asymmetry
 * against the client email's break-aware denominator is real (measured
 * 2.68 h platform-wide, 0.05 h on STARNET) and is a separate decision with a
 * separate before/after, because fixing it CHANGES the number.
 *
 * Aliases must be trusted identifiers (never user input).
 */
export function VIOLATION_HOURS_ROW_SQL(
  violationAlias: string, sessionAlias: string, shiftAlias: string,
): string {
  const gv = violationAlias, s = sessionAlias, sh = shiftAlias;
  // THE cadence expression. Everything below derives from this one string, in
  // two different denominations — see the note under WIN.
  //
  // From the SESSION SNAPSHOT (schema_v68), never a live join to sites: this
  // fragment is re-evaluated on every read of the hours export and every send
  // of the daily client report, long after the session closed. See D16.
  //
  // GREATEST(..., 1) is kept even though schema_v69 now constrains the column
  // to 5..240. A CHECK cannot retroactively fix a row written before it, and
  // the failure it guards is not a wrong number: generate_series raises
  // "step size cannot equal zero" on a zero interval and returns an empty
  // series on a negative one, so a bad row would THROW inside the client
  // email and the XLSX export. Defence in depth is cheap on a billing number.
  const IVL_MIN = `GREATEST(COALESCE(${s}.ping_interval_minutes, ${PING_WINDOW_MS / 60000}), 1)`;
  // TWO DENOMINATIONS OF ONE QUANTITY. WIN is an INTERVAL; the grid divisor
  // below is SECONDS. They must move together — changing one and not the
  // other yields a plausible wrong number rather than an error, on a figure
  // that has already been emailed to a paying client.
  const WIN = `(INTERVAL '1 minute' * ${IVL_MIN})`;
  // The instant the violation stops counting: its resolve, or session close.
  const effEnd = `LEAST(COALESCE(${gv}.resolved_at, NOW()), COALESCE(${s}.clocked_out_at, NOW()))`;
  // Snap an instant DOWN onto the window grid anchored at scheduled_start.
  const grid = (t: string) =>
    `${sh}.scheduled_start + (FLOOR(EXTRACT(EPOCH FROM (${t} - ${sh}.scheduled_start))
       / (${IVL_MIN} * 60.0)) * ${WIN})`;
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

/** Options shared by both fragments. See "PAYABLE IS OPT-IN" in the header. */
export interface HoursFragmentOptions {
  /** Emit payable_hours (per session) / payable_hours|h_payable (aggregate). */
  payable?: boolean;
}

/**
 * SQL fragment — PER SESSION. Correlated expressions for scheduled, actual,
 * [payable,] break and violation hours. Intended for embedding in existing
 * SELECT lists next to the session/shift columns they annotate.
 *
 *   const q = `SELECT ss.id, ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')} FROM shift_sessions ss JOIN shifts sh …`
 *
 * Fixed columns: expects `${sessionAlias}.clocked_in_at`,
 * `.clocked_out_at`, `.id`, `.ping_interval_minutes`;
 * `${shiftAlias}.scheduled_start`, `.scheduled_end`. The shift must be
 * INNER-joined (see PAYABLE_HOURS_ROW_SQL). Aliases must be trusted
 * identifiers (never user input).
 *
 * With { payable: true }, payable_hours is emitted directly after
 * actual_hours. Without it the output is unchanged from before D19 —
 * scripts/test-payable-hours.ts asserts that byte-for-byte.
 *
 * NULL-safe for shifts with no session (every field becomes 0 via
 * COALESCE at the caller's LATERAL/LEFT-JOIN boundary, not inside this
 * fragment).
 */
export function SHIFT_HOURS_SQL_FIELDS(
  sessionAlias: string, shiftAlias: string, opts: HoursFragmentOptions = {},
): string {
  const s = sessionAlias;
  const sh = shiftAlias;
  // Empty string when off, INCLUDING its line break, so the default output
  // is the pre-D19 text exactly.
  const payable = opts.payable
    ? `\n    ROUND(CAST(${PAYABLE_HOURS_ROW_SQL(s, sh)} AS NUMERIC), 2) AS payable_hours,`
    : '';
  return `
    ROUND(CAST(EXTRACT(EPOCH FROM (${sh}.scheduled_end - ${sh}.scheduled_start)) / 3600.0 AS NUMERIC), 2) AS scheduled_hours,
    ROUND(CAST(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(${s}.clocked_out_at, NOW()) - ${s}.clocked_in_at)) / 3600.0) AS NUMERIC), 2) AS actual_hours,${payable}
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
 * SQL fragment — AGGREGATE shape. The same actual, [payable,] break and
 * violation expressions as SHIFT_HOURS_SQL_FIELDS, each wrapped in SUM() for
 * a query that GROUPs BY something coarser than a session: per shift
 * (handoffs contribute several sessions), per site, per guard, per month.
 *
 *   const q = `SELECT ss.shift_id, ${SHIFT_HOURS_AGG_SQL_FIELDS('ss')}
 *                FROM shift_sessions ss JOIN shifts sh … GROUP BY ss.shift_id`
 *
 * scheduled_hours is deliberately absent — it is a property of the SHIFT,
 * not of the sessions being aggregated, so summing it here would double-count
 * a handoff. Callers select it from the shift row themselves. payable_hours
 * is different: it is a per-SESSION figure and safe to sum. Sessions of one
 * shift cannot overlap — a handoff closes A and opens B at one NOW() in one
 * transaction (D19) — so a shift's summed Payable cannot exceed its window.
 *
 * `naming` picks the output column names, because the two conventions in
 * this codebase disagree: routes/shifts.ts consumes actual_hours/break_hours/
 * violation_hours, routes/admin.ts consumes h_actual/h_break/h_violation.
 * With { payable: true } the payable column is payable_hours / h_payable,
 * emitted directly after the actual column; without it the output is
 * unchanged from before D19.
 *
 * The inner SUM returns NULL for a session with no breaks/violations; the
 * outer SUM skips those NULLs, and COALESCE(...,0) covers the all-NULL group.
 * That is the pre-existing behaviour of all six call sites this replaced.
 */
export function SHIFT_HOURS_AGG_SQL_FIELDS(
  sessionAlias: string,
  naming: 'hours_suffix' | 'h_prefix' = 'hours_suffix',
  shiftAlias = 'sh',
  opts: HoursFragmentOptions = {},
): string {
  const s = sessionAlias;
  const sh = shiftAlias;
  const col = naming === 'h_prefix'
    ? { actual: 'h_actual',     pay: 'h_payable',     brk: 'h_break',     viol: 'h_violation'     }
    : { actual: 'actual_hours', pay: 'payable_hours', brk: 'break_hours', viol: 'violation_hours' };
  const payable = opts.payable
    ? `\n    ROUND(CAST(COALESCE(SUM(${PAYABLE_HOURS_ROW_SQL(s, sh)}), 0) AS NUMERIC), 2) AS ${col.pay},`
    : '';
  return `
    ROUND(CAST(COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (COALESCE(${s}.clocked_out_at, NOW()) - ${s}.clocked_in_at)) / 3600.0)), 0) AS NUMERIC), 2) AS ${col.actual},${payable}
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
 * Compute the Actual-surface hours object (ShiftHours — no Payable) for one
 * shift session. Its one caller is the mobile active-session payload, which
 * stays on Actual (D19).
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
 * Sum an iterable of PayableShiftHours into a single aggregate. Totals are a
 * Payable surface (D19), so this sums payable_hours alongside the rest.
 *
 * NOTE on scheduled_hours: this sums it too, which is correct when the
 * caller is aggregating DISTINCT shifts (each shift's scheduled window
 * counts once). If aggregating multiple sessions belonging to the SAME
 * shift (mid-shift handoff), the caller should collapse to one
 * scheduled_hours per shift BEFORE summing — otherwise scheduled time
 * would be double-counted. payable_hours needs no such care: it is a
 * per-session figure and sessions of one shift do not overlap.
 */
export function sumShiftHours(items: Iterable<PayableShiftHours>): PayableShiftHours {
  const total = emptyPayableShiftHours();
  for (const h of items) {
    total.scheduled_hours += h.scheduled_hours;
    total.actual_hours    += h.actual_hours;
    total.payable_hours   += h.payable_hours;
    total.break_hours     += h.break_hours;
    total.violation_hours += h.violation_hours;
  }
  return {
    scheduled_hours: round2(total.scheduled_hours),
    actual_hours:    round2(total.actual_hours),
    payable_hours:   round2(total.payable_hours),
    break_hours:     round2(total.break_hours),
    violation_hours: round2(total.violation_hours),
  };
}
