# 2026-09-05 — push_skip_null_token

**Status:** investigated, unfixed. Awaiting a decision.
**Severity:** P3. No customer impact; no STARNET exposure.
**Issue:** Sentry `netraops-api` **`7633312535`** (`NETRAOPS-API-6`), level `warning`.

---

## Summary

`pingReminder` emits a Sentry **warning per reminder** for any guard with no
push token. Three guards on the **test tenant** have open sessions and zero
`guard_devices` rows, so the job produces **9 events/hour** — 6 at `:00`, 3 at
`:30`.

**This is noise, not a fault.** The job is behaving correctly: it writes the
in-app notification and skips the push. Nothing is broken, no reminder is lost,
and no paying customer is involved.

Three claims in the finding that prompted this are wrong, and each is corrected
below with evidence: the issue id, the event volume, and "continuously".

---

## Timeline (UTC)

| time | event |
|---|---|
| 2026-07-25 23:30:00.771 | issue `7633312535` first seen — **six weeks old, not new** |
| 2026-09-05 02:28–02:37 | 2 test-tenant guards clock in (both have devices) |
| 2026-09-05 **04:06:58** | GRD0022 `5ddb92e2` clocks in — **no device row** |
| 2026-09-05 **05:00:01** | first `ping_reminder` notification row for that session |
| 2026-09-05 04:00–09:59 | job demonstrably firing; **Sentry records 0 events** (see Evidence) |
| 2026-09-05 **08:31:58** | GRD0017 `98401c5a` clocks in — no device row |
| 2026-09-05 **09:22:54** | GRD0016 `0716914b` clocks in — no device row |
| 2026-09-05 **10:00:01** | Sentry begins recording; **9/hour** from here |
| 2026-09-05 15:01 | triage run 33973502815 reports it |
| 2026-09-05 15:30:01 | last event at time of writing |

---

## Evidence

### The issue id in the finding does not exist

`GET /api/0/issues/7633812535/` → **HTTP 403**, `"You do not have permission to
perform this action."`
`GET /api/0/issues/7633312535/` → **HTTP 200**, `push_skip_null_token`.
One transposed digit. All findings below use `7633312535`.

### Volume: 54 in 24h, not 303

`GET /api/0/issues/7633312535/?statsPeriod=24h`, hourly buckets:

```
09-04 15:00 .. 09-05 09:00   0     (19 consecutive hours)
09-05 10:00     9
09-05 11:00     9
09-05 12:00     9
09-05 13:00     9
09-05 14:00     9
09-05 15:00     9
24h total: 54
lifetime count: 306    firstSeen: 2026-07-25T23:30:00.771Z
```

`count: 306` is the **lifetime** total since 2026-07-25 — roughly 7/day averaged
over six weeks. It is not a 24-hour figure, and "firing continuously" does not
describe 19 hours of zero followed by a flat 9/hour.

### The caller is pingReminder, identified by timestamp alignment

Every event in the current burst carries `tags.flow = ping_reminder`. The
timestamps cluster exactly:

```
10:00:01 x3, 10:00:02 x3   -> 6 at :00
10:30:01 x3                -> 3 at :30
11:00:00 x3, 11:00:01 x3   -> 6 at :00
11:30:01 x3                -> 3 at :30
... repeating through 15:30
```

`pingReminder` is `* * * * *` (`CRONS.md`) but only acts on a **closed 30-minute
window**, which is why events appear only at `:00` and `:30` rather than every
minute. The doubling at `:00` is its second leg: the activity-report reminder is
gated on `if (minute !== 0) return;` (`pingReminder.ts:319`), so the hourly leg
adds a second group of 3. **3 guards x (1 ping leg + 1 hourly leg) = 6 at :00,
3 at :30, 9/hour.** The task leg emits nothing because those sessions have no
pending tasks.

### The emitter

`apps/api/src/jobs/pingReminder.ts:79-89`, inside `sendReminder`:

```ts
if (!row.fcm_token) {
  Sentry.captureMessage('push_skip_null_token', {
    level: 'warning',
    tags: { flow: 'ping_reminder' },
    extra: { guard_id: row.guard_id, shift_session_id: row.shift_session_id, type },
  });
}
```

It fires **once per reminder**, unconditionally, at `warning`. `guard_id` goes
to `extra`, not `tags`, which is why the event tag list carries no identity —
`['environment','flow','interface_type','level','os','os.name','release','runtime','runtime.name','server_name']`.

Five further call sites share the pattern and the same message string:
`preShiftReminder.ts:99`, `lateClockInReminder.ts:100`,
`shiftStartReminder.ts:100`, `services/swapPush.ts:81`,
`services/shiftPush.ts:168`. Older events in this same issue carry
`flow: late_clock_in`, `shift_start_reminder`, `pre_shift_reminder`,
`swap_push`, `shift_assignment` — so all six do fire, at different times.

### Where the null comes from

`services/deviceRegistry.ts:249-252`:

```ts
export function ACTIVE_PUSH_TOKEN_SQL(guardAlias: string): string {
  return `(SELECT d.push_token FROM guard_devices d
            WHERE d.guard_id = ${guardAlias}.id AND d.revoked_at IS NULL) AS fcm_token`;
}
```

A guard with no non-revoked `guard_devices` row yields `NULL`.

### The subjects — 3 guards, all on the test tenant

Derived from the job's own predicate (open session, clocked in >5 min ago). IDs
and counts only; `push_token` is unreadable by `claude_readonly` (see below).

| session_id | guard_id | company_id | badge | clocked_in_at | device rows (total/active) |
|---|---|---|---|---|---|
| `53d85e33` | `5ddb92e2` | `b7c7d32d` | GRD0022 | 04:06:58Z | 0 / 0 |
| `ae6e29e5` | `98401c5a` | `b7c7d32d` | GRD0017 | 08:31:58Z | 0 / 0 |
| `65c15a57` | `0716914b` | `b7c7d32d` | GRD0016 | 09:22:54Z | 0 / 0 |

`b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee` = **Star Guard, the test tenant.**

The latest event's `extra` is `guard_id 5ddb92e2-1c4d-482d-a178-a002eb2b22c9`,
`shift_session_id 53d85e33-7a6c-44e8-af53-5045924ed8c4` — an exact match to row
one, confirming the derivation rather than assuming it.

All **10** currently-open sessions belong to `b7c7d32d`. The other 7 each have
exactly 1 active device row.

### Sentry undercounts the emission — do not treat its count as volume

The three sessions' notification rows show the job fired long before Sentry
recorded anything:

| badge | ping_reminder notifications | first | last | location_pings |
|---|---|---|---|---|
| GRD0022 | 22 | 05:00:01Z | 15:30:01Z | 0 |
| GRD0017 | 13 | 09:30:00Z | 15:30:01Z | 0 |
| GRD0016 | 12 | 10:00:01Z | 15:30:01Z | 0 |

GRD0022 has 22 reminders starting 05:00:01 — one per 30-minute window through
15:30, exactly as expected. Each of those calls ran the `if (!row.fcm_token)`
branch. **Sentry recorded zero events before 10:00**, so at least ~15 emissions
in 04:00–09:59 are absent from Sentry.

**Why is UNCONFIRMED.** Plausibly client- or server-side rate limiting or a
quota drop; it cannot be checked with this token, which is refused
`/api/0/api-tokens/` (403). What is confirmed is the consequence: **the Sentry
event count is a floor on emission volume, not a measure of it.**

### Latent, not live: the subquery has no LIMIT 1

`ACTIVE_PUSH_TOKEN_SQL` is a scalar subquery with no `LIMIT 1`. Two non-revoked
rows for one guard would raise `21000 more than one row returned by a subquery
used as an expression`, failing the whole tick rather than one push.

Currently safe: `guards_with_multiple_active_devices = 0` across all 37 guards.
Latent only — recorded as a follow-up, not part of this incident.

---

## Root cause

**Falsifiable claim.** `pingReminder` selects every active session and calls
`sendReminder` unconditionally. `ACTIVE_PUSH_TOKEN_SQL` returns `NULL` for a
guard with no non-revoked `guard_devices` row, and `sendReminder` emits a
`warning`-level Sentry event on every such call. Three test-tenant guards have
open sessions and zero device rows, so each closed 30-minute window produces 3
events and the hourly activity-report leg produces 3 more.

**Test:** if any one of the three clocks out or acquires a device row, the rate
drops by exactly 3/hour. If all three clock out, it goes to 0.

**Classification: (iii), with a caveat.** These are guards with no device who
are legitimately scheduled — not stale rows (there are no rows to revoke, total
count is 0) and not a missing filter in the sense of a bug. The job *should*
proceed: it still writes the in-app notification, and suppressing that would be
a guard-facing behaviour change.

The defect is the **observability choice**, not the logic: an expected,
recurring, per-guard condition is reported as an individual `warning` event
rather than as a rate.

---

## Blast radius

- **3 guards**, `5ddb92e2` / `98401c5a` / `0716914b`, badges GRD0022 / GRD0017 /
  GRD0016 — all on `b7c7d32d` (**Star Guard, test tenant**).
- **STARNET: zero.** No open STARNET sessions. Of 9 STARNET guards, exactly 1
  (`c1f2c8a5`, GRD0003) has no active device row, and it is `is_active = false`
  with **0 future shifts** — it cannot reach this path.
- **Frozen entity: not involved.** `FREEZES.md` F1 is `e8274964` (GRD0002, Star
  Guard); it is not among the three.
- **Customer-visible effect: none.** No push is delivered to the three, but they
  have no registered device at all, so no deliverable notification is lost. The
  in-app rows are written (22 / 13 / 12).
- **Historically STARNET has appeared in this issue** — events on 2026-08-30 and
  2026-09-01 carry `company_id 27c4d404-8769-49ca-bfd6-93cb9b890067` under
  `flow: swap_push`. So the emitter is not test-tenant-only by design; it is
  test-tenant-only right now by who happens to be clocked in.

Note in passing, not part of this incident: all three sessions have **0
`location_pings`** across 10+ hours while being reminded 22/13/12 times. On the
test tenant that is expected (no device, no app).

---

## Fix proposal

### Recommended — stop emitting per occurrence (size **S**, **Tier 1**)

`apps/api/src/jobs/pingReminder.ts` only. Replace the per-call
`Sentry.captureMessage` with a tick-scoped counter, reported once in the
existing `[pingReminder]` summary line. Removes 9 events/hour and loses nothing:
the condition stays fully derivable from `guard_devices` and `notifications`.

Does **not** change guard-facing behaviour — the push skip and the in-app
notification are untouched.

### Rejected — filter the query (would be **Tier 2**)

Adding `AND EXISTS (active device)` to the job's `WHERE` would stop the in-app
notification as well as the Sentry event. That is a change to guard-facing
reminder behaviour and is **Tier 2 per `POLICY.md`**. Flagging and not
proposing it.

### Not applicable — revoke a stale row

There is nothing to revoke: `device_rows_total = 0` for all three.

### Noise fix, if a deploy is not wanted (size **S**, **Tier 1**)

Mute or rate-limit issue `7633312535` in Sentry. No code change. **Not
recommended**: it leaves the emitter wrong at all six call sites and would also
hide the STARNET case if one ever appears — the failure mode is that the alarm
you silenced is the one that later mattered.

### Follow-up, separate from this incident (size **M**, **Tier 1**)

The same pattern exists at five other call sites, and none of them tags
`company_id` consistently. Adding `company_id` to `tags` at all six would make
this signal tenant-attributable — the difference between "test tenant, ignore"
and "paying customer, act" is currently only discoverable by querying the DB.

**Recommendation: the S/Tier-1 code fix, scoped to `pingReminder`**, with the
six-call-site tagging raised as its own item rather than bundled.

---

## Loop notes

**What the triage report got right.** It surfaced a real, ongoing emitter and
gave the correct issue title, level, and `lastSeen`. Without the Phase 4.2
collector this would not have been noticed at all — the previous runner reported
on nothing.

**What it got wrong — three things, all from one root cause.**

1. **The issue id was wrong** (`7633812535`; real id `7633312535`). A 403, and
   the first two minutes of this investigation.
2. **"count 303 in 24 h" conflates lifetime with 24-hour volume.** `count` on
   the Sentry issues endpoint is the lifetime total since `firstSeen`
   (2026-07-25). The true 24h figure is **54**.
3. **"firing continuously" is contradicted by the buckets** — 19 hours of zero,
   then a flat 9/hour.

Points 2 and 3 are **a defect in the collector I wrote in Phase 4.2**, not in
the model's reading. `c_sentry` emits `.count` from the `?statsPeriod=24h`
issues listing, and the prompt's section table describes that column as if it
were period-scoped. It is not. The collector should emit a bucketed 24h sum
alongside — or instead of — `count`, and the prompt table should name the field
honestly. **Until that is fixed, every triage report will overstate the volume
of every recurring issue.**

**What was missing from the pack that I needed.**

- **Event `extra`.** The identity of the affected guard lives in
  `extra.guard_id` / `extra.shift_session_id`, and the pack carries only the
  issue summary line. Every identification step here required direct Sentry API
  calls the runner's model is not allowed to make. A collector that pulled the
  latest event's `extra` for the top few issues would have made this a two-minute
  triage instead of a full investigation.
- **Hourly buckets.** The onset time — the single most informative fact — is
  invisible in the pack.
- **`guard_devices` coverage.** The pack has heartbeats, sessions, violations
  and the customer signal, but nothing about device/token state, which is what
  this issue is entirely about.

**What the loop's own controls cost, correctly.** The Phase 5A dispatch asked
for `(push_token IS NULL) AS token_null`. That is **impossible by design**: the
Phase 2/3 column revoke denies `push_token` to `claude_readonly`
(`permission denied for table guard_devices`). Derived it from
`EXISTS`/`COUNT` on `revoked_at` instead. The control working as intended, but
the dispatch template should stop asking for a column it deliberately revoked.

**Loop friction worth fixing.** Nothing else. The read-only path was sufficient
to reach a falsifiable root cause, a bounded blast radius and a sized fix
without a single write.
