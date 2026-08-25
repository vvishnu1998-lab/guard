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

- **STARNET SECURITY** (tenant `27c4d404-...`) is a REAL PAYING CUSTOMER. Admin: info@starnetsecurity.com (Nataniel); client Sai receives daily reports.
- STARNET's FORWARD coverage is **Bethel AME Church** — deepak naik GRD0004 (20 future shifts) and Nikith Reddy GRD0005 (9). **23000 Cristo Rey Los Altos has ZERO future shifts.** Bhanu GRD0001 worked Cristo Rey on 2026-08-20 (his only shift there in 21 days); Nandu GRD0002 worked it 2026-08-16 → 08-19. Verified against `shifts` 2026-08-21.
- **Rosters change — re-verify against `shifts` before asserting who is on post.** The line above is a snapshot, not a standing fact; "Bhanu works Cristo Rey overnights" was carried in this file long after his schedule there ended.
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
- **Read the migration chain from `apps/api/src/db/migrate.ts` at the start of EVERY session. Never from memory, never from a dispatch, never from this file.** The chain is an explicit array and it moves within a session. Writing `schema_vN.sql` over an existing file silently destroys a shipped migration and changes history on any replay-from-empty. Two collisions have been caught this way on stale numbers (v46 — Break enforcement; v51 — location integrity review queue, taken *the same day* it was quoted as free). `ls schema_v*.sql | sort -V | tail -1` and the tail of the `files` array in `migrate.ts` are the only sources of truth.

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
- **Postgres-service vars are LITERALS, not template references.** `POSTGRES_PASSWORD`, `PGPASSWORD`, `DATABASE_URL`, `DATABASE_PUBLIC_URL` each hold their own copy of the password. **Setting `POSTGRES_PASSWORD` alone does NOT propagate to the other three.** Rotation is: `ALTER USER` FIRST, then FOUR explicit `railway variable set --skip-deploys` writes on the Postgres service, then a FIFTH on the guard service's `DATABASE_URL` literal — that last one auto-triggers the API redeploy. Five var writes, not one. (This file previously claimed template refs; that was wrong and would have left three vars stale mid-rotation.)

## Cross-tier consistency

- **When a reject path is removed server-side, audit every client that branches on it IN THE SAME DISPATCH.** A server that stops refusing does not make the client stop refusing; the guard still cannot proceed, and the fix reads as shipped because the server half is correct.
  - Precedent 1: `5dd8077` (2026-08-22) made clock-out persist-and-flag instead of rejecting on geofence. `apps/mobile/app/clock-out/index.tsx:85` kept throwing `GuardFacingError('GPS lock failed…')` and refusing to close the shift until `d4af9cb` (2026-08-24) — **two days during which the removal had no effect for any guard whose GPS was bad**, which is the entire population it was written for.
  - Precedent 2: the checkpoint error codes on the same date — one side fixed, the other never checked.
  - The tell is a comment that describes the server correctly while the code above it contradicts it. That file's own comment already read *"clock-out PERSISTS AND FLAGS server-side; it is never rejected"* five lines below the throw. **A correct comment next to contradicting code is evidence of a half-finished cross-tier change, not of correct behaviour.**
- Corollary: grep the mobile app for the removed condition before closing the dispatch. Client refusals are invisible in server logs — nothing reaches the API to be logged, so the absence of errors reads as success.

## Clock-out reality (measured 2026-08-24)

- **75% of all sessions since 2026-07-01 auto-closed (45/60); 78% for STARNET (14/18).** Bhanu 3/3, Nandu 4/4, deepak naik 3/3 — the highest-volume real guards have **never once** completed a manual clock-out.
- **No manual clock-out has EVER landed within 20 minutes of `scheduled_end`** — the closest is 20.9 min early, and the median is well over an hour. Every manual clock-out in the dataset is a guard leaving *early*.
- Cause is structural, not behavioural: the deployed sweep closes the session **at `scheduled_end`**, so a guard working their full shift has no window in which to clock out manually. `cee458f` moves it to `scheduled_end + 30 min` and is **on main but NOT deployed** — until it deploys, anything hung off manual clock-out (photo, reason, overtime) is a dead path by construction for full-shift guards.
- Therefore: the GPS hard-fail above is a *candidate* contributor to Bhanu's 2026-08-20 non-clock-out (auto-closed, all `clock_out_*` NULL — verified), but the zero-grace sweep explains it on its own. Do not attribute to the client refusal what the sweep already accounts for.

## Deploy gate

- Standing gate for API deploys touching guard/shift/login paths: push in the 0-90s window after a STARNET ping row lands. The ping is a *proxy* for "a guard's app is alive and just checked in, so we have maximum time before the next interaction".
- **The gate is satisfied by the CONDITION, not the proxy.** With 0 active shifts and 0 open sessions for the customer, no ping can land — the proxy is unsatisfiable while the thing it protects (nobody on post to disrupt) is trivially true. Deploying in that state is the safest window, not a bypass.
- Exercised 2026-08-24 16:28 UTC (`d497416..f2dae17`, deployment `e73be1b4`) on the CONDITION: 0 active STARNET shifts, 0 open sessions, last ping 2h55m stale. Approved explicitly on that reasoning.
- Exercised again 2026-08-24 23:32 UTC (`e22cb2e..4c5be77`, deployment `f8f6aafa`) on the PROXY, the normal path: Nikith Reddy pinged 23:32:28.142Z and the push went 27s later. Three sessions were open, so the zero-open-sessions exception did NOT apply and was not leaned on. **Record which of the two you used — they are not interchangeable.**
- Watching for the ping is a poll, and the predicate is the trap. A first attempt compared `pinged_at > '…20:35:42.698Z'` against a stored `…698954`, so a 2.5-hour-old row satisfied it and the watcher reported the gate open. Encode the gate itself — `pinged_at > NOW() - INTERVAL '75 seconds'` — and validate it returns NOTHING before arming.

## Verification norms for this project

- 3-viewport check on web UI changes: 375 / 390 / 1280px. Playwright ≠ real device — phone smoke test before "verified".
- Post-deploy verification via Railway logs / Sentry / curl evidence, per commit.
- For launch/status questions, search past chats — memory lags same-day sessions.
