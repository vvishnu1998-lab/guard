/**
 * Idempotency middleware — replays cached responses for repeated POSTs with
 * the same `Idempotency-Key` header. Audit Item 5.
 *
 * Scope: per-guard, per-endpoint (the `scope` argument to `idempotent(...)`),
 * keyed by the client-supplied UUID. 10-min TTL, ~1000-entry LRU.
 *
 * What's cached: anything the handler emits via `res.status(...).json(...)`.
 * Both successful (2xx, 201) AND failed (4xx) responses are cached, because
 * a retry of an attempt that legitimately rejected (e.g. 422 GEOFENCE_FAILED,
 * 409 already-clocked-in, 404 shift-not-found) should yield the SAME outcome
 * — not a fresh execution that could double-create or surface a different
 * error.
 *
 * NOTE: only res.json / res.status responses are cached. Unhandled throws
 * route through Express's default error handler which uses res.end(html)
 * and bypasses this middleware. That's intentional — caching a 500 from
 * an unexpected exception would prevent legitimate retries of transient
 * failures (DB lock contention, network blips). Anomalous 500s should
 * always re-execute on retry.
 *
 * Capacity: 1000 entries × 10-min TTL = headroom for ~6000 attempts/hour
 * before LRU eviction starts displacing live keys. If we ever hit that
 * ceiling, we're at a scale where this should be Redis, not in-process.
 *
 * Data integrity backstop: the `idx_shift_sessions_one_open_per_guard`
 * partial unique index in schema_v9.sql is still the last-line defense.
 * If a process restart loses the cache mid-replay window, the index turns
 * the would-be duplicate insert into a 23505 → 409 the client handles.
 */
import type { Request, Response, NextFunction } from 'express';

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;

interface CacheEntry {
  status: number;
  body: unknown;
  expiresAt: number;
}

// Map preserves insertion order — we use that for LRU eviction. On get we
// delete + re-insert to bump to MRU; on overflow we delete the oldest key
// (first iteration entry).
const store = new Map<string, CacheEntry>();

function get(key: string): CacheEntry | null {
  const e = store.get(key);
  if (!e) return null;
  if (e.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  // Bump to MRU
  store.delete(key);
  store.set(key, e);
  return e;
}

function set(key: string, status: number, body: unknown): void {
  if (store.has(key)) store.delete(key);
  store.set(key, { status, body, expiresAt: Date.now() + TTL_MS });
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
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
 *  - Cache miss → patch res.status / res.json so the response is cached
 *    on its way out, then call next(). Both happy- and error-path
 *    responses get cached.
 */
export function idempotent(scope: string) {
  return function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
    const key = req.header('Idempotency-Key');
    if (!key || !req.user?.sub) {
      return next();
    }

    const cacheKey = `${req.user.sub}:${scope}:${key}`;
    const cached = get(cacheKey);
    if (cached) {
      res.setHeader('Idempotent-Replay', 'true');
      res.status(cached.status).json(cached.body);
      return;
    }

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
      set(cacheKey, capturedStatus, body);
      return origJson(body);
    }) as Response['json'];

    next();
  };
}
