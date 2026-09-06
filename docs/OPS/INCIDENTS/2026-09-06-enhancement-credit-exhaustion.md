# 2026-09-06 — report enhancement: Anthropic credit exhaustion leaked to a guard

**Status:** investigated, unfixed. Awaiting a decision.
**Severity:** **P2** — customer-visible, on the paying tenant, but non-blocking.
**Surface:** `POST /api/ai/enhance-description` → mobile `reports/new.tsx`.

---

## Summary

A guard tapped **Enhance** and got a modal dialog containing Anthropic's raw
billing error — `400 invalid_request_error ... "Your credit balance is too low
to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase
credits."` — verbatim, on their phone, mid-shift.

Two independent defects compose into that:

1. **`routes/ai.ts:160` returns the upstream vendor's error message verbatim**
   in the client-facing `error` field. The mobile error layer is contractually
   entitled to display anything the server puts there, so it did.
2. **The API side captures nothing to Sentry on this path** — only
   `console.error`. Nine failures produced zero Sentry events.

**Submit was NOT blocked.** Verified in code and in the data: the guard's text
survives, `submit()` has no dependency on the enhancement outcome, and a report
was written 51 seconds after the last failure. The dialog is modal, so it must
be dismissed — an interruption, not a block.

**Two claims in the brief are not supported by the evidence** and are corrected
below: the failure window, and the security concern about the mobile binary.

---

## Timeline (UTC)

| time | event |
|---|---|
| — | credit pool drained by the shared org balance. **Start time UNVERIFIED** — see Evidence |
| 08:31:02 | earliest Railway log line available (5000-line window) |
| 08:31–15:06 | **6h35m with zero enhancement calls of any kind** — nobody tried |
| **15:02:38** | GRD0005 `4a71d17d` (STARNET) clocks in |
| **15:04:37** | GRD0008 `6b1402ba` (STARNET) clocks in |
| 15:05:23 | GRD0008 submits report `ecb3560a`, description 57 chars |
| **15:06:55.006** | **first** `[AI enhance-description] Error` — BadRequestError 400 |
| 15:06:55 → 15:09:31 | **9 failures, 9 distinct `request_id`s, 0 successes** |
| **15:09:31.158** | last failure |
| **15:10:22.638** | GRD0005 submits report `8cfe2ebe`, description 60 chars — **51 s after the last failure** |
| 15:25:02 | end of log window; no further attempts, no successes |
| — | funds restored. **Time UNVERIFIED** — not observable from here |

---

## Evidence

### A1 — every Anthropic call in the codebase

`grep -rn "api\.anthropic\.com\|ANTHROPIC_API_KEY\|@anthropic-ai" apps/`,
excluding `node_modules`, `.next`, `dist`, `ios`, `android`:

| file:line | app | feature | model | key |
|---|---|---|---|---|
| `apps/api/package.json:19` | api | — | — | declares `@anthropic-ai/sdk ^0.90.0` |
| `apps/api/src/routes/ai.ts:6` | api | import | — | — |
| `apps/api/src/routes/ai.ts:10` | api | client init | — | `process.env.ANTHROPIC_API_KEY` |
| `apps/api/src/routes/ai.ts:24` | api | `POST /api/ai/enhance-description` | `ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929'` | as above |

**That is the complete list. There are no others.**

**The mobile app does NOT call Anthropic directly — the security concern in the
brief does not apply.** `apps/mobile/package.json` and `apps/web/package.json`
both declare **zero** `@anthropic-ai` dependencies, and no source file in either
references `api.anthropic.com` or `ANTHROPIC_API_KEY`. Mobile calls
`POST /ai/enhance-description` on our own API (`reports/new.tsx:132-135`). The
key is server-side only, exactly as `ai.ts:2-3` claims: *"the API key never
leaves the server."* **No key is in the binary. Nothing to flag.**

Key location: Railway → service `guard` → env var **`ANTHROPIC_API_KEY`**. The
triage runner uses a GitHub Actions secret of the **same name** — different
store, but per the brief the **same org credit pool**, which is the root of the
budget-isolation half of this work.

### A2 — what happens on non-2xx today

**The error is surfaced verbatim.** `apps/api/src/routes/ai.ts:158-161`:

```ts
} catch (err: any) {
  console.error('[AI enhance-description] Error:', err);
  res.status(500).json({ error: err?.message ?? 'AI enhancement failed' });
}
```

The Anthropic SDK sets `err.message` on a `BadRequestError` to the full upstream
body — the Railway log shows `BadRequestError: 400 {"type":"error","error":
{"type":"invalid_request_error","message":"Your credit balance is too low..."}}`,
which is `${err.name}: ${err.message}`. So `err.message` **is** that JSON string,
and it goes straight into the response `error` field.

The chain to the guard's screen, end to end:

1. `ai.ts:160` → `{ error: '400 {"type":"error",...credit balance...}' }`, HTTP 500
2. `apiClient.ts:129` → `throw new ApiError(res.status, body)`
3. `errors.ts:65-68` → `message = body.message || body.error || ...` — picks up
   the vendor string
4. `errorCopy.ts:53` → `if (err instanceof ApiError) return err.message;`
5. `reports/new.tsx:150` → `Alert.alert('Enhancement Failed', <that string>)`

**Step 4 is not the bug.** `guardMessage` treats the server's `error` field as
**server-authored, guard-facing copy** — that is its documented contract. The
defect is `ai.ts` putting an *upstream vendor's* message into a field the client
is entitled to render.

**Submit is not blocked.** `submit()` (`reports/new.tsx:170`) gates on:
non-empty description, photo requirement, uploads finished, active session. It
never reads `enhanced`, `enhancing`, or any enhancement state. The submit button
is `disabled={submitting}` (`:460`), not `disabled={enhancing}` — and `enhancing`
is cleared in a `finally` (`:152`). `setOriginalDesc(description)` runs *before*
the request and the catch never clears `description`, so the guard's text
survives intact.

**There is no timeout.** `ai.ts:10` constructs the client with no `timeout` and
no `maxRetries`; no per-request override either. The SDK default is
**10 minutes** (`@anthropic-ai/sdk/client.d.ts:127`), and its own docs warn
*"request timeouts are retried by default, so in a worst-case scenario you may
wait much longer than this timeout."* Layered under the route's own 3-attempt
529 loop (`ai.ts:127-151`), a hung upstream can hold the guard's spinner for a
very long time. Not what happened here — a 400 returns instantly — but a live
latent defect on the same path.

**There is no Sentry capture on the API side.** `ai.ts:159` is `console.error`
only. This is the whole of the API's error observability for the path.

### A3 — Sentry was blind, and only half for the reason expected

Issues with events in the last 24 h:

| project | issues | any enhancement failure? |
|---|---|---|
| `netraops-mobile` | 1 — `NETRAOPS-MOBILE-9` `startBackgroundLocation` (info, n=112) | **no** |
| `netraops-api` | 3 — `NETRAOPS-API-2` CORS (n=9), `NETRAOPS-API-6` `push_skip_null_token` (n=327), `NETRAOPS-API-C` `retention_run_summary` (n=29) | **no** |

**API side: blind by construction.** No `Sentry.captureMessage` or
`captureException` anywhere in `ai.ts`. Nine failures, zero events. Expected.

**Mobile side: the code IS there and it still produced nothing.**
`reports/new.tsx:149` calls
`Sentry.captureException(err, { extra: { where: 'reports.new.handleEnhance' } })`.
I checked the **shipped** ref rather than the working tree, per the standing rule
that the working tree is not authoritative for mobile:

```
git show c932c09:apps/mobile/app/reports/new.tsx  ->  line 149, captureException present
git diff c932c09 HEAD -- apps/mobile/app/reports/new.tsx  ->  identical
```

`c932c09` is production Build 48 / v1.0.17. **So the capture is live in the
shipped binary and fired zero events.** Why is **UNCONFIRMED**. Candidates, none
verifiable read-only: the affected device is on an older runtime (two STARNET
devices are known to be on runtime 1.0.16, not 1.0.17 — see `OPEN-ITEMS.md` N7);
the event was queued but not flushed before the app backgrounded; or client-side
sampling. Worth resolving separately — a mobile capture that silently does not
arrive undermines every mobile finding, not just this one.

### A4 — usage counts

**Enhancement calls have no durable trace.** There is no table, no column, no
audit row — the only record is `console.log('[ai.enhance.success] ...')` at
`ai.ts:136-139` and the `console.error` at `:159`, both ephemeral in Railway's
log buffer. **Seven-day usage is therefore UNVERIFIED and unrecoverable.**

What the available 5000-line window (**08:31:02 → 15:25:02Z, 6h54m**) shows:

```
enhance FAILURES : 9   (15:06:55.006 -> 15:09:31.158, 9 distinct request_ids)
enhance SUCCESSES: 0
```

Nine distinct `request_id`s with no 529s means **nine separate user taps** — the
route's retry loop only re-fires on 529, and a 400 throws immediately.

*Reports* per tenant over 7 days — a proxy for who would use enhancement, not a
measure of it:

| company_id | reports 7d | distinct guards | last report |
|---|---|---|---|
| `27c4d404-…` **STARNET** | **95** | 5 | 2026-09-06T15:10:22Z |
| `b7c7d32d-…` Star Guard (test) | 51 | 14 | 2026-09-06T15:23:22Z |

**The paying customer is the heavier report user**, by volume and by reports per
guard (19 vs 3.6). This is not a test-tenant-only feature.

### A5 — blast radius

**11 sessions were open during the 2m36s burst** — 2 STARNET, 9 test tenant.
**Attribution from logs is impossible**: the error line at `ai.ts:159` logs no
actor, while the success line at `:137` logs `guard=` and `company=`. The failure
path is the one that cannot be attributed, which is exactly backwards.

Narrowing on evidence rather than assumption: the Enhance button requires
**≥10 words** (`MIN_ENHANCE_WORDS = 10`, `reports/new.tsx:46`, counted by
whitespace at `:47-49`), and the API independently rejects text under 10
characters (`ai.ts:82`). Descriptions written in the window:

| badge | company | desc chars | could have tapped Enhance? |
|---|---|---|---|
| GRD0008 `6b1402ba` | **STARNET** | 57 | **plausible** — at the threshold |
| GRD0005 `4a71d17d` | **STARNET** | 60 | **plausible** — at the threshold |
| GRD0013/26/10/12/17/22/16/24/11 | test | 4–26 | **no** — 26 chars cannot be 10 words; button disabled |

**So the affected guard is one of two STARNET guards, not one of eleven.** The
strongest single candidate is **GRD0005 `4a71d17d`**, session
`50ed1a75-a2ea-43a2-932a-6d066019b475`: clocked in 15:02:38, the burst runs
15:06:55–15:09:31, and report `8cfe2ebe` lands **51 seconds later** at 15:10:22
with a 60-character description. That is the signature of tapping Enhance
repeatedly, dismissing the dialog each time, and submitting the original text.

**This is not proof.** GRD0008 was equally on shift with an equally long report.
Marked as the leading candidate, not the confirmed subject.

**Frozen entities: not involved.** `FREEZES.md` F1 is `e8274964` (GRD0002, Star
Guard); not among the eleven.

**Customer-visible effect: yes, on the paying tenant.** A STARNET guard saw a
vendor billing message on their phone during a shift. No data was lost, no report
was blocked, and no reminder or enforcement path was touched.

### The brief's timeline is not supported

The brief gives the window as "approx 2026-09-06 03:50Z → funds restored".
**6h54m of logs covering 08:31:02 → 15:25:02 contain no enhancement call of any
kind before 15:06:55.** The credit pool may well have been empty from 03:50Z —
I cannot see logs that far back and do not contradict it — but **no guard hit the
failure until 15:06:55Z**, because nobody invoked the feature. The
customer-facing window is **2 minutes 36 seconds**, not eleven hours.

The distinction matters for severity: this was one guard, one burst, one shift —
not a day-long outage.

---

## Root cause

**Falsifiable claim, two parts.**

1. `routes/ai.ts:160` passes `err?.message` — an upstream vendor's error string —
   into the client-facing `error` field. `errorCopy.ts:53` renders any
   `ApiError.message` to the guard verbatim by design, because that field is
   contracted to be server-authored guard-facing copy. The vendor's billing text
   therefore reaches the phone with no further defect required.
2. The org's Anthropic credit pool is shared between the triage runner and the
   product's enhancement feature. The runner drained it, so the product path
   started returning 400.

**Test for (1):** any upstream error whose `message` is unsuitable for a guard
reaches the guard. Force any non-529 failure and the raw text appears. Nothing
about the credit case is special — a malformed-request or auth error would leak
the same way.

**Test for (2):** with the pools separated, draining the runner's budget leaves
`/enhance-description` working.

**Classification:** a graceful-degradation defect, not an availability one. The
feature is *allowed* to fail — it is an optional writing aid. It is not allowed
to fail *loudly, in vendor language, in a modal, on a paying customer's phone*.

---

## Blast radius

- **1 guard affected** (leading candidate `4a71d17d` GRD0005, STARNET), bounded
  to **2 candidates**, both STARNET.
- **2 minutes 36 seconds**, 9 taps.
- **0 reports lost.** Both STARNET reports in the window were written
  successfully; the guard's own text was preserved throughout.
- **0 enforcement, reminder, or geofence paths touched.**
- **0 frozen entities involved.**
- **Not observable in Sentry** on either project — so without the Railway log
  buffer, which retains hours not days, this would have left **no trace at all**
  once the buffer rolled.

---

## Fix proposal

### 1. Stop leaking upstream text — size **S**, **Tier 1**

`routes/ai.ts` catch: return a fixed, guard-safe message and never `err.message`.
Keep the real error server-side. This alone would have turned the incident into
a one-line "Enhancement unavailable".

### 2. Degrade gracefully on the client — size **S**, **Tier 1**

Non-blocking toast instead of a modal `Alert`, original text kept, submit never
gated. Most of this already holds — the text *is* preserved and submit *is*
unblocked — so the change is the presentation, not the state machine.

**Not Tier 2:** this touches the reports *composer*, not enforcement. It changes
no geofence, clock-in/out, break, ping-window or violation behaviour, and it
cannot suppress a report — it makes a failure less obstructive, never more.

### 3. Add a timeout — size **S**, **Tier 1**

8 s at the API. Today's effective ceiling is the SDK's 10-minute default,
multiplied by SDK retries, multiplied by the route's 3-attempt 529 loop.

### 4. Observability — size **S**, **Tier 1**

`Sentry.captureMessage('enhancement_failed', { tags: { status, flow: 'report_enhance' } })`
on the API side, and add `guard=`/`company=` to the **error** log line so the
failure path is at least as attributable as the success path.

Per `POLICY.md`, tags carry no per-guard identity — `status` and `flow` only;
ids go in `extra`.

### 5. Budget isolation — **runbook, not code**

Separate Console workspaces for the runner and the app, each with its own key and
spend limit, so the runner cannot drain the product. No code change: the API
keeps reading `ANTHROPIC_API_KEY`. Written up separately for Vishnu to apply.

### Recommendation

**All five.** 1 and 2 are the incident; 3 and 4 are the same defect class found
on the same path while looking; 5 is the reason it happened at all. Items 1–4 are
one small PR against `ai.ts` plus one mobile file. Item 5 is console work that
only Vishnu can do.

**Note on sequencing:** items 1–4 make the *next* exhaustion invisible to guards.
Item 5 makes it not happen. Doing only 1–4 leaves the product depending on the
runner's spending discipline; doing only 5 leaves the leak in place for any other
upstream error.

---

## Loop notes

**What the loop got right.** The Railway log collector — fixed in Phase 4.3 to
pass `--service`/`--environment` — is the only reason this is diagnosable. The
entire evidence base for the caller, the count, the burst window and the exact
vendor string came from `railway logs`. Before 4.3 that collector returned
`No service linked` while reporting success.

**What was missing.**

- **The pack has no coverage of `/api/ai/*` at all.** No error-rate signal, no
  cost signal. A feature that spends money per guard tap is invisible to triage.
- **Sentry would not have surfaced this** even with perfect collection: zero
  events on both projects. The triage loop's Sentry dependence has a blind spot
  wherever a path logs to console instead of capturing.
- **Enhancement usage has no durable trace**, so "how often is this used, and by
  whom" is permanently unanswerable for any period older than the log buffer.
  That is a product-analytics gap as much as an ops one.

**Two brief claims corrected.** The mobile binary does not contain the key (the
security flag does not apply), and the customer-facing window was 2m36s rather
than the ~11 hours implied. Both were checked rather than accepted — the first by
grepping both client package manifests, the second by widening the log window
from 500 to 5000 lines.
