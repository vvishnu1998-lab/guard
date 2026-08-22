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
- **DETECTION ≠ VALIDATION on mobile — do not conflate them.** Background boundary detection is native OS region monitoring (`Location.startGeofencingAsync`, `tasks/locationBackground.ts:176`): ONE circular region, `identifier: 'active_post'`, centre + `radius_meters`, Enter/Exit. **No polygon and no JS math are involved in detection.** Reading the JS containment helpers as the breach detector is the misreading that made an audit describe code no user runs.
- JS containment (`utils/geofence.ts`) is a client-side PRE-FLIGHT on submission screens only, never a detector. `isInsideGeofence` (:71) mirrors the server — polygon OR radius, never AND: usable polygon (≥3 verts) → polygon test alone; otherwise `distance <= radius + accuracy + 20m`. Deliberately does not fail closed; the server is the authority. Callers: `clock-in/step1.tsx:80`, `shifts/[id]/handoff-clock-in.tsx:199`, `violation/[violationId].tsx:81`.
- The 1.5× radius figure is a cheap short-circuit ahead of the polygon test on two screens only (`clock-in/step1.tsx:67`, `handoff-clock-in.tsx:186`), both gated on `polygonUsable` — it is not a general radius gate and is not ANDed with the polygon test.
- Null polygon no longer crashes mobile (fixed `f2eab42`, on main since `c9cb986`). `hasUsablePolygon()` at `utils/geofence.ts:13`; `isPointInPolygon` guards on it at :28, `isInsideGeofence` at :81.
- Mobile caches `activeShift.geofence` at clock-in — server-side geofence edits do NOT propagate to an app with a shift in progress. `refreshFromServer` (`store/shiftStore.ts:127`, fired on AppState→active `_layout.tsx:254` w/ 2s throttle, and home `useFocusEffect` `home.tsx:173`) only ever CLEARS a dead session; it deliberately never rewrites `activeShift`, or it would tear down region monitoring. Only `setActiveSession` rehydrates the fence: clock-in (`clock-in/step4.tsx:190`) or `restoreOrFetchShift`, which runs only `if (!isOnShift)` (`home.tsx:268`). Refresh path: force-quit is enough (the store is in-memory, so relaunch re-fetches) — re-login is NOT required; nuclear: reinstall.

## Error contract (API to mobile)

- **NEVER branch on error prose. Branch on status PLUS code, or on payload shape.** `err.message` is copy — it gets reworded, and every reword silently breaks whatever was matching it. `ApiError.code` carries the server's `error` field for exactly this purpose. Two live bugs from this in one day (2026-08-22): `checkpoints/scan.tsx` keyed on `err.status === 422 && linkMode` and rendered `MOCK_LOCATION_REJECTED` as "GPS signal too weak", telling the guard to fix their signal when the cause was a device setting; `(auth)/login.tsx` tested `msg.includes('locked')` for the lockout dialog, but the server's 423 copy reads "Too many failed attempts. Try again in 30 minutes or contact your supervisor." — no such substring, so that dialog had been **unreachable** since the copy was reworded. A third instance was already fixed once at `clock-in/step4.tsx` (`err.message === 'GEOFENCE_FAILED'`); the comment there records it.
- **Every guard GPS write route returns MORE THAN ONE 422** since Wave 2 — its own off-post/quota/window failure plus `MOCK_LOCATION_REJECTED`. Status alone has not been a usable discriminator on any of them since 2026-08-22.
- **`error` is a CODE, `message` is the copy.** A route putting a sentence in `error` leaves the client nothing to branch on, which is what forced `scan.tsx` onto status in the first place.

## Build/release invariants

- EAS remote versioning (`appVersionSource: 'remote'` + `autoIncrement`) is source of truth — `app.json` buildNumber/versionCode are ignored and lag.
- Mobile accumulates on `batch/mobile-N`; no builds until explicitly triggered. Once a build from that branch ships to TestFlight, merge the branch to main (`--no-ff`, NEVER squash — the individual commits are the record of what shipped in each build), then cut `batch/mobile-N+1` **from main**. Caps drift at one build. (Merge `c9cb986` closed the backlog; `batch/mobile-10` is the first branch cut under this rule.)
- The rule this replaced was "never cut from main", which existed because cutting from a STALE main once regressed Build 34's scope. That failure mode is real and is NOT reintroduced: cutting from main is safe only because main now absorbs each shipped batch. Cutting from a main that has NOT absorbed the last shipped batch regresses exactly as before — verify absorption first.
- Cost of the old rule, for anyone tempted to reinstate it: apps/mobile on main went four weeks stale and carried a DIFFERENT architecture from every shipped binary (periodic `startLocationUpdatesAsync` vs native `startGeofencingAsync`). An audit read main, described code no user runs, and produced a wrong conclusion about an Apple App Review submission. The failure is silent — `git status` clean, file present, compiles.
- Standing check: any audit of mobile BEHAVIOUR must state which ref it read. The working tree is NOT authoritative for mobile unless main has absorbed the last shipped batch — otherwise read the build commit via `git show <sha>:<path>`.
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
- DB credentials rotated 2026-07-31. The `guard-postgres` superuser MCP was deleted that day — NEVER re-add it; `postgres-readonly` (user scope) is the only DB MCP.
- `railway variable set` supports `--skip-deploys` (use it for Postgres-service var updates — a mid-rotation Postgres restart is never acceptable).
- Postgres-service vars `PGPASSWORD` / `DATABASE_URL` / `DATABASE_PUBLIC_URL` are template references off `POSTGRES_PASSWORD` — setting that one var propagates all four. The guard API's `DATABASE_URL` is a LITERAL copy — on rotation it must be set explicitly, which auto-triggers the API redeploy.

## Verification norms for this project

- 3-viewport check on web UI changes: 375 / 390 / 1280px. Playwright ≠ real device — phone smoke test before "verified".
- Post-deploy verification via Railway logs / Sentry / curl evidence, per commit.
- For launch/status questions, search past chats — memory lags same-day sessions.
