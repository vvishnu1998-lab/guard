# 2026-09-01 — `Error: Unauthorized` burst (N28)

**Status:** **CLOSED 2026-09-06 — N28 resolved.** Not an auth incident. The condition self-cleared
2026-09-01 17:00:01Z; the amplifier that turned it into 3,770 events is still in
the code, and the billing fault that started it is still **UNVERIFIED**.
**Severity:** **P2.** No guard-facing impact. Customer-visible: ~7 STARNET daily
client reports lost. Platform impact: it exhausted the Sentry quota and caused
the 94-hour blackout in `2026-09-06-sentry-rate-limited.md`.
**Item:** N28. **Branch:** `ops/n28-unauthorized`, cut from `main` @
`34a32c8ed74bd24aca8ae60ef929a362b990ee50` (`34a32c8`).
**Related:** `2026-09-06-sentry-rate-limited.md` (N27 — this is its cause),
`EXPIRIES.md` **E3** / **E15**, `OPEN-ITEMS.md` **N22**.
**Deadline: the Sentry events age out ~2026-11-30** (90-day retention). Every
event-level fact below is unreproducible after that date.

Read-only throughout. Zero production writes, zero Sentry writes. No names,
emails, coordinates, IPs or token values appear here. `DEVICES.md` was not
opened.

---

## Summary

**The dispatch's premise is wrong, and so was mine.** `Error: Unauthorized` is
**not** an inbound HTTP 401. There is no client, no route, no IP, no user agent
and no `company_id` to find, because **not one of these events came from an HTTP
request**. It is **SendGrid rejecting our own API key** on
`POST https://api.sendgrid.com/v3/mail/send`, captured from the outbound email
path.

All 10 retrievable events carry `flow=missed_shift_alert`, `service=sendgrid`,
`handled=yes`, and **no `request` entry at all**. The innermost stack frame is
`node_modules/@sendgrid/client/src/classes/client.js:167`. Their breadcrumbs
carry **250** SendGrid HTTP breadcrumbs, **every one `status_code: 401`**, and
**no other status code appears**.

The trigger is already a known open item: **`EXPIRIES.md` E15 — "SendGrid card
failing … Payment method declining."** A declining card suspends the account,
the API returns 401, and every outbound email fails.

**The amplifier is a deliberate retry loop.** `sendMissedShiftAlert` throws when
*every* recipient fails, specifically so the shift is **not** stamped and
"stays eligible for the next tick's retry" (`email.ts:736-739`). With SendGrid
down, `succeeded` is always 0, so the same shifts are retried **every 5
minutes, indefinitely**, and each attempt emits **one Sentry event per
recipient plus one for the throw**. Measured: **8 shifts × (4 admins + 1 throw)
× 12 ticks/hour = 480 events/hour**, sustained.

**Email was dead for 6 days 18 hours** — last success `2026-08-25 23:10:01Z`,
first success after `2026-09-01 17:00:01Z` — and **nothing in the ops loop
noticed**, because the loop has no email-delivery signal at all (`N22` says
exactly this).

**One declining credit card took out the error-monitoring platform.**

---

## Timeline (UTC)

| time | event |
|---|---|
| 2026-07-09 21:15:01.068 | issue `7602645302` `firstSeen` — **but Discover shows no events before 08-26**; see *Two sources disagree* |
| **2026-08-25 23:10:01.410** | **last successful email of any kind** (`shifts.missed_alert_sent_at` max before the outage) |
| 2026-08-26 17:10:00.427 | issue `7693907832` (`sendMissedShiftAlert: all N recipients failed`) first seen — **the same failure, one level up the stack** |
| 2026-08-26 → 08-31 | **six consecutive days, zero successful missed-shift alerts.** Sentry ramps 11 → 17 → 62 → 318 → 59 → 114 events/day |
| 2026-08-30 15:31:42.824 | the API process that served the burst starts (`contexts.app.app_start_time`) |
| 2026-09-01 01:00–03:00 | **12 shifts cross T+10** — the retry set fills up |
| 2026-09-01 03:00–11:00 | **sustained ~480 `flow=missed_shift_alert` events/hour** (384 per-recipient + 96 per-shift), eight hours |
| 2026-09-01 11:55:00.978 | breadcrumb: `[missed-shift] 8 missed shift(s) detected` |
| 2026-09-01 12:00:00.260 | breadcrumb: `[missed-shift] 8 missed shift(s) detected` — unchanged, five minutes later |
| **2026-09-01 12:00:00.486** | **last event Sentry ever recorded on this issue.** The org error quota is exhausted at this exact minute (N27) |
| **2026-09-01 12:00 → 17:00** | **the burst continues, invisibly.** ~5 h × 480/h ≈ **2,400 further events emitted and refused** |
| **2026-09-01 17:00:01.593** | **first successful email.** SendGrid recovers. Four shifts stamp in the same second |
| 2026-09-01 17:05:00 / 23:00:01 / 23:30:00 | three more successful sends — delivery is stable |
| 2026-09-05 10:00 | Sentry ingestion reopens (N27). **This issue does not reappear** — a genuine silence, because the cause was fixed four days earlier |
| 2026-09-06 03:00:01.791 | latest successful send. Email healthy |
| 2026-09-06 20:50 | this investigation. **0 shifts currently in the retry loop** |

---

## Evidence

### 1. The issue, and the shape

`GET /api/0/issues/7602645302/`:

| field | value |
|---|---|
| shortId / project | `NETRAOPS-API-4` / `netraops-api` |
| title | `Error: Unauthorized` |
| culprit | **`?(client)`** |
| level / status / substatus | `error` / `unresolved` / `ongoing` |
| count (lifetime) / userCount | **4671** / 5 |
| firstSeen / lastSeen | `2026-07-09T21:15:01.068Z` / **`2026-09-01T12:00:00Z`** |
| `metadata.filename` | `node:internal/process/task_queues` |
| `metadata.in_app_frame_mix` | **`system-only`** — *no application frame in the stack* |
| `isUnhandled` | `false` |

Hourly, 2026-08-30 → 2026-09-06 (Discover, `dataset=errors`):

| hour (UTC) | count |  | hour (UTC) | count |
|---|---|---|---|---|
| 08-31 23:00 | 48 | | 09-01 06:00 | 389 |
| 09-01 00:00 | 50 | | 09-01 07:00 | 356 |
| 09-01 01:00 | 48 | | **09-01 08:00** | **384** |
| 09-01 02:00 | 140 | | **09-01 09:00** | **384** |
| 09-01 03:00 | 432 | | **09-01 10:00** | **384** |
| 09-01 04:00 | 400 | | **09-01 11:00** | **384** |
| 09-01 05:00 | 417 | | 09-01 12:00 | **2** ← quota wall |

Daily over the issue's whole life: **zero until 08-26**, then
`08-26: 11 · 08-27: 17 · 08-28: 62 · 08-29: 318 · 08-30: 59 · 08-31: 114 ·
09-01: 3770`, then **zero**.

**Post-quota: nothing.** Ingestion has been open since 2026-09-05 10:00Z and
this issue has recorded nothing. That silence is real — the cause was fixed on
09-01.

### 2. It is SendGrid, not a client

All 10 retrievable events are identical in shape:

```
tags:    environment=production, flow=missed_shift_alert, service=sendgrid,
         handled=yes, mechanism=generic, level=error,
         runtime=node v18.20.5, os=Ubuntu Linux 24.04, server_name=2ad651f64266,
         release=7b238ec7226b6a4e03c30f7e4785b64722f4b3f8
entries: ['exception', 'breadcrumbs']        <-- NO 'request' ENTRY
user:    id=None  ip_address=None  geo={country_code: US}
```

Exception, 2 frames, innermost last:

```
node:internal/process/task_queues:95   process.processTicksAndRejections   in_app=False
node_modules/@sendgrid/client/src/classes/client.js:167                    in_app=False
```

Breadcrumbs, verbatim:

```
2026-09-01T12:00:00.260Z [console] [missed-shift] 8 missed shift(s) detected
2026-09-01T12:00:00.464Z [http]    {"http.method":"POST","status_code":401,"url":"https://api.sendgrid.com/v3/mail/send"}
2026-09-01T12:00:00.485Z [http]    {"http.method":"POST","status_code":401,"url":"https://api.sendgrid.com/v3/mail/send"}
```

Across all 10 events: **250 SendGrid breadcrumbs, 250 of them `401`, zero of any
other status.**

**Everything the dispatch asked me to tabulate does not exist.** There is no
`request.url`, no method, no user agent, no IP, no `tags.role`, no
`tags.endpoint`, no `tags.company_id`, and `user.id` is null — because
`tagRequest()` (`services/sentry.ts:114`) only ever runs inside an
authenticated HTTP request, and this never was one. **The absence is the
finding**, not a gap in the pull.

### 3. The amplifier, in code

**`"Unauthorized"` is thrown and logged nowhere in `apps/api/src`.**
`grep -rn "Unauthorized" apps/api/src --include="*.ts"` returns **two** hits,
both `rejectUnauthorized: false` in `db/pool.ts:5,7` — a Postgres TLS option,
unrelated. The string comes from the SendGrid SDK. **It is not the JWT
middleware and not a revoked-token JTI check.**

The chain, per event:

1. **`apps/api/src/jobs/missedShiftAlert.ts:24`** —
   `runJob('missedShiftAlert', '*/5 * * * *', …)`. Selects
   `status='scheduled' AND scheduled_start + INTERVAL '10 minutes' <= NOW() AND missed_alert_sent_at IS NULL`
   (`:26-29`).
2. **`services/email.ts:57-59`** — `sendToAdmins` sends **one `sgMail.send` per
   recipient** under `Promise.allSettled`.
3. **`services/email.ts:71`** — every rejected recipient calls
   `reportSendgridFailure(flow, err, {…})`, which at **`:28-33`** is
   `Sentry.captureException(err, { tags: { service: 'sendgrid', flow } })`.
   **One Sentry event per recipient per attempt.** ← *this issue*
4. **`services/email.ts:736-739`** — the deliberate part:

   ```ts
   // Throw when every recipient failed so the caller (missedShiftAlert cron
   // OR lateClockInReminder's T+30 rung) skips its own follow-on stamp and
   // the shift stays eligible for the next tick's retry.
   if (succeeded === 0) {
     throw new Error(`sendMissedShiftAlert: all ${failed} recipients failed for shift ${shiftId}`);
   }
   ```

5. **`jobs/missedShiftAlert.ts:40-46`** — catches that throw and calls
   `Sentry.captureException` **again**. ← *issue `7693907832`*

**So `missed_alert_sent_at` is never stamped while SendGrid is down, and the
same shifts are retried every 5 minutes forever.** Correct behaviour for a
transient blip; unbounded for a dead API key. It is self-limiting only per
shift: `autoCompleteShifts` flips `scheduled → missed` at `scheduled_end`, which
is what eventually drops each shift out of the set (`missedShiftAlert.ts:11-16`).

**The arithmetic checks out exactly.** Measuring both issues over the same hours:

| hour (UTC) | `7602645302` per-recipient | `7693907832` per-shift | all `flow=missed_shift_alert` | ratio |
|---|---|---|---|---|
| 09-01 08:00 | 384 | 96 | **480** | **4.00** |
| 09-01 09:00 | 384 | 96 | **480** | **4.00** |
| 09-01 10:00 | 384 | 96 | **480** | **4.00** |
| 09-01 11:00 | 384 | 96 | **480** | **4.00** |
| 09-01 totals | 3770 | 962 | 4732 | 3.92 |

96 per-shift events/hour ÷ 12 ticks/hour = **8 shifts per tick** — exactly the
`[missed-shift] 8 missed shift(s) detected` in the breadcrumb. 384 ÷ 12 ÷ 8 =
**4 recipients per shift**. `8 × (4 + 1) × 12 = 480/hour`.

**Second caller, smaller amplifier.** `lateClockInReminder.ts:183` also calls
`sendMissedShiftAlert` for its T+30 rung, but its catch at `:189-191` is
`console.error` only — no Sentry — so it doubles the *sends* without doubling
the shift-level events.

**Surface.** `reportSendgridFailure` has **8 call sites** in `email.ts` — every
outbound flow, not just this one. (An earlier draft said 10; that was a `grep -c`
of every *mention*, which counts the definition and a comment. Corrected by
grepping actual calls.) Three jobs add their own
`captureException` on top: `missedShiftAlert.ts:42`, `dailyShiftEmail.ts:41`,
`handoffNudge.ts:103`.

### 4. Database — the outage is visible without Sentry

`shifts.missed_alert_sent_at` is stamped **only** when at least one recipient
succeeds, which makes it a clean delivery oracle:

| metric | value |
|---|---|
| last successful send **before** the outage | **`2026-08-25 23:10:01.410Z`** |
| first successful send **after** | **`2026-09-01 17:00:01.593Z`** |
| **outage duration** | **6 days 17 h 50 m** |
| successful sends on 09-01 | 7, at `17:00:01 ×4, 17:05:00, 23:00:01, 23:30:00` |
| latest successful send (health check) | `2026-09-06 03:00:01.791Z` |
| shifts currently in the retry loop | **0** |

Daily stamps: `08-20: 2 · 08-21: 1 · 08-22: 1 · 08-23: 5 · 08-24: 3 · 08-25: 2 ·`
**`08-26 … 08-31: 0 0 0 0 0 0`** `· 09-01: 7 · 09-02: 12 · 09-03: 11 ·
09-04: 13 · 09-05: 14 · 09-06: 14`.

**Six consecutive zero days**, bracketed by normal volume on both sides.

**Railway logs cannot reach 2026-09-01 — proven, not assumed.**

| query | lines |
|---|---|
| `railway logs --since 2026-09-01T11:00:00Z --until 2026-09-01T12:10:00Z` | **0** |
| control: `railway logs --since 30m` | **315** |

The mechanism works and the window is genuinely empty. **Correcting the
dispatch's premise:** the CLI *does* support `--since`/`--until` (verified in
`railway logs --help`), so this is not a missing feature. The reason is
**deployment removal** — `railway deployment list` shows every deployment before
`7e2f6dbd` (2026-09-05 22:20 PT) as `REMOVED`, and the process that served the
burst started `2026-08-30T15:31:42.824Z`. Logs belong to a deployment; the
deployment is gone.

**Every inbound-auth hypothesis is dead on the data.** Counts only:

| table / query | result | reads on |
|---|---|---|
| `login_attempts` rows updated on 09-01 | **1** | credential stuffing |
| `login_attempts` rows updated 08-26 → 09-02 | **2** | " |
| `login_attempts` max `failed_count`, all time | **1** | " |
| `login_attempts` rows ever locked | **0** | " |
| `revoked_tokens` created 09-01 | 13 | revoked-token retry |
| `revoked_tokens` created 08-26 → 09-02 | 47 | " |
| `revoked_tokens` all time | 206 | " |
| `guard_devices` with `last_seen_at` in window | 6 | stale binary |
| …of those, `client` below runtime 1.0.17 | **0** | " |

Two rows of login activity cannot produce 3,770 events.

**GRD0002 `802a842f-da79-44a9-aa0e-f549a9420cef` (STARNET) is not the source.**

```
client = NULL   revoked_at = no   claimed_at = last_seen_at = 2026-09-01 02:03:03.346Z
sessions on 09-01 = 1        sessions ever = 8
```

One claim event and one session. **`OPEN-ITEMS.md` C4's "Build 44" remains
UNVERIFIED** — `client` is still NULL, so the device has still never made a
client-identifying write — and it is **irrelevant to this incident either way**,
because no event here came from a device.

**A near-coincidence, recorded so nobody rediscovers it as a theory:** that
device claimed its token at `02:03:03Z`, three minutes into the 02:00 ramp. It
is not the cause. **12 shifts crossed T+10 between 01:00 and 03:00Z** — the ramp
is the retry set filling with overnight no-shows, and it is fully explained
without the device.

### 5. Customer impact

| tenant | no-show alerts actually lost | daily client reports sent, before → during → after |
|---|---|---|
| **STARNET `27c4d404-…-93cb9b890067`** | **0** (0 no-show shifts in the window) | **91.3% → 57.1% → 72.7%** |
| Star Guard `b7c7d32d-…` (test) | 2 | 65.6% → 50.0% → 81.8% |

**STARNET lost no missed-shift alert**, because it had no no-shows during the
outage — luck, not design. What it did lose is **daily client reports**: 9 of 21
shifts unsent against a 2-of-23 baseline, so roughly **7 reports above baseline
never reached the client**.

**I nearly reported this wrong.** A first pass counted
`missed_alert_sent_at IS NULL` as "email lost" and returned STARNET in the
affected set. That column is NULL for *every shift that was never a no-show* —
the overwhelming majority. Only shifts with `status IN ('scheduled','missed')`
were ever owed an alert, and STARNET has **0** of those in the window. The
daily-report figure is quoted against a before/after baseline for the same
reason: a raw "9 not sent" means nothing without the 2-of-23 it is compared to.

---

## Two sources disagree (record, do not resolve)

| source | events, issue `7602645302` |
|---|---|
| issue endpoint `count` | **4671** (lifetime, since `firstSeen`) |
| Discover `events-stats`, 07-09 → 09-07 | **4351** |
| Discover, 09-01 alone | **3770** |
| per-issue `stats.14d` array | **empty** — 0 buckets, for an issue with `lastSeen` inside the window |

Discover also shows **nothing between 2026-07-09 and 2026-08-25**, though
`firstSeen` is 07-09. The 320-event gap and the missing early window are not
explained here; **every count in this file is Discover's**, because it is the
only source that buckets, and the issue counter is quoted only as `lifetime`.

`stats.14d` returning an empty array is the **third** time this endpoint has
been caught answering wrongly — see the same note in
`2026-09-05-push-skip-null-token.md` and `2026-09-06-sentry-rate-limited.md`.
**Do not use per-issue `stats` for anything.**

---

## Hypotheses, ranked

### (iii) Our own job in a retry loop — **CONFIRMED**

…but **outbound to SendGrid**, not inbound to us, which is not the shape the
dispatch's option (iii) described.

Evidence: `service=sendgrid` and `flow=missed_shift_alert` on every event; the
`@sendgrid/client` stack frame; 250 breadcrumbs all `401` on
`api.sendgrid.com/v3/mail/send`; the 4.00 ratio matching
`(recipients + 1) × shifts × ticks` exactly; six days of zero
`missed_alert_sent_at` bracketed by normal volume; recovery at a single
timestamp with four shifts stamping in the same second.

Trigger: **`EXPIRIES.md` E15 — the SendGrid card is declining.** A suspended
account returns 401 on send. **`SENDGRID_API_KEY` was deliberately not tested**
— testing it transmits the credential, the same reasoning `OPEN-ITEMS.md` N1
applies to the GitHub token. Delivery health was established from the database
instead.

Not fully explained: **why it recovered at 17:00:01Z on 09-01.** Nothing in the
repo or the database records a billing action. Vishnu will know.

### (i) A device with a dead/revoked token retrying — **RULED OUT**

No event has a request, a user, an IP or a route. `login_attempts` shows 2 rows
in the entire window and has never locked an account. GRD0002 `802a842f` has one
claim and one session. **The cadence question is answered and it is not a device
poll:** the interval is `*/5 * * * *`, the job's own cron
(`missedShiftAlert.ts:24`), and 480/h decomposes exactly as
`8 shifts × 5 events × 12 ticks`.

### (ii) Scanner or credential stuffing — **RULED OUT**

Same absence of request context, plus `login_attempts.failed_count` never
exceeding 1 and zero lockouts ever. A scanner leaves inbound traces; there are
none.

---

## Recommendations

### (a) Stop the amplifier — **Tier 1**, size M — *the one that matters*

The bug is that an **expected, correlated, indefinitely-repeating** failure is
reported as an individual `error` event per recipient per attempt. Exactly the
defect class as the 09-05 `push_skip_null_token` incident, one layer out.

In `services/email.ts`, `reportSendgridFailure` (`:28`) should **count** rather
than capture: aggregate per flow per tick, log one line with flow + recipient
count + HTTP status, and `captureException` **only** on a threshold or a
transition (first failure after a success, and every Nth thereafter). Fix it at
`reportSendgridFailure` and all **8** call sites inherit it; add the same at
`missedShiftAlert.ts:42`, `dailyShiftEmail.ts:41`, `handoffNudge.ts:103`.

**Do not change the retry semantics.** Not stamping `missed_alert_sent_at` on
total failure is correct — it is what makes the alert survive a transient
outage. **Changing it would be Tier 2** (guard/customer-facing alert delivery),
and it is not what is broken.

**Separately worth considering, and NOT bundled:** a circuit breaker — after N
consecutive total failures, stop attempting sends for M minutes. That bounds
both the event volume and the wasted API calls. Own dispatch.

### (b) Mobile 401 retry — **NO CHANGE NEEDED. Tier 0 (verification only)**

Checked because the dispatch asked. `apps/mobile/lib/apiClient.ts` already does
the right thing: `:106` `if (res.status === 401 && retry)` → refresh **once**;
on `RefreshRejectedError` (`:110`) it logs out and suppresses further calls,
with the file header stating *"Silently refreshes access token on 401 (single
retry) · Triggers logout on refresh failure"*. **No OTA required.** It is also
moot for this incident — no mobile client was involved.

### (c) Rate-limit 401s at the edge — **ALREADY EXISTS, AND IS IRRELEVANT. Tier 0**

`apps/api/src/index.ts:75-80`:

```js
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // tighter limit for auth endpoints
  …
```

Mounted at `:184` (`app.use('/api/auth', authLimiter, authRoutes)`), IP-keyed
with no `keyGenerator` — the shared-NAT concern already filed as C14/C17.
**It could not have helped here:** this traffic was *egress* to SendGrid. An
inbound limiter cannot throttle our own outbound calls.

### (d) Revoke a device row — **NOT APPLICABLE**

No device is involved. Nothing to revoke. Recorded so it is not re-proposed.

### (e) [VISHNU] Fix the SendGrid card — **Tier 2**, and do it first

`EXPIRIES.md` **E15** is the root cause and its state is **UNVERIFIED —
"failing now"**. Email currently works (last success `2026-09-06 03:00:01Z`), so
either the card was fixed on 09-01 or the account is in a grace period that will
lapse again. **Confirm which.** While there, fill **E3** (SendGrid key rotation
date), still `UNVERIFIED`. If the card is still failing this recurs — and on the
Team plan, at 480 events/hour, it reaches 50,000 in roughly four days with **no
on-demand headroom**, because the 11 cron monitors consume all of it (N27 Rec 1).

### (f) Give the loop an email-delivery signal — **Tier 1**, size S

**Email was dead for 6 days 18 hours and no signal anywhere reported it.** N22
already says the pack has no email-delivery signal; this is the incident that
proves the cost. The oracle is already in the database and needs no new table:

```sql
SELECT MAX(missed_alert_sent_at) FROM shifts;   -- last successful send
```

Add `hours_since_last_successful_email` to the `failures-24h` collector next to
the `sentry-dropped` line added under N27. Above ~26 h with shifts scheduled, it
is a finding. **This and (a) are the pair that would have caught this on day
one** — (a) stops it flooding, (f) makes it visible at all.

---

## Tier

| action | tier | why |
|---|---|---|
| This investigation — Sentry reads, Discover, `claude_readonly` SELECTs, repo greps, `railway logs`, this file | **Tier 0** | `POLICY.md`: read-only prod queries, Railway/Sentry reads, `ops/*` branch work, docs |
| Merging this file to `main` | **Tier 1** | `docs/OPS` update — and every push to `main` restarts the API. Hold the deploy gate; name the route |
| (a) amplifier fix | **Tier 1** | code + merge |
| (b) mobile verification | **Tier 0** | read-only; no change needed |
| (c) `authLimiter` | **Tier 0** | read-only; already exists |
| (f) email-delivery signal | **Tier 1** | code + merge |
| **(e) SendGrid billing** | **Tier 2** | credential/billing on a third-party account; affects every email to the customer's admins and client contacts |
| *(changing the retry/stamp semantics — not recommended)* | **Tier 2** | guard- and customer-facing alert delivery |

---

## Deadline

**~2026-11-30.** The plan's retention is **90 days** (`planDetails.retentionDays: 90`,
read during N27). Every event-level fact in *Evidence §2* — the tags, the
`@sendgrid/client` frame, the 250 `401` breadcrumbs, the
`[missed-shift] 8 missed shift(s) detected` lines — comes from the 10 events
Sentry still holds from 2026-09-01, and **is unreproducible after that date**.

The database evidence has no such expiry: `missed_alert_sent_at` is durable, and
the six-day gap is re-derivable at any time. **If only one class of evidence
survives, the database is the one that matters** — which is the argument for
recommendation (f).

---

## Learning

**Three investigations in a row reduced to the same mechanism: a routine failure
reported per occurrence instead of per rate.** `push_skip_null_token` (09-05)
emitted one Sentry event per skipped push. This emitted one per failed recipient
per retry, forever. In both, the *behaviour* was correct and the *observability
choice* was the defect — and here that choice cost the entire monitoring
platform for 94 hours. `reportSendgridFailure` is called from 10 places, so the
same shape is armed across every email flow the product has.

**The premise was wrong, and the title is why.** "Error: Unauthorized" reads as
an auth failure, so the dispatch asked for routes, IPs, user agents, JWT
middleware and a suspect device — and I wrote that framing into the N28 item
myself, having read the same title. The first event's tags falsified all of it in
about a minute. **The cheapest possible check — open one event and read its
tags — was worth more than every hypothesis built on the title**, and it should
have come before the hypotheses, not after them.

**Two of my own numbers in the N27 file were wrong, both from the same cause.**
I wrote *"4,671 events on 2026-09-01"* — 4,671 is the **lifetime** count since
2026-07-09; 09-01 was 3,770. And *"480 events/hour"* attributed to this issue —
this issue ran at 384/h; 480 was the whole `flow=missed_shift_alert`. The first
is precisely the lifetime-versus-window error whose correction is the entire
*Learning* section of the 09-05 incident, made three weeks later by the person
who wrote it down. **Writing a lesson down does not install it.** The habit that
would have caught it is mechanical: never quote a count without the window
beside it.

**Also wrong: "it has emitted nothing since."** It emitted for five more hours
into a quota that was already closed — roughly 2,400 further events — and the
apparent stop at 12:00:00 was the blackout starting, not the burst ending. The
real end was 17:00:01Z, and only the database could show that. **A signal going
quiet at the same moment your monitoring goes blind is the one case where
silence means nothing at all.**

**The failure was invisible in the one place it should have been loudest.** Not
one admin or client email left the system for six days and eighteen hours. Every
health check stayed green — `/health` runs `SELECT 1`, `/health/crons` proves the
jobs *ran*, and `cron_heartbeats` recorded `last_result='ok'` throughout, because
`missedShiftAlert` **was** working: it found the shifts, called SendGrid, caught
the error and reported it. Every component behaved correctly while the product's
entire outbound communication was down. **A liveness check that asks "did the job
run" cannot answer "did anything arrive."**

---

## Fix

Approved 2026-09-06: **(a)** count instead of capture, **(f)** email liveness in
the brief. **(b)**, **(c)**, **(d)** were verification-only or not applicable and
changed nothing. **(e)** is Vishnu's and is tracked in `EXPIRIES.md` E15.

### (a) `apps/api/src/services/email.ts` — the amplifier

`reportSendgridFailure` no longer calls `Sentry.captureException`. It keeps a
per-process state machine keyed by `flow`:

```ts
const SENDGRID_LOG_INTERVAL_MS = 60 * 1000;         // one console line / min / flow
const SENDGRID_CAPTURE_INTERVAL_MS = 60 * 60 * 1000; // one Sentry event / hour / flow
```

- **console**: at most one line per minute per flow,
  `[sendgrid.fail] flow=<f> count=<n> status=<code>`, where `count` is the number
  of failures suppressed since the last line — nothing is silently lost.
- **Sentry**: `captureMessage('sendgrid_failing')` on the **transition** into
  failure (first failure after a success), then at most **once per hour** while
  still failing. Tags are `service`, `flow`, `status`. `status` comes from
  `err.code ?? err.response.statusCode ?? err.statusCode` — the HTTP number, not
  the message text, because message text gets reworded.
- **Recipient identity never reaches Sentry.** It was previously passed in
  `extra`; the aggregated event carries counts only. The per-recipient
  `console.error` at each call site is untouched, so Railway logs keep the
  detail.

`noteSendgridSuccess(flow)` is new and is wired at **all 8 success points** —
`sendToAdmins`' fulfilled branch (which covers every admin-fan-out flow and
passes `flow` through dynamically), plus `incident_alert`, `daily_shift_report`,
`temp_password`, `welcome_guard`, `welcome_admin_primary`,
`welcome_admin_secondary`, `welcome_client`. Without it the "first failure after
a success" edge cannot exist and a flow that recovered and broke again would stay
silent until the hourly timer came round.

**Deliberately unchanged**, as instructed and as correct: the throw at
`email.ts:736-739`, the `missed_alert_sent_at` stamping semantics, the retry in
`missedShiftAlert.ts`, and every existing `console.error`. Not stamping on total
failure is what makes an alert survive a transient outage. **The retry was never
the bug** — reporting an expected, correlated, indefinitely-repeating condition
as an individual event was.

Under the old code the 09-01 burst emitted **3,770** events on this issue. Under
the new code the same outage emits **1 per flow on the transition + 1 per flow
per hour** — for a 6 d 18 h outage on one flow, **about 163 events instead of
tens of thousands**, and the console keeps a per-minute count throughout.

### (f) `scripts/ops/triage.sh` — email liveness in `c_failures_24h`

New `email liveness` block emitting `hours_since_last_successful_email`
(**`GREATEST`** of `shifts.missed_alert_sent_at` and
`shifts.daily_report_email_sent_at`), the two per-column ages, `shifts_ended_last_26h`,
`of_those_with_active_client`, and a precomputed `ALARM:` line.

Both columns are stamped **only after a send succeeds**, so their age is the age
of the last delivered email — no new table, no new write path.
`daily_report_email_sent_at` was **confirmed to exist** in production
(`information_schema`) rather than assumed, so this is not `UNVERIFIED`.

`GREATEST` of the two, not `missed_alert_sent_at` alone: that column only stamps
on a no-show, so a week without one would false-fire. Proven — the
`30 h missed-alert + 4 h daily-report` case returns **no alarm**.

`.github/ops/triage-prompt.md` gains the P1 BROKE rule
`P1 · no successful email in N h · all tenants · check SendGrid billing/key`,
with an instruction to read `shifts_ended_last_26h` first and say
`UNVERIFIED (no shifts due)` when it is 0.

**The 26 h threshold is shipped unvalidated, and the code says so.** Two gaps
over 26 h since 2026-07-01 — **72.0 h** (07-13 → 07-16) and **51.2 h**
(07-19 → 07-21) — sit outside the known outage, and both had client reports due
(9 and 2 shifts). The "nothing was due" explanation was tested and **falsified**.
So either those were undetected email outages, or `daily_report_email_sent_at`
does not stamp for every eligible shift. Both the collector comment and the
prompt carry the caveat, and **answering it is the collector's first job.**

### Tests

`apps/api/src/services/_sendgridFailure.test.ts`, 7 assertions, ts-node +
`node:assert` like its siblings. Sentry is a Proxy that records **every** method,
so a stray `captureException` fails the test.

| test | asserts |
|---|---|
| 50 consecutive failures | **≤ 1** capture (exactly 1, the transition) |
| success → failure | **exactly 1** capture |
| recipient | not a tag, and the address does not appear **anywhere** in the serialised payload |
| status | tagged `401` from the HTTP code; `unknown` when absent |
| console | exactly one `[sendgrid.fail]` line in <60 s, matching the required format |
| flows | independent — 2 flows, 22 failures, 2 captures |
| old behaviour | `captureException` never called from this path |

Full suite, all green:

```
_run.test.ts             10 passed, 0 failed
_healthCrons.test.ts     36 passed, 0 failed
_pingReminder.test.ts     5 passed, 0 failed
_aiEnhance.test.ts       10 passed, 0 failed
_sendgridFailure.test.ts  7 passed, 0 failed
                        ---------------------
                         68 passed, 0 failed
```

`npx tsc --noEmit` in `apps/api`: **clean**.

The collector SQL was exercised against production read-only across six cases —
healthy, sparse-but-fresh, 25.9 h, 26.1 h, the real 162 h outage, and
never-sent — and returned the correct branch each time, including
`UNVERIFIED` for never-sent.

---

## Verification plan

Nothing below has run yet. Written **before** deploy so it is a test rather than
a rationalisation.

**Deploy gate.** `POLICY.md` — merging to `main` restarts the API. This touches
`services/email.ts`, which every cron uses. Hold the gate and **name the route**
(CONDITION / PROXY / OVERRIDE).

1. **Force one send and watch what Sentry does *not* get.** Trigger a single
   admin email on the **Star Guard test tenant** — never STARNET, whose admins
   are real people. Confirm delivery, then confirm `netraops-api` records
   **zero** new events for that flow. Under the old code a failure would have
   produced one event per recipient.
2. **Force a failure and confirm exactly one capture.** With a deliberately bad
   key on the test path, expect **one** `sendgrid_failing` event tagged
   `flow=<f> status=401`, then **silence for an hour** while failures continue.
   Then confirm `[sendgrid.fail] flow=… count=N status=401` appears in
   `railway logs` at most once a minute, with `count` climbing.
   **This is the assertion that matters** — item 1 only shows the noise is gone;
   this shows a real outage is still reported once.
3. **No recipient in Sentry.** On the event from item 2, confirm the tag list is
   exactly `service`, `flow`, `status` (plus SDK defaults) and that no email
   address appears in the payload.
4. **`hours_since_last_successful_email` drops below 1.** Run
   `scripts/ops/triage.sh` (or `workflow_dispatch` with `dry_run: true`) after
   item 1 and confirm the `failures-24h` section shows `< 1` and
   `ALARM: none`.
5. **The alarm is reachable.** The P1 branch has been proven in SQL but **never
   end-to-end**. Confirm it in the pack the first time a genuine gap appears, or
   by running the collector against a clock-shifted copy. **Until a real
   firing is observed, treat this alarm as armed but unproven** — the same
   caution the ping-reminder incident earned.
6. **Guard-facing behaviour is unchanged.** `missed_alert_sent_at` keeps
   stamping at its normal daily rate (12–14/day since 09-02). A drop here means
   the change touched the retry path and must be reverted.

Item 2 is the one that matters. Items 1 and 4 confirm the noise is gone; item 2
confirms nothing was lost with it.

---

## N28 — CLOSED 2026-09-06

**Resolution.** Root cause identified and outside our code: SendGrid returned
401 on every send because the payment card was declining (`EXPIRIES.md` E15,
**card fixed 2026-09-06 per Vishnu**). The three hypotheses the item was opened
to separate are settled — **(iii), and outbound, not inbound**. Every
inbound-auth candidate is falsified on data, not on argument.

**Answered, each with its evidence above:** what it was (SendGrid 401,
`service=sendgrid` + `flow=missed_shift_alert` + the `@sendgrid/client` frame +
250 `401` breadcrumbs); why it started (card declining, last good send
`2026-08-25 23:10:01Z`); why it stopped (**not** the quota at 12:00 — the burst
ran five more hours invisibly and truly ended at `2026-09-01 17:00:01Z`, the
first successful send); and what amplified it (a designed 5-minute retry × one
capture per recipient).

**Not answered, and deliberately left open rather than guessed:** **why service
recovered at 17:00:01Z on 2026-09-01**, five days before the card was fixed.
Nothing in the repo or the database records a billing action that day. Carried
onto E15, because if it was a retried charge or a grace period it can lapse
again.

**Shipped with the close:** (a) the amplifier fix + 7 tests, (f) email liveness
in `failures-24h` with a P1 BROKE rule, the E15 annotation, and **N22 upgraded
to "migration recommended, no longer optional"**.

**Not closed by this:** N22 itself; E15's console check; and the unvalidated 26 h
threshold above.
