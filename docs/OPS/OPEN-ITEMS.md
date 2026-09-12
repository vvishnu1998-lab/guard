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

## New from Phase C overlap block (2026-09-09)

All six were found or deliberately deferred while adding overlap checks to the three
unguarded write paths. None is fixed by that work.

**N44. `repeat_days` has no transaction — a mid-loop INSERT failure commits a partial series and returns 500.**
verified: YES — read directly at `b7490c8`.

`apps/api/src/routes/shifts.ts:400-409` inserts one row per generated window in a bare
`for` loop of `pool.query` calls. There is **no `BEGIN`/`COMMIT`**. Each insert is its own
autocommit transaction, so a failure at iteration *k* leaves iterations 1..*k*-1 **already
committed** and the handler throws — the admin sees a 500 and a partially created series
with no indication of how much landed.

`specific_dates` does not have this problem: `:263` opens a transaction and `:283`
rolls the whole batch back on conflict.

**Phase C did NOT fix this.** It added a pre-loop batch overlap check
(`:398-...`) so that *conflict* creates zero shifts, which closes the common case. It does
not help a mid-loop failure from any other cause — a constraint violation, a dropped
connection, a statement timeout.

Fix is to wrap the loop in a transaction the way `specific_dates` already does. Deliberately
out of scope for Phase C: it changes a transaction boundary on a live write path, which
deserves its own diff and its own review.

**Size S. Tier 1.**

---

**N45. Every overlap check is check-then-act under READ COMMITTED — none locks the candidate guard's rows.**
verified: YES — all call sites read at `b7490c8`.

There are now eleven guard-overlap checks in `routes/shifts.ts` (eight pre-existing, three
added in Phase C). **Not one of them locks the candidate guard's other shift rows.** Where a
lock exists it is `FOR UPDATE OF sh` / `FOR UPDATE OF ssr, sh` on the row being *mutated*,
which is a different row from the one that would collide.

Postgres runs READ COMMITTED here and there is no advisory lock anywhere in the file. So two
concurrent requests can both run the check, both see no conflict, and both write — producing
exactly the double-booking the checks exist to prevent. The window is small and the observed
production rate is zero, but the guarantee is not there.

A real guarantee needs one of:
- `SELECT … FOR UPDATE` over the overlapping rows inside each transaction — which does not
  work for the two paths that have no transaction (`single`, `repeat_days`), or
- a GiST **exclusion constraint** on `tstzrange(scheduled_start, scheduled_end)` partitioned
  by `guard_id`. **`btree_gist` is not installed** (`pg_extension` carries only `plpgsql` and
  `uuid-ossp`), and the constraint would have to tolerate the 31 historical overlapping pairs
  already in production — so it needs a `NOT VALID` add plus a decision about the existing rows.

`services/shiftOverlap.ts` says this in its docblock so nobody mistakes the helper for a
guarantee.

**Size M–L. Tier 1 (contract-phase migration if the exclusion constraint route is taken).**

---

**N46. `notifications.tsx` swallows any 409 on swap-response / handoff-response and substitutes the wrong sentence.**
verified: YES — `apps/mobile/app/(tabs)/notifications.tsx:214-232` read directly.

```
if (err.status === 409) {
  return `This ${kind} was already responded to, or it expired. Pull down to refresh.`;
}
```

Every 409 from those two routes is discarded and replaced with that fixed string. **This is
already wrong today**, before any Phase C change: `swap-response` emits 409 at
`shifts.ts:1745` (stale/reassigned) **and** at `:1761` (the incoming guard now has an
overlapping shift); `handoff-response` emits 409 at `:1903` and `:1932`. A guard told the
invite "expired" pulls to refresh, sees it still there, and retries — the message is not
merely unhelpful, it is false.

The comment at `:206-208` justifying the status-based branch claims *"for these two routes
each status maps to exactly one situation class."* That is not true and was not true when it
was written.

**Fix order matters.** The server must emit a machine `code` in the 409 body and the mobile
client must branch on it — and **the mobile change has to ship first, by OTA, before any API
change to those two routes**, or the window between deploys makes the wrong copy more likely,
not less.

⚠ **Nandu is OTA-unreachable** — iOS build 44, runtime 1.0.14, below the 1.0.17 floor that
carries an update client. Any device on that build keeps the current behaviour regardless of
what is published.

Phase C did **not** touch these two routes, precisely because of this.

**Size S on each side, M to sequence. Tier 1 (mobile OTA, then API).**

---

**N47. `idx_shifts_guard_scheduled` is the wrong column pair for the canonical predicate.**
verified: YES — measured against production.

Phase A shipped `idx_shifts_guard_scheduled (guard_id, scheduled_start)`. The canonical
overlap predicate is `guard_id = $1 AND scheduled_start < $end AND scheduled_end > $start`.
`guard_id` equality uses the index; `scheduled_start < $end` is open-ended downward and so
barely narrows anything; `scheduled_end > $start` is not in the index at all and lands as a
heap filter.

Measured on the three heaviest guards — index range candidates vs rows surviving the filter:

| guard_id | badge | shifts | index candidates | after filter |
|---|---|---|---|---|
| `9a92092e-b393-4003-9f7e-8c7b607a5d9b` | GRD0001 | 72 | **72** | 12 |
| `e8274964-c274-4fde-ad4d-82bb1e128bc2` | GRD0002 | 40 | **40** | 0 |
| `2945918a-d8bd-4309-9a39-30abeee836e7` | GRD0009 | 29 | **29** | 7 |

The index returns **every one of that guard's shifts** and discards 80%+ in the heap.
`(guard_id, scheduled_end)` is the better pair — it bounds the side that actually excludes.

**Not urgent.** `shifts` is 511 rows in 11 pages; the planner currently chooses a sequential
scan for this predicate regardless, and will keep doing so for a long time. Revisit when the
table is large enough for the plan to matter — and if the N45 exclusion constraint lands
first, it supplies a usable GiST index and this becomes moot.

**Size S. Tier 1 (expand-only, `CREATE INDEX CONCURRENTLY` in its own single-statement file
— see `schema_v72.sql` for why).**

---

**N48. `repeat_days` stamps time-of-day with server-local `setHours`, and skips the site `is_active` check.**
verified: YES — read directly.

Two independent defects on the same path:

1. **`shifts.ts:373` resolves day-of-week in SITE tz** (`dowInTimeZone(cur, siteTz)`) and then
   **`:376` stamps time-of-day with a SERVER-local `setHours`**. The container runs UTC, so the
   series preserves the UTC wall clock rather than the site's, and drifts by an hour across a
   DST transition inside its own 28-day horizon. `specific_dates` does not have this — it binds
   `AT TIME ZONE $8` from `sites.timezone` (`:293-294`).
2. **`:352-397` never checks `sites.is_active`.** `specific_dates` returns 409
   *"Site is deactivated. Reactivate it before scheduling shifts."* at `:236-238`; the
   `repeat_days` and `single` paths select only `id, timezone` (`:334`) and will happily create
   shifts at a deactivated site.

⚠ **COUPLING — read before fixing (1).** Phase C's pre-loop overlap check deliberately compares
**the same drifted `Date` objects the INSERT binds** (`pending[].start/.end` → `toISOString()`
at `:405`). That is correct today: the check tests exactly what gets written. **Whoever fixes
the `setHours` defect must fix both together.** Change the window construction without changing
the check and the check starts testing a different series than the one created — which is worse
than the drift itself, because it silently reintroduces the double-booking Phase C closed.

Currently unobservable in production: all 23 sites are `America/Los_Angeles`.

**Size S each. Tier 1.**

---

**N49. `repeat_days` runs N pre-loop overlap queries where one `unnest` would do.**
verified: YES — by construction.

Phase C's batch check issues **one query per generated window** — up to **29** at the 28-day
horizon with all seven days selected (`while (cur <= horizon)` iterates 29 times). One query
that `unnest`s the window arrays and joins against `shifts` would make it O(1) round trips.

Accepted for now because the handler **already** performs one INSERT round trip per window in
the loop below (`:400-409`), so the check does not change the route's complexity class — it
doubles a count that was already O(N), on a route that is already unbatched.

Doing it requires a second exported function on `services/shiftOverlap.ts` (the single-window
`findOverlappingShift` cannot express it). **Worth doing if the 4-week horizon ever grows**, or
if `repeat_days` is ever called with a much larger day set.

**Size S. Tier 0.**

---

**N50. `adminPost` throws a plain `Error`, so apps/web cannot reach the `conflict` object the shift-creation 409 now carries.**
verified: YES — read directly at `9764e1d`.

`apps/web/lib/adminApi.ts:59-66`:

```js
export async function adminPost<T>(path: string, body: unknown): Promise<T> {
  const res = await adminFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
```

Only `.error` survives. Everything else in the body is discarded before the caller sees it.

**`adminPatch` was already upgraded for exactly this reason** (`:68-79`), throwing the local
`ApiError` that carries `status` and the full parsed `body`. Its docblock at `:29-33` says why,
naming this precise case:

> *"the 409 from PATCH /api/shifts/:id includes a `conflict` object naming the colliding shift
> so the UI can link straight to it. Throwing a bare `Error(err.error)` discards that, leaving
> the admin with a sentence they cannot act on."*

`adminPost` never got the same treatment. So now that all four admin creation paths emit the
`conflict` object, **`ScheduleShiftModal` still cannot deep-link from any of them** — it renders
`e.message` at `:291` and the structured field never arrives.

Nothing is broken by this: the sentence is complete and actionable on its own, and the modal
behaves identically before and after. It is unrealised value, not a regression.

**Why it is its own change.** The fix is one line — swap the `throw` for the `ApiError` shape
`adminPatch` already uses — but it changes the error TYPE every admin POST in the app throws.
`ApiError extends Error` and `message` is unchanged, so every existing `catch (e) { e.message }`
keeps working by construction; still, that is an app-wide blast radius for a one-line diff and it
deserves its own review rather than riding along inside a route change. `adminGet` (`:50-57`) and
`adminDelete` (`:81-87`) have the same gap and should move at the same time.

**Size S. Tier 1 (touches the shared admin fetch layer).**

---

## New from Phase B coverage matching (2026-09-09)

**N51. No `(site_id, scheduled_start)` index for the coverage match join.**
verified: YES — `pg_indexes` on `shifts` read at `749aa32`.

Phase B matches expanded template slots against shifts on **exact `scheduled_start` equality**,
scoped by `site_id`. `shifts` carries three indexes and none serves that join:

```
shifts_pkey                 UNIQUE btree (id)
idx_shifts_email_pending    btree (scheduled_end) WHERE daily_report_email_sent=false AND status='completed'
idx_shifts_expires_at       btree (expires_at)    WHERE legal_hold=false
idx_shifts_guard_scheduled  btree (guard_id, scheduled_start)     -- Phase A
idx_shifts_scheduled_start  btree (scheduled_start)               -- Phase A
```

`idx_shifts_scheduled_start` covers the window bound but not the `site_id` equality, so the
`occupied` CTE filters by site after the range scan. `(site_id, scheduled_start)` is the right
pair for both the window filter and the match join.

**Not urgent and deliberately not shipped here.** `shifts` is 511 rows in ~11 pages; the planner
seq-scans this predicate regardless, and Phase A already added two indexes to this table. Adding a
third in the same arc without a measured plan change would be cargo cult. Revisit when the table
is large enough for the plan to matter — and note that N47 already proposes
`(guard_id, scheduled_end)` for the overlap predicate, so the two should be decided together
rather than bolted on one at a time.

**Size S. Tier 1 (expand-only, `CREATE INDEX CONCURRENTLY` in its own single-statement file — see
`schema_v72.sql` for why).**

---

**N52. Two DST hazards in the coverage slot expansion — measured, documented in code, NOT fixed.**
verified: YES — both measured against production Postgres 18.6.

The expansion converts a site-local wall clock to an instant with
`(date + time)::timestamp AT TIME ZONE tz`, the same round-trip `services/tasks.ts:73` uses and
the same one `routes/shifts.ts` binds when creating a shift. On a DST transition day that
conversion is not injective, in both directions:

**1. SPRING FORWARD — a nonexistent local time does not raise; it maps forward.**
```
('2027-03-14'::date + '02:30'::time)::timestamp AT TIME ZONE 'America/Los_Angeles'  ->  2027-03-14T10:30Z
('2027-03-14'::date + '03:30'::time)::timestamp AT TIME ZONE 'America/Los_Angeles'  ->  2027-03-14T10:30Z
```
A 02:30 slot and a 03:30 slot **collapse onto the same instant**. Under exact-instant matching one
shift satisfies both, and `filled` over-counts.

**2. FALL BACK — the ambiguous hour resolves to the LATER (standard-time) instant.**
```
('2026-11-01'::date + '01:30'::time)::timestamp AT TIME ZONE 'America/Los_Angeles'  ->  2026-11-01T09:30Z
```
PDT 01:30 would be 08:30Z; Postgres returns 09:30Z (PST). A shift genuinely created at the *first*
01:30 will not match its slot, and that slot reads unfilled.

**When they first bite.** US transitions are **2026-11-01** and **2027-03-14**. The window is 14
days from today site-local, so the first window containing a transition opens **2026-10-19**.
Neither fires before then.

**Why not fixed in Phase B.** Both need a decision about what a slot *means* on a transition day —
does an 02:30 Sunday slot exist at all in the spring, and which 01:30 does a fall-back slot refer
to? That is a product question, not a formatting one, and answering it wrong is worse than the
current deterministic behaviour. Both are named in a comment at the expansion in
`routes/scheduling.ts` so the next reader finds them before a late-October window does.

**Currently unobservable in another sense too:** all 23 sites are `America/Los_Angeles`, so there
is exactly one transition pair to reason about, not one per zone.

**Size M to decide, S to implement. Tier 1.**

---

**N53. `GET /api/scheduling/coverage-status` applies no `is_active` filter, so deactivated sites appear in the payload.**
verified: YES — read at `749aa32`, confirmed against production.

`routes/scheduling.ts:355-357`:
```js
const siteRows = isVishnu
  ? await pool.query('SELECT id FROM sites')
  : await pool.query('SELECT id FROM sites WHERE company_id = $1', [req.user!.company_id]);
```

No `is_active` predicate. `GET /api/sites` **does** filter — `routes/sites.ts:55-58` documents
*"Default: hides deactivated sites (is_active = false) for company_admin"* — so the coverage array
contains rows the consuming page has no card to attach them to.

Production holds exactly one deactivated site: **`6c638a80-a887-4375-9687-bfb6c1acb3bc`**
("william pen hotel", STARNET SECURITY `27c4d404-8769-49ca-bfd6-93cb9b890067`).

**Harmless today**, on two counts: it has no scheduling profile, so `has_active_profile` is false
and both surfaces render nothing for it; and the pages key coverage by `site.id` off their own
site list, so an unmatched entry is simply never looked up. It is wasted payload and a latent
mismatch, not a bug anyone can see.

Fix is one predicate, but it should match whatever `sites.ts` decides for the vishnu case — that
role deliberately sees deactivated sites as an audit surface, so the filter is not
unconditional.

**Size S. Tier 0.**

---

**N54. Both admin surfaces depend on API fields shipped in the same commit, and deploy order is not enforced.**
verified: YES — by construction; `apps/api/railway.json` and the Vercel project deploy
independently off the same merge.

Phase B adds `has_slots`, `filled`, `off_template` and `window` to `/coverage-status` and reads
them in `app/admin/shifts/page.tsx` and `app/admin/sites/page.tsx`. **Nothing sequences the two
deploys.** Both fire off the same merge to `main`; either can win.

**Vercel ahead of Railway — MITIGATED IN CODE.** The new build would receive the pre-Phase-B shape,
where the Phase B fields are absent. Treating `has_slots` as falsy would render **"No slots
configured"** on every profiled site. Both surfaces therefore declare the Phase B fields
**optional** and branch on `has_slots === undefined` — meaning "old API" — returning the exact
pre-Phase-B rendering rather than the new one. `!cov.has_slots` is only ever reached after that
guard. Verified by grep: every `!cov.has_slots` (`shifts/page.tsx:437`, `sites/page.tsx:1155`)
sits after its guard (`:416`, `:1140`).

**Railway ahead of Vercel — NOT mitigable from this commit, and cosmetic.** The *already deployed*
web build reads `cov.scheduled`, which the new API no longer sends, with **no nullish fallback** —
`sites/page.tsx` renders `{cov.scheduled} / {cov.required} scheduled`. During that window the
sites page shows **"undefined / 24 scheduled"**. It is cosmetic, it self-heals the moment Vercel
finishes, and it cannot be fixed here because the offending code is what is already live. Recorded
so it is recognised rather than diagnosed from scratch.

**The general point outlives this phase.** Any API field a web surface reads in the same commit has
this shape. The convention that makes it safe — optional field, explicit `undefined` branch, never
truthiness — is the one to apply next time, and the reverse direction is the one nobody can
retrofit.

**Size S (this instance is handled). Tier 1 as a standing practice.**

---

## New from the unassigned-banner filter (2026-09-09)

**N55. ISO vs US date format split across the admin app — the same string reads as two different days.**
verified: YES — both halves read at `fd3cf50`, counts re-derived rather than estimated.

`/admin/shifts` renders its date range in **ISO** while every date picker one click away renders
in the **browser's locale**. For a US admin the same underlying value appears as `2026-10-09` in
one place and `10/09/2026` in another.

**`10/09/2026` and `2026-10-09` denote DIFFERENT DAYS** — 9 October versus 10 September. This is a
misreading risk, not an aesthetic one: an admin comparing a header range against a picker they
just set has no way to tell which convention either is using.

**ISO side** — `apps/web/app/admin/shifts/page.tsx`:
```
:363  {windowFrom} — {windowTo}                              header range
:405  {' '}between {windowFrom} and {windowTo}.              banner (site view)
:423  {' '}between {windowFrom} and {windowTo}.              banner (guard view)
:446  No sites have unassigned shifts between {windowFrom} and {windowTo}.
```
All four resolve from `apps/web/lib/shiftFormat.ts:117-124`:
```js
export function dayOffsetInZone(offsetDays: number, tz?: string): string {
  ...
  return d.toISOString().slice(0, 10);      // ISO by construction
}
```
`toISOString().slice(0, 10)` cannot produce anything but `YYYY-MM-DD`.

**Locale side** — `apps/web/components/admin/ScheduleShiftModal.tsx:372`:
```jsx
<input type="date" value={singleDate} min={todayInputMin} onChange={...} />
```
`<input type="date">` **holds** an ISO value (`value` is always `YYYY-MM-DD` per spec) but
**renders** in the browser's locale. Nothing in this repo chooses that format and nothing can
override it without replacing the native control.

**THE SPLIT IS APP-WIDE, NOT LOCAL TO THIS PAGE.** `<input type="date">` appears **21 times across
9 admin files** — `admin/sites/page.tsx`, `admin/sites/[id]/page.tsx`,
`admin/shifts/[shiftId]/page.tsx`, `admin/live-status/page.tsx`, `admin/billing/page.tsx`,
`admin/guards/page.tsx`, `components/admin/ExportPanel.tsx`,
`components/admin/ScheduleShiftModal.tsx`, `components/ActivityLogTable.tsx` — plus 4 more in the
client portal. Every one of them renders in browser locale beside ISO text somewhere on the same
screen.

**Why this is not a one-line fix.** Three options, each a decision about the whole admin app:

1. **Render ISO everywhere.** Requires replacing every native `<input type="date">` with a custom
   control, losing the platform date picker, its keyboard handling and its mobile UX.
2. **Render locale everywhere.** Requires formatting all four ISO display sites (and every other
   ISO date string in the admin app) through `Intl.DateTimeFormat`, and accepting that a shared
   link renders differently for a colleague in another locale — which matters now that
   `?unassigned=1` and the `/admin/sites/[id]` filters make filtered views shareable.
3. **Force one locale for the whole admin app** (e.g. `en-CA`, which is ISO), making both sides
   agree at the cost of ignoring the user's own setting.

There is no correct answer available from inside one page, which is why this is filed rather than
fixed. Whoever takes it should decide the convention first and apply it in one pass; a partial fix
makes the inconsistency harder to spot, not easier.

**Note on a correction:** an earlier pass estimated "twelve other date inputs" from reading grep
output. The counted figure is 21 admin + 4 client = **25**. Recorded so the smaller number is not
carried forward.

**Size S to decide, M to apply. Tier 1 (display convention, whole admin app).**

---

## New from Phase D slot assign (2026-09-09)

**N56. `shiftPush.ts:4-5` claims one caller; there are five.**
verified: YES — counted at this ref, not estimated.

`apps/api/src/services/shiftPush.ts:4-5`:
```
 * Called post-commit from POST /shifts (all three modes: single,
 * specific_dates, repeat_days) with the set of shift rows just created.
```

`grep -rn "pushShiftAssignments(" apps/api/src` excluding the definition returns **five**:

```
routes/shifts.ts:347      POST /shifts          specific_dates
routes/shifts.ts:507      POST /shifts          repeat_days
routes/shifts.ts:561      POST /shifts          single
routes/shifts.ts:734      PATCH /:id/assign-guard      ← not "POST /shifts"
routes/scheduling.ts:961  POST /site/:siteId/assign-slots   ← added by Phase D
```

The docblock was already wrong before Phase D: `PATCH /:id/assign-guard` has called it since the
assign-guard overlap work, and that is not a creation path at all — it pushes for an *assignment*
transition, which is why Phase D's PATCH branch pushes too.

**Reported in the Phase 0 audit and never filed.** Recording it now so the next person reading
that docblock to answer "who calls this?" does not get a wrong answer for a third time. Also worth
noting the substantive risk the comment hides: anyone reasoning about push volume or dedup from
"only POST /shifts calls this" will be wrong by two call sites, one of which fires per bulk
assignment.

Fix is a comment. **Size XS. Tier 0.**

---

**N57. No unique constraint on `(profile_id, day_of_week, shift_start_time)`.**
verified: YES — `pg_constraint` and `pg_indexes` on `site_profile_shifts` read at this ref.

`site_profile_shifts` carries a PK on `id`, an FK to `site_scheduling_profiles`, three CHECKs
(`day_of_week` 0-6, `shift_length_hours` 0-24, `guards_needed` 1-10) and one non-unique index
`idx_profile_shifts_profile (profile_id, day_of_week)`. **Nothing prevents two rows describing the
same profile, day and start time.**

Production has none — `GROUP BY profile_id, day_of_week, shift_start_time HAVING COUNT(*) > 1`
returns zero rows — and that absence is doing real work.

**What it protects.** Phase B and D group expanded slots by `(site_id, slot_start)` with
`guards_needed` **summed**, because summing is the only reading consistent with `required`, which
sums every row. But `slot_end` has no equivalent: when duplicates differ in LENGTH the merge has no
correct answer, and `services/slotExpansion.ts` takes `MAX(shift_length_hours)` — the post is
occupied until the last guard leaves. That is documented in the code as **a merge artifact, not a
correct answer**, and it is currently unreachable *only* because no duplicate exists.

**It also protects Phase D's slot identity.** `(site_id, slot_start)` is the key the slot list, the
eligibility query and the bulk-assign action all use. Two template rows at one instant are two
staffing intents collapsed into one addressable slot — the identity still works, but what it
identifies stops being a single template row.

Adding the constraint would make the ambiguity unreachable by construction rather than by luck.
Note it must be added `NOT VALID` or after a duplicate check, and `PATCH /profile/:profileId`
DELETEs and re-INSERTs the whole set (`scheduling.ts:250-259`) so the insert loop would need to
reject a duplicate payload with a 422 rather than a 23505.

**Size S. Tier 1 (expand-only migration).**

---

**N58. The blocked-reason inside a `<select>` option is unverified and may not be readable.**
verified: NO — this is a rendering question and nothing was rendered.

`components/admin/SlotAssignPanel.tsx` renders every candidate guard as an `<option>`, greyed via
`disabled` when `free_count === 0`, with the reason in the label:

```
Ravi Kumar (GRD0009) — free for 17 of 22 — Busy elsewhere: Media towers Wed 09:00
```

That is the locked behaviour — unavailable guards greyed **with the reason**, never hidden — and
the enum-to-label mapping is right. What is unknown is whether a string that long is legible inside
a native option list at this control's width. Native `<option>` cannot be styled, does not wrap,
and truncates differently per browser and platform; on a narrow viewport the reason may be the part
that disappears, which would leave a greyed name with no explanation — the exact failure the
greying was chosen to avoid.

**If it reads badly the fix is a different CONTROL, not different wording.** A listbox of real
elements (a button + a popover list) can wrap, can put the reason on its own line in a muted style,
and can keep the name visible while the reason truncates. Shortening the sentence to fit a native
option would trade the information away to keep the widget.

Decide it on a rendered screen at a real width, not in review.

**Size S to confirm, M if it needs the different control. Tier 0.**

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

---

## New from Phase E guard deactivation (2026-09-09)

**N59. No guard delete route exists — and `shifts_guard_id_fkey` is `ON DELETE CASCADE`.**
verified: YES — routes and catalog both read at this ref.

`apps/api/src/routes/guards.ts` declares exactly one `router.delete`, at `:1041`, and it deletes a
`guard_site_assignments` row, not a guard. `grep -rn "DELETE FROM guards" apps/api/src` returns
**zero**. `guards` has no `deleted_at` and no soft-delete flag. There is today no way to remove a
guard through the API at all.

That absence is currently the only thing standing between this schema and silent evidence loss:

```
shifts_guard_id_fkey             FOREIGN KEY (guard_id) REFERENCES guards(id) ON DELETE CASCADE
shift_reassignments_shift_id_fkey FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE CASCADE
```

Deleting one guard row would therefore cascade away **every shift they have ever held** — including
`completed` ones, which are the audit trail for work that was performed and billed — and then
cascade again into `shift_reassignments`. No warning, no count, no returned rows. The 511-row
`shifts` table is the system of record for what happened; a `DELETE FROM guards WHERE id = …` is a
one-line way to remove an arbitrary slice of it.

The two guard-referencing FKs on `shift_reassignments` (`old_guard_id`, `new_guard_id`) are
`NO ACTION`, which makes the ordering non-obvious rather than safe: whether a delete is blocked by
those or succeeds after the shift cascade has already removed the referencing rows depends on
cascade order, not on intent.

**The decision, stated so the next person does not have to rediscover it:** if a delete route is
ever added, the guard against future shifts must be added *in the same commit*, and the FK's
cascade semantics revisited at the same time — `ON DELETE RESTRICT`, or a soft delete, is almost
certainly what is wanted rather than a route that refuses while the FK stays armed. Phase E
deliberately did **not** add a route whose only job is to 403, because a route that exists only to
refuse invites someone to "fix" it.

Fix is a decision plus, if taken, a migration. **Size M. Tier 1.**

---

**N60. `missedShiftAlert` goes silent on `unassigned` rows — and nobody has decided whether that is right.**
verified: YES — `apps/api/src/jobs/missedShiftAlert.ts:25-30` read at this ref.

```sql
SELECT id FROM shifts
 WHERE status = 'scheduled'
   AND scheduled_start + INTERVAL '10 minutes' <= NOW()
   AND missed_alert_sent_at IS NULL
```

`status = 'scheduled'` is exact. Phase E's deactivation override sets
`status = 'unassigned', guard_id = NULL`, so from that moment the row is invisible to this job. The
same is true of the other three latch crons (`preShiftReminder.ts:53`, `shiftStartReminder.ts:53`,
`lateClockInReminder.ts:159`), but those three are unambiguously correct — there is nobody to
remind. **This one is not.**

The two readings, both defensible, neither chosen:

- **Silence is correct.** A missed-shift alert means "somebody was expected and did not turn up."
  After an unassign nobody was expected, so firing would be a false alarm, and the gap is already
  visible on the schedule and in the unassigned banner.
- **Silence is the exact failure this phase exists to prevent.** An override nobody backfilled
  passes its start time with an empty post and no alarm anywhere. The admin who unassigned 17
  shifts and then forgot is precisely the person this alert would have caught — and the original
  incident is that a post at 375 Shopping Complex went unattended without anyone noticing.

Related but separate, and worth fixing whichever way this goes: the predicate wraps the column
(`scheduled_start + INTERVAL '10 minutes' <= NOW()`), so it cannot use `idx_shifts_scheduled_start`
(v73). Rewriting it as `scheduled_start <= NOW() - INTERVAL '10 minutes'`, the form
`lateClockInReminder.ts:160` already uses, makes it sargable. `schema_v73.sql:38-42` calls this out
explicitly and states the rewrite was not in that phase's scope.

Fix is a product decision, then either nothing or a widened predicate plus a distinct alert body —
an "unfilled post" alert is not the same email as a "guard did not show up" alert.
**Size S. Tier 1.**

---

**N61. Deactivating a guard does not revoke their session — `guards.tokens_not_before` is never written.**
verified: YES — every reference in `apps/api/src` read at this ref.

The revocation mechanism exists and is **enforced**: `middleware/auth.ts:101` selects
`is_active, tokens_not_before` on every guard-authenticated request, and `:122-123` rejects a token
minted before that timestamp. The clients table gets the same treatment at `:142-153`.

**Nothing anywhere writes the guard column.** Every one of the ten hits is a read. So the gate is
armed and permanently unarmed at once: the check runs on every request and can never fire, because
the value is always NULL.

The consequence is narrower than it first looks, and worth stating precisely so nobody over- or
under-reacts. `middleware/auth.ts:101` also selects `is_active`, and a deactivated guard is
rejected on that basis — so deactivation *does* end API access at the next request. What
`tokens_not_before` would additionally cover is the case `is_active` cannot: a guard who stays
active but whose credentials should stop working (a password change, a lost device, a
resend-welcome that mints a new temp password while the old session keeps running). Phase E's
route is the natural place to *also* write it, and did not, because widening deactivation into
session management was not in scope.

So: **"deactivate" does not currently mean "logged out" as a general property** — it means "will
be refused at the next request because `is_active` is false." Those coincide today. They stop
coinciding the moment anything wants to revoke a session without deactivating the account.

Fix is one `UPDATE guards SET tokens_not_before = NOW()` at each revocation point, plus deciding
which points those are. **Size S. Tier 1.**

---

**N62. Four of five deactivated guards still hold open `guard_site_assignments`.**
verified: YES — queried at this ref, resolved by uuid.

| guard_id | badge | name | company_id | open assignments |
|---|---|---|---|---|
| `faf47dd5-9686-44a1-8623-994e8a26fcb3` | GRD0014 | Supriya | `27c4d404-…` STARNET | **2** |
| `7b79fc50-b91a-465c-9b7c-cabf10ab1f9a` | GRD0011 | Anoop | `27c4d404-…` STARNET | **1** |
| `09017296-3676-4ed6-805d-8be537608c74` | GRD0006 | Nikith Reddy | `b7c7d32d-…` Star Guard | **1** |
| `a532b077-39ba-43f1-93bd-176752fb6e21` | GRD0004 | deepak naik | `b7c7d32d-…` Star Guard | **1** |
| `c1f2c8a5-fe03-46e6-8cdc-457d061eee01` | GRD0003 | Nikith | `27c4d404-…` STARNET | 0 |

Five open assignments across four inactive guards — an open assignment being one with
`assigned_until IS NULL`, i.e. no end date at all. Every one of these says "this guard is posted to
this site indefinitely" about somebody who cannot log in.

This is the same finding the Phase 0 audit recorded and it is unchanged. Phase E deliberately does
**not** close assignments on deactivate: an assignment is a posting relationship, deactivation is
an account state, and conflating them would make reactivation lossy — a guard brought back would
silently have lost their posts. The open question is whether the *list* should surface it, since an
admin reading `/admin/guards` sees "2 sites" against an inactive guard with no indication that the
combination is contradictory.

Note for anyone querying this: badges collide. There are two GRD0004s, two GRD0003s and two
GRD0011s across tenants. Resolve by uuid.

Fix is a display decision, not a data change. **Size S. Tier 0.**

---

**N63. `vishnu` can read `deactivation-impact` but cannot deactivate.**
verified: YES — both route declarations read at this ref.

```
routes/guards.ts  GET  /:guardId/deactivation-impact   requireAuth('company_admin', 'vishnu')
routes/guards.ts  PATCH /:id/deactivate                requireAuth('company_admin')
routes/guards.ts  PATCH /:id/reactivate                requireAuth('company_admin')
```

The read matches its sibling `GET /:guardId/assignments/:id/impact`, which has been
`('company_admin', 'vishnu')` since it was written. The write matches what `/deactivate` and
`/reactivate` have always been. Both halves are individually consistent with their neighbours, and
together they produce a super-admin who can see the full blast radius of a deactivation and cannot
act on it.

Phase E did **not** widen the write, on the principle that a phase should not change the auth
surface of a route it was not scoped to change — the rewrite there was about gates and a
transaction, not about who may call it. Widening `/deactivate` to `vishnu` is defensible and
probably wanted, but it is a security-surface decision and belongs in a commit whose subject says
so.

Note `guardBelongsToCaller` (`routes/guards.ts:~490`) already handles the vishnu case explicitly —
it returns `null`, meaning "no company scope" — so the tenant plumbing for a widened write already
exists and would not need to change.

Fix is one argument, plus a deliberate decision. **Size XS. Tier 1.**

---

**N64. Two selected shifts that overlap *each other* both read as free in `shift-candidates`.**
verified: YES — by construction; the predicate is in `routes/guards.ts` shift-candidates at this ref.

The overlap cell excludes only the shift being evaluated:

```sql
WHERE sh2.id <> s.id
  AND <overlapPredicateSql: guard, status IN ('scheduled','active'), half-open instants>
```

That is deliberately identical to `findOverlappingShift`'s `excludeShiftId` contract — "the row
being mutated, so it cannot conflict with itself". It answers *"is this guard free at this
moment, given the shifts they already hold?"* correctly.

It does not answer *"can this guard take this whole selection?"* when the selection contains rows
that collide with one another. Select shifts A and B that overlap, pick one guard, and both cells
report free; the first `PATCH /api/shifts/:id/reassign` succeeds, and the second is refused with a
409 naming A as the conflict. The admin sees one failure and a correct reason, which is a much
milder failure than the offered-then-rejected problem this endpoint was built to fix — but it is
still a case where the pre-evaluation over-promises.

**Why it is not closed here.** Evaluating the selection against *itself* is a different question
from "is this guard free" — it is an interval-packing check over the selected set, independent of
which guard is chosen, and it belongs in the UI as a warning on the selection ("these two shifts
overlap; one guard cannot take both") rather than as a per-guard reason code. Folding it into the
candidates query would make `free_count` mean two different things at once.

Not reachable through either shipped surface today without deliberate effort: the deactivation
dialog lists one guard's shifts, and one guard's own shifts cannot overlap each other (the write
paths that created them all enforce the overlap check). The site page can surface two guards'
overlapping shifts at one site, so it is reachable there.

Fix is a client-side check on the selection. **Size S. Tier 0.**

---

---

## New from N43 migration-chain repair (2026-09-09)

**N65. `information_schema.columns` silently under-reports for `claude_readonly` — it filters by column privilege.**
verified: YES — reproduced against prod at this ref, both views compared side by side.

`information_schema` views are defined to show only objects the current user has some privilege on, and
for `columns` that filter is **per column**, not per table. `claude_readonly` holds column-level grants
that exclude the secret columns, so the view omits them **without any error, warning or row count
signal**. A query that looks complete comes back redacted.

Concretely, `information_schema.columns` returned `guards` with **9 columns**:

```
badge_number, company_id, created_at, email, id, is_active, must_change_password, name, phone_number
```

`pg_attribute` returns **11** for the same table — the two it hid are **`password_hash`** and
**`tokens_not_before`**. The same redaction applies elsewhere: `clients` and `company_admins` lose
`password_hash` + `tokens_not_before`, `guard_devices` loses `push_token`, `login_attempts` loses
`otp_hash`, `password_reset_tokens` loses `token`, `revoked_tokens` loses `jti`, and `vishnu_state`
loses `tokens_not_before`.

**Why this matters beyond tidiness.** `tokens_not_before` is the session-revocation gate
(N61). An audit that inventoried `guards` through `information_schema` would conclude the column
does not exist and that revocation is unimplemented — the opposite of the truth, which is that it
exists, is enforced on every request (`middleware/auth.ts:101,122`), and is simply never written.
The N43 audit hit exactly this and caught it only because the column count contradicted a number
established in an earlier phase.

**The rule: for column inventory under a read-only role, use `pg_attribute`, never
`information_schema`.**

```sql
SELECT c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE c.relkind = 'r';
```

`pg_catalog` does not filter by privilege — it is readable metadata about objects you may not be able
to SELECT from. The re-specified verification protocol in `docs/06-IMPLEMENTATION-PLAN.md` now states
this as a numbered step.

Fix is a habit, not code. Worth a grep of prior audits for `information_schema.columns` to see which
conclusions were drawn from a redacted view. **Size S. Tier 0.**

---

**N66. A constraint NAME tells you nothing about which era's predicate it holds.**
verified: YES — two migrations in one week nearly shipped a guard that would have done nothing.

`schema.sql` declares CHECKs **inline inside `CREATE TABLE`**. Postgres auto-names those
`<table>_<column>_check`. Later migrations then add explicit constraints, sometimes with the *same*
auto-style name and a *different* predicate. So `conname` is not a version marker, and the house
idempotency idiom —

```sql
IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '...') THEN ALTER TABLE ... ADD CONSTRAINT ...
```

— which is correct at `schema_v71.sql:124-149`, is **wrong wherever two eras share a name**. It fails
in *both* directions, and N43 hit one of each:

**Existence guard evaluates TRUE when it should skip** — `schema_v5.sql`. The constraint
`break_sessions_break_type_check` does **not** exist in production; `schema_v61` dropped it and never
restored that name. An existence guard therefore fires the `ADD`, which validates
`break_type IN ('meal','rest','other')` against 31 rows all holding `'break'`, and the replay dies
with 23514 exactly as it did unguarded. The guard would have looked like a fix and changed nothing.

**Existence guard evaluates FALSE when it should fire** — `schema_v75.sql`, the mirror. `schema.sql:7-8`
inlines `CHECK (status IN ('scheduled','active','completed','missed'))` on `shifts.status`, auto-named
`shifts_status_check`. On an **empty** database that name already exists by the time v75 runs, carrying
the four-value predicate — so an existence guard skips, and the six-value widening this file exists to
apply never happens. It would also skip on prod, where the name exists too. It would do nothing,
anywhere, forever.

**The test is `pg_get_constraintdef(oid)`, not `conname`.** Pick a token that can only appear in one
era's predicate and search the rendered definition:

```sql
SELECT pg_get_constraintdef(oid) INTO cur FROM pg_constraint
 WHERE conname = 'shifts_status_check' AND conrelid = 'shifts'::regclass;
IF cur IS NOT NULL AND position('unassigned' in cur) > 0 THEN ... skip ... END IF;
```

`schema_v62.sql:76-92` established this on `break_sessions` — it and `schema_v61` deliberately share
`chk_break_sessions_break_type` so `\d break_sessions` stays the single pre/post tell, and it
discriminates on `position('meal' in cur)`. That precedent should have been the default read and was
not. Where the constraint name is genuinely unique to one migration (`chk_shifts_source`,
`chk_shift_reassignments_direction`) the existence idiom remains correct and is still used.

Fix is a convention. **Size S. Tier 0.**

---

**N67. `schema_v41.sql`'s backfill CASE has no `'break'` branch and no `ELSE`.**
verified: YES — `apps/api/src/db/schema_v41.sql:38-48` read at this ref.

```sql
UPDATE break_sessions
   SET planned_duration_minutes = CASE break_type
     WHEN 'meal'  THEN 30
     WHEN 'rest'  THEN 15
     WHEN 'other' THEN 10
   END
 WHERE planned_duration_minutes IS NULL;

ALTER TABLE break_sessions ALTER COLUMN planned_duration_minutes SET NOT NULL;
```

`schema_v61` later relabelled every row to `break_type = 'break'`. A CASE with no matching WHEN and no
ELSE evaluates to **NULL**, so post-v61 this statement would write NULL into every row it touched —
and the `SET NOT NULL` three lines below would then raise **23502**.

It is inert today, for two reasons that are both accidents of current state rather than design: the
`WHERE planned_duration_minutes IS NULL` predicate matches **zero rows** in production, and the column
is already `NOT NULL` so no new NULLs can appear. Verified: prod has 31 `break_sessions` rows, 0 with a
NULL `planned_duration_minutes`. The replay confirms it too — the chain now runs clean end-to-end
through this file.

The file's own header at `:34` states **"All operations idempotent; safe to re-run."** That claim is
now false in substance. It is true only because nothing can currently reach the broken branch; if
`planned_duration_minutes` were ever made nullable again, or a row were inserted with it NULL, this
becomes a live 23502 at file 42 of 76.

Not fixed in N43 because fixing it means choosing a duration for a `'break'` row, which is a product
question (v62's comment says allowance now derives from scheduled shift length, not from the type),
and because touching a file that currently works to fix a path nothing takes is how new breakage gets
introduced. The minimum honest change is to correct the header claim; the real fix is an `ELSE 30` or
an explicit `WHEN 'break'`.

**Size XS. Tier 0.**

---

**N68. `guards.fcm_token` survives a replay only because `schema_auth.sql` re-adds it at file 2.**
verified: YES — traced statically, then confirmed by the Phase 3 replay completing with no 42703.

`schema_v64.sql` drops `guards.fcm_token`; it is the **only column the entire 76-file chain ever
drops**. Three statements in `schema_v63.sql` reference it in **static** SQL — the
`guard_devices_sync_mirror()` trigger function body, the backfill `INSERT ... SELECT g.fcm_token ...`,
and a `COMMENT ON COLUMN`.

Static SQL is parsed before it is executed. If the column were absent when v63 ran, the backfill would
raise **42703 undefined_column at parse time**, and its `AND NOT EXISTS (SELECT 1 FROM guard_devices)`
guard would **not** save it — a guard in the WHERE clause cannot prevent a parse failure. The file
would abort at position 64 of 76.

It does not, because `schema_auth.sql` (**file 2**) contains:

```sql
ALTER TABLE guards ADD COLUMN IF NOT EXISTS ... , ADD COLUMN IF NOT EXISTS fcm_token TEXT;
```

So a replay **resurrects** the column at file 2, v63 parses and runs against it (all-NULL, so the
backfill inserts nothing and v64's pre-flight computes 0 mismatches / 0 orphans), and v64 drops it
again at file 65. The final schema has no `fcm_token`, matching production — verified in the Phase 3
replay, which reports `guards.fcm_token present? | 0`.

**This is load-bearing and looks like dead weight.** Anyone tidying `schema_auth.sql` — removing an
`ADD COLUMN` for a column the current schema does not have, which is exactly the sort of cleanup that
reads as obviously safe — breaks the chain at file 64. `schema_v64.sql`'s own pre-flight is written
defensively (`has_col` + `EXECUTE` for every reference) and would survive; v63 would not.

Fix is either a comment in `schema_auth.sql` saying why the column must stay, or converting v63's
three static references to dynamic `EXECUTE` guarded on column existence, as v64 already does. The
comment is cheaper and sufficient. **Size XS. Tier 0.**

---

**N69. `migrate.ts` has no ledger, does not name the failing file on stderr, and discards `err.position`.**
verified: YES — `apps/api/src/db/migrate.ts` read in full at this ref; it is 26 lines.

```ts
    for (const file of files) {
      const sql = readFileSync(join(__dirname, file), 'utf8');
      console.log(`  → ${file}`);
      await client.query(sql);
    }
```
```ts
migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
```

Four separate gaps, all visible above:

1. **No ledger.** There is no `schema_migrations` table — confirmed across all 50 tables. Nothing
   records which files have been applied. The chain's only idempotency mechanism is that every
   statement happens to be re-runnable, which is precisely the property `schema_v5.sql` broke for
   eleven days. After an abort there is no way to ask the database where it got to.
2. **The failing file is not on stderr.** The `→ filename` line goes to **stdout**; the error goes to
   **stderr**. Any log capture that keeps only stderr — which is the common CI default — loses the
   location entirely and reports a bare driver error.
3. **`err.position` is discarded.** Because each file is one `client.query`, a 385-statement chain can
   only ever report the failing *file*, never the failing statement. The driver supplies a byte offset
   within the file in `err.position`, plus `detail`, `hint` and `where`; `console.error('Migration
   failed:', err)` renders whatever `util.inspect` chooses and none of it is addressed deliberately.
4. **Per-file atomicity is accidental, not stated.** A multi-statement simple query gets an implicit
   transaction, so each file is atomic — but that is Postgres's behaviour, not an invariant this file
   declares, and there are already exceptions: `schema_v24.sql` opens its own `BEGIN;`/`COMMIT;`, and
   `schema_v72`/`v73` are deliberately single-statement so `CREATE INDEX CONCURRENTLY` runs *outside*
   a transaction.

**DO NOT ADD PER-FILE `try/catch`.** It is the obvious-looking fix and it is wrong. Every file after
the failure point assumes its predecessors applied; swallowing an error and continuing means the rest
of the chain runs against a database whose state nobody checked, and the run reports success. Stopping
hard with a non-zero exit is the correct default. **The problem is not that it stops — it is that
stopping tells you nothing about where you now are.**

The N43 replay harness (not committed; it lived in scratch) demonstrated the diagnostics cheaply: it
printed `file`, `sqlstate`, `message`, `detail`, `hint`, `position` and `where` on failure, and parsed
the file list out of `migrate.ts` so the two could not drift. That is roughly fifteen lines. A ledger
is a larger decision and should be taken deliberately rather than bolted on.

**Size M. Tier 1.**

---

**N70. A text `ORDER BY` sorts differently on macOS than on Debian despite identical reported collation.**
verified: YES — measured during the N43 replay diff, on 161 index definitions.

Both databases report `datcollate = en_US.UTF-8`, `datctype = en_US.UTF-8`, `datlocprovider = c`
(libc). They nonetheless order the same strings differently, because the libc collation
*implementation* differs — Debian glibc in Railway's container versus macOS libc locally.

**The concrete case.** Comparing the replay database against production, all 50 per-table index
checksums matched, but the **global** index checksum did not. The two aggregates were built with
`string_agg(indexdef, '|' ORDER BY indexdef)` over the same **161 index definitions with identical
content**. Only the sort order differed, and that was enough to change the concatenation and therefore
the md5. Re-run as `ORDER BY indexdef COLLATE "C"`, both sides produced
`b3b95410019f34ecb596e54e6d14d91b`.

This cost real time and looked exactly like a schema divergence. It reported as one.

**The rule: any prod-vs-local catalog diff must order under `COLLATE "C"`,** or it will report a
phantom mismatch that then has to be chased. Per-object comparison masks it (small sets often sort the
same either way), which makes it worse — the diff appears clean until it is aggregated.

**Wider than diffing, and not investigated here:** the same divergence applies to any application
query with a text `ORDER BY` and no explicit collation. A list ordered by name, badge, email or label
can come back in a different order on a developer machine than in production. Whether any such
ordering is user-visible or load-bearing (pagination cursors, "first match wins" logic) is
**UNVERIFIED** — nothing was checked beyond the catalog diff that surfaced it.

Fix for diffing is a convention, now recorded in the verification protocol at
`docs/06-IMPLEMENTATION-PLAN.md`. Fix for the application question is a separate audit.
**Size S. Tier 0.**

---

---

## New from N46 swap/handoff 409 codes (2026-09-10)

**N71. The 1.0.16 tail: nine active devices no 1.0.17 OTA reaches. DECIDED - ask guards to update.**
verified: YES - `guard_devices` and Sentry release tags both read at this ref.

`app.json` sets `runtimeVersion: { policy: 'appVersion' }` with `version: 1.0.17`, so an update
published from this tree is offered only to binaries whose embedded runtime is exactly `1.0.17`.
Of 23 active devices:

| runtime | active | guards |
|---|---|---|
| **1.0.17** | **14** | Ahmad GRD0010, deepak naik GRD0004, Hari Nayak GRD0026, Jagdish GRD0012, kartikeya GRD0009, manju GRD0023, Parameshwari GRD0011, Prakash GRD0019, Raja GRD0015, Rajendar GRD0024, reddy GRD0001, Shiva GRD0020, Siddu GRD0010, Svineah GRD0008 |
| 1.0.16 | 5 | Anil GRD0007 (iOS), Charan GRD0013, Nikith Reddy GRD0005, Satish GRD0015, Shiva GRD0012 |
| no client string | 4 | Bhanu GRD0001, **Nandu GRD0002**, Naveen Yatakari GRD0009, vamshi krishna GRD0006 |

**The tail is 1.0.16, not a 1.0.14 straggler.** The N46 brief assumed Nandu was stranded on build 44
/ runtime 1.0.14. Sentry shows he *was* - `com.netraops.guard@1.0.14+44`, 2026-08-19 to 2026-08-20 -
and then moved to `1.0.16+46` on 2026-08-29. **No device anywhere has reported from 1.0.14 since
2026-08-20T11:08:47.** The four with no client string are a reporting artifact, not a fifth cohort;
see N73.

**DECISION (Vishnu, 2026-09-10): accept the tail. Ask guards to update rather than pin a publish.**
Not a gap missed. What closing it would have taken:

- a second OTA published from a tree pinned to `version: 1.0.16`, so the bundle carries a matching
  runtime - two bundles to maintain and two to roll back; or
- a new binary through TestFlight / Play internal, which is a store round-trip and does not help
  anyone who declines the update either.

The cost of NOT closing it is bounded and was measured before deciding: these nine keep **today's**
behaviour, which is unchanged rather than worse. The N46 API change is additive - an unadopted
client ignores `code`, `message` and the extra fields and branches on status exactly as it does now
(proved by `apps/mobile/scripts/check-respond-copy.ts`, 29/29 cases identical against a pre-N46
API). So the tail is a quality gap, never a breakage.

Revisit at the next binary release, when it closes for free. **Size S. Tier 1.**

---

**N72. `isOpenSessionConflict` is not wired into notifications.tsx, and now the server emits the code.**
verified: YES - `apps/mobile/lib/openSession.ts` and `(tabs)/notifications.tsx` read at this ref.

Since N46 Phase 3, `POST /shifts/:id/handoff-response` at `shifts.ts:2170` returns
`OPEN_SESSION_EXISTS` via `openSessionConflictBody`. Mobile has handled that code since the Aug 18
incident: `lib/openSession.ts` exports `isOpenSessionConflict` (which reads `details.code`, not
`err.code` - see the trap it documents at `:42-56`) plus a handler that refetches
`GET /shifts/active-session`, rehydrates `shiftStore`, and routes the guard home so they land on
their real on-shift state instead of a dead screen.

`notifications.tsx` does **not** call it. N46 gave that case accurate copy - "You're clocked in to
another shift right now. Clock out of it before accepting this handoff." - and stopped there.

**Deliberate. A navigation change does not ride into a copy fix.** Wiring the handler would move the
guard out of the notifications tab mid-flow, which is a different decision with a different failure
mode, and at the time the mobile half was written the server did not emit the code so it could not
have been exercised end to end. It can be now.

The open question is whether being bounced to the home screen is the right outcome when a guard taps
Accept on a handoff they cannot take. It is right on the clock-in wizard, where the screen is a dead
end. On the notifications list the screen is *not* dead - the card is still there and still valid,
and the guard may want to decline it, or answer a different invite. Plausibly the copy alone is
correct here and the handler is not wanted at all.

Fix is a product decision first, then roughly five lines. **Size S. Tier 0.**

---

**N73. `guard_devices.client` under-reports runtime for any device whose token claim predates the header.**
verified: YES - traced through `authStore.ts`, `apiClient.ts`, `auth.ts` and `deviceRegistry.ts` at this ref.

`guard_devices.client` is written only by `claimDevice`, and `services/deviceRegistry.ts:115` upserts
it as `client = COALESCE($4, client)` - a NULL argument **preserves whatever was there before**.
There are two claim sites:

- `routes/auth.ts:201`, guard **login**. `apps/mobile/store/authStore.ts:311-315` sends only
  `Content-Type`, so login carries **no** `X-NetraOps-Client` header. The claim therefore passes
  `null`, `COALESCE` keeps the stale value, and the adjacent log line at `auth.ts:224` prints
  `client="absent"`. This is **C20**, still true.
- `routes/auth.ts:307`, `POST /auth/guard/fcm-token`, called from `_layout.tsx:100` through
  `apiClient` - which **does** send the header (`apiClient.ts:82`). This is the only path that
  refreshes the value.

So a device that claimed its token before the header existed and has not re-registered since reads
`client = NULL` forever, regardless of what it is actually running. Four active devices are in that
state: Bhanu GRD0001, Nandu GRD0002, Naveen Yatakari GRD0009, vamshi krishna GRD0006. Nandu is the
proof - his row is NULL while Sentry has him on `1.0.16+46` since 2026-08-29.

**The comment at `auth.ts:208-224` is wrong about its own premise.** It says login "carries
platform/version/build/runtime/update in a single greppable line" and is "the one moment that always
precedes a test run". It carries nothing, for the reason above. Do not grep `guard_client` at login
to confirm a bundle; the standing rule (take the reading after a **clock-in**, never a login) is
correct and this is why.

**The two sources and what each is authoritative for:**

| question | source | why |
|---|---|---|
| which **binary** / runtime is this device on | **Sentry** `release` = `com.netraops.guard@<version>+<nativeBuild>` | present on every event, no sampling (`sentry.ts:69` `sampleRate: 1.0`), refreshed on every error |
| which **OTA bundle** is it running | **`guard_devices.client`** `update/<id>` | Sentry cannot answer it - an OTA changes neither `version` nor `nativeBuild`, so `release` and `dist` are identical before and after |

Neither is a substitute for the other, and the second is only as fresh as the device's last
`fcm-token` registration.

Fix is either to send the header from `authStore._request` (closing C20, which makes the login log
real) or to backfill on any authenticated request. **Size S. Tier 0.**

---

**N74. A content-match edit in `routes/shifts.ts` is unsafe without a uniqueness assertion.**
verified: YES - hit while editing, and the assertion is what stopped it.

`routes/shifts.ts` is ~3,900 lines carrying several routes that do structurally similar things, so
its guard-facing prose **repeats across routes**. The concrete case:

```
:2160  handoff-response    return res.status(409).json({ error: 'Shift has been reassigned by an admin; handoff is stale.' });
:2298  handoff-clock-in    return res.status(409).json({ error: 'Shift has been reassigned by an admin; handoff is stale.' });
```

Byte-identical, in **two different routes**. N46 scoped `handoff-response` only; `handoff-clock-in`
was never audited. A scripted `replace(old, new)` - or a `sed -i` - would have edited the wrong one,
or both, and the diff would have looked plausible because the replacement is the same shape as the
target.

It was caught because the edit script asserted `s.count(old) == 1` before every replacement and
aborted the whole run on the second occurrence, **before writing anything**. The fix was to widen
the anchor to include the preceding comment, which differs (`// Admin reassign got there first.`
versus `// Admin reassign in-between.`).

**The rule: never content-match into this file without asserting the anchor is unique, and prefer an
anchor that includes a neighbouring line.** Line numbers are not a safe substitute - they move (the
N46 brief cited `:1745`/`:1761`/`:1903`/`:1932` from an earlier audit and all four had shifted, one
of them into a different route entirely). Same class as [feedback_display_output_is_not_source] and
[feedback_verify_the_edit_target_exists]: the anchor has to be verified against the file, not
assumed from a previous reading.

Other duplicated prose in this file that would bite the same way has **not** been enumerated.
**UNVERIFIED** how many other strings repeat across routes.

Fix is a convention. **Size XS. Tier 0.**

---

**SETTLED - the `:1903` / `:1932` citation.** The N46 brief cited two 409s on `handoff-response`
as "already in progress" and "not eligible". The Phase 0 audit could not find them there and guessed
they might be `swap-response`'s 422; **that guess was also wrong**. They are `handoff-REQUEST`, a
third route, at `:2021` ("A handoff for this shift is already in progress.") and `:2050`
("Selected guard is not eligible (already clocked in, has an overlapping shift, inactive, or wrong
company).") at this ref. `handoff-response` never calls `checkShiftEligibility` and emits no 422.
Recorded so it is not re-litigated a third time. `handoff-request`'s four 409s carry no machine code
and were deliberately left out of N46's scope.

---

---

## New from N55 month-name dates (2026-09-10)

**N75. The shifts page resolves its window in the BROWSER's zone; the site drill-in resolves it in the SITE's.**
verified: YES - both call sites read at this ref.

```
app/admin/shifts/page.tsx:193-194     dayOffsetInZone(-30)            <- no tz argument
                                      dayOffsetInZone(90)
app/admin/shifts/site/[siteId]/page.tsx:100-101
                                      dayOffsetInZone(-1, siteData.timezone)
                                      dayOffsetInZone(90, siteData.timezone)
```

`dayOffsetInZone(offsetDays, tz?)` resolves "today" in `tz`, or in the browser's zone when `tz` is
omitted. So the two shifts surfaces disagree about which calendar day the window starts on, and the
disagreement is invisible: both render a plausible date.

For an admin in Pacific - all of them today - the two agree and nothing is wrong. For an admin east
of the site, the browser's "today" is a day ahead, so `/admin/shifts` can name a window that is not
the window it fetched. The header, the unassigned banner and the empty state all print
`windowFrom`/`windowTo`, which are the same values sent as `?from=&to=`, so the label is honest
about the request - the request itself is anchored to the wrong day.

`dayOffsetInZone`'s own docblock (`lib/shiftFormat.ts:203-215`) already says what to do: *"Pass the
site's zone wherever the page knows it."* The site drill-in does. The list page does not, and cannot
trivially - it spans MANY sites, so there is no single zone to pass. That is why this is a design
question rather than a missing argument: the window for a multi-site page has to be anchored to
something, and the candidates (company zone, each site's own zone, UTC) are a product decision.

**Deliberately not fixed in N55.** N55 changed how these dates are RENDERED. Changing which day they
name is a semantics change, and folding it into a formatting commit would make the diff lie about
its own blast radius - the same reason `fmtDateRange` stayed string-based. Filed so the two are not
confused later.

Fix is a decision, then a one-line change if the answer is "company zone". **Size S. Tier 1.**

---

**N76. Mobile prints three dates in device-locale numeric form, and one of them is burned into evidence photos.**
verified: YES - all three read at this ref.

| file:line | call | context |
|---|---|---|
| `app/(tabs)/reports.tsx:104` | `date.toLocaleDateString()` | report list rows |
| `app/violation/[violationId].tsx:201` | `new Date().toLocaleString()` | on-screen timestamp |
| `components/CameraCapture.tsx:482` | `new Date().toLocaleString()` | **photo watermark** |

All three pass NO locale and NO options, so they render in the device's locale - `9/10/2026` on a US
handset. That is the exact ambiguity N55 removed from the admin app: `10/09/2026` and `09/10/2026`
denote different days and a guard reading one has no way to tell which.

Everything else on mobile is already month-name and mostly zone-aware (`fmtInTz` in
`notifications.tsx`, `shifts/[id]`, `HandoffRequestModal`, `RequestSwapModal`; `lib/shiftTime.ts`,
`lib/pingSchedule.ts`, `profile.tsx`, `schedule.tsx`). These three are the outliers, not the norm.

**Two reasons this is not a copy of the N55 change.**

`CameraCapture.tsx:482` is a **watermark composited into the stored image**. Changing its format
changes what appears on evidence photos from that build forward, so photos taken before and after
carry different date formats for the same kind of record. That is a records decision - whether the
watermark format may change at all, and whether the change needs noting wherever those photos are
read - not a formatting one. It should not be decided by whoever happens to fix the other two.

And mobile ships by **OTA**, which is its own gate: runtime 1.0.17 only, inheriting the 1.0.16 tail
recorded in N71 (5 devices on 1.0.16 plus 4 with stale client rows). A web-only change has none of
that.

`reports.tsx:104` is the one with a live guard-facing ambiguity and the cleanest fix; it does not
need the other two to move with it.

**Size S. Tier 1** (OTA).

---

**N77. `{day:'2-digit', month:'short', year:'numeric'}` is hand-written in five places.**
verified: YES - all five read at this ref, and they currently AGREE.

```
lib/shiftFormat.ts:14              fmtDateShort
app/admin/sites/page.tsx:818       local fmtDate
app/admin/billing/page.tsx:251     inline
app/vishnu/companies/page.tsx:59   local fmtDate
app/vishnu/compliance/page.tsx:50  local fmtDate
```

Five copies of one option bag, all rendering `10 Sept 2026`, all with the same locale. Nothing is
broken and nothing renders differently today.

**Filing it so it is not discovered as a bug later.** The failure mode is not that a copy is wrong
now - it is that the next person to adjust the house date format changes `fmtDateShort`, sees the
shift tables update, and reasonably concludes the job is done. Four surfaces would keep the old
shape, and the difference would be small enough to survive review. That is the shape of drift this
codebase has hit before (`completedTrackableWindows` in A1, the ping-staleness threshold in the
client portal).

Collapsing them onto `fmtDateShort` is a mechanical change with no behaviour delta - which is also
why it was left out of N55, whose diff needed to stay auditable as "format changes only, at the
sites the audit inventoried".

Fix is tidying. **Size XS. Tier 0.**

---

---

## New from batch cancel (2026-09-11)

**N78. The cancel route's open-session 409 shows an admin a raw enum, and always has.**
verified: YES - traced end to end at this ref.

`PATCH /api/shifts/:id/cancel`'s open-session branch returns
`{ code, error: 'SHIFT_HAS_OPEN_SESSION', message: 'A guard is still clocked in on this shift...' }`.
`error` has carried the enum since that branch was written; only `code` is new.

`apps/web/lib/adminApi.ts:73` constructs `ApiError` with `body.error` as the message, and
`app/admin/shifts/[shiftId]/page.tsx:363` does `setCancelErr(String(e?.message ...))` straight onto
the screen. So an admin who tries to cancel a shift a guard is clocked in on reads the literal
string **`SHIFT_HAS_OPEN_SESSION`** - not the sentence sitting unused in `message` two lines below
it in the same body.

**Pre-existing. Not introduced by the batch-cancel work**, which deliberately left every `error`
value byte-identical (proven by diffing the route's error values against HEAD). It is called out in
the route docblock so the asymmetry is not "tidied" by someone who assumes it was an oversight.

The five sibling 409s do not have this problem - they keep prose in `error` precisely because web
renders that field. This one branch predates that reasoning.

**Two ways to close it, and they are not equivalent:**

- Move the prose into `error` and let `code` carry the enum, matching the other five. Cheapest, and
  makes the route internally consistent. Risk: anything branching on
  `error === 'SHIFT_HAS_OPEN_SESSION'` stops matching. Nothing does today -
  `jobs/autoCompleteShifts.ts:50` mentions it in a COMMENT only, and the new
  `lib/bulkShiftCopy.ts` reads `body.code`, not `body.error`.
- Leave the route alone and fix the consumer to prefer `body.message`. Narrower blast radius on the
  API, but every future consumer of this route inherits the same trap.

Recommend the first, in its own commit, with the grep for `error === ` branches run first.
**Size XS. Tier 0.**

---

## New from N60 unstaffed-post warning (2026-09-11)

**N79. Every email template interpolates operator-supplied text into HTML unescaped.**
verified: YES — `apps/api/src/services/email.ts` read in full at `d5af3f4`.

Eleven templates build HTML with template literals, and 30 distinct
`${row.*}` / `${data.*}` interpolations put database text straight into the
markup. None is escaped. Examples, all site or company text an admin can type:

```
${row.site_name}      ${row.site_address}     ${row.guard_name}
${r.site_name}        ${r.site_address}       ${row.badge_number}
```

**This is pre-existing and is NOT introduced by the unstaffed-post warning,
which deliberately matches the surrounding convention.** That was a choice:
escaping in one template only would make the other ten look safe by contrast,
and a reader comparing two adjacent renderers would reasonably conclude the
unescaped ones had been considered and cleared. They have not been.

**Why it is Tier 2 and not Tier 0.** The inputs are not attacker-controlled in
the usual sense — `sites.name`, `sites.address` and `guards.name` are written
by authenticated company admins for their own tenant, and the output goes to
that same tenant's admins by email, not to a browser session. There is no
cookie to steal and no same-origin context. The realistic damage is a broken
layout from a stray `<` or `&`, or an admin pasting a site name containing
markup and confusing the recipient.

**Why it is still worth closing.** Mail clients render HTML, `sites.name` has
no character CHECK, and the blast radius grows every time a template is added
— this phase added the eleventh. An `escapeHtml` helper applied across all of
them in one commit is a contained change; applied to one template it is worse
than nothing.

Fix: one `escapeHtml(s: string): string` in `services/email.ts`, applied to
every `${...}` that carries database text, in a single commit that touches all
eleven templates. Do not do it piecemeal.
**Size S. Tier 2.**

## New from the ASSIGN verb (2026-09-11)

**N80. `PATCH /shifts/:id/reassign` has NEVER pushed the outgoing guard — Map read with bracket syntax.**
verified: YES — `apps/api/src/routes/shifts.ts:872-899` and
`apps/api/src/services/deviceRegistry.ts:322-324` read at `28bc3a2`.

`getActivePushTokens` returns `Promise<Map<string, string>>`. Two lines read it,
and only one reads it correctly:

```js
const newToken = tokenByGuardId.get(new_guard_id);                              // :882  Map.get — works
const oldToken = shift.old_guard_id ? tokenByGuardId[shift.old_guard_id] : ...; // :892  property access on a Map — ALWAYS undefined
```

So `oldToken` is always `undefined`, the `if (oldToken && …)` never enters, and
**"Your {date} shift at {site} has been reassigned. You no longer need to cover
it." has never been delivered to anybody.** A guard whose shift is taken away
is told nothing: no push, and no Alerts row either (see N81).

It fails silently in the worst way — no throw, no log line, no Sentry event,
and the block is wrapped in the kind of `.catch()` that makes it look handled.
The comment directly above it describes pushing both guards and explains why
each is wrapped, so the code reads as working.

**Not fixed alongside the ASSIGN verb rename, deliberately.** A change to what
guards receive on their phones does not belong inside a UI relabelling, and it
wants its own verification on a real device.

Fix: `tokenByGuardId.get(shift.old_guard_id)`. One character class. Verify by
reassigning a shift away from a guard with an active `guard_devices` row and
confirming delivery, not by reading the diff.
**Size XS. Tier 1.**

---

**N81. `reassign` writes no `insertNotification` — the incoming guard gets a push and no Alerts row.**
verified: YES — no `insertNotification` call exists anywhere in
`apps/api/src/routes/shifts.ts:731-912`.

Every other notification path in the codebase treats the Alerts-tab row as the
source of truth and the push as best-effort — `preShiftReminder`,
`shiftStartReminder`, `lateClockInReminder` and `breakExpiryCron` all write the
row FIRST and push second, explicitly so a guard with no `fcm_token` still sees
it. `services/shiftPush.ts pushShiftAssignments` does the same.

`reassign` calls `sendPushNotification` directly and writes nothing. So a guard
newly put on a shift sees it in the Alerts tab if the admin used
`assign-guard`, and does NOT if the admin used `reassign` — the same
user-visible action with two different outcomes on the phone, decided by which
route the UI happened to call.

The ASSIGN verb makes this sharper, not worse: one button will now reach both
routes, so the inconsistency becomes a coin flip on the row's prior status.

Fix: `insertNotification({ type: 'shift_assigned', … })` before the push, same
ordering as the four crons. Check `routes/notifications.ts` scope filters admit
the type — `late_clock_in` needed a special case there for having no session.
**Size S. Tier 1.**

---

**N82. `assign-guard` has no site-active check; `reassign` does.**
verified: YES — `shifts.ts:773` refuses a deactivated site in `reassign`; no
equivalent exists anywhere in `assign-guard` (`:546-726`).

```js
if (!shift.site_is_active) {            // reassign only
  return res.status(409).json({ error: 'Site is deactivated. Reactivate it before reassigning shifts.' });
}
```

Once the bulk surface routes between the two, this becomes visible: at a
deactivated site an admin can FILL an empty shift but cannot MOVE an assigned
one. Same surface, same button, opposite answers, for a reason nothing on
screen explains.

Neither route is a superset of the other — `assign-guard` has a session gate
that `reassign` lacks, and `reassign` has this. They should converge.

**Zero instances today**: prod has 1 deactivated site with 0 unassigned shifts
and 0 upcoming shifts of any status. This is reachable the moment a site is
deactivated while holding future work.

Fix: add the same check to `assign-guard`, selecting `si.is_active` in the
existing shift lookup. Deactivated sites cannot accept new work and filling an
empty post is new work — the same argument `reassign` already makes.
**Size XS. Tier 2.**

---

**N83. Neither assign route carries machine codes; the bulk surface renders two registers side by side.**
verified: YES — every `res.status(409)` in `assign-guard` and `reassign` emits
a bare `{ error: '<prose>' }`. PR #42 added `code` to the six cancel 409s only.

`lib/bulkShiftCopy.ts REASON_LABEL` resolves failures on the enum and carries
two namespaces — lowercase `shift-candidates` reasons, UPPERCASE cancel codes.
The assign verb has neither, so its failures fall through to
`e?.message ?? '…'` and render raw server prose while a cancel failure in the
same batch renders a mapped label. A mixed batch shows both registers at once.

Codes wanted, mirroring the cancel route's hybrid `{ code, error, message }`:
`SHIFT_ALREADY_ASSIGNED`, `SHIFT_HAS_OPEN_SESSION` (reuse — same meaning),
`GUARD_OVERLAP`, `GUARD_NOT_ELIGIBLE`, `GUARD_NOT_FOUND`, `SITE_DEACTIVATED`,
`SHIFT_NOT_ASSIGNABLE`.

**Put the enum where the consumer can read it**: web's `ApiError` has no `code`
field and reads `err.body.code` while rendering `body.error` on screen, so
`error` must keep its prose. Mobile derives `ApiError.code` from `body.error`
and does not call these routes. See the cancel route's own docblock.

Deferred from the ASSIGN verb change, which ships with raw prose exactly as
`reassign` does today.
**Size S. Tier 2.**

---

**N84. The shift detail page could always fill an unassigned shift — only the bulk surface refused.**
verified: YES — `apps/web/app/admin/shifts/[shiftId]/page.tsx:237` and `:376`
read at `28bc3a2`, before the ASSIGN verb landed.

```js
const canReassign = !!shift && shift.status !== 'completed' && shift.status !== 'missed';   // :237
const body: { new_guard_id: string; reason?: string } = { new_guard_id: pickGuardId };      // :376
```

That gate mirrors `PATCH /shifts/:id/reassign` exactly, and that route refuses
only `completed`/`missed` — so an `unassigned` row has ALWAYS had an enabled
`REASSIGN GUARD` button on its detail page, and pressing it succeeds: the route
sets `guard_id`, flips status to `'scheduled'`, and writes a
`shift_reassignments` row with `old_guard_id = NULL`, which is exactly what
`assign-guard` does.

**So the capability existed the whole time, one click away, on another page.**
The bulk surface was the only thing refusing — four STARNET rows greyed out
reading "nobody is on this shift to move" while the same four rows were
fillable individually. Worth recording because the ASSIGN verb was scoped as
adding a capability, and it did not: it added REACH to one that was already
there.

**What is now inconsistent.** The same action reads **ASSIGN** on the bulk
surface and **REASSIGN GUARD** on the detail page, and the two hit different
routes for an unassigned row — bulk sends it to `assign-guard`, the detail page
to `reassign`. Neither route is a superset of the other (N82), and they differ
in what the guard receives (N81). An admin doing the same thing in two places
gets two different audit shapes and two different notification outcomes.

**A rename here reaches beyond the page.** `services/email.ts`'s missed-shift
alert links to this page with the text "Reassign Guard", and the page's own
docblock cites that link as its reason for existing. Renaming the control means
touching the email too, and the email's link is correct for its own context — a
missed shift always HAS a guard, so "reassign" is the accurate word there.

Fix is a product decision before it is a code change: either leave the detail
page alone and accept the two labels, or converge both on ASSIGN and reword the
email link. Deliberately NOT done inside the bulk-surface rename.
**Size S. Tier 2.**

---

**N85. A rejected CORS origin is a 500, and Sentry captures every one as an exception.**
verified: YES — `apps/api/src/index.ts:112-118` and `:214` read at `2f6b640`;
no 4-arg error middleware exists anywhere in `apps/api/src`.

```js
return cb(new Error(`CORS: origin ${origin} not allowed`));   // :117
```

The `cors` package forwards that to `next(err)`. Nothing in the API handles it
— there is no CORS-aware error middleware — so it reaches Express's default
handler and becomes a **500**. A browser preflight from a disallowed origin
therefore gets a 5xx instead of a response missing
`Access-Control-Allow-Origin`, which is what a decline looks like.

Fail-closed was the right intent and stays. The `cors` API expresses "decline"
as `cb(null, false)`; `cb(new Error(...))` expresses "this server broke". A
rejected origin is a routine, expected, client-side condition.

**THE 500 IS THE SMALLER HALF.** `Sentry.setupExpressErrorHandler(app)` (`:214`)
sees an error with no status, treats it as 5xx, and **captures it**. So every
blocked origin — every scanner, every stray embed, every misconfigured client —
becomes a Sentry exception, unbounded and forever.

That is the same defect class as the SendGrid retry storm (N27/N28): an
expected, correlated, indefinitely repeating condition reported as individual
events, which exhausted the monthly quota in ~10 hours and blinded error
monitoring for a further 94. It has not fired yet only because nothing is
currently hammering the API cross-origin. It needs no attacker — a search
crawler hitting an embedded URL would do it.

Found while trying to run apps/web locally against production's API: the
preflight on `POST /api/auth/admin/login` from `http://localhost:3000` returned
500 rather than a clean rejection.

Fix: `cb(null, false)`. One line. **Its own commit and its own verification** —
it is a production write-path behaviour change, and "the browser still blocks
it, and Sentry no longer sees it" is two assertions to prove, not one to assume.
Confirm `ALLOWED_ORIGINS` on Railway is unchanged while doing it.
**Size XS. Tier 1.**

---

## New from the notification-lifecycle work (2026-09-12)

**N86. Every auto-erase arm casts a JSONB value to `uuid` guarded only by key PRESENCE — one malformed value 500s the whole Alerts feed.**
verified: YES, by reading `apps/api/src/routes/notifications.ts` and by `EXPLAIN` against production.
All thirteen arms in `SHIFT_SCOPED_AND_NOT_COMPLETED` share the shape
`notifications.data ? 'k' AND EXISTS (… WHERE x = (notifications.data->>'k')::uuid …)`.
`data ? 'k'` proves the key exists; it proves **nothing about the value**. A single row whose
`data->>'k'` is not a parseable uuid raises `22P02` and takes down **both** `GET /api/notifications`
and `GET /api/notifications/unread-count` for that guard — the entire Alerts tab plus its badge,
not just the offending row.
**Not currently reachable**: every writer is server-side and writes uuids, and the nine pre-existing
arms have run this way in production for months. The exposure grows with each new arm (Phase 2 added
four) and with `POST /api/notifications`, the mobile self-report route, whose `data` body is
client-supplied — `VALID_TYPES` gates the `type` but nothing validates `data`.
Fix is a shared guard, not thirteen edits: a `safe_uuid(text)` SQL helper returning NULL on a bad
parse, or `… ~ '^[0-9a-fA-F]{8}-…$'` folded into one reusable fragment. Deliberately NOT done inside
the Phase 2 commit — making four new arms defensive while nine older ones stay exposed is worse than
consistent, and the real fix touches all thirteen.
**Size S. Tier 1** (behaviour change on a read path both mobile surfaces depend on).

**N87. Batched `shift_assigned` rows carry `shift_ids` (a JSON array) and can therefore never auto-erase.**
verified: YES, empirically against production — all 22 of GRD0005's `shift_assigned` rows are the
batched shape and none moves under the Phase 2 arm (76 -> 68 for that guard, none of the delta from
this type).
`services/shiftPush.ts` writes one row per guard per batch with
`data: { shift_ids: [...], site_ids: [...], count, first_date, last_date }` — no singular `shift_id`.
The Phase 2 arm keys on `data ? 'shift_id'`, so the batched row fails the guard and stays visible for
its whole scope window. That is the SAFE behaviour and was chosen deliberately (one clock-in out of
five does not make a five-shift assignment notice stale), but it means the arm currently only fires
for the single-shift reassign path in `routes/shifts.ts`.
Options, in rough order of preference: (a) erase when a session exists for **every** id in
`shift_ids`, via `NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'shift_ids') …)`;
(b) leave as-is and accept that batch notices persist for the shift scope window; (c) have shiftPush
write one row per shift, which fixes the erase but re-introduces the notification spam the batching
exists to prevent. **(c) is a regression, not a fix** — the batching was deliberate.
Decide before anyone "fixes" the arm by making it match on `shift_ids` naively.
**Size S. Tier 1.**

**N88. `task_assigned` cannot auto-erase: its push fires at TEMPLATE creation, when no task instance exists yet.**
verified: YES — `grep -rn "task_assigned" apps/api/src` shows the payload is
`{ type: 'task_assigned', site_id }` at `routes/tasks.ts:262` and `:271`; there is no
`task_instance_id` anywhere in it. The push is emitted from **`POST /api/tasks/templates`**, which
creates a `task_templates` row. Instances are generated later and elsewhere —
`services/tasks.ts:70`, `INSERT INTO task_instances (template_id, shift_id, site_id, title, due_at)`.
So at the moment the guard is told "New task", the thing that could be completed does not exist.
The column and value an erase arm would need are both real (`task_instances.status` varchar(20),
live values `pending` 8 / `completed` 4) — there is simply no row to point at.
**Current state is deliberate**: `task_assigned` is informational, has no CASE arm, and leaves the
feed when the guard dismisses it (read_at), like `chat` and the other four Phase 3.2 types. An arm
guarded on `data ? 'task_instance_id'` would be false for every row — inert code that reads as
working, which is worse than no arm.
Every near-substitute is worse and should NOT be reached for: keying on `site_id` + any pending
instance never erases (a recurring template always has pending instances) and is site-wide rather
than guard-specific; keying on the template id never erases (templates have no completion state);
copying the `task_reminder` shape fails because that arm joins through
`notifications.shift_session_id`, which is NULL on these rows by construction.
**If auto-erase is ever wanted, the fix is (b): move the push to instance-generation time**, where a
real `task_instance_id` exists and can go in the payload. That changes WHEN guards are notified (at
generation rather than at template creation), which is a product decision, not a refactor — a
recurring template would then notify on every generation cycle instead of once.
**Size M. Tier 1.**

**N89. `email.ts` renders a "minutes late" figure that is NOT the ping figure and must not be aligned with it.**
verified: YES — `apps/api/src/services/email.ts:882` computes `minutesLate` and renders it at `:919`,
`:923` and in the subject at `:950` ("⚠️ MISSED SHIFT — … is N min late"). It measures **clock-in
lateness against `shifts.scheduled_start`** for the missed-shift alert. It has **no ping-window
lateness render at all** — `grep -in "late|answered" email.ts` returns nothing else.
Logged because 2026-09-12 moved the ping figure in `routes/activityLog.ts` from window START to
window END, and there are now three same-shaped "N minutes late" strings on the platform measuring
three different things:
  1. `activityLog.ts` "Ping (X minutes)" / "Late Ping (X minutes)" — minutes INTO the window, from
     window **start**. Correct as-is; measuring from the end would make every on-time ping read 0.
  2. `activityLog.ts` "Missed — answered N minutes late" — from window **end**, as of 2026-09-12.
  3. `email.ts` missed-shift alert — from **`scheduled_start`**, unrelated to ping windows.
**Do not "align" (3) with (2).** They share a word and nothing else. This item exists so the next
person who greps for lateness finds the distinction written down instead of inferring a bug.
`email.ts` was explicitly out of scope for the Phase 2 dispatch and is unchanged.
**Size XS. Tier 0** (documentation only, unless someone decides the copy should differ).
