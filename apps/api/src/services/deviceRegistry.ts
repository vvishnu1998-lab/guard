/**
 * guard_devices — the single READER and WRITER for a guard's push token.
 *
 * Every path that used to UPDATE guards.fcm_token directly goes through the
 * write API below (P3), and as of R1 every path that used to SELECT it goes
 * through the read API at the bottom of this file. guards.fcm_token is now a
 * mirror with NO consumers: nothing in apps/api reads it and only the
 * schema_v63 trigger writes it, which is what makes v64's DROP COLUMN safe.
 *
 * WHY THIS EXISTS
 *
 * The old column had no uniqueness of any kind, so a device's token was
 * COPIED onto every guard row that device logged into and never removed from
 * the previous one. On 2026-08-31 that sent a STARNET guard's missed-ping,
 * location-ping, activity-report and clock-out notifications to a handset
 * signed into a different guard on a different tenant. It recurred on
 * 2026-09-01 across three guard rows and two tenants within hours of being
 * cleared by hand. Clearing it by hand is containment; this is the fix.
 */
import { pool } from '../db/pool';
import type { PoolClient } from 'pg';

export type RevokeReason =
  | 'logout'
  | 'stale'
  | 'repointed'
  | 'password_change'
  | 'admin_revoke';

/** Postgres unique_violation. Raised by either partial unique index. */
const UNIQUE_VIOLATION = '23505';

/**
 * Derive platform from the User-Agent. Mobile sends okhttp on Android and
 * CFNetwork on iOS. NULL when it is neither — a NULL that admits it does not
 * know beats a guess that reads as a fact, which is the same reasoning that
 * kept platform out of the v63 backfill.
 */
export function platformFromUserAgent(ua: string | undefined): 'ios' | 'android' | null {
  if (!ua) return null;
  if (ua.startsWith('okhttp')) return 'android';
  if (ua.includes('CFNetwork') || ua.includes('Darwin')) return 'ios';
  return null;
}

/**
 * CLAIM a push token for a guard, repointing it off any other guard.
 *
 * Postcondition at COMMIT, enforced by uq_guard_devices_one_active_per_token
 * and uq_guard_devices_one_active_per_guard rather than by this code being
 * careful: exactly one active row holds `token`, it belongs to `guardId`, and
 * `guardId` has no other active row.
 *
 * ── CONCURRENCY ────────────────────────────────────────────────────────────
 *
 * Two guards claiming the SAME token concurrently is the case the whole
 * change exists for, so it is worth being explicit about why one of them
 * loses rather than both appearing to succeed.
 *
 * 1. THE INDEX IS THE SERIALISATION POINT, NOT THIS FUNCTION.
 *    If no active row holds the token yet, both transactions find nothing to
 *    revoke, take no row locks, and both reach the INSERT. The partial unique
 *    index on push_token then admits exactly one; the loser raises 23505 and
 *    its whole transaction rolls back. There is no interleaving in which both
 *    commit, because the postcondition is an index, not a check-then-act.
 *    A read-then-write guard (SELECT … then INSERT) would NOT be safe here —
 *    under READ COMMITTED both transactions' SELECTs see no conflict and both
 *    proceed. That is precisely the shape the old code had.
 *
 * 2. THE LOSER RETRIES ONCE, AND THE RETRY CONVERGES.
 *    On 23505 we retry a single time. By then the winner has committed, so
 *    the retry's revoke step finds a real active row, revokes it, and the
 *    INSERT succeeds. Retries are bounded at one — a second failure means
 *    something other than this race and is thrown to the caller rather than
 *    looped on.
 *
 * 3. LOCK ORDER IS DETERMINISTIC, SO TWO CLAIMS CANNOT DEADLOCK.
 *    The revoke step locks its victims with `ORDER BY id … FOR UPDATE`. Both
 *    victim classes — the row holding this token, and this guard's existing
 *    row — are locked in one statement in ascending primary-key order.
 *    Without that ordering there is a real cycle: guard A claiming the token
 *    B holds, while B claims the token A holds, locks {B-row, A-row} in one
 *    transaction and {A-row, B-row} in the other. Ascending id in both makes
 *    a cycle impossible, so the pair serialises instead of deadlocking.
 *    Postgres re-evaluates the WHERE after acquiring each lock, so a row a
 *    concurrent transaction has already revoked drops out rather than being
 *    revoked twice.
 *
 * 4. RE-CLAIMING THE SAME TOKEN IS A NO-OP, NOT CHURN.
 *    mobile/_layout.tsx posts the token on EVERY authenticated launch. If the
 *    guard already holds exactly this token we bump last_seen_at and return,
 *    rather than revoke-and-reinsert. Without that short-circuit the history
 *    this table exists to keep would grow by one dead row per app launch.
 */
export async function claimDevice(params: {
  guardId: string;
  token: string;
  platform?: 'ios' | 'android' | null;
  client?: string | null;
}): Promise<void> {
  const { guardId, token } = params;
  const platform = params.platform ?? null;
  const client = params.client ?? null;

  for (let attempt = 0; attempt < 2; attempt++) {
    const cx: PoolClient = await pool.connect();
    try {
      await cx.query('BEGIN');

      // Fast path — already the active device for this guard. Touch and go.
      const touched = await cx.query(
        `UPDATE guard_devices
            SET last_seen_at = NOW(),
                platform     = COALESCE($3, platform),
                client       = COALESCE($4, client)
          WHERE guard_id = $1 AND push_token = $2 AND revoked_at IS NULL`,
        [guardId, token, platform, client],
      );
      if ((touched.rowCount ?? 0) > 0) {
        await cx.query('COMMIT');
        return;
      }

      // Revoke both victim classes in ONE statement, in ascending id order.
      // See CONCURRENCY note 3 — the ordering is what prevents the deadlock,
      // not an accident of the plan.
      await cx.query(
        `WITH victims AS (
           SELECT id FROM guard_devices
            WHERE revoked_at IS NULL
              AND (push_token = $2 OR guard_id = $1)
            ORDER BY id
            FOR UPDATE
         )
         UPDATE guard_devices d
            SET revoked_at = NOW(), revoked_reason = 'repointed'
           FROM victims v
          WHERE d.id = v.id`,
        [guardId, token],
      );

      await cx.query(
        `INSERT INTO guard_devices (guard_id, push_token, platform, client)
         VALUES ($1, $2, $3, $4)`,
        [guardId, token, platform, client],
      );

      await cx.query('COMMIT');
      return;
    } catch (err) {
      await cx.query('ROLLBACK').catch(() => {});
      const code = (err as { code?: string })?.code;
      // Lost the race to another claim of the same token. The winner has
      // committed by now, so a single retry sees its row and repoints it.
      //
      // Logged, not swallowed silently: a 23505 here means two guards claimed
      // one physical handset within the same instant, which is the exact
      // condition the 2026-08-31 incident was made of. It is handled
      // correctly now, but it is still worth being able to see in the logs
      // how often one device is being shared between accounts.
      if (code === UNIQUE_VIOLATION && attempt === 0) {
        console.warn(
          `[deviceRegistry] claim race on token ${token.slice(0, 24)}… for guard ${guardId} — retrying once`,
        );
        continue;
      }
      throw err;
    } finally {
      cx.release();
    }
  }
}

/**
 * Revoke every active device for a guard. The deliberate revocation paths:
 * logout, change-password, admin revoke. The mirror trigger nulls
 * guards.fcm_token, so dispatchers see no token and fall back to writing the
 * in-app notifications row only — which every one of the 18 already does
 * unconditionally.
 */
export async function revokeGuardDevices(
  guardId: string,
  reason: Extract<RevokeReason, 'logout' | 'password_change' | 'admin_revoke'>,
): Promise<number> {
  const res = await pool.query(
    `UPDATE guard_devices
        SET revoked_at = NOW(), revoked_reason = $2
      WHERE guard_id = $1 AND revoked_at IS NULL`,
    [guardId, reason],
  );
  return res.rowCount ?? 0;
}

/**
 * Revoke whatever active device holds this token, without knowing the guard.
 *
 * Safe precisely because uq_guard_devices_one_active_per_token guarantees at
 * most one match. That is what lets the DeviceNotRegistered cleanup live in
 * sendPushNotification and cover all 18 dispatch sites, instead of the 7 that
 * hand-rolled a compare-and-swap and the 11 that silently discarded the
 * signal. Under the old column-per-guard schema this query could not have
 * been written at all.
 *
 * Never throws: it is called from inside a push-delivery path whose failure
 * must not become the caller's failure.
 */
export async function revokeDeviceByToken(token: string): Promise<number> {
  try {
    const res = await pool.query(
      `UPDATE guard_devices
          SET revoked_at = NOW(), revoked_reason = 'stale'
        WHERE push_token = $1 AND revoked_at IS NULL`,
      [token],
    );
    return res.rowCount ?? 0;
  } catch (err) {
    console.error('[deviceRegistry] stale revoke failed for token', token.slice(0, 12), err);
    return 0;
  }
}

// ── READ SIDE ──────────────────────────────────────────────────────────────
//
// The 18 dispatch sites used to read guards.fcm_token, the schema_v63 mirror.
// They now read guard_devices directly, so the mirror has no consumers and
// v64 can drop it. Two mechanisms, deliberately not one:
//
//   * batch/joined cron queries take the SQL FRAGMENT below, because their
//     whole point is one round trip. Calling a helper per row would turn one
//     query into N+1 across the busiest jobs in the system.
//   * point lookups and fan-outs take the helpers, because they are already
//     one query per call and a helper is the smaller diff.

/**
 * Scalar subquery for a guard's active push token, ALIASED `fcm_token`.
 *
 * The alias is load-bearing and must not be "tidied". Every consumer of these
 * queries reads `row.fcm_token` — roughly thirty references across the eight
 * cron jobs — and keeping the output name identical means the conversion is
 * one line per query with zero downstream edits.
 *
 * Total by construction: uq_guard_devices_one_active_per_guard permits at
 * most one active row per guard, so this yields exactly one value or NULL,
 * never "which one?". NULL where the mirror was NULL, so every existing
 * `if (row.fcm_token)` branch behaves identically.
 *
 *   SELECT g.id, ${ACTIVE_PUSH_TOKEN_SQL('g')} FROM guards g ...
 */
export function ACTIVE_PUSH_TOKEN_SQL(guardAlias: string): string {
  return `(SELECT d.push_token FROM guard_devices d
            WHERE d.guard_id = ${guardAlias}.id AND d.revoked_at IS NULL) AS fcm_token`;
}

/**
 * The guard's active push token, or null.
 *
 * CONTRACT — NEVER THROWS ON A MISSING GUARD. A guard id with no row, or a
 * guard with no active device, both return null rather than raising. This is
 * not defensive habit: routes/shifts.ts:991 calls its push block
 * fire-and-forget inside an unawaited async IIFE, so a rejection there is an
 * unhandled promise rejection rather than a handled error. The previous
 * `tokRow.rows[0]?.fcm_token` yielded undefined for a missing guard, and this
 * must stay falsy in exactly the same cases.
 */
export async function getActivePushToken(guardId: string): Promise<string | null> {
  try {
    const res = await pool.query<{ push_token: string }>(
      `SELECT push_token FROM guard_devices
        WHERE guard_id = $1 AND revoked_at IS NULL`,
      [guardId],
    );
    return res.rows[0]?.push_token ?? null;
  } catch (err) {
    // A read failure must not become the caller's failure — the caller's job
    // is to send a best-effort push, and its notifications row is already
    // written by this point at every one of the call sites.
    console.error('[deviceRegistry] token lookup failed for guard', guardId, err);
    return null;
  }
}

/**
 * Active push tokens for several guards, as guard_id -> token.
 *
 * A guard with no active device is simply ABSENT from the map, which is the
 * same shape the old `AND fcm_token IS NOT NULL` queries produced. Same
 * no-throw contract as getActivePushToken.
 */
export async function getActivePushTokens(
  guardIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (guardIds.length === 0) return out;
  try {
    const res = await pool.query<{ guard_id: string; push_token: string }>(
      `SELECT guard_id, push_token FROM guard_devices
        WHERE guard_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [guardIds],
    );
    for (const r of res.rows) out.set(r.guard_id, r.push_token);
    return out;
  } catch (err) {
    console.error('[deviceRegistry] bulk token lookup failed', err);
    return out;
  }
}
