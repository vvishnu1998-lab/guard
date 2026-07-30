---
name: netraops-invariants
description: Ground-truth invariants for the NetraOps codebase and production environment — schema quirks, geofence rules, tenant/customer state, build system gotchas, and freeze policies. Use this skill in EVERY conversation about NetraOps, the guard platform, its repo (~/guard), its API/web/mobile apps, Railway/Vercel/EAS deployments, or the STARNET SECURITY customer — before planning, dispatching, or asserting anything about the system.
---

# NetraOps Invariants

Verified ground truth for the NetraOps platform. When live state may have changed, verify — but never contradict these invariants without evidence.

## Platform

- Monorepo `/Users/vishnuvardhanreddy/guard` (GitHub `vvishnu1998-lab/guard`).
- `apps/api` Node/Express/TS → Railway. `apps/web` Next.js App Router → Vercel (www.netraops.com canonical, auto-deploy on ff-merge to main). `apps/mobile` Expo/RN → EAS.
- Services: Railway Postgres, AWS S3 `guard-media-prod` (us-east-1), Firebase FCM, SendGrid (`alerts@em6648.netraops.com`), Sentry (react-native + netraops-api), Google Maps, Anthropic API.
- Brand: navy `#0B1526`, cyan `#00C8FF`, gold `#C9A84C`. Bundle `com.netraops.guard`.

## Live customer — freeze policy

- **STARNET SECURITY** (tenant `27c4d404-...`) is a REAL PAYING CUSTOMER. Admin: info@starnetsecurity.com (Nataniel); guard Bhanu GRD0001 works overnight shifts at 23000 Cristo Rey Los Altos; client Sai receives daily reports.
- No disruptive prod changes during active customer shifts without explicit approval. Check the clock before every deploy touching guard/shift/login paths.
- Any temporary Apple-review accommodation (widened geofences, seeded reviewer accounts/shifts) is frozen until approval and carries a logged revert task with original values.

## Schema invariants

- `site_geofence` is the source of truth for geofence validation — NOT `sites.geocoded_lat/lng` (editor pre-fill only).
- `shifts`: no `tenant_id`, no `timezone`, no `updated_at`. Scope via `guard_id`+`site_id`. NOT NULL: `site_id`, `guard_id`, `scheduled_start`, `scheduled_end`, `status`.
- `task_instances` has no `guard_id` — derive via JOIN on `shifts.guard_id`.
- `company_admins` has no `fcm_token` — including it in a SELECT throws 42703 and silently kills downstream awaits. Probe `information_schema` before referencing any column.
- `notifications` has no TTL columns — retention is application-layer (LIMIT 100).
- Timezone anchor: `CURRENT_DATE` in a UTC session at ~01:xx UTC resolves to tomorrow PT. Anchor via `(NOW() AT TIME ZONE 'America/Los_Angeles')::date`.
- Known bug class: DOW off-by-one in `repeat_days` expansion (Node UTC vs Pacific near midnight).

## Geofence behavior

- Server validation: `polygonOk OR radiusOk`.
- Mobile diverges: radius-gate 1.5× AND `isPointInPolygon`; null polygon crashes mobile (`apps/mobile/utils/geofence.ts:8`, no null guard).
- Mobile caches `pendingShift.geofence` at shift load — server-side changes don't propagate to open apps. Refresh path: force-quit + re-login; nuclear: reinstall.

## Build/release invariants

- EAS remote versioning (`appVersionSource: 'remote'` + `autoIncrement`) is source of truth — `app.json` buildNumber/versionCode are ignored and lag.
- `batch/mobile-N+1` is cut off `batch/mobile-N`, NEVER off main (cutting off main regressed Build 34's scope once).
- `babel.config.js`: `react-native-worklets/plugin` must be the LAST Babel transform or the app crashes pre-splash.
- iOS `eas submit` auto-resolves ASC keys from Expo server storage; Android needs local `google-service-account.json` (manual Console upload is the fallback).
- `npm start` does NOT run migrations. Run via `railway run npm run db:migrate` or `DATABASE_PUBLIC_URL` from workstation; `postgres.railway.internal` resolves only inside Railway.
- Migration pattern: `railway connect Postgres` piped SQL with `-v ON_ERROR_STOP=1`.

## Locked decisions (do not relitigate)

- Hours display: 4 fields (Scheduled/Actual/Break/Violation), no aggregate total. `actual_hours` = raw clock-out − clock-in. `violation=0` → "None"; `scheduled=0` → "—"; `actual/break=0` → "0h 00m". UI HH:MM, API decimal, XLSX decimal.
- Marketing: no public pricing page; one-month free trial is the offer; homepage stays gold `#C9A84C`; no fabricated metrics; staged fictional demo data OK.
- Positioning: enforcement vs tracking; client portal + no-show escalation + photo-verified pings vs Connecteam-class tools.

## Env/credentials handling

- Vercel/Railway env vars: `printf "%s" | vercel env add` only; verify with pull + length check.
- Super-admin auth uses `VISHNU_JWT_SECRET`; `CLIENT_JWT_SECRET` on Railway is stale legacy (`secretForRole('client')` returns `JWT_SECRET`).
- Secrets appearing in screenshots/chats get rotated immediately (SendGrid key precedent).

## Verification norms for this project

- 3-viewport check on web UI changes: 375 / 390 / 1280px. Playwright ≠ real device — phone smoke test before "verified".
- Post-deploy verification via Railway logs / Sentry / curl evidence, per commit.
- For launch/status questions, search past chats — memory lags same-day sessions.
