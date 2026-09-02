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

- **STARNET SECURITY** (tenant `27c4d404-8769-49ca-bfd6-93cb9b890067`) is a REAL PAYING CUSTOMER. Admin: info@starnetsecurity.com (Nataniel); client Sai receives daily reports.
- **Use the FULL id above — never a truncated `27c4d404-...` form.** This file carried the ellipsis until 2026-08-25, and a gate query written from it (`27c4d404-0000-0000-0000-000000000000`) returned ZERO ROWS and read as "no open STARNET sessions, gate is open". There was an open session. An empty result from a wrong id is indistinguishable from an empty result from a true condition — resolve the tenant by name (`SELECT id FROM companies WHERE name = 'STARNET SECURITY'`) if you ever doubt it. Two other tenants exist with confusable names: `Star Guard` (`b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee`, the TEST tenant) and a separate lowercase `starnet` (`1bba063e-a0df-4593-9466-81ee58bebc3d`). Neither is the paying customer.
- STARNET's FORWARD coverage spans BOTH sites. **Bethel AME Church** — deepak naik GRD0004 (18 future shifts) and Nikith Reddy GRD0005 (12), plus **11 future shifts still UNASSIGNED**. **23000 Cristo Rey Los Altos — Naveen Yatakari GRD0009 (7 future, through 2026-09-01)**, who was clocked in on post there at the time of writing. Bhanu GRD0001, Nandu GRD0002, vamshi krishna GRD0006 and Anil GRD0007 all have PAST Cristo Rey shifts and zero forward. Verified against `shifts` 2026-08-25.
- **Rosters change — re-verify against `shifts` before asserting who is on post.** The line above is a snapshot, not a standing fact. This has now failed TWICE: "Bhanu works Cristo Rey overnights" was carried here long after his schedule ended, and the 2026-08-21 snapshot asserting Cristo Rey had **ZERO** future shifts survived until 2026-08-25, by which point the site had 7 future shifts and a guard this file had never named (Naveen Yatakari GRD0009) clocked in on it. **A named-guard claim in this file older than a few days is wrong until re-queried.**
- **Badge numbers COLLIDE across tenants — a badge alone is NEVER an identifier.** Verified 2026-09-02: `GRD0005` is "naik" on Star Guard AND "Nikith Reddy" on STARNET SECURITY; `GRD0004` is **"deepak naik" on BOTH** Star Guard and STARNET SECURITY — same badge, same name, different tenant, different uuid; `GRD0001` collides across all three tenants (reddy / vishnu reddy / Bhanu). Always resolve by guard uuid, or tenant + badge. Reasoning from a name or a badge is how the 2026-08-31 push incident was nearly mis-attributed.
- Roster query: `SELECT c.name, g.badge_number, g.name, g.id, g.is_active, g.created_at FROM guards g JOIN companies c ON c.id = g.company_id ORDER BY c.name, g.created_at;`
- No disruptive prod changes during active customer shifts without explicit approval. Check the clock before every deploy touching guard/shift/login paths.
- Any temporary Apple-review accommodation (widened geofences, seeded reviewer accounts/shifts) is frozen until approval and carries a logged revert task with original values.

## Schema invariants

- `site_geofence` is the source of truth for geofence validation — NOT `sites.geocoded_lat/lng` (editor pre-fill only).
- `shifts`: no `tenant_id`, no `timezone`, no `updated_at`. Scope via `guard_id`+`site_id`. NOT NULL: `site_id`, `scheduled_start`, `scheduled_end`, `status`. **`guard_id` IS NULLABLE** — it is NULL for every `status='unassigned'` shift (15 in prod, 2026-08-25). This file previously listed `guard_id` as NOT NULL, which is wrong and would break any code that assumes a shift always has a guard. `status='unassigned'` <-> `guard_id IS NULL` holds across all 189 prod rows but is NOT enforced by any constraint — check both, never infer one from the other.
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
- **A MERGE can delete a feature while both parents look correct. `bd7e4e2` (2026-07-13) is the case.** `batch/mobile-3` owned a 498-line `(tabs)/alerts.tsx` holding the ONLY swap/handoff ACCEPT/DECLINE UI. The M3 line had a DIFFERENT 180-line `alerts.tsx` (the old violations list), which `85da501` deleted as an *"orphan … unreachable from any UI link"* — true of the file it was looking at, false of the same-named file on the other branch. The merge kept the deletion, kept batch/mobile-3's routing, and re-pointed the two `*_request_received` cases at `/shifts/{id}` under a comment claiming shift detail rendered an accept card. It never did. `GET /shifts/:id` 404s a recipient whose row is still `pending`, and `accepted` was only reachable through the deleted button. **Closed loop, 43 days, zero server errors** — a client that never calls is invisible. Restored in `4f15ee4`.
- **Therefore: when a merge deletes a file, read that path's last content on BOTH parents before accepting the deletion.** `git show <parent1>:<path>` and `git show <parent2>:<path>`, and compare line counts. Same filename, different file is the trap; `git log --diff-filter=D` names the deleting commit but not what the other side had. A justification written against one parent does not transfer.
- **`POST /shifts/:id/swap-response` and `/handoff-response` emit PROSE, not error codes — branch on `.status`, never `.code`, for those two routes.** Every failure is `{ error: '<English sentence>' }` with no `message` field, so `ApiError` (`lib/errors.ts:72`) sets `.code` to that sentence. `errors.ts`'s own doctrine says branch on `.code` not `.status`, and that is right for routes emitting an enum — these do not, and following it here means branching on prose that breaks the moment someone rewords a string. Status maps 1:1 to a situation class on both: 400 malformed / 403 not-addressed-to-you / 404 gone / 409 already-answered-or-stale / 422 eligibility (swap only) / 500. Pass 422 through verbatim — the server's sentence is the only place the eligibility detail exists. Giving these two routes real codes is an open API follow-up; until then `.status` is the only stable signal. Mobile does this in `notifications.tsx respondErrorCopy()`.
- `notifications.type` has **no CHECK constraint**, and `VALID_TYPES` (`routes/notifications.ts:17`) gates ONLY `POST /api/notifications`, the mobile self-report route — server crons calling `insertNotification` bypass it entirely. The real gate on a new type is `NotificationType` (server union) plus, on mobile, `navigateForNotification`: an unrecognised type has no case, so **the switch falls through and the tap does nothing** while `VISUAL_BY_TYPE`'s `?? chat` fallback still renders the row. Adding a type therefore requires the MOBILE case shipped FIRST, then the server switched over. Prefer reusing an existing type when the destination screen is the same.

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
- Watching for the ping is a poll, and the predicate is the trap. A first attempt compared `pinged_at > '…20:35:42.698Z'` against a stored `…698954`, so a 2.5-hour-old row satisfied it and the watcher reported the gate open. Encode the gate itself — `pinged_at > NOW() - INTERVAL '75 seconds'` — and validate it returns NOTHING before arming. Poll at **75s**, matching the interval, or the window falls between polls.
- **THREE routes exist and each is recorded differently. Name which one you used, every time.**
  1. **CONDITION** — 0 active shifts and 0 open sessions. The proxy is unsatisfiable while the thing it protects is trivially true. Safest window, not a bypass.
  2. **PROXY** — the normal path: a ping row lands, push inside 90s. Any STARNET guard's ping satisfies it; the gate is company-wide, not per-guard (2026-08-25 19:00:31 the ping came from Naveen at Cristo Rey while Nikith at Bethel AME was the one being watched for).
  3. **OVERRIDE** — Vishnu waives it explicitly. NOT a third flavour of the gate; record it as a bypass and capture what landed during the window. Exercised 2026-08-25 18:47:53 (`c10442a`, deployment `018b8fde`) with a session open and the last ping 16 min stale: **0 STARNET writes** — no ping, session boundary, or notification — across the following 7½ minutes.
- **An `eas update` is NOT an API deploy and the gate barely applies.** Publishing a bundle restarts nothing; a running app keeps its loaded JS and only swaps on cold start (`checkAutomatically: ON_LOAD`). There is no in-flight request to drop, so publish timing is near-irrelevant — the real exposure is a guard cold-starting onto new JS, which is the same whenever you publish. Honour the gate if asked, but do not reason as though an OTA can interrupt a shift mid-request.
- **A clean Sentry window after an OTA proves nothing until a device has TAKEN the update.** Confirm adoption first: `railway logs | grep client.identity` and look for the new `update/<id>`. Until then zero events means "nothing ran this code", not "this code is clean". Note `logClientIdentity` fires only on `clock-in`, `handoff-clock-in`, `ping`, `clock-in-verification` — a guard who only reads screens produces no line.

## Shipped state — snapshot 2026-08-25 19:00 PT

**A snapshot, not a standing fact.** Re-verify before asserting any of it: `git rev-parse origin/main origin/batch/mobile-13`, `eas channel:view production`, and the tail of `migrate.ts`. This block has gone stale before.

| thing | value |
|---|---|
| `origin/main` | `c10442a` — kind-aware swap/handoff expiry + halfway reminder. Deployment `018b8fde` SUCCESS |
| `origin/batch/mobile-13` | `b55a895` — supervisor-notify copy + swap send confirmation |
| production OTA group | `a2e4d334-63be-4a48-9a6f-71ec5864fb1f` (runtime 1.0.16, android+ios, from `b55a895`) |
| prior OTA group (revert target) | `5e10d527-09a9-4d7b-9b0f-53e9e3853871` (from `4f15ee4`) |
| prod schema | **v59** applied (`shift_swap_requests.reminder_sent_at`). **v60 is free** |

- Swap/handoff lifecycle as shipped: handoff expires at `requested_at + 30min`; pre-shift swap at `LEAST(requested_at + 24h, scheduled_start - 1h)`, with a request made inside that last hour running to `scheduled_start` rather than expiring on creation. One halfway reminder to the recipient, pre-shift only, claimed atomically via `reminder_sent_at`. Deadline lives in ONE place — `SWAP_DEADLINE_SQL`, exported from `jobs/expireSwapRequests.ts`.
- **Open, unaddressed:** halfway on a 24h window lands ~12h out and can fire at ~03:30 site-local. There is no quiet-hours suppression anywhere in the push path.
- **Unverified on any device:** the halfway reminder has never fired (0 pending rows since deploy), and `b55a895`'s three Alert dialogs + `WAITING_HOLD_MS` 1500→3000 have not been seen running.
- `eas update:republish --group <id>` targets **that group's branch only** — production, here. Smoke and preview stay put unless you pass `--destination-branch`. It creates a new group carrying the old bundle; it does not delete the newer one.
- **EVERY push to `main` triggers a Railway rebuild and API restart — including a docs-only or `.claude/`-only push. There is no path filter.** `apps/api/railway.json` sets build/deploy commands only; no `watchPatterns` exist anywhere. Confirmed the hard way 2026-08-25 19:27: a SKILL.md-only commit (`47fd899`) started deployment `9723b65b` one second after the push, with two STARNET guards on post and no gate held. The API bytes were identical, so nothing shipped — but the restart was real.
  - The bad inference that caused it: `0e9aa1d` (a SKILL.md-only commit on 08-24) has no deployment next to it in the list, which read as proof of a path filter. It is not. **Railway deploys per PUSH, not per COMMIT** — that commit was pushed alongside neighbours and absorbed into their deploy.
  - So: **the deploy gate applies to any push to `main`, whatever the diff touches.** The only genuinely gate-free push is to a branch with no CI target, e.g. `batch/mobile-*`.

## Verification norms for this project

- 3-viewport check on web UI changes: 375 / 390 / 1280px. Playwright ≠ real device — phone smoke test before "verified".
- Post-deploy verification via Railway logs / Sentry / curl evidence, per commit.
- For launch/status questions, search past chats — memory lags same-day sessions.
