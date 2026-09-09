# OPEN ITEMS

**`[VISHNU]` tag.** An item whose next action is Vishnu's alone — a console
change, a payment, a credential revoke — carries `[VISHNU]` in its heading. The
`waiting` collector greps for that tag and surfaces those items in the WAITING
line of the daily Slack brief, so tagging one is how it becomes visible daily
rather than only when someone re-reads this file.

Every item carries a `verified:` line. Either it names evidence checked on
2026-09-05 against repo / DB / CLI, or it says `NO — carried from chat memory`,
which means the claim is unconfirmed and must be checked before anyone acts on it.

Verification confirms the **state described**, not that the item is worth doing.
Several items below were verified as *already fixed* or *no longer reproducible* —
those say so.

---

## New from Phase 0 (2026-09-05)

**N1. [VISHNU] UPDATED 2026-09-05 — `gho_` GitHub token in cleartext in `.claude/settings.local.json`.**
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


**N20. CLOSED 2026-09-06 — `push_skip_null_token` at five other call sites, plus the missing `LIMIT 1`.**
**Resolution: both halves done on `ops/n20-push-skip`.** `grep -rn "captureMessage('push_skip_null_token'"
over `apps/api/src` now returns **one** live call — the rate-limited one inside
`services/pushSkipReporter.ts`. The three other matches are comments recording what was removed.

**The five call sites, by shape.** Three are crons with a natural batch boundary and now count into a
tick-scoped counter reported on their existing summary line as `skipped_no_device=N`, exactly as
`pingReminder` does: `preShiftReminder`, `shiftStartReminder`, `lateClockInReminder`. In
`lateClockInReminder` the counter is threaded into `fireGuardPush` rather than kept at module scope
(node-cron does not serialise ticks) and is named `skipped_no_device` because that job **already has a
`skipped`** meaning "unassigned shift, guard_id IS NULL" — a different condition, and conflating them
would have silently changed what an existing field meant. The `Sentry` import became dead in all
three and was removed; tick errors still reach Sentry through `runJob`.

The two services are request-path with no tick and no summary line, so a counter there would be
written and never read. They keep ONE `Sentry.captureMessage`, rate-limited per process to **once per
10 minutes per (flow, company_id)**, carrying `occurrences_since_last_report`. Every occurrence is
still logged as `[push.skip] flow=… guard=… company=…`.

**The company_id tag is the part this item actually asked for**, and it is now a tag rather than a
DB question. The window is keyed per tenant precisely so a burst on the test tenant cannot suppress
the first report for the paying one — asserted in the tests. `guard_id` is deliberately NOT a tag
(unbounded cardinality); it goes to `extra` and to every log line.

**The `LIMIT 1` half was mis-scoped in this item, and the correction matters more than the fix.**
This item said two non-revoked rows "would raise 21000 … and fail the entire tick", and called it
"latent, not live" on the strength of `guards_with_multiple_active_devices = 0`. Re-verified against
production 2026-09-06: **`uq_guard_devices_one_active_per_guard` exists** —
`CREATE UNIQUE INDEX … ON guard_devices (guard_id) WHERE revoked_at IS NULL` — created by
`schema_v63.sql:79-80`, which is in the `migrate.ts` chain, so a fresh database gets it too. The
state is therefore **unreachable, not merely absent**: that zero was enforcement, not luck, and
reading it as luck is what made this look urgent. `deviceRegistry.ts`'s own doc comment said so all
along.

Current counts, read-only: 44 guards, 23 with any device row, 22 non-revoked rows,
**`max_nonrevoked_rows_for_one_guard = 1`**, `guards_with_gt1_nonrevoked_device = 0`, and 13 guards
have more than one row once revoked history is counted — so the table does accumulate, and only the
partial index keeps actives unique.

`ORDER BY last_seen_at DESC NULLS LAST LIMIT 1` was still added to all three lookup paths
(`ACTIVE_PUSH_TOKEN_SQL`, `getActivePushToken`, `getActivePushTokens`) as **defence in depth**: a
future migration dropping or narrowing that index would otherwise silently re-arm a whole-tick
failure across six call sites. **The tie-break is unobservable today** — at most one row can match,
and 0 of the 22 active rows have a NULL `last_seen_at` — so the "which device gets the push" change
this item anticipated does not occur, and only would if the index were removed. `getActivePushTokens`
needed a second edit for the same reason: it builds a Map, so a plain `set()` on every row would have
left the **oldest** device winning and silently contradicted the other two paths.

**Tests:** `_pushSkipCounters.test.ts` (8) drives all three cron bodies through the real `runJob`
registration and asserts the counter, **zero Sentry calls**, no push, and that the in-app
notification is **still written** (the Tier-2 boundary). `_pushSkipReporter.test.ts` (8) asserts the
limiter fires once per window, the per-tenant and per-flow keying, that `company_id` is a tag and
`guard_id` is not, and that a failed tenant lookup degrades to `company=unknown` rather than throwing.
Full suite **84 passed, 0 failed**; `tsc --noEmit` clean.

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


**N21. Measure per-run API cost after 3 daily runs; target <= $0.40.**
verified: PARTIAL — the pack size is measured, the cost is not. Phase 4.4 trimmed the pack from
**1421 to 1114 lines / 67,251 to 49,875 bytes (-26%)** and cut `--max-turns` 40 -> 15. Target is
**~$0.35/run** (`DECISIONS.md` D13). **No run has been costed** — `claude -p` cannot authenticate on
this workstation, so the first real figure comes from CI. Use `--output-format json`, whose payload
carries `total_cost_usd` and a per-model breakdown, or the Console usage page for the runner's
dedicated key.

**The trim fell short of "roughly halved", and the reason is `STATE.md`.** Composition of the
repo-memory half after trimming, in lines: **STATE 348**, OPEN-ITEMS 154 (was 259), REPORT-TEMPLATE
116, POLICY 84, FREEZES 70, DECISIONS 69. STATE.md is **41% of repo memory and 31% of the entire
pack** — larger than every live signal combined (263 lines). It was embedded in full on the
instruction that it is "small"; it is now the largest file in the pack and grows every phase, because
each one appends a section.

Next lever, if the measured cost misses target: split `STATE.md` the way `DEVICES.md` was split in
N16 — a short current-state head that the pack embeds, and a per-phase history tail that it does not.
Do **not** simply truncate it: the model needs deployment ids, schema tip and the freeze list to grade
a finding, and those live at the top.


**N22. Migrate transactional email off SendGrid — Resend or Postmark. UPGRADED 2026-09-06: MIGRATION RECOMMENDED, no longer optional.**
**Why the upgrade.** The billing risk stopped being hypothetical. The declining card produced a **6 d 18 h** total email outage (2026-08-25 23:10Z → 2026-09-01 17:00Z, `INCIDENTS/2026-09-01-unauthorized-burst.md`, N28): no admin alert and no client report reached anyone on any tenant, ~7 STARNET daily client reports were lost, and the retry loop it drove exhausted the Sentry quota and blinded error monitoring for a further 94 h (N27). Nothing detected it — that gap is now closed by `hours_since_last_successful_email` in the `failures-24h` collector, but **detection is not resilience**. Evaluate on how a provider signals a billing problem *before* it starts refusing sends, alongside the criteria below.
verified: PARTIAL — the dependency is confirmed, the volume figure is not. `@sendgrid/mail` is a
declared dependency of `apps/api`, and SendGrid carries `dailyShiftEmail`, `missedShiftAlert` and the
handoff admin FYI. The brief gives **323 emails/month on a 50K plan** — a rounding error against the
plan, so the migration is about **billing risk, not capacity**. That figure is **UNVERIFIED**: there is
no `emails_sent` table, so volume is not derivable from the database; it would have to come from the
SendGrid dashboard.
Trigger is **E15**: the card is failing. A suspension silently stops every admin and client email, and
**the triage pack has no email-delivery signal at all**, so nobody would learn of it from the loop.
Evaluate Resend and Postmark on: domain re-verification effort (the sender is
`alerts@em6648.netraops.com`), template parity, and whether a failed send surfaces anywhere we already
watch. **Size M, Tier 1.** Fix the card first — that is E15, and it is hours not weeks.

**N23. [VISHNU] Report enhancement degraded gracefully; budget isolation pending.**
verified: YES — code half landed on branch `ops/n23-enhancement`; console half is **not** done.
Incident: `docs/OPS/INCIDENTS/2026-09-06-enhancement-credit-exhaustion.md`. `routes/ai.ts` no longer
returns `err.message` (it returned Anthropic's billing text to a STARNET guard's phone), gained an 8s
timeout with `maxRetries: 0`, a 529 retry cap of 1, `Sentry.captureMessage('enhancement_failed')`, and
`guard=`/`company=` on the failure log line. Mobile shows a non-blocking inline notice instead of a
modal carrying server text.
**Still open: the budget isolation itself** — two Console workspaces, two keys, $20/$30 limits, org
auto-reload. Until that is applied the runner and the product still share one credit pool and the
runner can still starve the product; the code change only makes that invisible to guards rather than
preventing it. Runbook: `docs/OPS/RUNBOOK-n23-budget-isolation.md`. **Vishnu applies. Tier 2** —
credential rotation, and step (b) restarts the API.

**N24. [VISHNU] Vercel Hobby plan is non-commercial under Vercel's ToS.**
verified: NO — carried from the brief, not independently checked. `apps/web` deploys to Vercel and
NetraOps has a paying customer, which is commercial use. If the project is on Hobby this is a terms
violation with a plausible enforcement outcome of the site being taken down — the same class of risk
as E14, and the web app is the client portal. **Not a technical question**: route to
`us-business-counsel` for the ToS reading, then to a plan decision. Confirm the current plan first;
the answer may be that it is already on Pro. **Size S to check, unknown to remediate. Tier 1.**

**N25. Mobile `Sentry.captureException` produced ZERO events on a shipped path.**
verified: YES, and this is the one that undermines other findings. `apps/mobile/app/reports/new.tsx:149`
calls `Sentry.captureException(err, { extra: { where: 'reports.new.handleEnhance' } })`. It is present
in the **shipped** ref, not just the working tree — `git show c932c09:apps/mobile/app/reports/new.tsx`
shows it at line 149, and `git diff c932c09 HEAD` on that file is empty. `c932c09` is production
Build 48 / v1.0.17.
On 2026-09-06 that path failed **9 times in 2m36s** and `netraops-mobile` recorded **zero** events in
the following 24h — its only issue was `NETRAOPS-MOBILE-9 startBackgroundLocation`.
**Why is UNCONFIRMED.** Check, in order: (1) the mobile Sentry **DSN** is set in the shipped build,
(2) the `environment` tag — two STARNET devices are on runtime **1.0.16**, not 1.0.17 (see **N7**), so
the failing device may be running older JS entirely, (3) **flush on background** — React Native drops
queued events if the app is backgrounded before the transport runs, (4) sample rate.
**Test with a forced capture**: add a temporary dev-only button that calls
`Sentry.captureException(new Error('n25-probe'))` and confirm the event arrives from a real device on
the production channel. Until this resolves, **treat "no mobile Sentry events" as "no information",
never as "no errors"** — the same lesson as the API-side blindness in this incident, one tier further
out. **Size S to diagnose, Tier 1.**

**N26. Anthropic month-to-date spend is not summed across runs.**
verified: PARTIAL — the per-run half is **done** in Phase 4.5, the month sum is **not**.
`scripts/ops/triage.sh` now calls `claude -p --output-format json` and writes `total_cost_usd`,
`session_id` and `num_turns` to `cost.json`, uploaded as artifact `triage-cost-<run_id>` with 90-day
retention. So from the next run onward, **each run's cost is recorded**, which is what N21 actually
asked for.

**Month-to-date is still UNVERIFIED.** Summing it means listing prior runs via `gh api`, downloading
each `triage-cost-*` artifact and adding them up — roughly 30 artifact downloads per brief, on a job
that is meant to be cheap. Two better options exist and neither is a one-PR change: query the Console
usage API per workspace (needs a key the runner does not have and should probably not get), or keep a
running total in a small committed file (needs the runner to write to the repo, which it currently
cannot — `permissions: contents: read`).

Deferred deliberately rather than half-built. Until it lands, the AHEAD line reads
`API $X last run · MTD UNVERIFIED`. **Size M, Tier 1.** Blocks the `$X MTD of $50` field of the brief.

**N29. STARNET +4 sites go-live 2026-09-07 — readiness check. Tier 0 (read-only).**
verified: YES — `INCIDENTS/2026-09-06-starnet-expansion-readiness.md`, 2026-09-07 02:30Z, `main` @ `0a5439e`,
`postgres-readonly` + one `railway variables` read. Four sites (`015a37e9` CCDC Folsom, `a4588d96` CCDC
Broadway, `ab450901` 375 Shopping Complex, `7fabf0ee` Jasper) created 2026-09-06 22:11–22:34Z; **all four
have a `site_geofence` row** (4-vertex polygon, center, radius 90/70/300/50 m). Five guards GRD0010–GRD0014
created the same hour, all `must_change_password = true`, **0 `guard_devices` rows** — none has ever logged
in successfully. 375 Shopping Complex has **26 shifts, 14:00–00:00 PT daily** through 10-10 (GRD0011 ×17,
GRD0010 ×9); the other three new sites have **0 shifts and 0 clients**. STARNET open sessions 0 at write
time (control 3).

**Blockers for tomorrow (Nataniel, Tier 2, admin portal):**
- **GRD0011 `7b79fc50` has a shift 09-07 14:00 PT and has never opened the app** (0 auth events, no
  device row). Clock-in opens 13:30. Without a login + password change: no clock-in, `missed` at 00:30,
  admin email at 14:10, no report.
- **Clock-in requires a shift row** — `routes/shifts.ts:3443-3446`, `shift_sessions.shift_id NOT NULL`,
  no ad-hoc path exists. If CCDC Folsom / CCDC Broadway / Jasper are staffed tomorrow, shifts must exist
  30 min before start or the guard cannot work in the app at all. UNVERIFIED whether they are staffed.
- **No new site has a client row** → `sendDailyShiftReport` skips and flags `daily_report_email_sent =
  true` anyway (`services/email.ts:483-491`). No backfill.

**Findings that outlive tomorrow:**
- **Brief premise inverted:** a site with **no** fence row is *allowed* (`geofence.ts:176-184`,
  `reason: 'no_geofence'`), not rejected. Fenceless = unenforced, silently.
- **`MOCK_LOCATION_ENFORCEMENT = on` in Railway production.** Code default `off`; the module header says
  `on` is not yet safe; no decision records it. Android-only; 0 of 35 STARNET sessions in 14 d carry
  `clock_in_location_mocked = true` (21 NULL). **[VISHNU] to confirm deliberate or move to `shadow`.**
  Tier 2.
- **Daily report ignores `client_sites`** — recipient join is `clients.site_id` only (`email.ts:476`);
  the "link client to site" path writes only `client_sites` (`routes/clients.ts:330`). Bethel AME has 0
  `clients.site_id` rows, 1 `client_sites` row, and 30 completed shifts flagged sent. **UNVERIFIED
  sent-vs-skipped** — the `[email] sendDailyShiftReport: skipped` log line at the next 09:00 PT run
  settles it. If skipped, Bethel has had no client report since 08-20 and linking a client to the four
  new sites the same way produces none either.
- GRD0013 `95505419` (4 `login_failed`, `failed_count = 3`, lockout at 5) and GRD0014 `faf47dd5`
  (1 `login_failed`) have the app installed and are failing on the password. No shifts, so not a
  tomorrow blocker; the only live signal on onboarding, and it is 2 of 2 failing.
- **Deploy gate:** STARNET now has an open session ~08:00–00:30 PT daily. CONDITION route is available
  ~00:30–08:00 PT only. Coverage is not derivable from contract fields (`contract_end` NULL on all four,
  0 `site_scheduling_profiles`).

---

### Merge-order note (2026-09-06, superseded)

The Phase 4.5 note here said N22–N25 and the AWS / SendGrid expiry rows existed
only on the unmerged PR #9 branch, so only **N1** could carry a `[VISHNU]` tag.
**That is now resolved on this branch:** `ops/n23-enhancement` is merged in
(below), so N22–N25, **E14** and **E15** are all present and taggable.

**The branch stack is now four deep**, and this is the whole of it:

```
main @ 34a32c8
  +-- ops/n23-enhancement        (PR #9)      N22-N25, E14, E15, ai.ts, N23 runbook
  +-- ops/phase-4-5-digest       (5897516)    five-line brief, c_failures_24h
        +-- ops/n27-sentry-ratelimit (12ab534)  sentry-dropped collector, N27
              +-- ops/n28-unauthorized          this branch: N28 (a) + (f)
```

**Merging this branch merges all four.** Both prerequisites were pulled in
because N28 (f) extends `c_failures_24h` (Phase 4.5) alongside the
`sentry-dropped` line (N27) and annotates the **E15** row (PR #9) — none of
which exist on `main`. Reimplementing any of them would have collided on merge.

**Still to do once this lands:** tag N23 (budget-isolation runbook — console
work), N24 (Vercel ToS — Counsel), E14 (AWS free plan ends 2026-09-30) and E15
with `[VISHNU]`, so the brief's WAITING line stops under-reporting them.
**N30. Vehicle-inspection S3 orphans are permanent and uncounted — a fourth orphan population.**
verified: YES — code read on `main` @ `eb974a4`, plus a prod S3 listing.
`submitSlotPhoto` wraps two statements in one `try` (`apps/mobile/app/inspection/index.tsx:182-198`):
`uploadToS3(...)` at `:186`, then `PATCH /inspections/:id` at `:188`. When the S3 POST succeeds
(`apps/mobile/lib/uploadToS3.ts:98`) and the PATCH then fails, the object is already in the bucket
and **nothing references it**: `public_url` is a local `const` returned at `uploadToS3.ts:108`,
consumed only by the PATCH argument, and discarded by `return 'reset'` at `index.tsx:196`. The retry
calls `uploadToS3` again, which requests a **fresh presign** (`uploadToS3.ts:49`) and therefore a
**fresh `uuidv4()` key** (`apps/api/src/routes/uploads.ts:53`). So every failed retry that got past
the S3 POST leaves exactly one permanent orphan.

**The purge cannot reach them.** `step5c_expiredVehicleInspections` selects
`FROM vehicle_inspections` (`apps/api/src/jobs/nightlyPurge.ts:297`) and deletes S3 objects named by
those rows (`:317`). An object with no row is invisible to it — this is row-keyed cleanup, not a
bucket sweep. Same structural shape as the three orphan populations already tracked against S3
retention; this is the fourth.

Not currently measurable from the repo: **no code anywhere in `apps/api/src` performs a
`ListObjects`/`Prefix` scan** (grepped, zero hits), so nothing counts bucket objects against DB rows.
The orphan count is therefore **UNVERIFIED** — establishing it needs an out-of-band reconciliation
listing `inspection/<company_id>/` against the five URL columns.

Population context, read-only 2026-09-08: **9 `vehicle_inspections` rows total** — STARNET 6 (1
incomplete), Star Guard 3 (1 incomplete). Both incomplete rows are 0-photo shells (see N31 note
below), so **neither is evidence of this failure mode**; no orphan has yet been observed, only shown
to be reachable. **Counting is Tier 0; deleting anything from the bucket is Tier 2.** Size M.

**N31. S3 inspection keys are UTC-dated while shifts are Pacific-dated.**
verified: YES — `apps/api/src/routes/uploads.ts:52` is
`const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD`, and `:53` builds the key as
`${context}/${company_id}/${date}/${uuid}.${ext}`. `toISOString()` answers in **UTC**, so every
object uploaded after 17:00 PT (16:00 during PST) files under **tomorrow's** date.

Live instance: session `7d0b32fb-840a-48bb-a9fe-d53f545d9a58` (SFMTA, Star Guard
`b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee`) is Pacific **2026-09-07**; its five objects all sit under
prefix `inspection/b7c7d32d-.../2026-09-08/` — confirmed by `head-object` on all five and a
`list-objects-v2` returning exactly those five. The adjacent `2026-09-07/` prefix is **empty**.

**This is the same bug family as the DOW `getDay()` UTC trap**, and the web already fixed its half:
`apps/web/app/admin/sites/[id]/page.tsx:181-190` replaced `toISOString().slice(0, 10)` with an
`Intl.DateTimeFormat('en-CA', { timeZone })` helper, and its comment says exactly why — *"at 5pm
Pacific it reads as tomorrow"*. `uploads.ts:52` is the same line the web deleted, still live on the
API side. The server-side query fix already exists too and is unrelated to keys:
`siteLocalDayRange` (`apps/api/src/services/dateRange.ts:82-102`) anchors bounds with
`AT TIME ZONE s.timezone`.

**Impact is narrow today and that is the reason to file rather than fix:** no in-repo tool scans by
date prefix (grep for `ListObjects`/`Prefix:` over `apps/api/src` → zero hits), so nothing in
production is currently wrong. The exposure is ad-hoc ops work — a human or agent reasoning in
Pacific over `inspection/<company>/<date>/` is off by one for any evening upload, which already
happened once during the 2026-09-07 triage. Changing the key format is **not** backfillable (existing
keys are immutable and referenced by stored URLs), so the realistic fix is a documented convention,
not a rewrite. **Tier 0 to document; Tier 1 if `uploads.ts` changes.** Size S.
**N32. SCAN HISTORY filters guards by NAME STRING, not `guard_id`.**
verified: YES — `main` @ `eb974a4`, three call sites in
`apps/web/app/admin/sites/[id]/page.tsx`. `guardOptions` builds a `Set<string>` of `guard_name`
(`:787-791`); the `<select>` emits the **name** as the option value (`:1612`,
`<option key={g} value={g}>`); and the predicate compares strings (`:819`,
`if (fGuard && !r.scans.some((sc) => sc.guard_name === fGuard)) return false;`). The filter value
round-trips through the URL as `?guard=<name>`.

**The CHECKPOINT filter immediately below it does this correctly** — `<option value={c.id}>`
(`:1622`), a uuid. So this is an inconsistency inside one control group, not a codebase-wide
convention.

**Names are not identifiers.** Per `netraops-invariants`, badge numbers collide across tenants and
`GRD0004` is "deepak naik" on **both** Star Guard and STARNET SECURITY. Names collide *within* a
tenant too — verified read-only 2026-09-08, `Star Guard` (`b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee`)
holds **two same-name pairs**: `c2f4b9e3-bed9-4693-b752-a04bc115e863` / `a532b077-39ba-43f1-93bd-176752fb6e21`
(GRD0003 / GRD0004, also carried item C23) and `0af98d92-b028-44d6-b1e3-d242161087ac` /
`ed2ccfa0-a9fd-4e5c-a14b-45bc9b2696fd` (GRD0012 / GRD0020). Selecting either name filters to the
union of both guards' scans with no way to separate them, and no indication in the UI that it did.

**Latent, not live — and the check that establishes that is worth keeping.** A site's scan list is
already scoped to one site, hence one tenant, so a collision only bites when both members of a pair
scanned at the **same** site. They have not: grouping `checkpoint_scans` by site and comparing
`COUNT(DISTINCT guard_id)` against `COUNT(DISTINCT LOWER(TRIM(g.name)))` returns **zero rows** —
every site's scan history currently has as many distinct names as distinct guards. Re-run that query
before downgrading this item; it is one roster change away from being wrong.

Second-order: `guard_name` is nullable (`LEFT JOIN guards` at `checkpoints.ts:256`), and `:789`
skips falsy names, so scans with a NULL guard are absent from the dropdown and unreachable by any
filter value.

**Not fixed in this dispatch** — the INSPECTIONS tab shipping alongside keys its guard filter on
`guard_id` from the start, so this item covers SCAN HISTORY only. Fixing it is a contained change to
the three lines above plus the `?guard=` param contract (existing shared links carrying a name would
stop matching — acceptable, or handle by falling back to a name match when the value is not a uuid).
**Size S, Tier 1.**



**N33. Pre-existing hydration mismatch on `/admin/live-status` — the "Last updated" clock.**
verified: YES, and verified as **NOT introduced by the inspection work**, which is the part that took
evidence rather than assertion. Loading the page logs
`Warning: Text content did not match. Server: "22:52:39" Client: "22:52:40"`, traced to a `<p>` inside
`LiveMapPage` (`apps/web/app/admin/live-status/page.tsx`, the "Refreshes in Ns · Last updated
HH:MM:SS" line), followed by `An error occurred during hydration. The server HTML was replaced with
client content in <#document>` — React discards the SSR tree and re-renders the whole page client-side.

**Method, because "it was already broken" is the easiest claim in the world to get wrong:** the
`inspection_incomplete` chip added on `db595cb` edits the same file, so the disproof was
`git stash push -- apps/web/app/admin/live-status/page.tsx`, reload, re-read the console — **the
mismatch reproduced on the unmodified file** — then `git stash pop`. Same-file proximity is not
causation, and stashing is the cheapest way to separate them.

**The cause is structural, not a race.** A wall-clock timestamp rendered during SSR and again at
hydration differs whenever the two straddle a second boundary, which at one-second resolution is most
loads. The value is non-deterministic by construction. The fix is to render the clock only after
mount (`useEffect` + state, so the server emits a placeholder); `suppressHydrationWarning` would hide
the warning while leaving the mismatch in place.

**Same family as the production React errors already carried** — minified `#418` / `#423` / `#425` are
the prod encodings of "text content did not match" and "there was an error while hydrating", recorded
as open after the 2026-08-21 site-detail restructure and never attributed to a cause. This is the
first instance of that family with a named file and a reproduction. It does **not** prove the prod
errors are this line — that mapping is **UNVERIFIED**, and the site-detail page is a different route.

Cost while unfixed: every Live Status load throws away the server render and rebuilds on the client.
Functionally invisible, which is why it has survived, but it lands on the one page an admin keeps open
all shift. **Size S, Tier 1.** Deliberately not fixed in this dispatch — unrelated to inspections, and
folding it in would have quietly widened a scoped change.

**N34. No odometer sanity check — a reading is validated for RANGE only, never against the vehicle.**
verified: YES — read-only against production 2026-09-08.

`PATCH /inspections/:id` accepts any integer in `[0, 9_999_999]`
(`apps/api/src/routes/inspections.ts:220-226`) and the only database constraint agrees:
`chk_vehicle_inspections_odometer` is `odometer_reading IS NULL OR (>= 0 AND <= 9999999)`.
**No monotonicity check, no plausible-delta check, no trigger** (`pg_trigger` on
`vehicle_inspections` returns zero non-internal rows). Nothing anywhere reads the vehicle's previous
reading, because nothing needs to: there is no per-vehicle odometer state — the entire history is
the `vehicle_inspections` rows themselves.

**The reported instance, confirmed.** Same `vehicle_id` `c121646b-bb89-4d30-a91a-87eb409afad0`
(Star Guard, SFMTA, "patrol car 1", plate `ts157651`):

| Pacific date | reading | guard |
|---|---|---|
| 2026-08-24 | **42,130 mi** | `2945918a-d8bd-4309-9a39-30abeee836e7` (GRD0009) |
| 2026-09-07 | **12,201 mi** | `9a92092e-b393-4003-9f7e-8c7b607a5d9b` (GRD0001) |

Backwards by **29,929 mi** on one vehicle, and both rows are `completed_at`-stamped — the server
called each inspection complete.

**The paying tenant's series is ALSO unusable, and that is the part the brief understated.**
Star Guard is the test tenant, so the backwards jump is indeed harmless. But STARNET's
"Maryknoll Patrol Car" (`45d12160-ea9a-46f7-87d0-52e3a371d898`, Cristo Rey) reads
**0 → 5,577 → 5,590 → 5,594 mi** across 2026-08-23 → 08-30. It is monotonic, so a
monotonicity-only rule would pass it — but the anchor is **0**, which is not an odometer, and the
implied first delta is **5,577 mi in 6 days (~930 mi/day)** for a patrol car working one site.
Any mileage-over-time series computed from that first point is wrong by the whole 5,577, on the
customer who asked for the feature. `0` passes the range check today because the constraint's floor
is `>= 0`.

**Blast radius is currently zero, which is exactly why it is worth fixing now.** Grepped: no code in
`apps/api/src`, `apps/web/app` or `apps/mobile` computes a mileage delta, trend or total — every
consumer of `odometer_reading` displays a single row's value verbatim (shift detail, the new
INSPECTIONS tab, the mobile capture screen). So **nothing is producing a wrong number today**; the
corruption is sitting in the data waiting for the first consumer. Building the client's
mileage-over-time report on top of this without a cleaning pass would ship those two defects as
features.

Design notes for whoever takes it, so the obvious fix does not get written twice:
- **Monotonicity alone is insufficient** (STARNET's series is monotonic and still wrong) and also
  **too strict** to hard-fail on: odometer rollover, a vehicle swap, and a genuine typo corrected on
  the next shift all look identical to a decrease.
- Prefer **flag, do not block** — same posture as break overrun, and consistent with the whole
  inspection flow being *prompted, never blocking* (`inspections.ts:4`). A guard on post at 3am must
  not be stuck behind a validator.
- A floor above `0` and a per-day delta ceiling would catch both live cases. Both need the previous
  reading for that `vehicle_id`, which is one indexed query on `vehicle_inspections`.
- Historic rows need a **backfill decision** regardless: a validator added today does not clean the
  two bad series already stored.

**Latent, not urgent. Size M, Tier 1** (API read-path plus a new write-path validation; no schema
change if it is flag-only, one column if the flag is persisted).

**N35. An EXPIRED presigned inspection photo renders as a broken image, not the MISSING tile.**
verified: YES — reproduced against production 2026-09-08, and the code path confirmed on both
surfaces that render inspection photos.

S3 answers an expired link with `AccessDenied` / *"Request has expired"*, quoting
`X-Amz-Expires: 900`, `Expires: 15:46:29Z` against `ServerTime: 17:20:27Z` — 94 minutes past a
15-minute link — on a key under `inspection/27c4d404-…/2026-08-31/`.

**Why it degrades badly rather than gracefully.** The per-slot render keys the empty state on the
URL being absent, not on the image failing to load:

- `apps/web/app/admin/sites/[id]/page.tsx:2245,2249` — `const url = inspDetail[key] as string | null;`
  then `{url ? (<img src={url} …/>) : (…MISSING…)}`
- `apps/web/app/admin/shifts/[shiftId]/page.tsx:564,568` — the same two lines

An expired URL is still a perfectly good non-empty string, so it takes the truthy branch and lands
in an `<img>` that 403s. **Neither file has any `onError` handler** (`grep -rn 'onError'` over both
returns nothing), so the browser's broken-image glyph is the entire feedback. The admin sees the
same visual for "this photo was never taken" and "your link went stale while the tab was open",
which are opposite facts — one is a guard compliance gap, the other is nothing at all.

Refreshing the page re-signs and the photos return, so the data is fine and this is purely a
presentation defect.

**The fix is `onError`, NOT a longer TTL.** The 900s window is the containment property —
`PRESIGN_GET_TTL_SECONDS = 60 * 15` (`apps/api/src/services/s3.ts:189-192`), whose own comment says
it is short so *"a screenshot of the URL becomes useless quickly."* Raising it to paper over a
missing error handler trades a real security property for a cosmetic one. Swap the broken glyph for
an explicit "Link expired — refresh the page" state, distinct from MISSING.

**Wider than the tab.** Any inspection photo opened in a new tab or pasted to someone else hits the
same wall, and there the page-refresh remedy is not available — the recipient has only a dead URL
with no explanation. Same shape applies to every presigned read path, since `urlOrPresign` is shared;
this item is scoped to inspections because that is where it was reproduced.

**Cosmetic, latent.** No data loss, no wrong number, and the failure is self-healing on reload.
**Size S, Tier 1.**

**N36. A deploy can be superseded before anyone verifies it — nothing enforces verify-before-next-merge.**
verified: YES — observed live 2026-09-08, not reasoned about.

`770f38b1-951e-475a-b7b5-5cf28b5da9a4` carried **PR #18**, a real code change: the live-status ping
lateness anchor (`ced1f7b`, 4 files incl. `lib/lateness.ts`) plus a new required CI check
(`13508da`, `.github/workflows/window-anchor.yml`). It reached SUCCESS at **10:50:10 PT**. The next
merge — PR #19, **docs-only** — started `7579554d-4209-4b20-bd73-20208a4818fb` at **11:01:53 PT** and
superseded it. **11 minutes 43 seconds, no health check in between.** `770f38b1` went
SUCCESS → REMOVING having never been probed.

**The code is fine; the process is the hole.** `770f38b1`'s changes are verified now, but only
*transitively*: they are ancestors of `996733c`, whose deploy `7579554d` was checked
(`/health/crons` 200 / 19 jobs / `stale: []`). That is luck of ordering, not a control. Had the
lateness anchor wedged a cron, the docs deploy on top would have produced an identical green and the
regression would read as healthy.

**Nothing gates this.** Branch protection's required contexts are
`["Scan for hard-coded secrets", "Ping window anchor (TS vs SQL)"]` — **both are CI checks on the
code, neither observes the running service.** A merge is never blocked by the previous deploy being
unverified, or unhealthy, or still building. The deploy gate in `POLICY.md` protects *guards from
restarts*; it says nothing about *verifying what the last restart shipped*.

**Sharpened, because "SUCCESS" is the trap.** Railway `SUCCESS` means the container built and
started. It is not a health signal — `/health` only runs `SELECT 1`, and a wedged cron still returns
`{"status":"ok"}` (see the Railway section of `STATE.md`). So even reading the deployment list is
not verification; `/health/crons` is the weakest check that would actually catch this class.

Related and compounding: the Sentry uptime monitor (id `8024493`) is **still pointed at
`https://www.netraops.com`**, the web app, rather than `api.netraops.com/health/crons` — see N4 and
`RUNBOOK-phase4-apply.md` step (d). Until it is repointed there is no automated backstop either, so
an unverified deploy is genuinely unobserved rather than merely unverified-by-a-human.

Cheapest fixes, in order of effort: (a) repoint the uptime monitor, which closes the automated half
without any process change; (b) a one-line post-merge check on `/health/crons` before the next merge
is opened — the sequential-PR discipline that `strict: true` already forces makes the slot natural;
(c) a CI job that polls the deployment and its health after merge, which is the only version that
cannot be skipped by a person in a hurry.

**Procedural, not code. Size S for (a), M for (c). Tier 1.**


---

## New from Phases A–D (2026-09-08)

**N37. Activity-log PDF sorts one row out of order — sorting on a key it does not display.**
verified: PARTIAL — the symptom is observed; the cause is inferred and the age is unknown.

A `19:05 MISSED / ANSWERED LATE` row renders **between 18:04 and 18:50** in the activity-log
PDF. The row is a merged `missed_answered_late`, which by design sorts at the **window's
start** (`event_time = window_start`, where the obligation fell due) while LOG TIME displays
**when it was actually answered**. So the row is almost certainly sorted correctly on
`window_start` and displaying the resolving ping's timestamp — two different instants, one
column. `routes/activityLog.ts` documents that merge and the sort choice explicitly.

**UNVERIFIED — whether this predates Phase D.** The merged-row behaviour long predates it, but
Phase D changed the grid `windows[]` is built from in the same file, so "it was always like
this" cannot be assumed. Cheapest check: render the same shift's PDF from `origin/main` at
`7b30e69` (pre-D) and at `dfdcc8c` (post-D) and compare row order. If identical, it predates
Phase D and is a display bug, not a regression.

Client-facing surface. **Size S to diagnose, S–M to fix. Tier 1.**

---

**N38. Duplicated Pacific formatter in `lib/lateness.ts` — collapse during Phase G, NOT before.**
verified: YES — read directly.

`computeLatenessAnchored` uses a module-level `fmtPacificHHMM`; `computeLateness` keeps its own
inline `Intl.DateTimeFormat` with a byte-identical option bag. Two copies of a three-line
formatter, which this codebase's own doctrine argues against.

**Deliberate, and the timing matters.** PR #18 froze `computeLateness` so the two hourly-report
call sites could not regress, and proved it byte-identical to `main` with a mechanical `diff`.
Collapsing the formatter now edits that function and **destroys the byte-identity proof** that
is currently the only thing protecting the `computeLateness(…, [0])` report columns.

Do it in Phase G, when `lateness.ts` is open anyway for `PING_STALE_MINUTES`, and re-establish
the proof on the other side. Flagged in-code at `lib/lateness.ts` so it is not discovered as an
oversight.

**Size S. Tier 1. Blocked on Phase G by choice, not by dependency.**

---

**N39. CI runs `ts-node` directly, so the `npm run check:window-anchor` path is unexercised.**
verified: YES.

`.github/workflows/window-anchor.yml` invokes `npx ts-node scripts/check-window-anchor.ts`
rather than the npm script. Deliberate: `check:window-anchor` passes
`dotenv_config_path=../../.env`, which does not exist on a runner, and routing CI through
`dotenv` adds a dependency the check does not need.

**The cost is that the npm script is now the untested path.** A local run and a CI run no
longer exercise the same entry point, so the two can drift — a change to the npm script's flags
would be invisible to CI, and the CI invocation could drift from what a developer runs locally.
Neither is load-bearing today; both are the kind of gap that surfaces as "it passes in CI".

Options: point CI at the npm script and make the dotenv path optional, or delete the npm script
and document the direct invocation. **Do not leave two entry points with one tested.**

**Size S. Tier 0.**

---

**N40. `docs/03-UX-DESIGN.md:202` and `docs/04-APP-FLOW.md:564,571` document a hook that does not exist.**
verified: YES — `grep -r useBatteryThrottle apps/` returns **zero** occurrences.

Both files describe
`pingIntervalMs = useBatteryThrottle((activeShift.ping_interval_minutes ?? 30) * 60_000)`
and a battery-throttled background ping cadence. **There is no `useBatteryThrottle`**, and
`ping_interval_minutes` — though carried in the active-session payload and declared in three
mobile type definitions — **is never read on mobile at all**. Background location is
event-driven native geofencing, not a periodic timer.

**Do not plan Phase F from those two sections.** They describe an architecture that was either
never built or was removed without the docs following. `04-APP-FLOW.md` was modified 2026-09-03
and still carries it; `03-UX-DESIGN.md` has not been touched since 2026-05-16.

The correct sources for mobile ping behaviour are `apps/mobile/lib/pingSchedule.ts` (the grid,
hardcoded 30) and `apps/mobile/tasks/locationBackground.ts` (geofencing, not polling).

**Size S to correct the docs. Tier 0. Blocks nothing, misleads everything.**

---

**N41. `schema_v68.sql` comment says "138 existing rows"; the real count was 210.**
verified: YES — 211 sessions at write time, 210 NULL.

The figure was taken from a `routes/admin.ts` comment dated 2026-09-03 during the C0 audit and
not re-counted before the migration was written.

**Do NOT amend the migration.** It is applied in production, and editing an applied migration —
even for a comment — changes what a replay-from-empty produces, for a number that is
illustrative and load-bearing on nothing. The semantics of NULL do not depend on how many rows
carry it.

Recorded here so the discrepancy is not later mistaken for evidence that the migration ran
against a different dataset than intended.

**No action. Recorded only.**

---

**N42. Phase H must narrow the `shift_sessions` CHECK so an interval ≤ 10 is unreachable.**
verified: YES — the inversion is reasoned from code read this session, not observed in prod.

`sites.ping_interval_minutes` permits **5–240** (`schema_v14.sql:39`) and
`shift_sessions.ping_interval_minutes` (schema_v68) has **no CHECK at all** — deliberately, so
the constraint could land with the picker that defines the allowed set.

**Below ~10 minutes the `pingReminder` recovery range inverts.** `recoveryMsFor` is
`min(10 min, interval/3)`, so at interval 5 it yields 1 min 40 s — correct. But the *reason* the
formula exists is that a flat range at or above the interval spans past the **next** window's
close, at which point `windowJustClosed` has already advanced to the newer window and the tail
of the range is unreachable. The recovery that `schema_v57` was written to provide then
**silently becomes a no-op** — no error, no log, no missing row. Exactly the failure class this
repo keeps re-encountering.

The formula protects the code path; it does **not** protect the data. A direct
`UPDATE sites SET ping_interval_minutes = 5` remains possible, and the picker is not an
enforcement boundary (D15).

Phase H should add a CHECK on `shift_sessions.ping_interval_minutes` admitting only the picker
set, and consider narrowing the `sites` CHECK to match. **Verify the existing 211 rows satisfy
any new constraint before adding it** — 210 are NULL and one is 30, so a NULL-permitting CHECK
on {15,30,45} passes today, but re-check at the time.

**Size S. Tier 1 (expand-only migration). Blocks: nothing. Blocked by: the picker set, now
locked as D15.**


---

## New from Phase A schema work (2026-09-09)

**N43. `migrate.ts` has been unrunnable end-to-end since 2026-08-29 — a full replay dies at file 6 of 74.**
verified: YES — mechanism read at `7de9e0c` and both halves confirmed against production.

`npm run db:migrate` replays every file in the `migrate.ts` array from `schema.sql` onward. It
now **aborts at `schema_v5.sql`** and applies nothing after it.

**Mechanism.** `apps/api/src/db/schema_v5.sql:10-12` is an **unguarded** re-add:

```sql
ALTER TABLE break_sessions
  ADD CONSTRAINT break_sessions_break_type_check
  CHECK (break_type IN ('meal', 'rest', 'other'));
```

`schema_v61.sql:89-90` (`UPDATE break_sessions SET break_type = 'break' WHERE break_type <> 'break'`,
landed in `0931d87`, **2026-08-29**) relabelled the domain, and `schema_v62.sql` narrowed it to
`CHECK (break_type = 'break')`. v5's preceding `DROP CONSTRAINT IF EXISTS` (`:7-8`) is therefore a
no-op — that constraint no longer exists — so the `ADD CONSTRAINT` runs, **validates against live
data**, and raises **SQLSTATE 23514**.

Production confirms both halves:
- `SELECT break_type, COUNT(*) FROM break_sessions GROUP BY 1` → **31 rows, all `'break'`**.
- CHECK constraints on `break_sessions` today: `chk_break_sessions_break_type`
  (`CHECK (break_type = 'break')`) and `chk_break_sessions_ended_by`.
  **`break_sessions_break_type_check` is absent.**

`'break'` is not in `('meal','rest','other')`, so the constraint cannot validate.

**Why it takes the whole run down.** `migrate.ts:11-15` loops with **no per-file `try/catch`** (the
`try` has only a `finally`), and `migrate.ts:23-26` does `process.exit(1)` on the first rejection.
So the failure at file 6 of 74 means **every migration from `schema_v6.sql` onward is unreachable**
by this path — including any future file appended to the array.

**Consequence already absorbed.** `schema_v71/v72/v73` (Phase A) were applied **by hand via psql**,
not through `migrate.ts`. Their array entries exist and are correct, but the array was not the
mechanism of application. Any future migration must assume the same until this is fixed.

**Not fixed here, deliberately.** This is pre-existing and predates the Phase A work; repairing a
historical migration is its own decision with its own blast radius (the fix is either guarding v5's
`ADD CONSTRAINT` in a DO block, or aligning its CHECK with the post-v62 domain — and either edits a
file that has already been applied to every environment). Do **not** fold it into a feature phase.

**Related:** the same class of latent defect is why `schema_v71.sql`'s DO-block guards are qualified
with `AND conrelid = 'shifts'::regclass` (following `schema_v8.sql:31-34`) rather than matching on
`conname` alone.

**Size S to fix, M to re-validate the whole chain. Tier 1 (touches an applied migration).**

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
