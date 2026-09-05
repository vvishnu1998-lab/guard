# OPEN ITEMS

Every item carries a `verified:` line. Either it names evidence checked on
2026-09-05 against repo / DB / CLI, or it says `NO — carried from chat memory`,
which means the claim is unconfirmed and must be checked before anyone acts on it.

Verification confirms the **state described**, not that the item is worth doing.
Several items below were verified as *already fixed* or *no longer reproducible* —
those say so.

---

## New from Phase 0 (2026-09-05)

**N1. `gho_` GitHub token in cleartext in `.claude/settings.local.json` — revoke (Vishnu).**
A permission-allow entry embeds a full literal `gho_…` OAuth token in plaintext.
verified: YES — string present in the file; `git ls-files --error-unmatch .claude/settings.local.json` → *"did not match any file(s) known to git"*; `git check-ignore -v` → `.gitignore:19`; `git log --all -S '<token>'` → zero commits. **Not a repo leak**, but a live-format credential on disk outside the keyring. Not tested for validity (testing transmits it). `gh auth status` shows an active `gho_` token in keyring with scopes `gist, read:org, repo, workflow`.

**N2. `nightlyPurge` has no timezone → `0 0 * * *` runs at 00:00 UTC ≈ 17:00 PT; `RETENTION_DRY_RUN` defaults true.**
verified: PARTIAL — `nightlyPurge.ts:53` is `cron.schedule('0 0 * * *', runNightlyPurge)` with no options arg; `grep -L timezone apps/api/src/jobs/*.ts` includes it. `nightlyPurge.ts:42`: `const DRY_RUN = process.env.RETENTION_DRY_RUN !== 'false'` → defaults **true**. **UNVERIFIED — the Railway env value of `RETENTION_DRY_RUN`** (would require reading service vars; not done in a read-only pass). If unset in prod, the purge has never deleted anything.

**N3. Four crons have no top-level catch; nine catch to console only; `missedPingCron` has no Sentry import.**
verified: YES — no top-level catch: `dailyShiftEmail` (unwrapped `pool.query` `:24`), `missedShiftAlert` (`:25`), `monthlyHoursReport` (`:52`), `nightlyPurge` (deliberate, documented `:58-63`). Console-only top-level catch: `chatRetention`, `expireSwapRequests`, `handoffNudge`, `lateClockInReminder`, `locationIntegrityCron`, `missedPingCron`, `pingReminder` (`:407`, imports Sentry but does not call it), `preShiftReminder`, `shiftStartReminder`. `grep -c Sentry apps/api/src/jobs/missedPingCron.ts` → 0. Full table in `CRONS.md`.

**N4. `netraops-api` has zero Sentry alert rules; nothing monitors `/health`.**
verified: YES — `/api/0/projects/netraopscom/netraops-api/rules/` → `[]`; `netraops-web/rules/` → `[]`; `netraops-mobile/rules/` → 1 rule (id 17063121, Sentry's auto-created "high priority issues" default, last triggered 2026-08-23). Org metric alert rules → `[]`. Org cron monitors → `[]`. Uptime monitors → exactly one, id 8024493, on `https://www.netraops.com` (project `netraops-web`, 60s, auto-detected `mode: 3`). **No API or `/health` monitor exists.**

**N5. `locationIntegrityCron.ts:8-9` comment claims "20 minutes after nightlyPurge" — false, it is ~8 hours.**
verified: YES — `locationIntegrityCron.ts:40` is `cron.schedule('20 0 * * *', runLocationIntegrityJob, { timezone: 'America/Los_Angeles' })` = 00:20 PT. `nightlyPurge.ts:53` has no timezone = 00:00 UTC ≈ 17:00 PT. Gap is ~7h20m–8h20m depending on DST, not 20 minutes.

**N6. `main` is unprotected; gitleaks is advisory only.**
verified: YES — `gh api repos/vvishnu1998-lab/guard/branches/main/protection` → 404 `"Branch not protected"`. `.github/workflows/gitleaks.yml` is the only workflow (`gh workflow list` → `gitleaks active 266080625`), runs on `pull_request` and `push: branches: [main]`, last 5 runs SUCCESS. With no protection rule, a failing scan blocks nothing.

**N7 (new, found while verifying). Two STARNET guards are below the published OTA runtime and cannot receive any update.**
verified: YES — `guard_devices.client` for GRD0005 Nikith Reddy = `runtime/1.0.16` (android, build/17, last seen 2026-09-05T00:57Z); GRD0007 Anil = `runtime/1.0.16` (ios, build/41, last seen 2026-09-04T00:17Z). All three EAS channels publish at runtime **1.0.17**. Per `release-ops` SKILL.md:45 §3b, a device below the published runtime "can never be reached by ANY update and needs a store install."

**N8 (new, found while verifying). Three divergent copies of the skills exist on disk.**
verified: YES — `netraops-invariants/SKILL.md` hashes: repo `.claude/skills/` = `75d1cdf8ec` (2026-09-01, newest); Claude plugin session cache under `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/…` = `2eb54992f4` (2026-08-24, 11 days stale — **this is what the `anthropic-skills:` plugin serves**); three identical copies under `~/Downloads/.claude`, `.claude 2`, `.claude 3` = `8f26d16486` (2026-08-21). Supersedes carried item C11.

---

## Carried items

**C1. Build 49: device-position-on-Exit + AD_ID revert, after Build 48 review.**
verified: PARTIAL — Build 48 exists and is real: `eas build:list` shows IOS appBuildVersion **48** / ANDROID **24**, appVersion 1.0.17, commit `c932c09`, channel `production`, status `FINISHED`, created 2026-08-30T01:21:10Z. **UNVERIFIED — the review outcome that gates Build 49** (no ASC/Play CLI access; see `FREEZES.md`). The content of the Build 49 payload is carried from chat memory.

**C2. `sites.ts:444` write path + `:351` preview unexercised.**
verified: PARTIAL — both lines exist and are the Pacific-anchor code: `:349-353` is the `open_assignments` count using `(NOW() AT TIME ZONE ${PACIFIC_TZ_SQL})::date`; `:442-446` is the deactivation `closed` query with the comment *"Pacific, not CURRENT_DATE: the session runs Etc/UTC…"*. "Unexercised" is a claim about production traffic and is **not verified** — no query was run to count executions.

**C3. `seed-apple-reviewer.ts` (commit `bda0524`) has a plaintext password; never run.**
verified: YES for the plaintext — `apps/api/scripts/seed-apple-reviewer.ts:48` contains a hardcoded password string literal passed to `bcrypt.hash(...)`. Commit `bda0524` = `scripts: add seed script for Apple App Store reviewer credentials`. File exists, 4285 bytes. "Never run" — verified: NO, carried from chat memory (would need a DB check for an `Apple Reviewer Admin` / `AR-100` row).

**C4. Nandu GRD0002 `802a842f` on Build 44, unreachable by OTA.**
verified: PARTIAL — the guard id is confirmed: `802a842f-da79-44a9-aa0e-f549a9420cef` = Nandu, GRD0002, **STARNET SECURITY**. A device row exists with a live push token (claimed 2026-09-01T02:03Z, `revoked_at` NULL). **The build number is UNVERIFIED from the DB — `guard_devices.client` is NULL for this device**, meaning it has never made a `clock-in` / `handoff-clock-in` / `ping` / `clock-in-verification` write since claiming. `release-ops` SKILL.md:45 records "Nandu GRD0002 on `1.0.14+44`" from an earlier session; that specific version string is carried from chat memory, not re-confirmed. The *conclusion* (unreachable by OTA) holds for any runtime below 1.0.17.

**C5. India site under `starnet` `1bba063e` not created.**
verified: YES — `starnet` (`1bba063e-a0df-4593-9466-81ee58bebc3d`) has exactly **1** site: `william pen hotel`, `America/Los_Angeles`. No India site exists under that tenant. (The four `Indian Test Site 1–4` sites belong to `Star Guard` `b7c7d32d`, not `starnet`.)

**C6. `pingReminder` nags answered windows — add an `anyPingInWindow` guard per the `missedPingCron` pattern.**
verified: **ALREADY FIXED — close this item.** `pingReminder.ts:274` already calls `anyPingInWindow(row.shift_session_id, closed.windowStart, closed.windowEnd)` and `continue`s with `[pingReminder.skipped.answered] session=… window=…`. Its comment states it is ordered *before* the claim deliberately, using "the same two Dates the break check just used, so the reminder and missedPingCron can never disagree about which window is in question."

**C7. Super-admin password rotation.**
verified: NO — carried from chat memory. What *is* verified: super-admin auth is env-based, not a DB row — `apps/api/src/middleware/auth.ts:185` comments *"DB row (env-based auth), so revocation lives in the vishnu_state"*, and `:193` reads `SELECT tokens_not_before FROM vishnu_state WHERE id = 1`. A rotation date cannot be read from the repo or the DB; it lives in `VISHNU_JWT_SECRET` on Railway. Add to `EXPIRIES.md`.

**C8. Dead `KpiRow.tsx`.**
verified: YES — `apps/web/components/admin/KpiRow.tsx` exists; `grep -rn "KpiRow" apps/web` returns exactly one hit, the file's own `export default async function KpiRow()` at `:10`. Zero importers. Confirmed dead.

**C9. `apps/api/dist` stale.**
verified: YES — `apps/api/dist/` last modified 2026-07-16 07:55; `find apps/api/src -name "*.ts" -newer apps/api/dist` returns source files including `index.ts`, `middleware/auth.ts`, `constants/breakDurations.ts`. Local artifact only — Railway rebuilds via `npm run build`, so this does not affect prod.

**C10. `uq_location_pings_session_window` has a hardcoded date.**
verified: YES — live index definition:
```
CREATE UNIQUE INDEX uq_location_pings_session_window ON public.location_pings
USING btree (shift_session_id, window_label)
WHERE ((window_label IS NOT NULL) AND (pinged_at >= '2026-08-21 00:00:00+00'::timestamp with time zone))
```
Both the hardcoded `2026-08-21` bound and the `window_label IS NOT NULL` clause are present. Anything counting ping *rows* as windows depends on this predicate.

**C11. Skills 3-copy sync.**
verified: YES, and worse than stated — see **N8**. Three distinct versions across five files on disk. Superseded by N8; keep N8, retire this framing.

**C12. `release-ops` §3b applies on batch branches only.**
verified: PARTIAL — §3b exists at `.claude/skills/release-ops/SKILL.md:45`, titled *"OTA channels — PUBLISH TO BOTH, ALWAYS"*. Its content is about publishing every `eas update` to both `production` and `preview`; it does not mention batch branches. `.claude/skills/` **is** tracked on `main` (8 files). The "batch branches only" framing does not match what the section says — **needs restating by Vishnu before it can be actioned.**

**C13. `04-APP-FLOW` §5/§16 and `03-UX-DESIGN` §3.3 are stale.**
verified: PARTIAL — the sections exist: `docs/04-APP-FLOW.md:182` `## 5. Active Shift — Background Geofence Breach`; `:562` `## 16. Background Location Pings (configurable cadence + battery throttle)`; `docs/03-UX-DESIGN.md:195` `### 3.3 Active Shift`. **Staleness itself is verified: NO — carried from chat memory.** Note `04-APP-FLOW.md` was modified 2026-09-03; `03-UX-DESIGN.md` has not been touched since 2026-05-16.

**C14. `/forgot-password` has no per-email rate limit.**
verified: YES — route is `apps/api/src/routes/auth.ts:846` (`router.post('/forgot-password', …)`), mounted under `app.use('/api/auth', authLimiter, authRoutes)` (`index.ts:135`). `authLimiter` (`index.ts:69-75`) is `windowMs: 15*60*1000, max: 20` with **no `keyGenerator`** → express-rate-limit defaults to IP. No per-email counter exists in the route body.

**C15. Client portal PDF / schedule / daily email unexercised; retention countdown null.**
verified: PARTIAL — 7 clients exist, 1 belongs to STARNET. The daily email path *is* exercised: 124 shifts have `daily_report_email_sent = true`. Monthly reports also run: `monthly_hours_reports` has 6 rows, last `generated_at` 2026-09-01T12:00:01Z. The retention countdown is verified as **static copy, not a computed value** — `apps/web/app/client/download/page.tsx:40` renders the fixed string *"Reports older than your data retention limit may not be available."* with no number. PDF and schedule surfaces: verified NO — carried from chat memory.

**C16. `express-validator` unused; no ESLint; no request logging.**
verified: YES on all three — `grep -rln "express-validator" apps/api/src` → **0 files** (it is still a declared dependency in `apps/api/package.json`). `find . -maxdepth 3 -name ".eslintrc*" -o -name "eslint.config.*"` (excluding node_modules) → **none**. `grep -rn "morgan\|pino\|winston" apps/api/src apps/api/package.json` → **no matches**.

**C17. `authLimiter` is IP-keyed → shared-NAT collateral.**
verified: YES — `index.ts:69-75`, no `keyGenerator`, so express-rate-limit keys on IP. 20 requests / 15 min shared across every guard behind one NAT. Same finding as C14, different consequence.

**C18. DOW `getDay()` UTC bug.**
verified: PARTIAL — largely fixed, with a residual. `apps/api/src/services/siteTime.ts` now resolves weekday per site timezone, but `:40` still ends `] ?? d.getDay()` — a UTC fallback when the timezone yields an unrecognised weekday name (documented at `:23`). Call sites carry fix comments: `routes/shifts.ts:326` (*"server-local getDay() would off-by-one on…"*) and `services/tasks.ts:32` (*"the previous `clockInAt.getDay()` returned the UTC day: Bethel AME…"*). **Open portion: the `?? d.getDay()` fallback at `siteTime.ts:40`.**

**C19. `handoff_complete` push sends an empty `toGuardName`.**
verified: YES, **but the line number in the carried note is wrong — it is `shifts.ts:2326`, not `:2324`.** Source:
```js
toGuardName: '', // From guard's perspective; blank keeps copy generic
```
The inline comment asserts this is intentional. Whether the resulting copy reads correctly is a product judgment, not verified here.

**C20. `authStore._request` does not send `X-NetraOps-Client`.**
verified: YES — `apps/mobile/store/authStore.ts:307` defines `_request`; its `fetch` at `:311-313` sets `headers: { 'Content-Type': 'application/json' }` only. Its authenticated sibling at `:361-366` adds `Authorization` only. By contrast `apps/mobile/lib/apiClient.ts:82` *does* send `'X-NetraOps-Client': CLIENT_HEADER`. Callers of `_request` include guard login (`:78`) and forgot-password (`:135`) — consistent with login not carrying the client header.

**C21. Root `.vercelignore` missing.**
verified: YES — no `.vercelignore` at repo root and none at `apps/web/`.

**C22. Indian test sites should use `Asia/Kolkata`.**
verified: YES, still open — all four `Indian Test Site 1–4` sites (tenant `Star Guard` `b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee`) have `timezone = 'America/Los_Angeles'`. A query for any site with a non-Pacific timezone returns **zero rows** across all four tenants.

**C23. Star Guard has two `deepak naik` accounts sharing one push token.**
verified: PARTIAL — the duplicate accounts are real: `Star Guard` has `deepak naik` GRD0003 (`c2f4b9e3-bed9-4693-b752-a04bc115e863`) **and** `deepak naik` GRD0004 (`a532b077-39ba-43f1-93bd-176752fb6e21`). **The shared-token half is no longer reproducible: neither account has any `guard_devices` row at all** (both `push_token` NULL). The duplicate-account cleanup remains open; the token collision does not currently exist.

**C24. `batch/mobile-15` commit subject says "(NOT APPLIED)" — false.**
verified: YES — `origin/batch/mobile-15` tip is `777f273 feat(db): schema_v64 — drop the guards.fcm_token mirror (NOT APPLIED)`, and `1252051 feat(db): schema_v63 — guard_devices table, expand half (NOT APPLIED)` carries the same claim. Both **are** applied: `schema_v63.sql` and `schema_v64.sql` are in the `migrate.ts` chain (which runs to v66), the `guard_devices` table exists in prod with columns `id, guard_id, push_token, platform, client, claimed_at, last_seen_at, revoked_at`, and `guards.fcm_token` **no longer exists** (a `pg_attribute` sweep for `%token%` on `guards` returns only `tokens_not_before`). Both subjects are false and misleading on replay.
