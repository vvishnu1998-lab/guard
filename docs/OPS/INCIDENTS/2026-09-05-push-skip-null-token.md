# 2026-09-05 — push_skip_null_token

**Status:** **RESOLVED** 2026-09-05.
**Merged:** `3b3c9a1` (PR #6). **Deployment:** `9775a777-9523-4b58-91c0-9e49edd6b21e`, SUCCESS, 2026-09-05 09:12:04 PT / **16:12:04Z**.
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
| 2026-09-05 16:00:04 | **last `flow: ping_reminder` event ever recorded on this issue** |
| 2026-09-05 **16:12:04** | deploy `9775a777-9523-4b58-91c0-9e49edd6b21e` SUCCESS — fix live |
| 2026-09-05 16:30:01 | window boundary passes: reminders still written, **0 Sentry events** |
| 2026-09-05 16:45:34 | verification complete; **RESOLVED** |

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

---

## Fix

Approved 2026-09-05: **1-a** (code fix, pingReminder only), **2-b** (other five
call sites deferred), **3-a** (collector count fix in the same branch).

Branch `ops/phase-5-null-token`. Commit sha recorded on merge.

### `apps/api/src/jobs/pingReminder.ts` — the incident fix

The per-call `Sentry.captureMessage('push_skip_null_token', { level: 'warning' })`
is replaced by a tick-scoped counter:

```ts
export interface SkipCounter { skippedNoDevice: number }
export function newSkipCounter(): SkipCounter { return { skippedNoDevice: 0 }; }
```

`sendReminder` takes an optional `skipped?: SkipCounter` and increments it
instead of emitting. The counter is created per tick and threaded into all
three legs — **not** kept at module scope, because node-cron does not serialise
ticks and a tick overrunning its minute would share a module-level counter with
the next one.

It is reported in the two **existing** summary lines:

```
[pingReminder] schedule-anchored: fired N ping reminder(s) skipped_no_device=X
[pingReminder] Sent activity-report reminder to N of M active guards skipped_no_device=X
```

`skipped_no_device` is the tick running total at each point. One documented
gap: the task leg runs after both lines, so a task reminder skipped for a
missing device is counted but not printed. Accepted — that leg only fires for a
session with pending tasks, and the condition stays queryable either way.

**Unchanged, deliberately:** the push skip, the `insertNotification` write, the
`runJob` wrapper, the heartbeat, and the job's `WHERE` clause. No guard-facing
behaviour moves. No new tags.

The `Sentry` import became dead and was removed — it was used only by the
deleted `captureMessage`. Tick errors still reach Sentry through `runJob`,
tagged `job=pingReminder`.

### `scripts/ops/triage.sh` — the collector fix (item 3-a)

`c_sentry` now emits `count_24h` **and** `lifetime` as separate columns, plus
`firstSeen`. `count_24h` is summed from per-issue hourly buckets.

**A second bug surfaced while implementing this.** The first attempt summed the
buckets embedded in the issues *listing*. Those are not trustworthy: measured
2026-09-05, the listing returned 24 buckets summing to **0** for issue
`7713575234`, while `/issues/7713575234/?statsPeriod=24h` returned 25 buckets
summing to **4** — with the events plainly inside the window at 11:42–11:57Z.
Same field name, different answer. `c_sentry` therefore makes one extra call per
recent issue against the per-issue endpoint, capped at `SENTRY_ISSUE_CAP=15`
with the cap announced in the output rather than silently truncating.

Verified after the change:

```
id|shortId|level|count_24h|lifetime|firstSeen|lastSeen|title
7633312535|NETRAOPS-API-6|warning|60|311|2026-07-25T23:30:00.771000Z|...|push_skip_null_token
7713575234|NETRAOPS-API-T|error|4|4|2026-09-05T11:42:00Z|...|Cron failure: shiftstartreminder
```

`60` vs `311` is exactly the distinction the original finding collapsed.
`NETRAOPS-API-T` reads `4`, not `0`.

### `.github/ops/triage-prompt.md`

- New second line: *"Copy every id (issue ids, shas, uuids, deployment ids)
  verbatim from the pack. Never retype or abbreviate an id."* — the transposed
  digit in the original finding cost the first minutes of this investigation.
- The section table now names both columns and warns against quoting `lifetime`
  as a 24h figure.
- Reading guidance added: check `firstSeen` before calling anything new, and do
  not describe an issue as "continuous" without evidence for it.

### Tests

`apps/api/src/jobs/_pingReminder.test.ts`, 5 assertions, ts-node + `node:assert`
like its siblings. Sentry is stubbed with a Proxy so that **any** Sentry call —
not just `captureMessage` — fails the test.

| test | asserts |
|---|---|
| no device row | counter increments, no push, **zero Sentry calls** |
| no device row | the in-app notification is **still written** (Tier-2 boundary) |
| with a device | push sent, counter untouched, no Sentry call |
| accumulation | 3 skips on one counter; a second counter starts at 0 and does not disturb the first |
| optional arg | omitting the counter does not throw and still emits nothing |

Full suite: `tsc --noEmit` clean; `_run` 10 passed, `_healthCrons` 36 passed,
`_pingReminder` 5 passed. **51 passed, 0 failed.**

---

## Verification plan

Observe after merge and deploy:

1. **Event rate goes to zero.** Issue `7633312535`, `flow: ping_reminder`.
   Current baseline is 9/hour (6 at `:00`, 3 at `:30`), so the first `:30`
   boundary after deploy is the earliest proof and the first `:00` is the
   confirmation. Compare the 30 minutes after deploy against the 30 before.
   **Expect 0 new `flow: ping_reminder` events.** Events from the other five
   call sites may still appear — that is N20, not a failed fix.
2. **The job still runs.** `cron_heartbeats` row for `pingReminder`:
   `last_result = 'ok'`, age under 120s (2× its 60s interval).
3. **The route stays healthy.** `GET /health/crons` → 200, `jobs: 19`,
   `stale: []`.
4. **Reminders still land.** `notifications` rows of type `ping_reminder` keep
   accruing for the three sessions at the same cadence. If these stop, the fix
   suppressed a guard-facing notification and must be reverted — that is the
   one outcome that would make this worse than the noise.
5. **The counter appears.** Railway logs show
   `[pingReminder] schedule-anchored: fired N ping reminder(s) skipped_no_device=3`
   while the three test sessions remain open.

Item 4 is the one that matters. Items 1–3 confirm the noise is gone; item 4
confirms nothing was lost with it.


---

## Verification

Measured 2026-09-05 16:45:34Z, **2010 seconds (33.5 min) after deploy**, so the
30-minute post-window is fully elapsed — confirmed by query rather than assumed
(`after_window_complete = true`). It also spans the **16:30 window boundary**,
which under the old code would have produced 3 events.

### 1. Sentry event rate — 6 to 0

Issue `7633312535`, filtered on `flow = ping_reminder`:

| window | events |
|---|---|
| `[15:42:04Z, 16:12:04Z)` — before | **6** |
| `[16:12:04Z, 16:42:04Z)` — after | **0** |

The 6 before all landed at the `16:00` boundary — `16:00:02` x3 and `16:00:04`
x3 — exactly the documented shape (3 ping leg + 3 hourly leg). After the deploy:
nothing, through a boundary that previously fired. The newest event on the issue
from any flow is `16:00:04Z`, i.e. before the deploy.

### 2. The job still runs

`cron_heartbeats` row for `pingReminder`: `last_result = 'ok'`,
`last_run_ms = 60`, `age_s = 34` — well inside its 120 s threshold (2 x 60 s).

### 3. The route is healthy

`GET https://api.netraops.com/health/crons` → **HTTP 200**,
`{"status":"ok","jobs":19,"stale":[]}`.

### 4. Reminders still land — the check that mattered

The three sessions are **still open and still have no active device**, so the
emitting condition is unchanged. `notifications` of type `ping_reminder`:

| session_id | before 30 min | after 30 min | latest |
|---|---|---|---|
| `53d85e33` | 1 | **1** | 2026-09-05T16:30:01.048Z |
| `ae6e29e5` | 1 | **1** | 2026-09-05T16:30:01.077Z |
| `65c15a57` | 1 | **1** | 2026-09-05T16:30:01.281Z |

One per 30-minute window per session, before and after, unchanged. Guard-facing
behaviour is identical; only the Sentry emission stopped. This is the pairing
that makes the result meaningful: **the condition still holds and the
notification still fires, while the noise went to zero.** A drop here would have
meant the fix suppressed a reminder and had to be reverted.

### 5. The counter appears in the logs

`railway logs --service guard --environment production --lines 200`:

```
total lines returned:              200
grep -c 'skipped_no_device='         1
grep -c 'push_skip_null_token'       0
```

The single match:

```
[pingReminder] schedule-anchored: fired 11 ping reminder(s) skipped_no_device=3
```

`skipped_no_device=3` — exactly the three no-device guards. One match rather
than several is correct, not a shortfall: that line prints only at a window
boundary, and the 200-line window contains exactly **1** `schedule-anchored`
line and **0** `activity-report reminder` lines, so it spans one `:30` boundary
and no top-of-hour. One boundary, one summary line, one match.

`push_skip_null_token` no longer appears in the logs at all.

**All five verification items pass.**

---

## Learning

The finding that opened this incident was wrong in three ways — a transposed
digit in the issue id, a lifetime count quoted as a 24-hour volume, and
"continuously" describing 19 hours of silence followed by a flat 9/hour — and
none of those were the model's fault. Two came directly from a collector I had
written three phases earlier, which emitted Sentry's `count` field under a
heading that said "last 24h" when that field is the lifetime total since
`firstSeen`. The lesson is not "check the numbers" but something narrower and
more useful: **a collector that mislabels a field is worse than one that omits
it**, because the omission is visible and the mislabel is not — every
downstream report inherits the error with full confidence, and the reader has
no way to detect it from the report alone. The same shape appeared twice more
inside this one incident: `railway logs` exiting 0 while printing an error, and
Sentry's issues *listing* returning bucket data that disagrees with its own
per-issue endpoint (0 versus 4 for the same issue in the same window). All three
are the identical failure — a source that answers confidently and wrongly — and
the only defence that worked in each case was checking one number against an
independent source before believing it. That is now the habit worth keeping:
when a signal is going to drive a decision, measure it twice from two places,
and if the two disagree, fix the collector before writing the report.


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

### Finalised after close (2026-09-05)

**What the loop got right.** The 5A/5B/5C split held. Investigation produced a
falsifiable claim; the fix was scoped to exactly what was approved; verification
had a pre-registered plan written *before* the fix shipped, which is what made
item 4 (reminders still landing) a real test rather than a post-hoc
rationalisation. Every one of the five verification items was checkable
read-only.

**Three collector defects were found and fixed inside this incident**, all the
same class — a source that answers confidently and wrongly:

1. `c_sentry` emitted `count` (lifetime) labelled as 24h. **Fixed** — separate
   `count_24h` and `lifetime` columns plus `firstSeen`.
2. The Sentry issues *listing* embeds bucket data that disagrees with the
   per-issue endpoint (0 vs 4, same issue, same window). **Fixed** — one extra
   call per recent issue against the authoritative endpoint, capped at 15 with
   the cap announced.
3. `railway logs` exits 0 while printing "No service linked", so the collector
   wrapper recorded a failure as a 3-line success. **Fixed in Phase 4.3** —
   explicit error-text matching on top of the exit-status check.

**Still open from this incident.** N20: five other call sites still emit per
occurrence, none tags `company_id` consistently, and
`ACTIVE_PUSH_TOKEN_SQL` still lacks `LIMIT 1`. Deliberately deferred, not
forgotten.

**One process note.** The Phase 5A dispatch asked for
`(push_token IS NULL) AS token_null`, which the Phase 2/3 column revoke makes
impossible (`permission denied for table guard_devices`). The control worked
exactly as designed; the dispatch template is what needs updating, so future
phases stop asking for a column the loop deliberately revoked.
