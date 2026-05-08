# Phase 2 — Security audit

## Score: 6.5/10

Solid foundational security (parameterized SQL, RBAC, multi-tenant scoping), but gaps in rate limiting, token revocation, and secret handling.

## CRITICAL

### C1. Unsafe CORS fallback with credentials
**File**: `apps/api/src/index.ts:50`
```ts
origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : true,
credentials: true,
```
If `ALLOWED_ORIGINS` is ever unset (typo, deploy env drift, rollback), any origin can make authenticated cross-origin requests. Fail-closed, not fail-open. Impact: account takeover via malicious site + stolen session.

**Fix**: throw on startup if `ALLOWED_ORIGINS` is missing in production.

### C2. `POST /api/auth/forgot-password` not rate-limited per-target
**File**: `apps/api/src/routes/auth.ts:466`
Only the global 500/15m limiter applies. Attackers can spam reset emails (email bombing + account enumeration) and burn SendGrid quota.

**Fix**: dedicated limiter — 5 requests / hour / email.

### C3. OTP guard-unlock endpoints brute-forceable
**Files**: `apps/api/src/routes/auth.ts:371, 420`
`request-unlock` and `verify-unlock` only hit the 500/15m global. A 6-digit OTP has 1M combos; at 500/15m = 2000/hr the full space falls in ~500 hrs — but `verify-unlock` has no per-account lock, so distributed brute force is cheap.

**Fix**: lock OTP after 3 failed verifies for 1 hr; rotate OTP on every failed attempt.

### C4. Client PDF endpoint accepts JWT in query string
**File**: `apps/api/src/routes/clientPortal.ts:144-157`
```ts
const rawToken = req.query.token as string;
```
Token leaks into: Railway access logs, browser history, `Referer` headers. Anyone with log access (or a shared machine) gets a long-lived client JWT.

**Fix**: switch to `Authorization: Bearer` header (same as every other route) or issue a short-lived signed download URL server-side.

## MAJOR

### M1. Access tokens not revocable
**File**: `apps/api/src/middleware/auth.ts:26-59`
`requireAuth` only calls `jwt.verify` then checks guard `is_active`. It does NOT consult `revoked_tokens`. Only the `/refresh` endpoint at `auth.ts:281-292` checks the table. Logout revokes the refresh JTI but the access token remains valid until `exp`.

The admin "revoke guard session" at `auth.ts:321-337` only clears FCM; the token keeps working. For a security product this is a compliance red flag.

**Fix**: add `jti` to access tokens too, check `revoked_tokens` on every request; OR drop access-token TTL to 15 minutes.

### M2. Photo URL trust in reports
**File**: `apps/api/src/routes/reports.ts:98-107`
```ts
await pool.query(
  `INSERT INTO report_photos (report_id, storage_url, ...) VALUES ($1, $2, ...)`,
  [report.id, photo_urls[i].url, ...]
);
```
The URL is stored verbatim with no check that it's from the company's S3 prefix or that the uploading guard owns it. A guard can submit someone else's photo URL as their own evidence. Chain-of-custody broken.

**Fix**: validate URL matches `https://{S3_BUCKET}.s3.{REGION}.amazonaws.com/reports/{company_id}/{guard_id}/` prefix.

### M3. Inconsistent bcrypt cost
**File**: `apps/api/src/routes/admin.ts:93` uses cost 10; other routes use 12. ~4× weaker for super-admin-created company admins.

**Fix**: use 12 everywhere.

## MINOR

### m1. Missing helmet / security headers
**File**: `apps/api/src/index.ts`
No `helmet`, no `X-Frame-Options`, no CSP, no `X-Content-Type-Options`. Low risk for an API-only service but cheap to add.

### m2. Type hole in verify-password
**File**: `apps/api/src/routes/auth.ts:148` uses `(req as any).user.id` — `AuthPayload` only has `sub`. Fails safe (returns 404) but indicates missing TS strictness.

### m3. S3 presigned URL lifetime (5 min) reasonable but not centrally configured
**File**: `apps/api/src/services/s3.ts:17` (`Expires: 300`). Fine, but consider 60-120s for clock-in verification photos.

### m4. OTP hash presence in `login_attempts`
`otp_hash` + `otp_expires_at` columns are hashed but there's no explicit pepper and no account-unlock audit trail beyond `auth_events`.

## WORKING WELL

- **SQL injection**: every `pool.query(...)` uses `$1, $2` placeholders. No template-string interpolation of user input found.
- **Password hashes never returned**: `SELECT password_hash` queries (auth.ts:46, 119, 147, 168, 190, 219) only feed `bcrypt.compare`; response bodies never include the field.
- **Multi-tenant isolation on admin routes**: `WHERE company_id = req.user!.company_id` consistently in `admin.ts:182, 221, 256`.
- **Client portal IDOR**: site_id sourced from JWT (`req.user!.site_id`) in every `clientPortal.ts` route. No `req.params.siteId` trust.
- **Anthropic key**: only referenced in `apps/api/src/routes/ai.ts` — never in web or mobile (verified via grep).
- **RBAC**: every admin route uses `requireAuth('company_admin')` or `requirePrimaryAdmin()`; every super-admin route `requireAuth('vishnu')`; guard routes `requireAuth('guard')`. No role-escalation path found.

## Route inventory (subset — focus on auth boundaries)

| METHOD | PATH | AUTH | FILE:LINE |
|---|---|---|---|
| POST | /api/auth/guard/login | none | auth.ts:41 |
| POST | /api/auth/admin/login | none | auth.ts:185 |
| POST | /api/auth/client/login | none | auth.ts:214 |
| POST | /api/auth/vishnu/login | none | auth.ts:248 |
| POST | /api/auth/refresh | none | auth.ts:269 |
| POST | /api/auth/forgot-password | none | auth.ts:466 |
| POST | /api/auth/reset-password | none | auth.ts:511 |
| POST | /api/auth/guard/request-unlock | none | auth.ts:371 |
| POST | /api/auth/guard/verify-unlock | none | auth.ts:420 |
| GET  | /api/client/reports/pdf | query-param token (!) | clientPortal.ts:144 |
| POST | /api/shifts/:id/clock-in | guard | shifts.ts:199 |
| POST | /api/locations/ping | guard | locations.ts:25 |
| POST | /api/reports | guard | reports.ts:54 |
| GET  | /api/admin/kpis | company_admin | admin.ts:182 |
| POST | /api/admin/companies/:id/admins | vishnu | admin.ts:87 |
| POST | /api/ai/enhance-description | guard,company_admin | ai.ts:20 |

All unauthenticated routes are expected login/reset endpoints. No missed `requireAuth`.
