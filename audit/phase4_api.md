# Phase 4 — API / backend

## Score: 6/10

SQL is clean, route organization is sensible, and cron jobs exist for every intended background task. What drags the score: no global error handler, raw DB error messages bleed to clients, four separate JWT secrets with no rotation plan, and no external scheduler for crons.

## CRITICAL

### C1. No global error handler — stack trace leak risk
**File**: `apps/api/src/index.ts:49-85`
`express-async-errors` is imported (line 2) but no `app.use((err, req, res, next) => ...)` is registered. Express falls back to its default handler, which includes the full stack in `NODE_ENV !== 'production'`. One accidental deploy without `NODE_ENV=production` on Railway exposes internal paths, package versions, and in some cases secrets that appear in stack frames.

**Fix**: add a terminal handler that logs server-side but responds with `{ error: 'Internal server error' }` + the HTTP status, regardless of env.

### C2. Raw Postgres error messages returned to clients
**Files**: `guards.ts:66`, `shifts.ts:172, 194, 262`, `ai.ts:63`
```ts
res.status(500).json({ error: err.message ?? '...' });
```
Postgres errors include constraint names (`duplicate key value violates unique constraint "guards_email_key"`), column names, and sometimes literal values. That's reconnaissance material for an attacker and inconsistent UX for a client (error shape is "human-ish string from DB" vs the structured messages elsewhere).

**Fix**: map known Postgres error codes (`23505` unique violation, `23503` fk violation, `23514` check violation) to friendly strings; everything else → generic 500.

## MAJOR

### M1. Cron jobs run in-process, single-instance assumed
**File**: `apps/api/src/index.ts:24-28`
All 5 jobs (`nightlyPurge`, `dailyShiftEmail`, `monthlyRetentionNotice`, `missedShiftAlert`, `autoCompleteShifts`) are `import`ed as side effects → `node-cron` registers them in the same process that serves API traffic.

Consequences:
1. If Railway scales API to >1 replica, every replica fires every cron → duplicated retention emails, concurrent hard-deletes.
2. If the API restarts at 00:00:01 UTC, `nightlyPurge` is skipped for 24h and nothing surfaces that fact.
3. Long-running crons (retention purge has transaction over multiple tables) block the event loop and slow concurrent API requests.

**Fix options**:
- **Cheap**: add a `pg_advisory_lock` at the start of each job.
- **Right**: move to Railway scheduled jobs or a separate worker dyno; add a `cron_runs` table written at start/end of every execution so "did it run?" is queryable.

### M2. Four JWT secrets, no rotation scheme
**File**: `apps/api/.env`
`JWT_SECRET`, `JWT_REFRESH_SECRET`, `VISHNU_JWT_SECRET`, `CLIENT_JWT_SECRET` — all long-lived, all static. If any one leaks (e.g., via Railway log screenshot), the only remediation is a forced redeploy with a new value, which instantly invalidates every issued token and logs every user out. There is no `kid` header, no signing-key rotation, no grace window.

**Fix**: support dual-key verification (`kid` header + an array of accepted keys) so you can rotate without a forced logout.

### M3. Inconsistent status codes for input validation
Most routes return `400` for missing params (`shifts.ts:179`, `locations.ts:29`) but a handful rely on the try/catch + `500`. Clients can't programmatically distinguish "you sent bad input" from "the server exploded." For a B2B API this matters; monitoring will under-report real 500s because validation errors pollute the bucket.

### M4. Rate limiter keyed by IP only
**File**: `apps/api/src/index.ts:35-47`
`express-rate-limit` defaults to `req.ip`. Multi-tenant means multiple companies behind corporate NAT share one IP; one noisy company can lock out another. Auth endpoints (20/15m) are especially prone to this — a single brute-force attempt effectively DoSes every legitimate admin on that egress IP.

**Fix**: keyGenerator = `req.ip + ':' + (req.body?.email ?? '')` for auth endpoints; keep IP-only for write endpoints.

## MINOR

- **No request ID / correlation ID middleware.** `console.error` writes to Railway logs without any way to tie a log line to a client-reported failure.
- **`health` endpoint exposes DB status but no version.** Deploy rollback visibility is zero — can't verify which commit is running without SSH + `git log`.
- **`/api/ai/enhance-description`** passes user-submitted text to Anthropic API. No rate limit per user, no size cap beyond the route handler (verify in `ai.ts:20`). One guard can burn the whole `ANTHROPIC_API_KEY` budget.
- **No CSRF token.** Cookies store refresh tokens (`client/login/page.tsx:50` sets `guard_admin_refresh` cookie). Combined with `credentials: true` CORS, any origin allowed by `ALLOWED_ORIGINS` can CSRF an authenticated admin. Fine if ALLOWED_ORIGINS is locked down; risky if a subdomain ever gets compromised.
- **`trust proxy: 1`** (`index.ts:31`) is correct behind Railway's single proxy layer. No issue — noting because it's easy to get wrong and this one is right.

## WORKING WELL

- **`express-async-errors`** is imported — async route handlers won't silently swallow rejections.
- **Parameterized queries everywhere** — see Phase 2, no template-string interpolation.
- **Clear route module organization** — one file per domain (shifts, reports, guards, sites, clients, tasks, locations, admin, clientPortal, exports, uploads, ai, auth). Easy to reason about.
- **Clock-in handler is transactional** (`shifts.ts:199-231`) — the pattern to copy for clock-out (see Phase 3 C2).
- **Job names are self-documenting**: `autoCompleteShifts`, `dailyShiftEmail`, `missedShiftAlert`, `monthlyRetentionNotice`, `nightlyPurge`. No cleverness.

## UNVERIFIED

- Last successful execution of each cron (no `cron_runs` table, no structured "job ran" log — only `shifts.missed_alert_sent_at` for missed-shift and `data_retention_log.notification_*_sent_at` for retention). Worth adding in Phase 8 gap list.
- Railway env parity with `apps/api/.env` (need `railway variables`).
- Actual Anthropic spend per month (no dashboard link saved).
