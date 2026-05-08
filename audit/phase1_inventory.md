# Phase 1 — Inventory

## Repo layout (monorepo, Turbo)

| Path | Stack | Purpose |
|---|---|---|
| `apps/api/` | Node 18 + Express 4 + TS | Backend REST API (Railway) |
| `apps/web/` | Next.js 14 App Router | Web portals (admin, client, super admin) — Vercel |
| `apps/mobile/` | Expo RN (router) | Guard mobile app |
| `packages/` | shared (see: `packages/` dir exists, content TBD) | - |

## API routes module inventory — `apps/api/src/routes/*.ts`

```
admin.ts         — company admin portal
ai.ts            — Anthropic enhancement proxy
auth.ts          — login / refresh / forgot / reset / logout
clientPortal.ts  — client-facing read endpoints
clients.ts       — client CRUD (admin-scoped)
exports.ts       — PDF report exports
guards.ts        — guard CRUD + assignment
locations.ts     — GPS ping ingest + geofence
reports.ts       — reports submit/list
shifts.ts        — shift CRUD + clock-in/out
sites.ts         — site CRUD
tasks.ts         — task templates + instances + completions
uploads.ts       — S3 presigned URL issuer
```

Mount points (`apps/api/src/index.ts:67-79`):
```
POST /api/auth/*   (authLimiter: 20/15m)
/api/shifts, /api/reports, /api/locations, /api/tasks,
/api/sites, /api/guards, /api/clients, /api/admin,
/api/exports, /api/uploads, /api/client, /api/ai
— all behind the global 500/15m limiter
```

## Jobs (cron) — `apps/api/src/jobs/*.ts`

```
autoCompleteShifts.ts       — close shifts past scheduled_end
dailyShiftEmail.ts          — end-of-day client summary
missedShiftAlert.ts         — alert if no clock-in 30m past start
monthlyRetentionNotice.ts   — retention warnings (60/89/140)
nightlyPurge.ts             — delete reports/photos at retention
```

Imported side-effect style at `apps/api/src/index.ts:24-28`. **No external scheduler (Railway cron / pg_cron) — all self-scheduled node-cron in-process.**

## DB schema (live dump)

23 tables. Already saved — full column/constraint dump is embedded below.

Tables: `auth_events, break_sessions, clients, clock_in_verifications, companies, company_admins, data_retention_log, geofence_violations, guard_site_assignments, guards, location_pings, login_attempts, password_reset_tokens, report_photos, reports, revoked_tokens, shift_sessions, shifts, site_geofence, sites, task_completions, task_instances, task_templates`.

No `users` table; role-partitioned auth across `guards`, `company_admins`, `clients`, plus env-hardcoded super-admin (`VISHNU_EMAIL`, `VISHNU_PASSWORD_HASH`).

## Env vars referenced in `apps/api/.env`

```
DATABASE_URL
JWT_SECRET, JWT_REFRESH_SECRET, VISHNU_JWT_SECRET, CLIENT_JWT_SECRET   (4 secrets!)
VISHNU_EMAIL, VISHNU_PASSWORD_HASH
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET
SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, VISHNU_EMAIL_ALERTS
ALLOWED_ORIGINS
GOOGLE_MAPS_API_KEY
PORT
```

**Not visible in `.env` but referenced in code (need Railway check):**
- `ANTHROPIC_API_KEY` — used by `routes/ai.ts`; if unset in Railway, AI enhancement silently fails.
- FCM/Firebase — `services/firebase.ts` referenced; key location unclear.

## Live row counts (snapshot)

```
guards=6, shifts=8, shift_sessions=6, sites=3, companies=2, clients=3,
company_admins=2, reports=29, location_pings=28, geofence_violations=0,
data_retention_log=3, auth_events=169, revoked_tokens=16
```

Dev/test data only — no real paying customer load yet.

## Indexes worth noting

- `idx_company_admins_one_primary` — partial UNIQUE on `(company_id) WHERE is_primary`. Good.
- `idx_guards_company WHERE is_active` — good.
- `idx_location_pings_session_time` — good query path for dashboard.
- **Missing**: partial UNIQUE on `shift_sessions (guard_id) WHERE clocked_out_at IS NULL` — allows double-clock-in races. Critical gap.

## What I could NOT verify in Phase 1 (UNVERIFIED)

- Vercel env var inventory (need user to paste `vercel env ls`).
- Railway env var inventory (need user to paste).
- Last successful cron execution (no `cron_runs` table; only inferable from `auth_events`, `shifts.missed_alert_sent_at` fields).
