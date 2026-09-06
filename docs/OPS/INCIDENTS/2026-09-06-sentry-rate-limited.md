# 2026-09-06 — Sentry rate_limited (582 / 30 d)

**Status:** **RESOLVED — self-resolved by the 2026-09-05 Team upgrade.** No code
change required. Two follow-ups raised, one of them urgent for an unrelated
reason.
**Severity:** P3 in effect (observability only), but it **blinded Sentry for
94 hours**, and one closed incident was investigated during the blackout.
**Item:** N27. **Branch:** `ops/n27-sentry-ratelimit`, cut from `main` @
`34a32c8ed74bd24aca8ae60ef929a362b990ee50` (`34a32c8`).
**Related:** `2026-09-05-push-skip-null-token.md` — this file answers the
question that one left `UNCONFIRMED`.

All figures below are read-only from the Sentry API with the token in
`~/.sentryclirc`. Zero production writes. No token value appears in this file or
in any command that produced it.

---

## Summary

Between **2026-09-01 12:00Z** and **2026-09-05 10:00Z** Sentry refused **582**
error events across all three projects. The reason is **`error_usage_exceeded`
(526)** plus **`spike_protection` (56)** — an **organisation-level quota
exhaustion**, not a project, key, or client-side limit.

The trigger was a burst on `netraops-api` on 09-01: **4,776 accepted events in
ten hours**, dominated by issue `7602645302` `Error: Unauthorized`. Cumulative
accepted crossed 5,000 during the 11:00Z hour; the first refusal lands in the
12:00Z hour.

**For three entire days — 09-02, 09-03, 09-04 — the organisation accepted zero
error events.** Not "fewer". Zero, on all three projects simultaneously.
Ingestion resumed at **2026-09-05 10:00Z**, when the Team plan's billing period
began.

**Dropping has stopped.** `rate_limited` in the last 24 h is **0** on all three
projects; 30.9 h clean at the time of writing.

**The headline number understates the loss by ~4×.** A further **1,755** events
were discarded *inside the SDKs* with reason `ratelimit_backoff` — the client
backing off after Sentry's 429s. That reason is **zero on every day before
09-01 and zero on every day after 09-05**, so it is entirely a consequence of
this event. **True loss: 582 + 1,755 = 2,337 events.**

Two things the brief assumed, corrected below: the 582 is **not** carried by one
project, and PAYG is **not** $0 — the on-demand budget is **100% consumed**, all
of it by the 11 cron monitor seats that `RUNBOOK-phase4-apply.md` step (g)
already says to delete.

---

## Timeline (UTC)

| time | event |
|---|---|
| 2026-05-16 | org `netraopscom` created (`dateJoined`) |
| 2026-05-30 | trial ends (`lastTrialEnd`) — free-plan billing period anchors to the 30th |
| 2026-08-26 17:10 | issue `7693907832` `sendMissedShiftAlert: all 2 recipients failed…` first seen |
| **2026-08-30 00:00** | free-plan period starts (inferred — see Root cause). Quota counter resets to 0 |
| 2026-09-01 02:00–03:00 | burst begins on `netraops-api`: 210 then 540 events/h |
| 2026-09-01 04:00–07:00 | **spike protection fires** — 10, 10, 23, 13 = **56** events refused, `netraops-api` only. Stops at 08:00 |
| 2026-09-01 08:00–11:00 | flat **480 events/h** accepted, four hours running |
| 2026-09-01 11:55:02 | last event ever recorded on `7693907832` |
| 2026-09-01 **~11:5x** | cumulative accepted crosses **5,000** (5,056 at the end of the 11:00Z hour) |
| 2026-09-01 **12:00** | **quota wall.** 2 more accepted, then `error_usage_exceeded` starts at 63/h. `ratelimit_backoff` jumps to 365/h. Last event ever recorded on `7602645302` (12:00:00.486Z) |
| 2026-09-01 12:00 → 09-05 09:59 | **blackout.** `accepted = 0` org-wide for 94 hours |
| 2026-09-02 / 09-03 / 09-04 | accepted **0 / 0 / 0** on all three projects |
| 2026-09-05 04:06:58 | (other incident) GRD0022 `5ddb92e2` clocks in with no device row |
| 2026-09-05 05:00:01 | (other incident) `pingReminder` begins emitting `push_skip_null_token` — **Sentry refuses every one** |
| 2026-09-05 05:00–09:00 | `netraops-api` `rate_limited` 3, 3, 3, 2, 3 per hour; `accepted` 0 |
| **2026-09-05 10:00** | **ingestion resumes.** `accepted` 9/h, `rate_limited` 0. Team billing period start is `2026-09-05` |
| 2026-09-05 10:00–15:00 | `netraops-api` accepted 9, 9, 12, 9, 9, 9 — the "9/hour" of the 09-05 incident |
| 2026-09-05 16:12:04 | (other incident) deploy `9775a777` — six hours *after* ingestion resumed, unrelated to it |
| 2026-09-06 16:52 | this investigation. **0 rate_limited in the last 24 h** |

---

## Evidence

### A1 — project × outcome, fixed window `2026-08-07T00:00:00Z → 2026-09-07T00:00:00Z`, `category=error`

| project | accepted | filtered | rate_limited | client_discard | total |
|---|---|---|---|---|---|
| netraops-api | 5732 | 0 | **494** | 1739 | 7965 |
| netraops-mobile | 240 | 0 | **44** | 103 | 387 |
| netraops-web | 146 | 96 | **44** | 3 | 289 |
| **TOTAL** | **6118** | **96** | **582** | **1845** | **8641** |

**No single project carries the 582.** It is 494 / 44 / 44 — and all three fell
to `accepted = 0` on the same three days. That simultaneity is the finding: a
per-key or per-project limit cannot do that.

Outcomes `invalid` and `abuse` returned **no groups at all** — zero, not omitted.

**A note on how this table was produced.** The first pass used
`statsPeriod=30d`, and its outcome totals and reason totals disagreed by 14
events (6118 vs 6104 accepted). `statsPeriod` is a *sliding* window and the two
calls ran minutes apart. Both tables here use an explicit `start`/`end`, and
they now reconcile exactly. Same class as the three collector defects in the
09-05 incident: a source that answers confidently and differently each time.

### A1 — rate_limited by day (30-day window)

| day | api | mobile | web | total |
|---|---|---|---|---|
| 2026-08-07 … 2026-08-31 | 0 | 0 | 0 | **0** (25 consecutive days) |
| 2026-09-01 | 337 | 18 | 9 | **364** |
| 2026-09-02 | 41 | 4 | 15 | **60** |
| 2026-09-03 | 45 | 18 | 16 | **79** |
| 2026-09-04 | 47 | 3 | 4 | **54** |
| 2026-09-05 | 24 | 1 | 0 | **25** |
| 2026-09-06 | 0 | 0 | 0 | **0** |
| **TOTAL** | **494** | **44** | **44** | **582** |

### A1 — accepted by day, all three projects, 08-29 onward

| day | api | mobile | web |
|---|---|---|---|
| 2026-08-29 | 398 | 1 | 3 |
| 2026-08-30 | 86 | 30 | 4 |
| 2026-08-31 | 154 | 6 | 2 |
| 2026-09-01 | **4758** | 12 | 6 |
| 2026-09-02 | **0** | **0** | **0** |
| 2026-09-03 | **0** | **0** | **0** |
| 2026-09-04 | **0** | **0** | **0** |
| 2026-09-05 | 63 | 0 | 4 |
| 2026-09-06 | 20 | 1 | 2 |

### A2 — reason breakdown (same fixed window)

Org rollup:

| outcome | reason | count |
|---|---|---|
| accepted | none | 6118 |
| client_discard | **ratelimit_backoff** | **1755** |
| rate_limited | **error_usage_exceeded** | **526** |
| filtered | react-hydration-errors | 96 |
| rate_limited | **spike_protection** | **56** |
| client_discard | event_processor | 49 |
| client_discard | network_error | 41 |

Per project:

| project | outcome | reason | count |
|---|---|---|---|
| netraops-api | accepted | none | 5732 |
| netraops-api | client_discard | ratelimit_backoff | 1739 |
| netraops-api | rate_limited | **error_usage_exceeded** | **438** |
| netraops-api | rate_limited | **spike_protection** | **56** |
| netraops-mobile | accepted | none | 240 |
| netraops-mobile | client_discard | event_processor | 48 |
| netraops-mobile | rate_limited | **error_usage_exceeded** | **44** |
| netraops-mobile | client_discard | network_error | 41 |
| netraops-mobile | client_discard | ratelimit_backoff | 14 |
| netraops-web | accepted | none | 146 |
| netraops-web | filtered | react-hydration-errors | 96 |
| netraops-web | rate_limited | **error_usage_exceeded** | **44** |
| netraops-web | client_discard | ratelimit_backoff | 2 |
| netraops-web | client_discard | event_processor | 1 |

`key_quota`, `project_quota`, `org_quota` and `smart_rate_limit` returned **no
groups** — the only two `rate_limited` reasons in the window are
`error_usage_exceeded` and `spike_protection`.

`spike_protection` is `netraops-api` only, and only in the four hours
**09-01 04:00–07:00Z** (10, 10, 23, 13). It stopped four hours *before* the
quota wall, so it is a separate, earlier, smaller event — the burst detector
doing its job, not the cause of the blackout.

### A2 — `ratelimit_backoff` is entirely a consequence of this incident

`client_discard` by reason, per day, non-zero only:

| day | ratelimit_backoff | network_error | event_processor |
|---|---|---|---|
| 2026-08-17 … 2026-08-24 | **0** | 41 | 24 |
| 2026-08-30 | **0** | 0 | 25 |
| 2026-09-01 | **1626** | 0 | 0 |
| 2026-09-02 | **33** | 0 | 0 |
| 2026-09-03 | **22** | 0 | 0 |
| 2026-09-04 | **64** | 0 | 0 |
| 2026-09-05 | **10** | 0 | 0 |
| **TOTAL** | **1755** | **41** | **49** |

Zero before 09-01, zero after 09-05, 1,755 inside the window. These are events
the SDK never even attempted to send because it was honouring Sentry's
`Retry-After`. **They are lost the same as the 582 and they are not in the
headline number.**

### A2 — the hour the wall hit, and the hour it lifted

Org-wide hourly, `groupBy=reason&groupBy=outcome`:

| hour (UTC) | accepted | rate_limited/error_usage_exceeded | rate_limited/spike_protection | client_discard/ratelimit_backoff |
|---|---|---|---|---|
| 2026-09-01 08:00 | 480 | 0 | 0 | 0 |
| 2026-09-01 09:00 | 480 | 0 | 0 | 0 |
| 2026-09-01 10:00 | 480 | 0 | 0 | 0 |
| 2026-09-01 11:00 | 480 | 0 | 0 | 0 |
| **2026-09-01 12:00** | **2** | **63** | 0 | **365** |
| 2026-09-01 13:00 | 0 | 54 | 0 | 354 |
| … | 0 | 1–10/h | 0 | 0–6/h |
| 2026-09-05 09:00 | 0 | 3 | 0 | 2 |
| **2026-09-05 10:00** | **10** | **0** | **0** | **0** |
| 2026-09-05 11:00 | 9 | 0 | 0 | 0 |

### A3 — every place a limit can live, with its current value

| where | endpoint | value |
|---|---|---|
| **Per-key rate limit, `netraops-api`** | `GET /projects/netraopscom/netraops-api/keys/` | key `3fa5ac06fa3401530c6406777fe65b62` "Default", `isActive: true`, **`rateLimit: null`** |
| **Per-key rate limit, `netraops-mobile`** | same | key `d7e7ccf869ff958cad9251888612526a` "Default", `isActive: true`, **`rateLimit: null`** |
| Per-key rate limit, `netraops-web` | same | key `46c55d084078a90b0892b458fd02d0a9` "Default", `isActive: true`, **`rateLimit: null`** |
| **Spike protection, all 3 projects** | `GET /projects/netraopscom/<slug>/` | `options["quotas:spike-protection-disabled"] = false` → **spike protection ENABLED** (Sentry default) on all three |
| Org-level spike protection | `GET /organizations/netraopscom/` | **not exposed.** `quota` is `null`, `features` is `[]`, no `spikeProtection` key. Re-confirms N11. |
| Inbound filters, `netraops-api` | `GET /projects/.../filters/` | active: `filtered-transaction` only. Inactive: `browser-extensions`, `legacy-browsers`, `localhost`, `web-crawlers` |
| Inbound filters, `netraops-mobile` | same | identical to api |
| Inbound filters, `netraops-web` | same | active: `browser-extensions`, `filtered-transaction`, `web-crawlers`, `legacy-browsers` (all 8 browsers). Inactive: `localhost` |
| Project option filters (all 3) | project `options` | `filters:react-hydration-errors = true`, `filters:chunk-load-error = true`, `filters:blacklisted_ips = ""`, `filters:error_messages = ""`, `filters:releases = ""` |

**Conclusion: no per-key limit exists anywhere.** The only two limits that can
refuse an event on this account are spike protection (per project, on, default)
and the org quota.

### A3 — subscription, `GET /api/0/customers/netraopscom/`

The org endpoint carries no billing data; `/customers/<org>/` does and returns
HTTP 200 with this token.

| field | value |
|---|---|
| `plan` / `planDetails.id` | **`am3_team`** — name "Team", `billingInterval: monthly`, `price: 2900` (¢) |
| `billingPeriodStart` → `billingPeriodEnd` | **`2026-09-05` → `2026-10-04`** |
| `renewalDate` | `2026-10-05` |
| `isFree` | `false` · `onTrialPlan` `false` · `trialEnd` `null` · `lastTrialEnd` **`2026-05-30`** · `dateJoined` `2026-05-16` |
| `categories.errors` | `reserved: 50000`, `prepaid: 50000`, **`usage: 90`**, `usageExceeded: false`, `onDemandSpendUsed: 0` |
| `planDetails.planCategories.errors[0]` | `{events: 50000, unitPrice: 0.058, price: 0, onDemandPrice: 0.0}` |
| `pendingChanges` | **`null`** |

**Team 50 K: CONFIRMED.** `reserved` and `prepaid` are both 50,000, and
`usage: 90` exactly equals the accepted events since the period start
(09-05: 67 + 09-06: 23 = 90). That equality independently confirms the billing
period started 2026-09-05.

**"PAYG $0": FALSE for the current period.**

| field | value |
|---|---|
| `onDemandMaxSpend` | **858** (¢ = **$8.58**) |
| `onDemandSpendUsed` | **858** (¢ = **$8.58**) — **100% consumed** |
| `onDemandBudgets` | `{budgetMode: "shared", sharedMaxBudget: 858, enabled: true, onDemandSpendUsed: 858}` |
| `categories.monitorSeats` | `reserved: 1`, `usage: 12`, `usageExceeded: true`, **`onDemandQuantity: 11`**, **`onDemandSpendUsed: 858`** |
| `planCategories.monitorSeats[0].onDemandPrice` | **78.0** (¢/seat) |
| every other category's `onDemandSpendUsed` | **0** |

**11 seats × $0.78 = $8.58 — exactly the whole on-demand spend.** The
organisation's entire pay-as-you-go budget is being consumed by the **11 Sentry
cron monitors** that `STATE.md` and `RUNBOOK-phase4-apply.md` step (g) already
say to delete because they have been alarming falsely since Phase 4 stopped
sending check-ins.

`onDemandSpendUsed == onDemandMaxSpend`, so **there is currently $0 of on-demand
headroom for an error overage.** If errors exceed 50,000 in this period they are
refused immediately, exactly as on 09-01. **UNVERIFIED: whether `858` is a
ceiling Vishnu set or one Sentry raised automatically to cover the seats.** The
API does not say, and the distinction matters — a user-set ceiling is a hard
wall, an auto-raised one is not. Console check.

### A4 — client-side SDK options (`sampleRate`, `tracesSampleRate`, `beforeSend`, `maxBreadcrumbs`, custom drops)

| app | file:line | option | value |
|---|---|---|---|
| api | `apps/api/src/services/sentry.ts:70` | `sampleRate` | **`1.0`** |
| api | `apps/api/src/services/sentry.ts:71` | `tracesSampleRate` | `0.05` |
| api | `apps/api/src/services/sentry.ts:76` | `beforeSend` | scrub only — **always `return event`** (`:96`), never `null` |
| api | `apps/api/src/services/sentry.ts:98` | `beforeBreadcrumb` | scrub only — always returns the crumb |
| api | `apps/api/src/services/sentry.ts:66` | activation | gated on `process.env.SENTRY_DSN` |
| mobile | `apps/mobile/lib/sentry.ts:69` | `sampleRate` | **`1.0`** |
| mobile | `apps/mobile/lib/sentry.ts:70` | `tracesSampleRate` | `0.05` |
| mobile | `apps/mobile/lib/sentry.ts:72` | `beforeSend` | scrub only — **always `return event`** (`:89`) |
| mobile | `apps/mobile/lib/sentry.ts:91` | `beforeBreadcrumb` | scrub only |
| web | `apps/web/sentry.shared.ts:172-182` | `sharedOptions` | **no `sampleRate` key at all** — SDK default 1.0 applies |
| web | `apps/web/sentry.shared.ts:175` + `:39` | `tracesSampleRate` | `TRACES_SAMPLE_RATE = 0.05` |
| web | `apps/web/sentry.shared.ts:178` + `:67-93` | `ignoreErrors` | 20 entries (ResizeObserver, extensions, `Script error.`) |
| web | `apps/web/sentry.shared.ts:179` + `:95-114` | `denyUrls` | 13 regexes (adsense, facebook, `chrome-extension://`, …) |
| web | `apps/web/sentry.shared.ts:124` | `beforeSend` | **the only `return null` in any of the three** — `:128-130`, drops events whose top stack frame is an extension URL |
| all three | — | `maxBreadcrumbs` | **set nowhere.** `grep -rn maxBreadcrumbs apps` (excl. `node_modules`, `.next`, `ios`, `android`) → 0 matches. SDK default 100 applies |

**No client-side option can produce a `rate_limited` outcome.** `sampleRate`,
`beforeSend → null`, `ignoreErrors` and `denyUrls` all suppress an event *before*
it is sent — those surface as `client_discard/event_processor` (49 in the
window), never as `rate_limited`. `rate_limited` is only ever emitted by Sentry's
own ingestion.

**And none of it changed.** Last commit touching each config:

- `apps/api/src/services/sentry.ts` → `e0516b6`, **2026-05-15**
- `apps/mobile/lib/sentry.ts` → `7f64a1f`, **2026-05-15**
- `apps/web/sentry.shared.ts` → `2240352`, **2026-08-04**

**Ref read for mobile:** `git show c932c09:apps/mobile/lib/sentry.ts` —
`c932c09` is the commit behind iOS Build 48 / Android Build 24, the shipped
binaries. It is **byte-identical** to the working tree (`diff` clean), and
`sampleRate: 1.0` is at `:69` there too. So the working tree is authoritative
for mobile in this case, and that was verified rather than assumed.

### A5 — correlation with the `push_skip_null_token` incident

`netraops-api` only, 2026-09-05 hourly:

| hour (UTC) | rate_limited | accepted | client_discard |
|---|---|---|---|
| 00:00 | 1 | 0 | 0 |
| 01:00 | 2 | 0 | 2 |
| 02:00 | 7 | 0 | 5 |
| 05:00 | **3** | **0** | 0 |
| 06:00 | **3** | **0** | 0 |
| 07:00 | **3** | **0** | 0 |
| 08:00 | **2** | **0** | 1 |
| 09:00 | **3** | **0** | 2 |
| **10:00** | **0** | **9** | 0 |
| 11:00 | 0 | 9 | 0 |
| 12:00 | 0 | 12 | 0 |
| 13:00 | 0 | 9 | 0 |
| 14:00 | 0 | 9 | 0 |
| 15:00 | 0 | 9 | 0 |
| 16:00 | 0 | 6 | 0 |

The 09-05 incident recorded: *"2026-09-05 10:00:01 | Sentry begins recording;
**9/hour** from here"*, and separately observed that `pingReminder` had
demonstrably been firing since 05:00:01Z (22 `ping_reminder` notification rows
for session `53d85e33` starting then) while **Sentry showed zero events**. It
concluded: *"Plausibly client- or server-side rate limiting or a quota drop; it
cannot be checked with this token."*

**It can be checked, and it was the quota.** `netraops-api` accepted **zero**
events from 09-01 12:00Z to 09-05 09:59Z while refusing 2–3/hour as
`error_usage_exceeded`; at 10:00Z acceptance resumes at exactly the 9/hour the
incident documented. **The "10:00" in that timeline is the quota lifting, not
the onset of anything.** The emitter had been running for five hours.

Note the 05:00–07:00 refusals are **3/hour** — one guard on shift × (ping leg at
`:00` + hourly leg at `:00` + ping leg at `:30`) = 3, exactly the shape that
file derived. At 09:00, with a second guard on shift, 6 would be expected and 3
were refused; the gap is the SDK's own `ratelimit_backoff` discarding the rest
before transmission. **Refused counts are a floor on emission, which is what
that incident said and is now the confirmed mechanism rather than a hypothesis.**

**The 09-05 10:00–16:00Z bursts did not cause the rate limiting.** They fall
entirely *after* it ended. Causality runs the other way.

### A5 — what filled the quota

`GET /projects/netraopscom/netraops-api/issues/` over 2026-09-01:

| issue | shortId | level | lifetime count | firstSeen | lastSeen |
|---|---|---|---|---|---|
| `7602645302` | NETRAOPS-API-4 | error | **4671** | 2026-07-09T21:15:01.068Z | **2026-09-01T12:00:00.486Z** |
| `7693907832` | NETRAOPS-API-E | error | **1109** | 2026-08-26T17:10:00.427Z | **2026-09-01T11:55:02.240Z** |
| `7633312535` | NETRAOPS-API-6 | warning | 327 | 2026-07-25T23:30:00.771Z | 2026-09-06T02:45:00.422Z |

Titles: `Error: Unauthorized` and
`Error: sendMissedShiftAlert: all 2 recipients failed for shift 3c8efaf`.

Both `lastSeen` values sit **at the quota wall** (11:55 and 12:00). Both are
still `status: unresolved`. Neither has been accepted since — and ingestion has
been open since 09-05 10:00Z, so they are genuinely quiet now, not merely
invisible.

**A source that answers wrongly, again:** `GET /issues/7602645302/?statsPeriod=14d`
returns a `stats.14d` array that is **all zeros**, for an issue with
`count: 4671` and a `lastSeen` five days ago and inside the window. Same class
as the listing-vs-per-issue disagreement recorded in the 09-05 incident.
**Issue-level bucket data was not used anywhere in this file; every number here
comes from `stats_v2` outcomes.**

### A6 — has dropping stopped?

| window | api | mobile | web | org total |
|---|---|---|---|---|
| **last 24 h** (`2026-09-05T16:00Z → 2026-09-06T17:00Z`) | **0** | **0** | **0** | **0** |
| last 7 d (`2026-08-30T16:00Z → 2026-09-06T17:00Z`) | 494 | 44 | 44 | **582** |

Accepted in the last 24 h: api 26, mobile 1, web 5 — ingestion is live, so the
zero is "nothing was refused", not "nothing was sent". The last hour bucket
carrying any refusal is **2026-09-05 09:00Z**; **30.9 hours clean** at
2026-09-06 16:52Z.

The 7-day figure equalling the 30-day figure is the other half of the proof:
**every one of the 582 falls inside 09-01 → 09-05.**

---

## Root cause

**Falsifiable claim.** The organisation was on a free (Developer) plan with a
**5,000 error/month** quota whose billing period began **2026-08-30**
(`lastTrialEnd` 2026-05-30, monthly, anchored to the 30th). A burst on
`netraops-api` on 09-01 consumed the entire month's quota in ten hours. From the
moment the counter crossed 5,000, Sentry refused every error event from every
project with `error_usage_exceeded`. The Team upgrade on **2026-09-05** opened a
new billing period with 50,000 reserved errors, and ingestion resumed at 10:00Z.

**The arithmetic**, cumulative accepted from 2026-08-30T00:00Z:

| hour (UTC) | accepted | cumulative |
|---|---|---|
| 2026-08-30 (all day) | 120 | 120 |
| 2026-08-31 (all day) | 162 | 282 |
| 2026-09-01 03:00 | 540 | 1168 |
| 2026-09-01 07:00 | 446 | 3136 |
| 2026-09-01 08:00 | 480 | 3616 |
| 2026-09-01 09:00 | 480 | 4096 |
| 2026-09-01 10:00 | 480 | 4576 |
| 2026-09-01 11:00 | 480 | **5056** |
| **2026-09-01 12:00** | **2** | **5058** ← first `error_usage_exceeded` |

The counter crosses 5,000 inside the 11:00Z hour and the wall lands in the next
one. **A 5,000-event quota fits to within the resolution of the data.**

**The period start is INFERRED, not read.** The Sentry API exposes only the
*current* subscription; the pre-09-05 plan and its period boundaries are not
retrievable. Two independent facts support 2026-08-30: `lastTrialEnd` is
2026-05-30 (monthly anchor = the 30th), and no other candidate start yields a
round quota — from 2026-08-16 the sum is 5,961, from 2026-08-05 it is 6,042.
**Test that would falsify it:** the Sentry billing history page showing a period
boundary other than 08-30, or a prior plan with a quota other than 5,000.

**Verdict: hypothesis (i), self-resolving, with one qualification.**

**Ruled out, and how:**

- **(ii) per-key rate limit.** `rateLimit` is **`null`** on all three DSN keys.
  A per-key limit also cannot explain three projects going to zero on the same
  three days, and it reports as `key_quota`, which returned **no groups**.
- **(ii) spike protection.** Enabled on all three projects (default), and it
  *did* fire — but **56 events, `netraops-api` only, in four hours on 09-01,
  ending at 08:00Z, four hours before the blackout began**. It accounts for 9.6%
  of the 582 and 0% of the 94-hour outage. It behaved correctly: it throttled a
  genuine burst. **No change recommended.**
- **(ii) inbound filters.** Filters produce the `filtered` outcome, never
  `rate_limited`. The only filtered events in the window are 96
  `react-hydration-errors` on `netraops-web`.
- **(iii) client-side sampling or drop logic.** `sampleRate` is `1.0` on api and
  mobile and unset (default 1.0) on web; no `beforeSend` on api or mobile can
  return `null`; `maxBreadcrumbs` is set nowhere. None of these can produce a
  `rate_limited` outcome in the first place — they suppress before send. And no
  Sentry config file has been touched since 2026-08-04, four weeks before the
  drops; mobile's is byte-identical at the shipped build `c932c09`.
- **(iii) the `push_skip_null_token` bursts as cause.** They are **after** the
  window. The 09-05 10:00–16:00Z events are the first thing Sentry accepted once
  the quota lifted.

**What remains true and is not self-resolving:** the on-demand budget is fully
consumed by 11 cron monitor seats, so the 50,000 reserved errors are a hard wall
with no PAYG cushion behind them.

---

## Fix sha

**`no code change`** — and that is correct. The mechanism was an account-level
quota; nothing in `apps/api`, `apps/mobile` or `apps/web` contributed to it or
could have prevented it. The only artefact of Phase A is this file.

The condition ended on **2026-09-05** with the Team upgrade — a billing action,
not a deploy. Deployment `9775a777-9523-4b58-91c0-9e49edd6b21e` at 16:12:04Z
that day belongs to the *other* incident and post-dates the recovery by six
hours; **do not read it as the fix for this one.**

---

## Verification

The claim being verified is "dropping has stopped", and the window is chosen from
the mechanism: the quota resets at the billing-period boundary, so the only
window that can answer it is one entirely after **2026-09-05 10:00Z**, when
ingestion resumed.

1. **`rate_limited` in the last 24 h = 0**, on each project separately —
   `2026-09-05T16:00Z → 2026-09-06T17:00Z`, api 0 / mobile 0 / web 0.
2. **The zero is not an empty pipe.** Same window, `accepted` = api 26, mobile 1,
   web 5. Events are flowing and none are being refused. Without this control the
   zero would be indistinguishable from a broken query.
3. **The quota has headroom.** `categories.errors`: `usage: 90` against
   `reserved: 50000`, `usageExceeded: false`. The 90 equals accepted since the
   period start (67 + 23) exactly, which cross-checks the period boundary from a
   second source.
4. **`ratelimit_backoff` is also zero** on 09-06 — the SDKs are no longer
   backing off, which is the client-side half of the same signal.
5. **Last refusal:** hour bucket `2026-09-05 09:00Z`. 30.9 h clean at
   2026-09-06 16:52Z.

**Not verified, deliberately:** whether the account survives the *next* burst.
It will not, on the current on-demand budget — see Recommendation 1. Nothing
observed here proves recurrence is prevented, only that the present condition
has cleared.

---

## Recommendation

**No Phase B code change for the rate limiting itself.** Hypothesis (i) holds;
per the dispatch that means document as resolved-by-upgrade, add the dropped-event
line to the collector, and close N27. Four items, sized and tiered:

**1. [VISHNU] Delete the 11 Sentry cron monitors. — Tier 2, size S, do first.**
They now have three independent reasons to go: they alarm falsely (9 `Cron failure:`
issues on 2026-09-05 while every job was healthy — `STATE.md`), they cost
**$8.58/month**, and they consume **100% of the organisation's on-demand budget**,
leaving zero headroom for an error overage against the 50,000 reserved. This is
`RUNBOOK-phase4-apply.md` step (g), already written, and it is the single action
that most reduces the chance of a repeat. Sentry console work on Vishnu's
account = Tier 2. **While there, read the on-demand budget setting** and record
whether `$8.58` is a ceiling that was set or one Sentry raised — the API cannot
distinguish them and the difference decides whether an error overage is refused
or billed.

**2. Add a dropped-event count to the failures-24h collector. — Tier 1, size S.**
One `stats_v2` call:
`/organizations/netraopscom/stats_v2/?field=sum(quantity)&statsPeriod=24h&groupBy=outcome&groupBy=reason&category=error`,
emitting `rate_limited` **split by reason** and `client_discard/ratelimit_backoff`
as separate columns. Surface in the AHEAD line. Three requirements learned here:
use an explicit `start`/`end` rather than `statsPeriod` (the sliding window made
two of my own tables disagree by 14 events); carry the **reason**, because
`spike_protection` and `error_usage_exceeded` need different responses; and count
`ratelimit_backoff` too, or the brief will under-report loss by ~4× exactly as
the 582 headline did. **This is the only thing here that would have caught the
09-01 blackout on day one** — nothing in the loop reads ingestion outcomes today,
which is why three days of total blindness passed unremarked.

**3. Correct the 09-05 incident. — Tier 1, size S.** Two statements in
`2026-09-05-push-skip-null-token.md` are now answerable and one is misleading:
its *"Why is UNCONFIRMED"* under "Sentry undercounts the emission" has an answer
(org quota, `error_usage_exceeded`, 09-01 12:00Z → 09-05 10:00Z), and its
timeline row *"10:00:01 Sentry begins recording"* reads as an onset when it is
the quota lifting. Append a cross-reference rather than rewriting a closed file.

**4. Raise `Error: Unauthorized` (`7602645302`) as its own item. — Tier 0 to
investigate.** 4,671 lifetime events, 5 users, still `unresolved`, and it burned
a month's quota in ten hours at a sustained 480/h. It is quiet now, and nobody
knows why it started or why it stopped. On the Team plan the same burst reaches
50,000 in roughly four days with **no on-demand cushion behind it**.

**Item numbering — do not allocate on this branch.** `main` @ `34a32c8` ends at
**N21**; N22–N25 exist only on `ops/n23-enhancement` (PR #9) and N26 only on
`ops/phase-4-5-digest`. Writing N27/N28 into `OPEN-ITEMS.md` from a branch cut
from `main` would collide on merge, the same trap the "Merge-order note
(2026-09-06)" already records. `OPEN-ITEMS.md` is therefore **untouched here**;
add these after PR #9 and the Phase 4.5 branch land, and this file is the
evidence they cite.

---

## Tier

| action | tier | why |
|---|---|---|
| Phase A: Sentry API reads, repo greps, this file, commit on `ops/*` | **Tier 0** | `POLICY.md` — "Railway/Sentry reads", "branch work on `ops/*`", "docs" |
| Merging this file to `main` | **Tier 1** | "updates to `docs/OPS` state files" — and every push to `main` restarts the API, whatever the diff touches. Hold the deploy gate and name the route |
| Rec 2 — collector change | **Tier 1** | code + merge to main |
| Rec 3 — incident cross-reference | **Tier 1** | `docs/OPS` update |
| Rec 4 — investigating `7602645302` | **Tier 0** | read-only |
| **Rec 1 — deleting the 11 cron monitors / reading the on-demand budget** | **Tier 2** | Sentry console on Vishnu's account. Changes a live third-party service's configuration and its billing |

Phase A performed **zero production writes** and **zero Sentry writes** — every
call was a `GET`. The auth token was read from `~/.sentryclirc` inside a helper
script and never appeared in a command line, an output, or this file.

---

## Learning

**The observability system had no observability.** For 94 hours Sentry accepted
nothing, and the ops loop — heartbeats, `/health/crons`, the daily triage pack,
the Slack brief — reported healthy throughout, because every one of those
watches whether *jobs run*, and none watches whether *events land*. The
`sentry-netraops-api` collector reads the issues list, which during a blackout
returns the same stale issues as ever, with no field saying "and 526 more were
refused". A collector that reads only what arrived cannot see what didn't. That
is Recommendation 2, and it is the whole finding.

**The blackout silently corrupted a concurrent investigation.** The 09-05
incident was worked *inside* this window. It noticed the symptom — "at least ~15
emissions in 04:00–09:59 are absent from Sentry" — reasoned correctly that the
count was a floor rather than a measure, and marked the cause `UNCONFIRMED`
because the token could not reach `/api-tokens/`. It was right to stop there,
and the answer was two `stats_v2` calls away in an endpoint nobody had thought
to try. **The lesson is not "check harder" but "when a signal is missing, ask
the transport whether it was refused, not only the emitter whether it fired."**

**The headline number was the smallest of three.** The brief said 582. The
server refused 582; the SDKs discarded a further 1,755 backing off from the
resulting 429s; and the true emission was higher still, since backoff drops
happen before any counter. `ratelimit_backoff` is zero on every day outside the
window, so attribution is unambiguous — but it sits under `client_discard`,
which reads like client-side noise and had been ignored as such. **A drop
accounted to the client can still be the server's fault.**

**Two briefed premises were false, in opposite directions.** "Which project
carries the 582" presupposed one project; it is three, and the simultaneity
across all three is what identified the org-level cause within minutes. "PAYG $0"
described a budget that is fully spent. Neither error was careless — both are
what the console shows at a glance — and both would have survived unchallenged
if the answers had been assembled from the questions rather than from the API.
Same shape as the client-ping-ratio brief, where the stated symptom was the
opposite of the measured one.

**A sliding window made my own two tables disagree by 14 events.** `statsPeriod=30d`
is evaluated at call time, so an outcome table and a reason table taken minutes
apart do not reconcile. Every table here uses an explicit `start`/`end`, and the
discrepancy is recorded rather than quietly fixed, because the next person will
reach for `statsPeriod` first. Along with `/issues/<id>/?statsPeriod=14d`
returning an all-zero bucket array for an issue with 4,671 events, that is two
more instances of the failure class this loop keeps finding: **a source that
answers confidently and wrongly.** The defence that worked, again, was measuring
the same quantity from two places and refusing to write until they agreed.
