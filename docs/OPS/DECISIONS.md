# DECISIONS

Settled calls. Do not relitigate. Changing anything here is **Tier 2** — live,
Vishnu present (`POLICY.md`).

These are Vishnu's decisions, recorded as given on 2026-09-03/05. They are not
findings and are not "verified" in the evidence sense — a decision is true because
it was decided. Where a decision *references* a system fact, that fact is checked
and the evidence noted inline.

---

## 2026-09-03 / 2026-09-05 — monitoring & triage loop

### Channel and escalation

- **D1. Slack is the channel.** Routine output goes to Slack.
- **D2. No auto-action on silence.** Absence of a signal never triggers an action.
  Silence is reported, not acted on. (Restated as a standing rule in `POLICY.md`.)
- **D3. P0 escalates by SMS every 15 minutes** until acknowledged.
- **D4. claude.ai is the call path**, plus a daily digest delivered via Gmail.

### Cost

- **D5. $100 API cap. $50 alert threshold.**

### Models

- **D6. Opus 5 for alarms. Sonnet 5 for digests.**

### Cadence

- **D7. 08:00 PT daily. Monday's run also carries the weekly.**

### Scope of v1

- **D8. Mode is maintenance** — not feature development.
- **D9. v1 = 5 signals + the customer signal**, triage by cron or manual
  invocation, **IDs only** in output.
- **D10. Data leaving the DB toward a model or Slack is IDs, badges, and counts
  only.** No names, no emails, no coordinates, no token values. (Mirrors the
  standing rule in `POLICY.md`.)

### Site-specific

- **D11. Bethel AME Church `53c71c64` has enforcement off and is excluded from
  ping signals.**
  Evidence checked 2026-09-05: site id `53c71c64-1973-4f82-be9c-98e4800beece`,
  name `Bethel AME Church`, tenant `STARNET SECURITY`
  (`27c4d404-8769-49ca-bfd6-93cb9b890067`), `checkpoints_enabled = false`,
  `is_active = true`, `timezone = America/Los_Angeles`. The `checkpoints_enabled`
  flag confirms enforcement is off at the site level. **The ping-signal exclusion
  is a decision about the monitoring loop, not a DB flag — there is nothing in the
  schema to check it against.** It must be implemented in Phase 2 and cannot be
  inferred from site state.

---

## 2026-09-05 — cadence and cost

### D12. Triage runs **daily, targeting the 08:00 PT hour**, not every 6 hours.

This restores **D7**. The 6-hourly schedule was **shake-out only** — it existed
to surface runner bugs quickly while the loop was being built, and it earned its
keep: the silent `railway-logs` failure, the `push_skip_null_token` volume
mislabel and the Sentry listing/per-issue disagreement were all found because
runs came often enough to compare. That work is done; four runs a day of a
read-only report is cost without signal.

**AMENDED 2026-09-07 — `cron: '7 13 * * *'`, nominally 06:07 PT.**

Originally `cron: '0 15 * * *'`, aimed squarely at 08:00 PT. That assumed
GitHub fires a scheduled workflow at the time you ask for. It does not.
**Measured on 09-05 and 09-06, this repo's schedules ran 2–4 hours late**, so a
brief meant for 08:00 was arriving late-morning — past the point where it can
shape the day, which is the entire purpose of a founder brief.

The schedule now aims **early** so the lag is absorbed rather than added to:
06:07 PT nominal lands ~08:00–09:30 PT. The `:07` follows GitHub's own advice to
avoid the top of the hour, where queue contention and therefore delay are worst.

**This buys a better distribution, not a guarantee.** Scheduled workflows are
best-effort — GitHub may run one late or skip it entirely under load, and
nothing available here changes that. If a run has to happen at a known time,
dispatch it by hand. If briefs start arriving before 08:00, the lag has eased
and the nominal time should move back later, not stay early by habit.

Still UTC — GitHub Actions cron has no timezone option — so the PT arrival
shifts an hour across DST in either direction.

`workflow_dispatch` is unchanged — a manual run is still available at any time,
and still gets the stronger model when a `focus` is supplied.

### D13. The context pack is trimmed for cost. Target **~$0.35/run**.

`railway-logs` 300 → 100 lines, `git log` −20 → −10, `SENTRY_ISSUE_CAP` 15 → 10,
`--max-turns` 40 → 15, and `OPEN-ITEMS.md` embedded as open items only rather
than in full.

**Trimming states what it dropped.** The OPEN-ITEMS section carries an explicit
note naming what was omitted and where the full file is. A trimmed file that
does not say it was trimmed is how a reader concludes an item does not exist —
the same failure class as a mislabelled field.

Measured effect on the pack: **1421 → 1114 lines, 67,251 → 49,875 bytes (−26%)**.
Short of half. See N21 — the remaining bulk is `STATE.md`.


---

## 2026-09-06 — what Slack is for

### D14. Slack gets a five-line founder brief. Nothing else.

UP / BROKE / CUSTOMER / AHEAD / WAITING, one line each, under a header carrying
the worst status of the five. The full report goes to the run artifact and is
read only when a brief line sends you there.

**Failures first, and named.** BROKE is the second line, above customer and
ahead, because a failure with a next step is the only thing that reliably needs
action today. A brief that opens with metrics trains the reader to skim.

**Nothing in Slack that has no decision attached.** Every BROKE line ends in a
next step; if one cannot be named, the finding stays in the report. WAITING
exists to make "this is blocked on you" unambiguous rather than implied.

**No customer ops metrics.** CUSTOMER carries three facts — active yesterday,
guard count with direction, days since last contact — and no dashboard. Session
counts, ping ratios, report volumes and completion rates are operational
telemetry: they belong in the report, and acting on them is the admin portal's
job, not a founder brief's. The one question this line answers is *is the
customer still there, and when did I last speak to them.*

**⚪ is a real state.** A line that could not be established at all is white, not
green. Inferring a green from a missing signal is the failure this whole loop was
built to stop, and the brief is the surface where it would be least visible.

---

## 2026-09-08 — per-site ping cadence (Phases A–D)

### D15. The picker set is **15 / 30 / 45**. Nothing else.

Three values, not six. The earlier working set (15/30/45/60/75/90) was a
placeholder carried through the D0 audit and is **superseded**; it survives only
as the parameter matrix in `scripts/check-window-anchor.ts`, where extra
coverage is harmless.

`sites.ping_interval_minutes` still permits **5–240** (`schema_v14.sql:39`), so
the column is wider than the picker and always was. **The picker is not the
enforcement boundary** — direct SQL can still set 5, and at that value the
`pingReminder` recovery range inverts (see D17 and the Phase H open item). The
CHECK narrowing that makes the picker real is Phase H work.

### D16. Readers take the cadence from the **SESSION SNAPSHOT**, never from `sites`.

`shift_sessions.ping_interval_minutes` (schema_v68) is written once at clock-in
and is immutable thereafter. `sites.ping_interval_minutes` is only ever its
SOURCE. No reader may join `sites` for a cadence.

**Why this is not a style preference.** `missedPingCron`, `pingReminder`,
`services/email.ts` and `shiftHours.ts`'s `VIOLATION_HOURS_ROW_SQL` all
re-derive windows **long after a session closes** — the daily client report
renders over an hour past `scheduled_end`, `violation_hours` is recomputed on
every read of the hours export, and the activity log is queried for arbitrary
past ranges. A live join would let an admin editing a site at 21:00
retroactively change how many windows a guard was accountable for at 14:00, and
move a ratio **already emailed to a paying client**.

That is not a display bug. It rewrites a closed session's obligations and a
billed number after the fact, with no record that either changed.

NULL means "session predates schema_v68" — a different statement from "ran on
30" — so readers `COALESCE(x, 30)` at the call site rather than defaulting
inside the window functions or backfilling a cadence nobody measured.

### D17. The capability gate keys on `runtime/`, not `version/` and not `build/`.

The client header is
`platform/<os>; version/<v>; build/<b>; runtime/<r>; update/<id>`
(`apps/mobile/lib/apiClient.ts:56`).

**`build/` is unusable.** It comes from `app.json`, which EAS remote versioning
ignores. Production proves the gap: handsets report `build/41` (iOS) and
`build/17` (Android) while the shipped builds are **48** and **24**.

**`version/` is nearly right and still wrong.** The capability being gated is
JS-level — it lives in `apps/mobile/lib/pingSchedule.ts` — and an OTA replaces
that JS **without moving the store version**. A device can gain the capability
while `version` stands still. `runtimeVersion` is what an update group is
published against, so it is the field that tracks which JS a handset can run.

**They look identical in the field, which is exactly why this is written down.**
All eight client strings production has recorded carry `version` and `runtime`
as the same value, because `app.json` sets `runtimeVersion` to
`{"policy": "appVersion"}`. The two diverge **only** in the OTA case the gate
exists to catch — so a reader comparing them today would reasonably conclude
either would do, and be wrong in the one scenario that matters.

Comparison is **numeric per segment**, never lexicographic: `'1.0.9' > '1.0.10'`
as strings, which would open the gate to a handset older than the threshold.
`_pingIntervalGate.test.ts` asserts the string form really would disagree, so
the test fails if anyone reduces it to `localeCompare`.

Evidence dates: header format read from `apps/mobile/lib/apiClient.ts`
2026-09-08; the build/48-vs-`build/41` gap and the eight client strings read
from `guard_devices.client` in production the same day.

---

## 2026-09-26 — auto clock-out, hours, admin shift edits

Taken during the Bethel 18-hour shift incident
(`INCIDENTS/2026-09-26-bethel-18h-shift.md`) and the U4a review that followed.

### D18. An auto clock-out records `GREATEST(clocked_in_at, scheduled_end)`, not the sweep time.

**Status: decided 2026-09-26.** Built in **U4a** (`92e5fbc`, branch
`fix/autoclose-anchor-scheduled-end`) — not yet merged or deployed.

**Status update 2026-09-26 — SHIPPED, and the backfill has run.**
- U4a merged as `1d6b60b` (PR #79) at 09:06:10 PT by gate route CONDITION;
  Railway deployment `0dbee65e` SUCCESS. The first auto-close under it —
  session `806ecf64` (Star Guard test tenant), 09:45 PT tick — recorded
  `clocked_out_at` 09:15:00.000 PT, exactly its scheduled end, with
  `total_hours` 0.25.
- **The q9c backfill was COMMITTED on 2026-09-26** (by Vishnu, after that
  verification): **206** auto clock-outs re-anchored — Star Guard 181,
  STARNET SECURITY 25 — removing **103.1385 h** (STARNET 12.5041 h); **9**
  violations re-resolved, **0** breaks, **0** rows on legal hold. The re-run
  census (the rule above) returns **0**. The SQL that ran is kept, with
  sha256, in `INCIDENTS/2026-09-26-bethel-18h-shift/`.
- Still open: grace 30 → 15 (**U4b**).

**Status update 2026-09-26 — U4b BUILT: grace 30 → 15 minutes.** `761d7f5` on
`fix/autoclose-grace-15` — not yet merged or deployed.
- The grace is one constant, **`AUTO_CLOSE_GRACE_MINUTES` = 15**
  (`apps/api/src/constants/autoCloseGrace.ts`), read by the sweep's three
  predicates, the clock-out reminder's window and
  `scripts/backfill-stale-shifts.ts`, whose grace-less count is fixed with it (it
  also stops the cron that importing the job registers, so it now exits). The
  anchor above and Payable (D19) are unchanged.
- Cost, measured before building (prod, manual clock-outs 2026-08-25 00:00 →
  2026-09-26 00:00 PT): **7 of 113** landed +15 … +30 min past `scheduled_end`, all
  STARNET; they would now be
  auto-closed at the anchor. Their post-end minutes leave Actual; Payable is
  unchanged.
- **Accepted with it:**
  - A break begun in roughly the last 15 minutes before `scheduled_end` is still
    open when the sweep runs (every plan is 30 min) and is cut at the anchor:
    `ended_by = 'auto_complete'`, no "Break ended" push, no return check, no
    overrun verdict. Pay is unaffected — breaks are paid.
  - The late-clock-in T+30 admin email (both jobs run every 5 min): a no-show
    shift of 10 minutes or less is flipped to `'missed'` before its T+30 rung and
    never gets it; at 11–19 minutes it is never sent or races the sweep on the
    same tick, depending on the start minute; at 20+ it is always sent.
  - Mobile keeps its own 30-minute local expiry until the next OTA (N138):
    between +15 and +30 a guard can see a local breach alert that the server's
    409 cannot retract, and a clock-out attempt gets 404 and an alert reading
    "Clock-Out Failed" / "Active session not found" (the raw server text, one OK
    button, no refresh).
    *Update 2026-09-29:* the mobile gate is 15 in the 2026-09-29 OTAs (N138), and a
    clock-out on an already-closed session now answers 409 `SESSION_CLOSED`
    ("You are already clocked out of this shift. Go back to the home screen to
    refresh.") instead of the 404 — see N138. Shipped in PR #85 (`a8ba597a`, merged
    2026-09-29 19:00:51 PT; Railway `ecc4c4af`).
- Proof lives outside CI (the harness needs a local Postgres):
  `apps/api/scripts/test-auto-complete-shifts.ts` is **63/0 on `761d7f5`**; the same
  harness run against `6638018`'s job is **49/14** — the 14 are exactly the new
  cases (shifts ended t0−20 and t0−16, a break from t0−25) and the counts.

**Status update 2026-09-27 — U4b SHIPPED.** PR #82 merged as `579ee12` at 10:04:06 PT
by gate route PROXY, 9 s after a STARNET ping; Railway deployment `6c6107f9`
SUCCESS, API live 10:05:37 PT. `/health` answered on `579ee12`; `/health/crons` 20
jobs, none stale; the first on-post ping after the deploy landed and the restart
caused no missed ping. Staged test (Star Guard GRD0001 at SFMTA, scheduled
09:30–11:03 PT, never clocked out): the 11:15 tick closed nothing and the **11:20
tick** closed it — `clocked_out_at` 11:03:00 (the anchor), `clock_out_reason`
`'auto'`, `total_hours` 1.55, shift completed. Under the old 30-minute grace it
would have closed at 11:35.

- The sweep still **fires** at `scheduled_end` + grace; it no longer **records**
  that moment. One anchor, `GREATEST(clocked_in_at, scheduled_end)`, is used for
  `clocked_out_at`, `total_hours`, open breaks (`GREATEST(break_start, anchor)`)
  and violation resolution. `clock_out_reason` stays `'auto'`. Manual and handoff
  clock-outs are unchanged.
- **Grace 30 → 15 minutes is decided and ships separately as U4b**, together with
  `apps/api/scripts/backfill-stale-shifts.ts`'s grace-less predicate (`:34`,
  `:43`), which moves with it.
- **Every historical auto clock-out is corrected by rule, not by count:** the q9c
  backfill selects `clock_out_reason = 'auto' AND clocked_out_at >
  GREATEST(clocked_in_at, scheduled_end)` and re-anchors each row with the job's
  own formulas, skipping and counting rows on legal hold. It runs **only after U4a
  is deployed and verified in production** — while the old sweep is live, new
  rows keep matching the rule. It stays a draft until then.

Evidence (2026-09-26, prod, read-only): 206 auto clock-outs match the rule, every
one +30.00 … +35.01 min past `scheduled_end` — STARNET SECURITY 25 (12.504 h),
Star Guard 181 (90.634 h); clock-ins 2026-08-24 09:58 → 2026-09-25 23:00 PT; 0 on
legal hold. The last five before U4a all landed at +30.01 min.

### D19. Hours: Actual stays raw; a new **Payable** figure drives totals and billing.

**Status 2026-09-26 — SHIPPED.** U6 merged as `4a577e6` (PR #80); Railway
deployment `4683c913` SUCCESS on that commit. Verified 2026-09-26: Vishnu checked
the render on prod desktop and a real iPhone (real Payable values, no wrap or
collision), and Bethel AME Church through the builder reads **Payable 301.45 h /
Actual 303.95 h**. The August regeneration is DONE (2026-09-27, below).

Earlier status, kept as history:

**Status: decided 2026-09-26. NOT YET BUILT (U6).** **Replaces the "4 fields
(Scheduled/Actual/Break/Violation), no aggregate total" lock** recorded in the
`netraops-invariants` skill (repo `SKILL.md:68`, plugin copy `:58`) and in the
`services/shiftHours.ts` header. Those describe shipped behaviour and change when
U6 ships, not before.

**Status update 2026-09-26 — BUILT in U6** on `feat/payable-hours`, not yet
merged or deployed: `43d77c0` (the fragment and types), `116e355` (hours export,
workbook, snapshot fixture), `2497d68` (admin analytics, ACTIVE SITES),
`7399665` (analytics export column), `a0d6846` (web labels, '—' when absent).
The skill lock and the `shiftHours.ts` header are rewritten in the same branch.
Choices made while building it (approved 2026-09-26, Phase 0 A1–A12):
- **Payable is opt-in.** One definition, `PAYABLE_HOURS_ROW_SQL`; the fragments
  emit it only with `{ payable: true }`, typed `PayableShiftHours`. `ShiftHours`
  keeps its four fields, and every surface that stays on Actual gets
  byte-identical SQL — so no Payable figure reaches a client or guard payload.
- The leaderboard **ranks** by Payable: `h_payable DESC, h_actual DESC, g.id`.
- **ACTIVE SITES status stays on Actual** (an activity signal); its hours cell
  shows Payable. ACTIVE SITES now reads the shared aggregate fragment; the
  hand-typed Actual copy is gone (old and new SQL match on every prod site).
- The web shows **'—' when `payable_hours` is absent** and never falls back to
  Actual or to the stored `total_hours` scalars (start-clamped legacy). The month
  KPI's sub-line leads with Actual.
- The analytics XLSX header is the raw key `payable_hours`, like its siblings;
  the CSV labels it `Payable Hours`.
- One PR for API and web: the API change is additive and the web tolerates both
  deploy orders.
- **The August regeneration waits** for the regenerate-route S3 key fix (a small
  PR after U6 — `OPEN-ITEMS.md` N123): today that route writes a different object
  from the monthly job's. **Update 2026-09-26:** fixed on `fix/monthly-report-key`
  (`ad1948e`, `3ee957f`), not yet merged or deployed. The route and the monthly
  job now write one key through `services/monthlyReport.ts`; the route is
  vishnu-only and needs an explicit year and month. The regeneration itself runs
  only on Vishnu's explicit approval, after that fix is deployed, from a signed-in
  vishnu portal session against the deployed route.

- **Actual** stays raw: clock-out − clock-in.
- **Payable** = clocked-in time inside the scheduled window, one definition beside
  `actual_hours` in `shiftHours.ts`:
  `GREATEST(0, LEAST(COALESCE(clocked_out_at, NOW()), scheduled_end) −
  GREATEST(clocked_in_at, scheduled_start))`.
- **Totals and billing use Payable.** The billing and monthly hours XLSX (detail,
  aggregates, SUMMARY), admin analytics (month KPI, leaderboard, monthly bars) and
  ACTIVE SITES — the last via the shared fragment, replacing its hand-inlined copy
  (`routes/admin.ts:1399`). The analytics export gains a **Payable Hours** column.
- **Stay on Actual:** the daily client email, the client site-security PDF, the
  guard my-hours PDF and mobile.
- **Coverage %, Variance and SHORT compute from Payable. OVER and OFFPOST_ANOMALY
  stay on Actual.** Variance (Payable − Scheduled) is ≤ 0 by construction, so it
  becomes a shortfall figure; OVER is the only overtime signal.
- **Handoff shifts:** the per-session scheduled share is split in proportion to
  Payable (equally when the shift's Payable is 0). Sessions of one shift cannot
  overlap — a handoff closes A and opens B at one `NOW()` in one transaction — so
  summed Payable cannot exceed the window.
- **NO_SCHEDULE rows:** Payable 0, the flag kept, coverage null.
- **STARNET's August monthly report is regenerated after U6 ships.** Files already
  in S3 are frozen snapshots until then. The file it replaces (read 2026-09-26):
  `monthly-reports/27c4d404-8769-49ca-bfd6-93cb9b890067/netraops-hours-starnet-security-2026-08.xlsx`,
  version **`Fk9p_3JF1RK8e46Z93vafVVLZlrCg4Qf`**, 16,251 bytes, written
  2026-09-01T12:00:02Z by the monthly job. The regeneration overwrites that same
  key, so this version becomes noncurrent, and lifecycle rule `noncurrent-30d`
  (`NoncurrentDays 60`) deletes it about 60 days later — **accepted 2026-09-26
  (N123, B11).** A copy of the file as delivered is retrievable by that version
  id only until then.
  **Done 2026-09-27 02:20:55Z** by vishnu through the deployed route (N123 merged
  as `6638018`, PR #81, Railway `e086f901`). Row `1521d5c7` kept its id and its
  `s3_url` byte for byte; the new current version is
  **`gtwNqclVg6tAQDOumS.uF94HO9Fdi30N`** (17,880 bytes, NOTES commit `66380180`), and
  `Fk9p_3JF1RK8e46Z93vafVVLZlrCg4Qf` is noncurrent until about 2026-11-26. Checked
  row by row against the digest-verified August extract: 42 shifts, Actual
  343.42 h, Payable 340.43 h; Bethel AME Church 22 shifts, 113.33 / 112.29 h; 11
  flagged (7 AUTO_CLOSED, 4 SHORT), every flag equal to the D19 rules.

Evidence (2026-09-26, prod, read-only): no hours figure today is capped at
`scheduled_end` on any surface; 0 NO_SCHEDULE shifts; 1 multi-session shift, 0
overlapping session pairs, 0 of 388 shifts with summed Payable above the window.
Bethel AME Church, clock-ins 2026-08-24 … 09-25 (55 sessions): Actual 310.45 h
today → 303.95 h after the D18 backfill; Payable 301.45 h (301.43 raw) before and
after.

### D20. Admin shift edits: on an ACTIVE shift, the end time only; a confirm step above 12 hours.

**Status 2026-09-28 — SHIPPED (U2, U5).** PR #83 merged as `95a10a38` at 19:30:44 PT by
gate route PROXY — a scripted push about 8.4 s after a STARNET ping (GRD0015 `68f76ea9`;
`pinged_at` 19:30:35.626 PT, GitHub's `mergedAt` 19:30:44 to the second). Railway
deployment `157494b0` SUCCESS on that commit (created 19:30:46 PT per `railway deployment
list`; live about 19:31:58 per the session record). v81 (`shifts_end_after_start`) was
applied by hand before the merge (about 18:49 PT) and is validated in production.
Staged test the same evening, Star Guard shift `7267a4ae` (scheduled 19:30–20:30 PT;
session `345bba98`, clock-in 19:40:41), edited by a company_admin:
- extend 20:30 → 21:45 at 19:44:12, then shorten → 21:15 at 19:45:00; the session stayed open;
- close at 20:45, applied 21:02:05: `clocked_out_at` 20:45:00, `clock_out_reason`
  `'admin_corrected'`, `total_hours` 1.0717, shift `completed`; the 20:00 missed ping was
  kept and the 20:30 one deleted;
- 3 `shift_schedule_edited` audit rows (before/after `scheduled_end`) and 3 notification
  rows with D20's three bodies (push delivery not checked);
- the 21:05, 21:10 and 21:15 sweep ticks closed nothing.
The guard handset was a development build (`guard_devices.client` `runtime/;
update/embedded`), so this proves the server. The mobile half (U3, N146) was published by
OTA on 2026-09-29 (production 1.0.17 `fe530a7a`, preview 1.0.18 `429943ab`; D21).

Earlier status, kept as history:

**Status 2026-09-28 — BUILT (U2, U5)** on `feat/active-shift-end-edit`, not yet merged
or deployed: `8081f62` (v81), `18e2038` (U5, API), `4db2b69` (missed-window crons),
`8094269` (U2, API), `da9eca0` (harness), `c2f34f9` (review fixes), `dcb8ec2` (web),
`2c0e8a7` (the create modal's overnight roll). Choices made while building it —
Phase 0 decisions 1a–13a and the Phase 1 decisions, approved 2026-09-28:
- **The end edit** (`editActiveShiftEnd`, `routes/shifts.ts`). Gate: status
  `active`, exactly one open session, and it is the assigned guard's (409
  `NO_OPEN_SESSION` / `SESSION_STATE_CONFLICT`; a reassign can leave another
  guard's session under the shift, N142). The start is fixed (422 `START_LOCKED`);
  the end must follow the start and the clock-in (422 `END_NOT_AFTER_START` /
  `END_BEFORE_CLOCK_IN`).
- **A later-than-now end** keeps the session open, moves `scheduled_end`, and clears
  the session's clock-out-reminder latch so the reminder fires for the new end;
  the reminder's claim now re-reads the shift's current end under `FOR SHARE`, or a
  tick racing the edit could stamp the latch for the old end.
- **An end at or before now** — including the unchanged end once it has passed —
  closes the session at that time in one transaction, with the sweep's formulas and
  the Bethel q11/q8a shape: `clock_out_reason = 'admin_corrected'` (N120's writer),
  `total_hours` in the same statement, open breaks cut at the end (`ended_by`
  `'auto_complete'`; breaks already closed are left as recorded), every missed ping
  and report whose window ends after the new end deleted, resolved or not (both
  missed-window crons now re-check the shift's current end under `FOR SHARE` at
  insert), violations resolved by the sweep rule, the shift `completed`. It needs
  `confirm_close_session` (409 `CLOSE_CONFIRM_REQUIRED`), so the server's clock, not
  the browser's, decides a clock-out happened; a confirmed close whose end has not
  arrived is 409 `CLOSE_END_NOT_PAST`. Refused on legal hold (409 `LEGAL_HOLD`).
  After COMMIT, open handoffs on the shift are cancelled and both guards told.
- **The sweep race.** The sweep closes sessions with `UPDATE … FROM shifts` and no
  lock on the shift row, so an extension committed while a tick that had already
  judged the old end due was waiting was closed at the OLD end, leaving the shift
  `active` with no open session — reproduced locally (evidence under N116). An edit
  that keeps the session open is refused (409 `SHIFT_AUTO_CLOSING`) once the auto
  clock-out is less than a minute away, judged on entry and again before COMMIT.
- **Locks.** Shift row first (lock_timeout 3 s), then the session `FOR NO KEY
  UPDATE` and child rows under a 500 ms lock_timeout, below the 1 s
  deadlock_timeout: against a writer that takes the session first (the guard's
  clock-out, the sweep) the admin yields with 409 `SHIFT_BUSY`, never the guard.
- **Audit and push.** The existing `shift_schedule_edited` audit row, before/after
  with both keys. Push type unchanged; bodies: "Your shift now ends Fri, Sep 26,
  6:00 AM. Fully close and reopen NetraOps to update your screen." (extend), "…
  Clock out at that time." (shorten), "Your admin ended this shift at 6:00 AM. You
  are now clocked out." (close).
- **U5.** Every create and edit path refuses end ≤ start (422
  `END_NOT_AFTER_START`) and asks above 12 hours of elapsed time —
  `confirm_long_shift`, else 409 `LONG_SHIFT_CONFIRM_REQUIRED` with the real end —
  enforced by the API, not only the web. Exactly 12:00 does not ask. v81 adds
  `CHECK (scheduled_end > scheduled_start)`, applied by hand before the merge
  (`scripts/ops/v81_shifts_end_after_start*.sql`). assign-slots stays out of U5
  (N147). The create modal rolls an overnight end by calendar date; the old
  `+86_400_000 ms` put a 19:00 → 07:00 shift starting 2026-11-01 before its start.
- **Web.** EDIT SCHEDULE shows for an active shift with exactly one open session
  (fails closed on an older API); the start is shown but fixed; a confirm step in
  the modal ("This clocks the guard out at HH:MM." / "over 12 hours: Ends … —
  18h"); the create modal asks the same. **Mobile is unchanged** — the refetch is
  U3 (N146).
- **Deploy: one PR.** Admin tabs loaded before the deploy send no
  `confirm_long_shift`: until reloaded, a create or edit over 12 h gets the 409 with
  no confirm button. Its message says why; a reload fixes it.
- **Proof** (outside CI; local Postgres 18.6):
  `apps/api/scripts/test-active-shift-end-edit.ts` is **115/0** on the branch and
  **30/83** against `579ee12`, where every new behaviour fails;
  `test-auto-complete-shifts.ts` 63/0; `check-date-format` passes in 5 zones, and
  its overnight-roll cases fail against the old roll.

Earlier status, kept as history:

**Status: decided 2026-09-26. NOT YET BUILT (U2, U5).**

- **U2:** the shift detail EDIT control works on an **active** shift for the
  **end time only** (scheduled shifts keep start + end). An end already in the past
  closes the open session at that time. Today `PATCH /api/shifts/:id` refuses
  `active` (`routes/shifts.ts:1644`) and any shift with a session (`:1669-1681`),
  and no admin route closes a session — which is why the Bethel shift needed a
  hand correction. The mobile app keeps a cached end until a cold start; a refetch
  follows later as an OTA, and handsets below the published runtime cannot take it
  (N115).
- **U5:** create and edit show a **confirm step when the duration exceeds 12
  hours.** The create modal rolls an end earlier than the start into the next day
  silently (`apps/web/components/admin/ScheduleShiftModal.tsx:226`), and
  `POST /api/shifts` checks neither end > start nor a maximum (`:376`).

Evidence (2026-09-26, prod, read-only): STARNET had 4 shifts over 12 h in the last
60 days — 2 were this AM/PM mistake (`b3a29807`, `c3574592`, both 18 h at Bethel),
2 were real overnights (13 h, 12.5 h).

Drift noted 2026-09-28 (prod, read-only): the same count now reads **3** — `b3a29807`
(18 h), `238fbb77` (13 h), `87125a0a` (12.5 h). The 2026-09-26 Q11 correction moved
`c3574592` to 12:00–18:00 by hand, with no `shift_schedule_audit` row, so it is no
longer over 12 h. STARNET also scheduled 90 shifts of exactly 12 h in those 60 days,
which is why the confirm asks only above 12 h. 0 of 837 shifts have
`scheduled_end <= scheduled_start`.

---

## 2026-09-29 — OTA publishing

Taken during the batch-18 publish, which found that no OTA bundle had ever carried the
Sentry DSN (`OPEN-ITEMS.md` N152).

### D21. An OTA is exported and gated from a clean tree, then published with `--skip-bundler` — never bundled by `eas update`, never from a dirty tree.

**Status: decided 2026-09-29.** First used for `429943ab` (preview 1.0.18, `f5a84c4`,
08:39:30 PT) and `fe530a7a` (production 1.0.17, `ddc6f0a`, 11:33:06 PT). The procedure is
release-ops §3b; the tool is `scripts/ops/ota-export-and-gate.sh`. In `main` since PR #85
(`a8ba597a`, merged 2026-09-29 19:00:51 PT by gate route PROXY).
- **Export each runtime from a clean worktree at the publish commit**, with
  `EXPO_PUBLIC_API_URL` (from `eas.json` `build.<channel>.env`), `EXPO_PUBLIC_SENTRY_ENV` and
  `EXPO_PUBLIC_SENTRY_DSN` set explicitly, and no `apps/mobile/.env*` in the tree. A build
  profile's `env` does not reach an update.
- **`EXPO_PUBLIC_SENTRY_ENV` is `production` on every channel**, preview included. Sentry's
  `environment` therefore does not name the channel; `contexts.ota_updates` (`channel`,
  `update_id`, `is_embedded_launch`) does.
- **Gate every bundle before any publish:** in each Hermes bundle, the API URL is present;
  no `localhost:3001`; no `undefined/api`; the exact DSN is present; exactly one Sentry
  public key, equal to the DSN's. A FAIL stops the publish.
- **Keep a sha256 manifest** beside the export, and check it before publishing.
- **Publish with `eas update --skip-bundler --input-dir <export>` from the matching tree's
  `apps/mobile`**, so the runtime and commit EAS records are that tree's. Vishnu runs every
  `eas` command.
- **Never a dirty tree.** It would publish code no commit holds, under HEAD's sha. Every
  publish before 2026-09-29 was made from a dirty tree (Vishnu, from the update list).
- **Publish each runtime to every channel that has a live binary at it.** A skipped channel
  is written down with the reason. The same bytes to a second channel go by republish, not a
  second export.
- **Preview is not a test-only channel.** STARNET guard GRD0024 (`94ab7696`) ran the vc27
  preview APK, which Vishnu gave them (confirmed 2026-09-29): its `guard_devices` rows, embedded
  id `dc827710…`, run from 2026-09-28 04:52 to 2026-09-29 14:23 PT, when the guard signed in
  on an iPhone (production) again. A preview publish can reach a paying customer.
- **The DSN never touches a tree, the chat or a terminal's output:**
  `umask 077 && printf 'EXPO_PUBLIC_SENTRY_DSN=%s\n' "$(pbpaste)" > <scratch>/dsn.env` —
  one line, mode 0600, outside every worktree, deleted after the export.

Evidence (2026-09-29): `apps/mobile/lib/sentry.ts:64` skips `Sentry.init` without a DSN;
eas-cli 18.5.0 merges only server-side variables into an update, and only with
`--environment` (`build/commands/update/index.js:190-195`); in 90 days `netraops-mobile`
had 204 error events, none from an OTA update id (Sentry, read in the batch-18 session).

---

## 2026-09-30 — the database pool

Taken in the pool error-listener fix (`OPEN-ITEMS.md` N158; Phase 0 on 2026-09-29/30). PR #86
(`scripts/ops/proxy-merge.sh` and the #85 SHIPPED docs) is folded into the same PR by merge
commit `b5b549d`, so both land in one gated merge.

### D22. Every checked-out pool client carries an `'error'` listener: a dying connection fails its request, never the process.

**Status 2026-09-30 — SHIPPED.** PR #87 was merged as `d1218f09` at 16:00:30 PT by gate route
PROXY: `scripts/ops/proxy-merge.sh --live`, 12.5 s after a STARNET ping from GRD0024 (`94ab7696`;
HTTP 201 at 23:00:18.007Z; GitHub `mergedAt` 23:00:30Z). It gated on that one guard (D23),
after the 13:00 attempt aborted at its deadline without merging while waiting on a guard who
never pinged.
- **Deploy:** Railway deployment `c07bf30a` finished SUCCESS on that commit (created
  23:00:32.569Z, booted once at 23:01:43Z), and `/health` reported `d1218f09` from 16:02:00 PT.
- **Switchover:** no 5xx on either deployment. The only 4xx were 401s from one browser polling
  `/api/chat/rooms` with a stale token, at the same rate as the hour before.
- **After it:** no `[pg.client_error]` and no idle-client errors. Sentry (netraops-api) had
  0 events 15:30–16:30 PT, against 23 in the previous 7 days. All 15 short-interval crons
  ticked `ok` on the new deployment by 16:33, and STARNET pings landed on it (16:05, 16:30).
- **PR #86** (folded in by `b5b549d`, its merge commit, an ancestor of `d1218f09`) shows merged
  at 23:00:32Z.
- **Earlier that day:** both 10:30 dry runs passed, one gating on one guard and one on two. A
  Vercel preview failure made #87 UNSTABLE, which the script refuses, until the preview was
  redeployed; the cause was a Google Fonts fetch in `next/font` (N162).

Earlier status, kept as history:

**Status 2026-09-30 — BUILT, not merged or deployed**, on `fix/pool-client-error-listener`
(`apps/api/src/db/pool.ts` only).
**Proof (2026-09-30, local PG 18.6, `apps/api/scripts/test-pool-client-error.ts`).** Each case
runs in its own child process, and the parent injects the fault:
- `pg_terminate_backend` on a checked-out client, with no query and mid-query;
- a FATAL mid-query, then a plain `release()` before the socket closes (V10);
- a TCP reset through a proxy, and an idle client;
- `pg_ctl stop -m fast` and `-m immediate`;
- `POST /shifts/:id/clock-out`, `PATCH /shifts/:id/cancel`, and the autoCompleteShifts tick
  through `runJob`.
origin/main's `pool.ts` is the negative control. Mutations M1–M9 each remove one part of the
fix. Every mode must fail exactly its predicted set, and the predictions were written before
the first run. Tested `pool.ts` blob `c6e2ec40`. Results:
- **Node 25.7.0, pg 8.20.0 / pg-pool 3.13.0, plain, Sentry off:** fix 79/0, main 29/50, M1
  29/50, M2 76/3, M3 62/17, M4 60/19, M9 78/1.
- **Node 25.7.0, pg 8.23.0 / pg-pool 3.14.0 (production's), TLS, real `Sentry.init` with an
  in-memory transport:** fix 106/0, main 32/74, M1 32/74, M2 100/6, M3 77/29, M4 78/28, and
  M5, M6, M6d, M6e and M7 at 100/6 each.
- **Node 18.20.5 (production's Node):** fix 79/0 and 106/0; main 29/50 and 32/74; M5, M6, M6d,
  M6e and M7 at 100/6 each, so the stale-context leak is real on Node 18 too.
The Sentry checks: one warning event per dying client, and no stale user, tag, request or
trace. M5–M7 fail them. An independent verifier reproduced every count on its own cluster,
and an unlisted mutation ('connect' instead of 'acquire') was caught (C1 44/35).
Not covered: half-open TCP (a hang, not a crash); CI, which has no Postgres.
- **What:** on pool `acquire` a listener is added to the client, and on `release` it is
  removed. pg-pool emits `acquire` before it removes its own idle listener and `release` after
  it puts it back (`_acquireClient` / `_release` in pg-pool 3.13.0 and 3.14.0), so a client
  always has a listener. It covers `pool.connect()` and `pool.query()` clients.
- **Why:** a checked-out client has no `'error'` listener, and pg emits `'error'` synchronously
  whenever the connection dies, query in flight or not. So any Postgres restart or network drop
  while a client is checked out kills the API: 35 `pool.connect()` call sites in the API
  process (36 with `db/migrate.ts`), 1 replica. Not observed in production (N158), so this is
  preventive. It must merge before the current Postgres auto-update window next opens
  (Sat 2026-10-03 10:00 UTC).
- **Sentry:** each dying client is captured once (a client usually emits twice): level
  `warning`, tags `flow: db_pool` and `pg_code`, fingerprinted by code. The capture runs with
  cleared isolation and current scopes and no active span. The listener runs in the async
  context of whichever request opened the socket, so without that the event would carry that
  request's user, tags, URL and trace. There is no capture when no Sentry client exists, and
  the listener never throws. Log tag: `[pg.client_error]`.
- **Idle-client log:** prints `code`, `severity` and `message` only. The error object carries
  `err.client` (host, port, user, database, socket).
- **Behaviour change:** a request caught at the moment the DB dies now gets a 500 instead of a
  connection reset, and a cron tick fails instead of the process. After a plain `release()` the
  dead client is dropped on release, or through pg-pool's idle listener when its socket closes.
  One wasted reuse is possible; a crash is not.
- **Rejected:** `pool.on('connect', …)`, which also stops the crash but logs every idle-client
  error twice; `process.on('uncaughtException')`, which would stop Sentry exiting on real
  crashes; `release(err)` at every call site, which is not needed to prevent the crash.
- **Not in D22:** the seven bare catch-block `ROLLBACK`s (N159); half-open TCP hangs (no
  keepAlive, `query_timeout` or `statement_timeout`); `idle_in_transaction_session_timeout`;
  ending the pool on SIGTERM; a DB-free CI tripwire (a later stage, Vishnu 2026-09-30).


---

## 2026-09-30 — the PROXY gate, and daily report recipients

### D23. The PROXY gate waits for ONE calibrated guard's ping, not every open session's.

**Status: decided 2026-09-30 (Vishnu).** First applied to PR #87 (D22).
- **Rule:** before arming, choose one STARNET guard who pinged in the window before the
  boundary. Their device UA must be calibrated (Railway HTTP 201s matched to that session's DB
  ping rows) and shared by no other session open at arming. The UA file names that guard only.
  Silent sessions never gate. If that guard has not pinged in the window before the boundary,
  choose another calibrated guard who has; still one.
- **Why:** the gate is a timing signal. The merge goes out in the quiet seconds right after a
  ping, so the restart falls between ping windows. Waiting for every open session let one
  silent guard decide the slot: on 2026-09-30 the 13:00 run aborted at its deadline because
  GRD0026 never pinged for 13:00, although GRD0010 and GRD0024 pinged at 13:00:09 and 13:00:13.
- **Accepted consequence:** another guard's ping can land during the 1–2 minute switchover.
  #87's switchover had no 5xx (D22).
- Recorded in POLICY.md (route 2) and the header of `scripts/ops/proxy-merge.sh`, which still
  accepts several gating lines.

### D24. The daily shift report goes to every active client linked to the site through `client_sites`; a skip is never flagged sent.

**Status 2026-10-01 — SHIPPED.** PR #88 merged as `a83bae0b` at 21:04:22 PT on 2026-09-30 by
gate route PROXY, on the D23 one-guard gate (GRD0015's 21:04:10 ping). Railway deployment
`c7f59660` SUCCESS; `/health` reported `a83bae0b` from 21:05:53 PT. The first run on it,
2026-10-01 09:00 PT, checked at 09:25 PT from Railway logs, the database and Sentry:
- one `[daily-email] Starting` line (16:00:00.919Z) and one `Done` line, `sent: 1 (partial: 0),
  skipped: 8 (no_client 8), failed: 0; emails delivered: 1, failed: 0`. No other deployment and
  no error line in the window, so no double send;
- Bethel AME Church's 2026-09-30 shift (`605b067a`) was flagged at 09:00:01.502 PT, the only
  shift the run flagged. Its one recipient is STARNET's client, linked through `client_sites`.
  The 8 shifts at sites with no client are still unflagged;
- Sentry: no netraops-api issue with an event since 07:00 PT, and no event tagged
  `flow:daily_shift_report` in 24 h. A 14-day control query returned events, so the search
  works;
- `scripts/ops/triage.sh`'s email-liveness queries, run as written: last daily client report
  0.5 h ago, 1 report due in the last 26 h, ALARM none;
- STARNET's admin confirmed the same morning that STARNET is receiving the daily reports.

Earlier status, kept as history:

**Status 2026-09-30 — BUILT, not merged or deployed**, on `fix/daily-report-recipients`
(OPEN-ITEMS N161). Decided by Vishnu after the N161 Phase 0 the same day:
1. **Recipients:** every active client linked to the site through `client_sites`, in the site's
   own company. `clients.site_id`, legacy since v36, is not read. Reading it as well would add
   nobody today (every client's primary site also has a `client_sites` row), but a client whose
   primary site an admin unlinked would keep getting that site's reports.
2. **Gates:** no report for a site whose client access is disabled (the portal toggle, and site
   deactivation, which sets the same column) or whose company is inactive.
3. **Partial failure:** the shift is flagged sent once at least one recipient got it. A
   recipient whose send failed is not retried, so nobody gets a duplicate. If every recipient
   failed, the shift stays unflagged and counts as failed.
4. **Skips are logged and counted, never flagged.** The 36-hour window limits re-checks to at
   most two runs. A durable skip record is a follow-up (N163).
5. **The ping line is sent as it is,** including for Bethel AME Church, which has enforcement
   off (D11). Vishnu tells STARNET's admin before the client's reports start.
6. **One message per recipient** (personalized greeting), rendered inside the async callback.
   A render error goes to Sentry under `stage: render`, never through the SendGrid failure
   reporter. A shift whose every recipient failed produces ONE Sentry event, carrying the
   original error (render or SendGrid), and the job tags `service: sendgrid` only on send
   failures. The incident alert gets the same render fix.
7. **Counters:** the job logs `sent (partial), skipped (reasons), failed; emails delivered,
   failed`. `scripts/ops/triage.sh` counts reports due by the same rule.
- **Not in D24:** the durable skip column (N163). (Corrected 2026-10-01: this bullet also
  listed Bethel's 2026-09-30 report, shift `605b067a`, as accepted lost, because the old code
  would have skipped it in the 2026-10-01 run. It was not lost: the merge landed the evening
  before, and that run sent it.)
- **Merge gate:** Tier 2, because it starts daily reports to STARNET's client (POLICY.md Tier
  2 covers anything sent to STARNET's people or its guards). Vishnu present; never 08:55–09:05 PT, because jobs
  have no lock and overlapping containers could send the 09:00 run twice. Vishnu confirms the
  two Star Guard test inboxes first; this change starts reports to them too.
- **Proof (2026-09-30, local PG 18.6, `apps/api/scripts/test-daily-report-recipients.ts`):**
  - 16 seeded cases and one cross-cutting check, run twice through the real job callback.
    Fix: 45/0.
  - origin/main, the negative control, fails exactly its predicted 21 checks.
  - Mutations M1–M13 each fail exactly their predicted set. M12 and M13 (a render failure
    sent to the SendGrid reporter) were added after the Phase 1 verifier showed the harness
    could not see that case.
  - The single-client send payload is byte-identical to origin/main's (4,666 bytes).
  - The existing email tests pass.

---

## 2026-10-01 — repeat series and DST

### D25. A repeat_days series is the base's wall clock at the site on every date; drifted shifts are corrected by a script in the guard container.

**Status 2026-10-01 — BUILT, not merged or deployed**, on `fix/n160-repeat-days-dst`
(OPEN-ITEMS N160). Decided by Vishnu after the N160 Phase 0 the same day:
1. **Wall-clock end.** Each date's start and end are the base's local times at the site, as on
   specific_dates. An 18:00 → 06:00 post stays covered until 06:00 on both DST nights: 13 h in
   autumn, 11 h in spring. A night over 12 h asks for the U5 confirm, judged per date.
2. **The repeated hour.** On 2026-11-01 the local hour 01:00–01:59 happens twice. Every date,
   day 0 included, takes Postgres's reading (the later, PST, instant), as specific_dates does.
   The web sends the earlier (PDT) instant for day 0, so day 0 can land an hour after what was
   sent.
3. **Deactivated sites.** single and repeat_days now refuse one, with specific_dates' 409.
   assign-slots still does not check: filed as N164.
4. **The correction** is `src/ops/n160DstCorrection.ts`, run inside the guard container with
   `railway ssh`. Dry run by default; `--apply --expect=N` writes only when the plan holds the
   dry run's count. Each correction makes the admin edit's writes and sends its notice, under
   the super-admin token's sub with reason `N160 DST correction`. Everything commits in one
   transaction, and it can be re-run safely.
5. **Series the rows cannot settle**, because their reference shift may itself be wrong, are
   listed for Vishnu's review and never corrected.
6. **Timing:** the code fix this week, the correction right after it is live, both before
   2026-11-01.
- **Found while building it.** An admin's later edit of one shift in a series looks like drift.
  Production has one: a 375 Shopping Complex series whose shifts on 09-29 and 10-01 were edited
  on 09-29 and 09-30. A shift with a `shift_schedule_audit` row is never corrected, and never
  serves as the reference.
- **Not `railway run`,** which Phase 0 proposed: the guard service's `DATABASE_URL` is Railway's
  private host, which does not resolve from a workstation. The script ships in the image
  (`dist/ops/`).
- **Merge gate:** Tier 2 (this file changes; POLICY.md), on the PROXY route with the D23 gate,
  and never 08:55–09:05 PT. The correction is Tier 2 on its own: Vishnu present, after the
  deploy is verified.
- **Proof (2026-10-01, local Postgres 18.6 at Etc/UTC,
  `apps/api/scripts/test-n160-repeat-days-dst.ts`):**
  - 53/0 with the process clock at UTC, America/Los_Angeles and Asia/Kolkata.
  - origin/main, the negative control, fails exactly its predicted checks: 21 at UTC and
    Asia/Kolkata, 17 at America/Los_Angeles, where the Bethel case passes. The first prediction
    was wrong on one check: on main a Sunday 00:30 series writes Sunday Nov 1 twice and no
    Nov 22, so its row count comes out right.
  - 18 mutations (6 of the route, 12 of the correction) each fail exactly their predicted set.
  - One verifier, the same day: no must-fix. Its three should-fix gaps in the correction are
    closed. A shift is corrected only by the exact UTC-offset change the old loop made, which
    stops a second series an hour apart from being "corrected". The suspect window starts at the
    series' first shift, edited or not. Each UPDATE's result is checked against the plan.
    Mutations 17–19 are those three cases.
  - `test-active-shift-end-edit.ts` 115/0 at UTC and America/Los_Angeles.
  - The correction's planner SQL, captured from the module and run read-only on production at
    about 10:15 PT and again at 10:55 PT after the review's fixes (`$1` replaced by `NOW()`,
    nothing else): 1 correction, Bethel `4cf22350` to
    09:00–15:00 PST (17:00–23:00 UTC), no overlap and no session; 1 refusal, the edited shift
    above; 0 suspects.

---

## How to add to this file

One dated section per decision batch. State the decision, then — if it references
a system fact — the evidence and the date it was checked. A decision whose
supporting fact has since changed is still a decision; note the drift rather than
silently editing the decision.
