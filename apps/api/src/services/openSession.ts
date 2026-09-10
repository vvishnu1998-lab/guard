/**
 * The ONE spelling of "is this guard clocked in right now?"
 *
 * routes/shifts.ts:103 has asked this question since the clock-in idempotency
 * work, inside openSessionConflictBody. Phase E needs the same question on an
 * admin path — guard deactivation is BLOCKED while a session is open — and a
 * second copy of the predicate is exactly the drift that services/
 * shiftOverlap.ts and services/slotExpansion.ts were extracted to prevent.
 *
 * ── Why LIMIT 1 is not a guess ───────────────────────────────────────────
 *
 * idx_shift_sessions_one_open_per_guard is a partial UNIQUE index on
 * (guard_id) WHERE clocked_out_at IS NULL. A guard therefore CANNOT hold two
 * open sessions, and "the open session" is well defined rather than "an"
 * open session. Verified against prod at 408a5cf: 3 open sessions, 3 distinct
 * guards, and zero shifts in status 'active' without one.
 *
 * ── Which connection it reads through ────────────────────────────────────
 *
 * Defaults to the pool, and routes/shifts.ts MUST keep that default: its
 * caller runs inside a 23505 catch, by which point the route's own
 * transaction is aborted and its client unusable (routes/shifts.ts:99-101).
 *
 * The optional `db` exists for the opposite case. PATCH /guards/:id/deactivate
 * re-asks this question INSIDE its transaction, after locking the shift rows,
 * because the pre-flight answer can go stale: routes/shifts.ts:3702 clock-in
 * does `UPDATE shifts SET status='active'`, so a guard can clock in between a
 * pooled check and the commit that unassigns the very shift they just started.
 * Locking the shifts first and then re-reading through the SAME client is what
 * makes the block hold; a pooled read there would look at a different snapshot
 * and defeat the interlock.
 *
 * So: pass the client only when it is LIVE and inside the transaction whose
 * locks you are relying on. Never pass one whose transaction has aborted.
 * Signature matches services/shiftOverlap.ts:94, same Querier type, same
 * default, for the same reason.
 */
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

type Querier = Pick<PoolClient, 'query'>;

export interface OpenSessionRow {
  shift_id:      string;
  site_id:       string;
  site_name:     string;
  clocked_in_at: Date;
}

/** The open session for this guard, or null. Never throws — a lookup failure
 *  is logged and reported as "no session found", because every caller is
 *  already on an error path and a 500 there would replace a useful conflict
 *  reply with a useless one. Note the direction of that failure: a caller
 *  that BLOCKS on a session (Phase E deactivate) fails OPEN, so it must not
 *  be the only gate on anything irreversible. It is not — the override still
 *  requires an explicit confirmation.
 *
 *  ONE EXCEPTION TO THE SWALLOW: when called with a transaction client, an
 *  error has already aborted that transaction, so returning null would let the
 *  caller sail on and fail at COMMIT anyway. The deactivate route therefore
 *  treats a null from the in-transaction call as "re-check inconclusive" only
 *  because its pre-flight check already ran through the pool; the two together
 *  fail closed where one alone would not. */
export async function findOpenSession(
  guardId: string,
  db: Querier = pool,
): Promise<OpenSessionRow | null> {
  try {
    const open = await db.query<OpenSessionRow>(
      `SELECT ss.shift_id, ss.site_id, s.name AS site_name, ss.clocked_in_at
         FROM shift_sessions ss
         JOIN sites s ON s.id = ss.site_id
        WHERE ss.guard_id = $1 AND ss.clocked_out_at IS NULL
        LIMIT 1`,
      [guardId],
    );
    return open.rows[0] ?? null;
  } catch (err) {
    console.error('findOpenSession lookup failed:', err);
    return null;
  }
}

/** Clock-in time as a Pacific wall-clock string, e.g. "2:00 PM". The one
 *  formatting both the guard-facing and admin-facing messages share. */
export function clockedInAtPacific(clockedInAt: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: 'numeric',
    minute: '2-digit',
  }).format(clockedInAt);
}

/**
 * The conflict body shape, established by routes/shifts.ts and reused
 * verbatim on the admin path. Callers differ ONLY in the prose they put in
 * `message` — see the note on voice in routes/guards.ts's deactivation-impact
 * handler. Every key and every type here is identical to what the two
 * clock-in call sites have returned since that function was written.
 */
export interface OpenSessionConflictBody {
  code:    'OPEN_SESSION_EXISTS';
  error:   string;
  message: string;
  open_session: {
    shift_id:      string;
    site_id:       string;
    site_name:     string;
    clocked_in_at: string;
  } | null;
}
