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

## How to add to this file

One dated section per decision batch. State the decision, then — if it references
a system fact — the evidence and the date it was checked. A decision whose
supporting fact has since changed is still a decision; note the drift rather than
silently editing the decision.
