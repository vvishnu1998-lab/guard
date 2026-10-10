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

## How to add to this file

One dated section per decision batch. State the decision, then — if it references
a system fact — the evidence and the date it was checked. A decision whose
supporting fact has since changed is still a decision; note the drift rather than
silently editing the decision.
