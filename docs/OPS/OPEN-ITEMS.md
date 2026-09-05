# OPEN ITEMS

Every item carries a `verified:` line. Either it names evidence checked on
2026-09-05 against repo / DB / CLI, or it says `NO — carried from chat memory`,
which means the claim is unconfirmed and must be checked before anyone acts on it.

Verification confirms the **state described**, not that the item is worth doing.
Several items below were verified as *already fixed* or *no longer reproducible* —
those say so.

---

## New from Phase 0 (2026-09-05)

**N1. UPDATED 2026-09-05 — `gho_` GitHub token in cleartext in `.claude/settings.local.json`.**
verified: **the entry was still present at the start of Phase 4 and has now been removed from the file.**
`grep -c "gho_" .claude/settings.local.json` returned **1** before the Phase 4 prune and **0** after
(586 allow entries -> 471; the token entry is one of 115 removed). The file remains untracked and
gitignored (`.gitignore:19`), and the token never entered git history — `git log --all -S` returns zero
commits, re-confirmed.
**STILL OPEN, and this is the part that matters: removing the line from a local file does not revoke the
credential.** The token is valid until revoked at github.com/settings/tokens. **Vishnu revokes.**
Deliberately not tested for validity — testing transmits it.

**N2. `nightlyPurge` has no timezone → `0 0 * * *` runs at 00:00 UTC ≈ 17:00 PT; `RETENTION_DRY_RUN` defaults true.**
verified: PARTIAL — `nightlyPurge.ts:53` is `cron.schedule('0 0 * * *', runNightlyPurge)` with no options arg; `grep -L timezone apps/api/src/jobs/*.ts` includes it. `nightlyPurge.ts:42`: `const DRY_RUN = process.env.RETENTION_DRY_RUN !== 'false'` → defaults **true**. **UNVERIFIED — the Railway env value of `RETENTION_DRY_RUN`** (would require reading service vars; not done in a read-only pass). If unset in prod, the purge has never deleted anything.

**N3. Four crons have no top-level catch; nine catch to console only; `missedPingCron` has no Sentry import.**
verified: YES — no top-level catch: `dailyShiftEmail` (unwrapped `pool.query` `:24`), `missedShiftAlert` (`:25`), `monthlyHoursReport` (`:52`), `nightlyPurge` (deliberate, documented `:58-63`). Console-only top-level catch: `chatRetention`, `expireSwapRequests`, `handoffNudge`, `lateClockInReminder`, `locationIntegrityCron`, `missedPingCron`, `pingReminder` (`:407`, imports Sentry but does not call it), `preShiftReminder`, `shiftStartReminder`. `grep -c Sentry apps/api/src/jobs/missedPingCron.ts` → 0. Full table in `CRONS.md`.

**N4. CLOSED 2026-09-05 — `netraops-api` has zero Sentry alert rules; nothing monitors `/health`.**
verified: **RESOLVED by Phase 4 — alerting now exists.** The replacement is not a Sentry issue-alert rule; it is
`GET /health/crons` probed by Sentry Uptime, which is a better fit: an issue-alert rule fires on an
*exception*, and the whole point of Phase 0's finding was that a wedged cron throws nothing. The probe
detects absence, which is the actual failure mode. Remaining wiring is runbook work, not code:
the uptime monitor (id `8024493`) is still pointed at `https://www.netraops.com` and must be repointed at
`https://api.netraops.com/health/crons` — see `RUNBOOK-phase4-apply.md` step (d), and note the
first-deploy 503 caveat in step (c). The 6-hourly `ops-triage` workflow adds a second, independent
channel that reads Sentry, Railway and the database and posts to Slack.

**N5. `locationIntegrityCron.ts:8-9` comment claims "20 minutes after nightlyPurge" — false, it is ~8 hours.**
verified: YES — `locationIntegrityCron.ts:40` is `cron.schedule('20 0 * * *', runLocationIntegrityJob, { timezone: 'America/Los_Angeles' })` = 00:20 PT. `nightlyPurge.ts:53` has no timezone = 00:00 UTC ≈ 17:00 PT. Gap is ~7h20m–8h20m depending on DST, not 20 minutes.

**N6. `main` is unprotected; gitleaks is advisory only.**
verified: YES — `gh api repos/vvishnu1998-lab/guard/branches/main/protection` → 404 `"Branch not protected"`. `.github/workflows/gitleaks.yml` is the only workflow (`gh workflow list` → `gitleaks active 266080625`), runs on `pull_request` and `push: branches: [main]`, last 5 runs SUCCESS. With no protection rule, a failing scan blocks nothing.

**N7 (new, found while verifying). Two STARNET guards are below the published OTA runtime and cannot receive any update.**
verified: YES — `guard_devices.client` for GRD0005 (`4a71d17d`, STARNET) = `runtime/1.0.16` (android, build/17, last seen 2026-09-05T00:57Z); GRD0007 (`36478eb1`, STARNET) = `runtime/1.0.16` (ios, build/41, last seen 2026-09-04T00:17Z). All three EAS channels publish at runtime **1.0.17**. Per `release-ops` SKILL.md:45 §3b, a device below the published runtime "can never be reached by ANY update and needs a store install."

**N8 (new, found while verifying). Three divergent copies of the skills exist on disk.**
verified: YES — `netraops-invariants/SKILL.md` hashes: repo `.claude/skills/` = `75d1cdf8ec` (2026-09-01, newest); Claude plugin session cache under `~/Library/Application Support/Claude/local-agent-mode-sessions/skills-plugin/…` = `2eb54992f4` (2026-08-24, 11 days stale — **this is what the `anthropic-skills:` plugin serves**); three identical copies under `~/Downloads/.claude`, `.claude 2`, `.claude 3` = `8f26d16486` (2026-08-21). Supersedes carried item C11.


**N9. `AGENTS.md` carried two stale facts — FIXED 2026-09-05 in this commit.**
verified: YES — both corrected in the Phase 2 commit. (a) *"DB: PostgreSQL on Railway (22 tables,
multi-tenant by company_id)"* — the live database has **48** base tables in `public`
(`pg_class` count, 2026-09-05), now 49 once v67 is applied. Changed to 48. (b) *"Email: SendGrid
(sender: alerts@netraops.com, domain verified)"* — the actual sender is
`alerts@em6648.netraops.com`. Both were found in Phase 1 while adding `CLAUDE.md` and flagged as
out of scope then. Nothing else in `AGENTS.md` was touched.

**N10. Column-level grants do not cover columns added later — future `ALTER TABLE ADD COLUMN` on the eight narrowed tables must re-GRANT.**
verified: YES, structural — this is documented Postgres behaviour, not a defect.
`scripts/ops/readonly-column-revoke.sql` replaces `claude_readonly`'s table-level SELECT with
column-level SELECT on `guards`, `company_admins`, `clients`, `guard_devices`,
`password_reset_tokens`, `revoked_tokens`, `login_attempts` and `vishnu_state`. Once that runs, a
new column on any of those eight is **unreadable** by `claude_readonly` until explicitly granted,
and the failure surfaces as a runtime 42501 on a query that previously worked — most often a
`SELECT *`. Every future migration touching those tables must carry
`GRANT SELECT (new_column) ON <table> TO claude_readonly;`, or deliberately withhold it if the new
column is itself a secret. The caveat is written into the header of the revoke script and into
`CRONS.md`. **Not yet live — the revoke script has not been run** (`RUNBOOK-phase2-apply.md` step e).


**N11. Request Sentry cron-monitor credits / confirm the quota.**
verified: PARTIAL — the quota is still unreadable. `GET /api/0/organizations/netraopscom/` returns HTTP 200
with `status: active` but **no `planTier` field, an empty `quota` object, and no cron entries in `features`**
(re-checked 2026-09-05). What *is* now known: **11 cron monitors were auto-created** by the Phase 2/3
check-ins and all 11 are `status: active`, `isMuted: false`. Phase 4 disables check-ins, so the question is
no longer blocking — but if check-ins are ever re-enabled, the quota must be established first rather than
discovered by exhausting it. **Tier 0** to ask Sentry; **Tier 1** to change any flag.

**N12. Mobile base URL should move to `api.netraops.com` on Build 49.**
verified: PARTIAL — `https://api.netraops.com/health` returns HTTP 200 `{"status":"ok","db":"connected"}`,
so the host is live and serving the same body as `guard-production-6be4.up.railway.app`. **Which base URL
the shipped mobile binary actually uses was NOT verified in this pass** — that requires reading the build
commit's config, not the working tree, and Build 48 (`c932c09`) predates this. Bundling the switch into
Build 49 avoids a standalone binary release. **Size S, Tier 2** (it is an EAS build).

**N13. Twilio SMS layer for P0 escalation is not built.**
verified: PARTIAL — `twilio` is a declared dependency of `apps/api` (`package.json`), so the library is
present. **No SMS escalation path exists in the ops loop**: `DECISIONS.md` D3 requires P0 to escalate by SMS
every 15 minutes until acknowledged, and Phase 4 ships Slack only (`scripts/ops/triage.sh` posts to a webhook
and stops). Nothing in the runner can page anyone. Until this exists, **D3 is a decision without an
implementation** — do not treat P0 escalation as covered. **Size M, Tier 1.**

**N14. Vercel to Slack notifications — v2.**
verified: NO — carried from the Phase 4 dispatch, not independently checked. No Vercel-to-Slack integration
was looked for or found in this pass. Deferred to v2 by scope, not by evidence.

**N15 (new, found while verifying). `password_reset_tokens` exists in production but is created by no migration.**
verified: YES — production `public` holds **49** base tables; a full replay of the `migrate.ts` chain into an
empty local database produces **48**, and the set difference is exactly `['password_reset_tokens']`
(the reverse difference is empty). It appears in **zero** `schema_v*.sql` files
(`grep -l password_reset_tokens apps/api/src/db/*.sql` → none) and is referenced by **zero** TypeScript files
under `apps/api/src`. It holds **0 rows**.
So it is an out-of-band orphan: a fresh database would not have it, and nothing would notice.
**Consequence already fixed here:** it is one of the eight tables in `scripts/ops/readonly-column-revoke.sql`,
which therefore aborted on any database lacking it. Both that script and its verify companion now guard each
table on `to_regclass` and report `SKIPPED (absent)` instead of failing — confirmed against a fresh local
`guard_dev`: 7 tables narrowed, `password_reset_tokens` skipped, exit 0. The production revoke already ran
successfully on the unguarded version (the table exists there), so **no prod re-run is needed.**
Open question is whether to drop the orphan or add it to the chain. **Size S, Tier 2** (it is a prod schema
change either way).


**N16. CLOSED 2026-09-05 — guard names reached the model's context via the pack.**
verified: **RESOLVED in this commit.** The pack embeds six repo-memory files, and `STATE.md`'s
device-inventory table was the only one carrying guard NAMES — 8 distinct names, all inside that one
table (lines 121-139), zero elsewhere in that file. Fixed structurally rather than by prompting:
- the table moved verbatim to **`docs/OPS/DEVICES.md`**, which `triage.sh` does **not** embed
  (the pack's file list is `STATE`, `OPEN-ITEMS`, `FREEZES`, `DECISIONS`, `POLICY`, `REPORT-TEMPLATE`);
- 9 further name occurrences found in `OPEN-ITEMS.md` (6) and `FREEZES.md` (3) were replaced in place
  with `guard_id` + `badge_number` + `company_id`. One of those was inside a *quotation* of
  `release-ops` SKILL.md, so the name there is marked `[name redacted]` rather than silently rewritten.
Post-fix scan of all six embedded files: **0 name occurrences**. `DEVICES.md` keeps all 8, unchanged,
and carries a header saying it must never be added to the pack.

**N17. Daily digest email to Gmail is not built.**
verified: YES, absent — `DECISIONS.md` D4 specifies "claude.ai is the call path, plus a daily digest
delivered via Gmail". `scripts/ops/triage.sh` posts to a Slack webhook and stops; `grep -ci "gmail\|smtp\|sendgrid" scripts/ops/triage.sh`
returns 0. The runner has no email path at all. Until this exists D4 is a decision without an
implementation. **Size M, Tier 1.**

**N18. Twilio SMS on P0 is not built.**
verified: YES, absent — `DECISIONS.md` D3 requires P0 to escalate by SMS every 15 minutes until
acknowledged. `twilio` is a declared dependency of `apps/api`, so the library exists, but nothing in
the ops loop can page anyone: the runner's only output channels are the Slack webhook and the
uploaded artifacts. **Do not treat P0 escalation as covered.** Supersedes N13, which said the same
thing; keep this number and retire N13's framing. **Size M, Tier 1.**

**N19. Vercel to Slack notifications are not built.**
verified: NO — carried from the dispatch, not independently checked. No Vercel-to-Slack integration
was searched for or found in this pass. Deferred to v2 by scope, not by evidence. Supersedes N14.


**N20. `push_skip_null_token` at five other call sites, plus a latent missing `LIMIT 1`.**
verified: YES — `grep -rn "push_skip_null_token" apps/api/src` returns six sites. The 2026-09-05 fix
touched **only** `pingReminder.ts`; the other five still emit a `warning`-level Sentry event per call:
`preShiftReminder.ts:99`, `lateClockInReminder.ts:100`, `shiftStartReminder.ts:100`,
`services/swapPush.ts:81`, `services/shiftPush.ts:168`. Historical events in issue `7633312535` carry
`flow: late_clock_in`, `shift_start_reminder`, `pre_shift_reminder`, `swap_push` and
`shift_assignment`, so all of them do fire.

None tags `company_id` consistently, which is the part that actually matters: the difference between
"test tenant, ignore" and "paying customer, act" is currently discoverable only by querying the DB.
Two of the historical events DID carry `company_id 27c4d404-8769-49ca-bfd6-93cb9b890067` under
`flow: swap_push` (2026-08-30, 2026-09-01), so STARNET has reached this path before.

Bundle with: **`ACTIVE_PUSH_TOKEN_SQL` (`services/deviceRegistry.ts:249`) has no `LIMIT 1`.** It is a
scalar subquery, so two non-revoked `guard_devices` rows for one guard would raise
`21000 more than one row returned by a subquery used as an expression` and fail the entire tick, not
one push. **Latent, not live** — verified 2026-09-05: `guards_with_multiple_active_devices = 0` across
all 37 guards. Every one of the six call sites depends on that function, which is why the two belong
in one PR.

**Size M, Tier 1.** Incident context: `docs/OPS/INCIDENTS/2026-09-05-push-skip-null-token.md`.

---

## Carried items

**C1. Build 49: device-position-on-Exit + AD_ID revert, after Build 48 review.**
verified: PARTIAL — Build 48 exists and is real: `eas build:list` shows IOS appBuildVersion **48** / ANDROID **24**, appVersion 1.0.17, commit `c932c09`, channel `production`, status `FINISHED`, created 2026-08-30T01:21:10Z. **UNVERIFIED — the review outcome that gates Build 49** (no ASC/Play CLI access; see `FREEZES.md`). The content of the Build 49 payload is carried from chat memory.

**C2. `sites.ts:444` write path + `:351` preview unexercised.**
verified: PARTIAL — both lines exist and are the Pacific-anchor code: `:349-353` is the `open_assignments` count using `(NOW() AT TIME ZONE ${PACIFIC_TZ_SQL})::date`; `:442-446` is the deactivation `closed` query with the comment *"Pacific, not CURRENT_DATE: the session runs Etc/UTC…"*. "Unexercised" is a claim about production traffic and is **not verified** — no query was run to count executions.

**C3. `seed-apple-reviewer.ts` (commit `bda0524`) has a plaintext password; never run.**
verified: YES for the plaintext — `apps/api/scripts/seed-apple-reviewer.ts:48` contains a hardcoded password string literal passed to `bcrypt.hash(...)`. Commit `bda0524` = `scripts: add seed script for Apple App Store reviewer credentials`. File exists, 4285 bytes. "Never run" — verified: NO, carried from chat memory (would need a DB check for an `Apple Reviewer Admin` / `AR-100` row).

**C4. GRD0002 `802a842f` (STARNET) on Build 44, unreachable by OTA.**
verified: PARTIAL — the guard id is confirmed: `802a842f-da79-44a9-aa0e-f549a9420cef` = GRD0002, **STARNET SECURITY** (`27c4d404-8769-49ca-bfd6-93cb9b890067`). A device row exists with a live push token (claimed 2026-09-01T02:03Z, `revoked_at` NULL). **The build number is UNVERIFIED from the DB — `guard_devices.client` is NULL for this device**, meaning it has never made a `clock-in` / `handoff-clock-in` / `ping` / `clock-in-verification` write since claiming. `release-ops` SKILL.md:45 records "[name redacted] GRD0002 on `1.0.14+44`" from an earlier session; that specific version string is carried from chat memory, not re-confirmed. The *conclusion* (unreachable by OTA) holds for any runtime below 1.0.17.

**C5. India site under `starnet` `1bba063e` not created.**
verified: YES — `starnet` (`1bba063e-a0df-4593-9466-81ee58bebc3d`) has exactly **1** site: `william pen hotel`, `America/Los_Angeles`. No India site exists under that tenant. (The four `Indian Test Site 1–4` sites belong to `Star Guard` `b7c7d32d`, not `starnet`.)

**C6. CLOSED 2026-09-05 — `pingReminder` nags answered windows; add an `anyPingInWindow` guard.**
verified: **ALREADY FIXED IN CODE — no work required, item closed.** `pingReminder.ts:274` calls
`anyPingInWindow(row.shift_session_id, closed.windowStart, closed.windowEnd)` and `continue`s,
logging `[pingReminder.skipped.answered] session=... window=...`. Its comment states the ordering is
deliberate — the check runs *before* `claimWindow` so a satisfied window never burns a claim, using
"the same two Dates the break check just used, so the reminder and missedPingCron can never disagree
about which window is in question." Re-confirmed on `f480fc2` during Phase 2; line number unchanged
by the runJob conversion, which touched only the registration call at `:181`. Nothing to implement.

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

**C23. Star Guard has two duplicate guard accounts sharing one push token.**
verified: PARTIAL — the duplicate accounts are real: `Star Guard` (`b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee`) has two accounts with the SAME name: GRD0003 (`c2f4b9e3-bed9-4693-b752-a04bc115e863`) **and** GRD0004 (`a532b077-39ba-43f1-93bd-176752fb6e21`). **The shared-token half is no longer reproducible: neither account has any `guard_devices` row at all** (both `push_token` NULL). The duplicate-account cleanup remains open; the token collision does not currently exist.

**C24. `batch/mobile-15` commit subject says "(NOT APPLIED)" — false.**
verified: YES — `origin/batch/mobile-15` tip is `777f273 feat(db): schema_v64 — drop the guards.fcm_token mirror (NOT APPLIED)`, and `1252051 feat(db): schema_v63 — guard_devices table, expand half (NOT APPLIED)` carries the same claim. Both **are** applied: `schema_v63.sql` and `schema_v64.sql` are in the `migrate.ts` chain (which runs to v66), the `guard_devices` table exists in prod with columns `id, guard_id, push_token, platform, client, claimed_at, last_seen_at, revoked_at`, and `guards.fcm_token` **no longer exists** (a `pg_attribute` sweep for `%token%` on `guards` returns only `tokens_not_before`). Both subjects are false and misleading on replay.
