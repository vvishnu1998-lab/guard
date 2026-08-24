/**
 * Idempotency middleware — replays a cached SUCCESS for repeated POSTs
 * carrying the same `Idempotency-Key`. Audit Item 5.
 *
 * Scope: per-guard, per-endpoint (the `scope` argument to `idempotent(...)`),
 * keyed by the client-supplied UUID. Backed by the `idempotency_keys` table
 * (schema_v54), 30-minute TTL.
 *
 * ── WHY POSTGRES AND NOT A Map ──────────────────────────────────────────
 *
 * This used to be a process-local `Map`. That is not idempotency across a
 * restart, a redeploy, or a second instance — and Railway redeploys on every
 * push, so the cache emptied on exactly the events most likely to make a
 * client retry. The old docblock already named the ceiling ("we're at a
 * scale where this should be Redis, not in-process"); Postgres is already
 * here, already durable, and already what the request is talking to.
 *
 * ── WHY ONLY 2xx IS CACHED ──────────────────────────────────────────────
 *
 * The previous version deliberately cached 4xx too, reasoning that a retry
 * of an attempt that legitimately rejected should yield the same rejection
 * rather than re-execute. That reasoning was correct for the only two call
 * sites it had — clock-in and handoff-clock-in, whose sole 4xx
 * (409 OPEN_SESSION_EXISTS) ends in a `router.replace` with
 * `cancelable: false`, so the screen unmounts and the next attempt mints a
 * fresh key. It does NOT generalise, and keeping it would have shipped a
 * guard-blocking bug the moment /reports was added:
 *
 *   PHOTO_TOO_LARGE tells the guard "Remove that photo and submit the rest."
 *   The guard does exactly that — same mounted screen, same key, DIFFERENT
 *   payload — and a cached 4xx replays a rejection about a photo that is no
 *   longer attached. The error message instructs an action the cache
 *   defeats.
 *
 *   REPORT_OFF_POST is the same shape: reports/new.tsx keeps the form
 *   mounted on purpose "so the guard can walk back onsite and hit Submit
 *   again without re-typing". Caching it strands them on-post for the
 *   remaining TTL.
 *
 * The mechanism exists to prevent DOUBLE-CREATION, and only a 2xx creates.
 * A 4xx means nothing was written — POST /reports rolls back in one
 * transaction, clock-in rolls back, break-start's 422s fire before its
 * INSERT — so re-executing a 4xx cannot double-create, and the condition
 * behind it may legitimately have changed. 4xx therefore always
 * re-executes.
 *
 * NOTE: unhandled throws never reach here either — they exit via
 * res.end(html), not res.json. That is intentional: caching a 500 from an
 * unexpected exception would block a legitimate retry of a transient
 * failure. It is also why input validation must return 4xx rather than
 * throw (see the input gate in routes/reports.ts).
 *
 * ── CLEANUP ─────────────────────────────────────────────────────────────
 *
 * Expired rows are swept opportunistically here, bounded and fire-and-
 * forget. Explicitly NOT delegated to jobs/nightlyPurge.ts: RETENTION_DRY_RUN
 * is unset on Railway and the code default is `!== 'false'`, so every purge
 * step runs in dry-run in production and deletes nothing. A sweep added
 * there would look implemented and silently do nothing.
 *
 * ── LIMIT ───────────────────────────────────────────────────────────────
 *
 * This does not dedup CONCURRENT in-flight duplicates: two simultaneous
 * requests with the same key both miss and both execute. A DB unique index
 * is still the last-line defense where one exists —
 * idx_shift_sessions_one_open_per_guard for clock-in,
 * uq_break_sessions_one_open_per_session for break-start (both schema-
 * enforced, both with 23505 handlers). POST /reports has no such index.
 * Closing that needs an INSERT-first claim row plus a story for a crashed
 * claim-holder, which is why it is not a two-line change; tracked
 * separately.
 */
import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { Sentry } from './sentry';

/** Rows older than this are invisible to reads and eligible for the sweep. */
const TTL_MINUTES = 30;

/** Upper bound on rows removed per sweep, so cleanup can never become the
 *  expensive part of a request. */
const SWEEP_LIMIT = 200;

/** Minimum gap between sweeps, process-local. The sweep is a nicety, not a
 *  correctness requirement — reads already filter on expires_at. */
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;

interface CacheEntry {
  status: number;
  body: unknown;
}

async function get(cacheKey: string): Promise<CacheEntry | null> {
  const { rows } = await pool.query<{ status: number; body: unknown }>(
    `SELECT status, body FROM idempotency_keys
      WHERE cache_key = $1 AND expires_at > NOW()`,
    [cacheKey],
  );
  return rows[0] ?? null;
}

/**
 * Store a successful response. ON CONFLICT DO UPDATE rather than DO NOTHING:
 * a key whose previous entry has expired should be reusable, and the row is
 * keyed on cache_key so the update simply replaces the stale body.
 */
async function set(cacheKey: string, status: number, body: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO idempotency_keys (cache_key, status, body, expires_at)
     VALUES ($1, $2, $3::jsonb, NOW() + ($4 || ' minutes')::interval)
     ON CONFLICT (cache_key) DO UPDATE
       SET status = EXCLUDED.status,
           body = EXCLUDED.body,
           created_at = NOW(),
           expires_at = EXCLUDED.expires_at`,
    [cacheKey, status, JSON.stringify(body ?? null), String(TTL_MINUTES)],
  );
}

/** Bounded delete of expired rows. Never awaited by a request path. */
function sweepIfDue(): void {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  pool
    .query(
      `DELETE FROM idempotency_keys
        WHERE ctid IN (
          SELECT ctid FROM idempotency_keys WHERE expires_at < NOW() LIMIT $1
        )`,
      [SWEEP_LIMIT],
    )
    .catch((err) => console.error('[idempotency] sweep failed:', err));
}

/**
 * Express middleware. Must run AFTER auth so `req.user.sub` is populated.
 * Header must be `Idempotency-Key` (any reasonable client UUID).
 *
 * Behaviour:
 *  - No header → pass through (idempotency is opt-in per request).
 *  - No req.user → pass through (auth will reject anyway; no cache key
 *    can be formed without a guard id).
 *  - Cache hit → respond from cache with `Idempotent-Replay: true` header
 *    and skip the handler entirely.
 *  - Cache miss → patch res.json so a 2xx response is recorded on its way
 *    out, then call next().
 *
 * A store failure never fails the request: if the lookup throws we fall
 * through and execute normally, which is the same behaviour as a cache
 * miss. Losing idempotency is worse than nothing, but failing a guard's
 * write because the cache is unavailable is worse still.
 */
export function idempotent(scope: string) {
  return function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = req.header('Idempotency-Key');
    if (!key || !req.user?.sub) {
      return next();
    }

    const cacheKey = `${req.user.sub}:${scope}:${key}`;

    void (async () => {
      let cached: CacheEntry | null = null;
      try {
        cached = await get(cacheKey);
      } catch (err) {
        console.error('[idempotency] lookup failed — executing normally:', err);
        Sentry.captureException(err, {
          tags: { flow: 'idempotency', scope },
        } as unknown as Parameters<typeof Sentry.captureException>[1]);
      }

      if (cached) {
        res.setHeader('Idempotent-Replay', 'true');
        res.status(cached.status).json(cached.body);
        return;
      }

      sweepIfDue();

      // Capture status + body on the way out. Express's res.status returns
      // the response object for chaining; res.json sends the response.
      let capturedStatus = 200;
      const origStatus = res.status.bind(res);
      res.status = ((code: number): Response => {
        capturedStatus = code;
        return origStatus(code);
      }) as Response['status'];

      const origJson = res.json.bind(res);
      res.json = ((body: unknown): Response => {
        // 2xx only — see the docblock. The write is fire-and-forget so a
        // slow or failing cache write never delays or breaks the response
        // the guard is waiting on.
        if (capturedStatus >= 200 && capturedStatus < 300) {
          set(cacheKey, capturedStatus, body).catch((err) => {
            console.error('[idempotency] store failed:', err);
            Sentry.captureException(err, {
              tags: { flow: 'idempotency', scope },
            } as unknown as Parameters<typeof Sentry.captureException>[1]);
          });
        }
        return origJson(body);
      }) as Response['json'];

      next();
    })();
  };
}
