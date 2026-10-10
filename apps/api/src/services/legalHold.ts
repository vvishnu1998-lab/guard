/**
 * Insert-time legal-hold inheritance.
 *
 * ── THE DEFECT THIS EXISTS TO CLOSE ─────────────────────────────────────
 *
 * The admin cascade (`routes/admin.ts`) is a point-in-time snapshot: it
 * flips the rows that exist when the hold is placed and nothing re-applies
 * it afterwards. Proven in production — report 53fc82ec was held at
 * 2026-07-13T20:27:58.744Z, its session stayed open another 57 minutes, and
 * the ping written at 20:57:56.376Z (+29m58s) carried legal_hold = false
 * for the 68 days that followed. Five checks (triggers, rules, PL
 * functions, periodic jobs, insert-time inheritance, column defaults) all
 * came back negative: nothing repaired it.
 *
 * A new row on a held session must therefore be born held.
 *
 * ── WHY A SQL FRAGMENT AND NOT A HELPER FUNCTION ────────────────────────
 *
 * `deviceRegistry.ts:224-232` states the house rule for exactly this fork:
 * batch/joined queries take the FRAGMENT because their whole point is one
 * round trip; point lookups take a helper because they are already one
 * query per call. Every call site below already holds its session id and is
 * already issuing an INSERT, so a helper would add a round trip to
 * POST /ping and POST /reports — the two highest-frequency guard writes on
 * the platform — to fetch a value the same statement can read for free.
 *
 * The fragment also closes a race a helper cannot. On the ping path the
 * session is SELECTed at `locations.ts:305` and the row is INSERTed at
 * `:544` — 239 lines apart, on a different connection, with a geofence
 * query and an S3 HEAD network call in between. A `legal_hold` read at the
 * top is stale by an unbounded interval by the time the write happens, and
 * a hold placed inside that window would be missed by the very mechanism
 * meant to catch it. Reading it INSIDE the INSERT makes the read and the
 * write one statement.
 *
 * The checkpoint scan path had already reached the same conclusion for a
 * different column — "round_window computed inside the INSERT (no
 * read-then-write race)" at `checkpoints.ts:513` — before it became a call
 * site of this fragment.
 *
 * ── TWO CALL SITES ARE INSERT ... SELECT, NOT INSERT ... VALUES ────────
 *
 * `locations.ts` (clock_in_verifications, schema_v80) is the second. Its
 * statement ALREADY joins `shift_sessions ss`, so the fragment's own `ss`
 * shadows the outer alias inside each subquery — legal, and identical in
 * result because both are keyed on the same parameter. Reading the joined
 * row directly would work and is deliberately not done; see the note at
 * that call site.
 *
 * `checkpoints.ts:556` interpolates this into a SELECT list, because its
 * statement must read `s.timezone` from a joined `sites` row to compute
 * round_window. Scalar subqueries are valid in both forms and neither
 * changes the source row count. Verified against production 2026-09-19 by
 * extracting the rendered statement from the file and running its source
 * SELECT: one row in, one row out, 14 columns to 14 SELECT items, and the
 * one held session yields legal_hold = true with legal_hold_at =
 * 2026-07-13T20:27:58.744Z. Nothing here assumes a VALUES list, so do not
 * add such an assumption.
 *
 * ── THE COALESCE IS LOAD-BEARING, NOT DEFENSIVE ─────────────────────────
 *
 * `legal_hold` is NOT NULL on all ten tables that carry it (schema_v80 made
 * clock_in_verifications the tenth). A scalar
 * subquery matching no row yields NULL, which would raise 23502 and abort
 * the INSERT — losing a guard's ping, report or scan to a parent lookup.
 * Fail-safe requirement (c) says the opposite must happen: on any doubt the
 * row is written with legal_hold = false. COALESCE is what enforces that,
 * in SQL, with no branch to forget. DO NOT REMOVE IT.
 *
 * The direction of "safe" here is the inverse of `mockLocation.ts`'s
 * `isExemptGuard`, which fails toward ENFORCEMENT. This fails toward the
 * row remaining deletable, because no guard may be blocked from clocking
 * in, pinging or filing a report by a legal-hold lookup. That trade is
 * deliberate and it has a cost worth naming: every fail-open here silently
 * recreates the defect above for one row. The parent lookup is a primary
 * key equality on a row the route has already authorised, so the case is
 * close to unreachable — but it is not free, and it is not logged, because
 * SQL cannot log.
 *
 * ── legal_hold_at ───────────────────────────────────────────────────────
 *
 * Inherited verbatim, not stamped NOW(). A child born into an existing hold
 * was frozen when the PARENT was frozen; that is the answer "held since"
 * wants. NULL when the parent is not held, which is exactly right. No
 * COALESCE — the column is nullable on every table (schema_v78).
 *
 * @param sessionParam the placeholder ALREADY carrying shift_session_id in
 *                     the caller's parameter array, e.g. '$1'. Callers pass
 *                     a literal they control; no request data reaches this.
 */
export function INHERIT_HOLD_FROM_SESSION_SQL(sessionParam: string): string {
  return `COALESCE((SELECT ss.legal_hold FROM shift_sessions ss WHERE ss.id = ${sessionParam}), false), ` +
         `(SELECT ss.legal_hold_at FROM shift_sessions ss WHERE ss.id = ${sessionParam})`;
}

/** The two column names the fragment above supplies values for, in order.
 *  Kept beside it so a call site cannot drift the column list out of step
 *  with the VALUES list — the failure mode that silently shifts every
 *  column after it. */
export const INHERIT_HOLD_COLUMNS = 'legal_hold, legal_hold_at';
