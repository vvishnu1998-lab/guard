/**
 * Guard double-booking check — one predicate, one response shape.
 *
 * Phase C. Eight overlap predicates already existed in routes/shifts.ts and
 * three write paths had none. This module is the single spelling of the
 * question "does this guard already hold a shift in this window", so the
 * three unchecked paths get the same answer and the same 409 body as the
 * five that were already guarded.
 *
 * ── The predicate ────────────────────────────────────────────────────────
 *
 * HALF-OPEN [start, end). A shift ending 16:00 and one starting 16:00 do NOT
 * overlap. This matches all eight pre-existing predicates verbatim — strict
 * `<` and strict `>`, never `<=`/`>=`. Do not "fix" it to closed: a guard is
 * free the instant the prior shift ends, and there is deliberately NO
 * rest-gap rule.
 *
 * CROSS-SITE. There is no site_id term and there must not be one. A guard
 * cannot be in two places at once regardless of whose post it is. All eight
 * existing predicates are already cross-site; this preserves that rather
 * than adding it.
 *
 * STATUS IN ('scheduled','active'). `cancelled`, `completed` and `missed`
 * rows carry a guard_id but do not occupy the guard. `unassigned` rows have
 * guard_id NULL (verified in prod: 8 rows, all NULL) and so can never match
 * a guard-keyed predicate anyway — widening the filter to include it would
 * be theatre.
 *
 * ── windowStart is a PARAMETER, never derived ────────────────────────────
 *
 * This is the load-bearing design choice, and it exists to protect a caller
 * this module does not yet have.
 *
 * Handoff is NOT the same question as scheduling. routes/shifts.ts:1485-1488
 * and :1906-1908 establish that a handoff transfers the REMAINDER of a shift
 * that is already underway, so its overlap window is [NOW, shift.end) — B's
 * just-finished morning shift must not disqualify them. The swap path asks
 * the full-window question, [shift.start, shift.end).
 *
 * Deriving windowStart from the candidate shift inside this helper would
 * silently convert the first question into the second and break handoff. So
 * the caller states the window and this module never guesses. The existing
 * handoff predicates at :1513 and :1926 are correct as they stand and are
 * deliberately NOT routed through here.
 *
 * ── What this module does NOT do ─────────────────────────────────────────
 *
 * It does not open, commit or roll back a transaction. The caller owns the
 * boundary and passes its client, exactly as checkShiftEligibility
 * (services/guardAssignments.ts:140) and clearScheduleDerivedLatches
 * (services/shiftLatches.ts:117) do.
 *
 * It does not lock. NONE of the overlap checks in this codebase locks the
 * candidate guard's other shift rows — where a lock exists it is
 * `FOR UPDATE OF sh` on the row being mutated. Every one of them, including
 * this one, is therefore a check-then-act race under READ COMMITTED. Two
 * concurrent requests can both pass and both write. Closing that needs
 * either `SELECT … FOR UPDATE` over the overlapping rows or a GiST exclusion
 * constraint on tstzrange (btree_gist is not installed). Filed as an open
 * item; do not mistake this helper for a guarantee.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

type Querier = Pick<PoolClient, 'query'>;

/**
 * THE predicate, as composable SQL.
 *
 * findOverlappingShift below answers this question for ONE guard against ONE
 * window, which is all any write path needs. Reading a whole dropdown is a
 * different shape: routes/guards.ts's shift-candidates evaluates every guard
 * in the company against every selected shift, and doing that by calling the
 * scalar helper in a nested loop is 16 guards x 25 shifts = 400 round-trips
 * for one dropdown, and 5,600 at the 200-shift cap.
 *
 * So the batch caller composes this fragment instead of writing the
 * comparison out a second time. The strict `<` / `>` and the status list live
 * here, once, and findOverlappingShift itself is built from them — so the
 * scalar and batch forms cannot drift. Same device as
 * services/slotExpansion.ts's exported CTE, for the same reason.
 *
 * Every argument is a SQL EXPRESSION spliced into the query — a column
 * reference like `sh.scheduled_start`, or a placeholder like `$3`. NEVER pass
 * user input here; values belong in bound parameters, and every caller in
 * this repo passes literals it wrote itself.
 */
export function overlapPredicateSql(o: {
  /** Columns on the shift row being tested for occupancy. */
  guardCol:  string;
  statusCol: string;
  startCol:  string;
  endCol:    string;
  /** The candidate guard. */
  guardExpr: string;
  /** The window, half-open [winStart, winEnd). */
  winStart:  string;
  winEnd:    string;
}): string {
  return `${o.guardCol} = ${o.guardExpr}
        AND ${o.statusCol} IN ('scheduled','active')
        AND ${o.startCol} < ${o.winEnd}
        AND ${o.endCol}   > ${o.winStart}`;
}

/** The offending shift, resolved far enough to name the collision. */
export interface OverlapConflict {
  shift_id:        string;
  guard_name:      string | null;
  site_name:       string;
  scheduled_start: string;
  scheduled_end:   string;
  /** The CONFLICTING site's zone — the message renders in it, not the caller's. */
  site_tz:         string | null;
}

/**
 * The single scheduled/active shift this guard already holds inside
 * [windowStart, windowEnd), or null. Ordered by scheduled_start so the
 * earliest collision is the one reported, matching routes/shifts.ts:1211.
 *
 * @param excludeShiftId  the row being mutated, so it cannot conflict with
 *                        itself. Pass null when the row does not exist yet
 *                        (an INSERT path), which is why this is nullable
 *                        rather than optional — callers must decide.
 * @param db              pool, or the caller's client when inside a txn.
 */
export async function findOverlappingShift(
  guardId: string,
  windowStart: Date | string,
  windowEnd: Date | string,
  excludeShiftId: string | null,
  db: Querier = pool,
): Promise<OverlapConflict | null> {
  const { rows } = await db.query<OverlapConflict>(
    `SELECT s.id              AS shift_id,
            g.name            AS guard_name,
            si.name           AS site_name,
            s.scheduled_start,
            s.scheduled_end,
            si.timezone       AS site_tz
       FROM shifts s
       JOIN sites si ON si.id = s.site_id
       LEFT JOIN guards g ON g.id = s.guard_id
      WHERE ($4::uuid IS NULL OR s.id != $4)
        AND ${overlapPredicateSql({
          guardCol: 's.guard_id', statusCol: 's.status',
          startCol: 's.scheduled_start', endCol: 's.scheduled_end',
          guardExpr: '$1', winStart: '$2', winEnd: '$3',
        })}
      ORDER BY s.scheduled_start
      LIMIT 1`,
    [guardId, windowStart, windowEnd, excludeShiftId],
  );
  return rows[0] ?? null;
}

/**
 * The 409 body. Reproduces routes/shifts.ts:1232-1243 exactly — the same
 * sentence and the same `conflict` object, because apps/web already
 * deep-links from that shape and a second spelling would fork the contract.
 *
 * Times render in the CONFLICTING site's timezone, not the caller's and not
 * the server's: the admin needs to read the collision in the zone the guard
 * is actually standing in. Falls back to America/Los_Angeles when the site
 * row carries no zone, same as :1217 (sites.timezone is NOT NULL in prod, so
 * the fallback is defensive rather than reachable).
 */
export function overlapConflictBody(c: OverlapConflict): {
  error: string;
  conflict: Omit<OverlapConflict, 'site_tz'>;
} {
  const tz = c.site_tz ?? 'America/Los_Angeles';
  const day = new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', timeZone: tz,
  }).format(new Date(c.scheduled_start));
  const from = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: tz,
  }).format(new Date(c.scheduled_start));
  const to = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: tz,
  }).format(new Date(c.scheduled_end));
  return {
    error:
      `These hours overlap ${c.guard_name ?? 'this guard'}'s shift at ` +
      `${c.site_name} on ${day}, ${from} – ${to}. Move or cancel that shift first.`,
    conflict: {
      shift_id:        c.shift_id,
      guard_name:      c.guard_name,
      site_name:       c.site_name,
      scheduled_start: c.scheduled_start,
      scheduled_end:   c.scheduled_end,
    },
  };
}

// ── The constraint, and the race it converts ────────────────────────────
//
// N45. Every overlap check above is check-then-act under READ COMMITTED:
// two concurrent requests can both run findOverlappingShift, both see
// nothing, and both write. schema_v77 closes that with a PARTIAL exclusion
// constraint, and the residue is that the losing request now raises
// SQLSTATE 23P01 instead of silently double-booking.
//
// PROVEN, not assumed — local PG 18.6, two concurrent psql sessions, both
// overlap checks returning 0: A committed, B took 23P01, one row landed
// instead of two.
//
// A 23P01 here is NOT a server fault. It is the same condition the
// pre-flight check reports as a 409, observed a few milliseconds later.
// Every caller must render it the way it renders that 409 — an admin or a
// guard should not be able to tell a race from an ordinary conflict,
// because operationally it is not a different thing.

/** The constraint added by schema_v77. Matched on, so it is spelled once. */
export const GUARD_OVERLAP_CONSTRAINT = 'shifts_no_guard_overlap';

/**
 * True for the exclusion violation schema_v77 raises, and nothing else.
 *
 * Matches the CONSTRAINT NAME as well as the SQLSTATE deliberately: 23P01
 * is the class for every exclusion constraint, and a future one on another
 * table must not be swallowed by an overlap handler. Same shape as the
 * 23505 guards at routes/shifts.ts:2700 and :3983.
 */
export function isGuardOverlapViolation(err: unknown): boolean {
  const e = err as { code?: unknown; constraint?: unknown } | null | undefined;
  return e?.code === '23P01' && e?.constraint === GUARD_OVERLAP_CONSTRAINT;
}

/**
 * Name the shift that won the race, for the error message.
 *
 * ON A FRESH CONNECTION, AND THAT IS THE WHOLE POINT. A 23P01 aborts the
 * transaction it fired in — every subsequent statement on that client
 * raises 25P02 (in_failed_sql_transaction) until it is rolled back. So this
 * defaults to `pool` rather than taking the caller's client, and callers
 * must have rolled back before they get here.
 *
 * Best-effort by construction: it swallows its own failure and returns
 * null. A lookup that cannot resolve the collision must degrade to prose,
 * never replace a 409 the caller already decided on with a 500.
 */
export async function resolveOverlapAfterRace(
  guardId: string,
  windowStart: Date | string,
  windowEnd: Date | string,
  excludeShiftId: string | null,
): Promise<OverlapConflict | null> {
  try {
    return await findOverlappingShift(guardId, windowStart, windowEnd, excludeShiftId);
  } catch (err) {
    console.error('[shiftOverlap] post-race conflict lookup failed:', err);
    return null;
  }
}

/**
 * The 409 body for a lost race, in the ADMIN register.
 *
 * `code` carries the enum and `error` keeps prose, because apps/web's
 * ApiError has no `code` field — it renders `body.error` on screen and
 * reads the enum off `.body.code` (lib/adminApi.ts:38-47, lib/
 * bulkShiftCopy.ts:118-129). Putting the enum in `error` here would print
 * GUARD_OVERLAP at an admin, which is exactly the N78 defect.
 *
 * Mobile is NOT a consumer of any route that uses this — the two assign
 * routes are called only from apps/web (AssignGuardModal, BulkShiftActions,
 * the shift detail page). The guard-facing races reuse their own existing
 * 409 vocabulary instead, so no mobile OTA is sequenced ahead of this.
 */
export function guardOverlapRaceBody(c: OverlapConflict | null): {
  code: 'GUARD_OVERLAP';
  error: string;
  message: string;
  conflict?: Omit<OverlapConflict, 'site_tz'>;
} {
  if (!c) {
    const prose =
      'That guard was given an overlapping shift a moment ago. ' +
      'Refresh and try again.';
    return { code: 'GUARD_OVERLAP', error: prose, message: prose };
  }
  const body = overlapConflictBody(c);
  return {
    code:     'GUARD_OVERLAP',
    error:    body.error,
    message:  body.error,
    conflict: body.conflict,
  };
}
