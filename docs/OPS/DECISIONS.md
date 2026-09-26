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

**Status: decided 2026-09-26. NOT YET BUILT (U6).** **Replaces the "4 fields
(Scheduled/Actual/Break/Violation), no aggregate total" lock** recorded in the
`netraops-invariants` skill (repo `SKILL.md:68`, plugin copy `:58`) and in the
`services/shiftHours.ts` header. Those describe shipped behaviour and change when
U6 ships, not before.

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
  in S3 are frozen snapshots until then.

Evidence (2026-09-26, prod, read-only): no hours figure today is capped at
`scheduled_end` on any surface; 0 NO_SCHEDULE shifts; 1 multi-session shift, 0
overlapping session pairs, 0 of 388 shifts with summed Payable above the window.
Bethel AME Church, clock-ins 2026-08-24 … 09-25 (55 sessions): Actual 310.45 h
today → 303.95 h after the D18 backfill; Payable 301.45 h (301.43 raw) before and
after.

### D20. Admin shift edits: on an ACTIVE shift, the end time only; a confirm step above 12 hours.

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

---

## How to add to this file

One dated section per decision batch. State the decision, then — if it references
a system fact — the evidence and the date it was checked. A decision whose
supporting fact has since changed is still a decision; note the drift rather than
silently editing the decision.
