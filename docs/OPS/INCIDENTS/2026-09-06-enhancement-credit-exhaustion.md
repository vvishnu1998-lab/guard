# 2026-09-06 — report enhancement: Anthropic credit exhaustion leaked to a guard

**Status:** **fix committed, not yet merged.** Budget isolation still pending — see N23.
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

---

## Fix

Approved 2026-09-06: **1-a** (all five), **2-b** (mobile Sentry blindness → its
own item), **3-b** (pack `/api/ai` coverage → folded into N21).

Branch `ops/n23-enhancement`. Merge sha recorded on merge.

### `apps/api/src/routes/ai.ts`

**Never returns `err.message`.** Both failure exits now emit the same shape:

```
HTTP 503
{ "error": "ENHANCEMENT_UNAVAILABLE",
  "message": "Enhancement unavailable — your text will be submitted as written." }
```

`error` is a stable **code**, `message` is the copy — the documented contract.
`ApiError.code` therefore becomes something a client could branch on, and
`ApiError.message` becomes copy we wrote rather than copy Anthropic wrote.

503 rather than 500: the upstream is unavailable, and nothing retries on 5xx
(`apiClient.ts` retries only 401, for token refresh), so the status change costs
nothing.

The **empty-response** branch previously returned `500 {"error":"Empty response
from AI"}` — a different shape for the same user-visible situation. It now
returns the identical 503 body, so the client has one case to handle.

**Timeout: 8s, with `maxRetries: 0`.** The pair matters. The SDK default is a
**10-minute** timeout with **2** internal retries, and the SDK's own docs warn
that "request timeouts are retried by default, so in a worst-case scenario you
may wait much longer than this timeout". Setting a timeout without disabling SDK
retries would not bound anything. Retry policy now lives entirely in the route's
529 loop, so the worst case is countable: **2 attempts × 8s + one 1s backoff = 17s.**

**529 retries capped at 1** (2 attempts, was 3). A guard is watching a spinner.

**Observability.** `Sentry.captureMessage('enhancement_failed', ...)` with
`tags: { status, flow: 'report_enhance' }` — low-cardinality, **no guard
identity in tags** per `POLICY.md`; ids go in `extra`. And the failure log line
gains `guard=` / `company=`, matching the success line. Until now the *success*
path was attributable and the *failure* path was not, which is why the nine
failures on 2026-09-06 could not be pinned to a guard from logs.

### `apps/mobile/app/reports/new.tsx`

The modal `Alert.alert('Enhancement Failed', guardMessage(err, ...))` is replaced
by a non-blocking inline notice rendered beside the Enhance control:

> Enhancement unavailable — your text will be submitted as written.

**Fixed copy — `guardMessage(err)` is not called on this path.** That is the
change that matters: `guardMessage` renders `ApiError.message` verbatim by
contract, so any future upstream string would leak again even with the API fix
in place. Belt and braces on both sides of the wire.

`guardMessage` is deliberately **kept** for the *submit* failure at `:347` —
that is our own error, and a failed submit genuinely warrants a modal.

The notice clears when a new attempt starts. `description`, `submit()`,
`submitting` and every other piece of state are untouched — submit was already
unblocked and stays that way.

### OTA safety

**This mobile change is JS-only and OTA-publishable.** No native module, no
dependency, no `app.json` change — a `useState`, a `<View>`, and two styles.

- runtime: **1.0.17** (`expo.runtimeVersion: {policy: 'appVersion'}`)
- channel: **production** (also `preview` — `release-ops` §3b requires both)
- current production group: `6536a189-52c6-4816-bda9-bcb7ba44116d`

**Not published.** Publishing is a separate, explicit act.

**Reach caveat:** two STARNET devices are on runtime **1.0.16** (N7) and cannot
receive a 1.0.17 update at all. They need a store install. **The API-side fix
covers them anyway** — with `err.message` gone, an old client shows the fixed
`message` field, so the vendor text cannot reach even an un-updated device.
That is the reason for fixing both sides rather than just the client.

### Tests

`apps/api/src/routes/_aiEnhance.test.ts`, 10 assertions, ts-node + `node:assert`
like its siblings. The Anthropic SDK, Sentry and `requireAuth` are stubbed in
`require.cache`, so no network call and no event is sent.

Most assertions are **negative** — what must never appear in the response —
because that is what actually broke:

| test | asserts |
|---|---|
| client construction | `timeout: 8000` **and** `maxRetries: 0` |
| credit 400 | body contains no `credit balance`, `Plans & Billing`, `invalid_request_error`, upstream `request_id`, or the word `Anthropic` |
| failure shape | 503, `ENHANCEMENT_UNAVAILABLE`, exact guard-safe copy |
| Sentry | one `enhancement_failed`; tags are exactly `{status, flow}`; **no guard/company id in tags**; ids present in `extra` |
| log line | `[ai.enhance.failed]` carries `guard=`, `company=`, `status=` |
| retry | a 400 makes exactly **one** upstream call |
| timeout | same 503 shape; no upstream wording; `status` tag `'0'` |
| empty response | 503, not the old 500 |
| success | unchanged, 200, no Sentry event |
| validation | short text still 400, **zero** paid calls |

Full suite: `tsc --noEmit` clean in **both** `apps/api` and `apps/mobile`;
`_run` 10, `_healthCrons` 36, `_pingReminder` 5, `_aiEnhance` 10 — **61 passed,
0 failed**.

---

## Verification plan

Observe after merge and deploy. The API fix is verifiable immediately; the mobile
half is not, until an OTA is published.

1. **The vendor text cannot reach a client.** Force a failure — the cheapest
   trigger is an invalid `ANTHROPIC_API_KEY` in a non-production environment, or
   simply wait for the next real upstream error. The response body must be
   exactly `{"error":"ENHANCEMENT_UNAVAILABLE","message":"Enhancement
   unavailable — your text will be submitted as written."}` with **no** vendor
   string anywhere in it.
2. **Sentry now sees it.** A failure produces `enhancement_failed` on
   `netraops-api` with `flow: report_enhance`. Before this change the path was
   invisible: 9 failures, 0 events.
3. **Failures are attributable.**
   `railway logs --service guard --environment production | grep ai.enhance.failed`
   shows `guard=` and `company=`.
4. **The success path is unharmed.** A normal enhancement still returns text and
   still logs `[ai.enhance.success] guard=... company=...` with token counts.
   **This is the one that matters** — items 1–3 confirm the failure is handled;
   4 confirms the feature still works. An 8s timeout is a real behaviour change,
   and a slow-but-healthy upstream would now fail where it previously succeeded.
   If success rates drop after deploy, the timeout is the first suspect.
5. **Mobile, manual — cannot be automated.** No test framework exists in
   `apps/mobile`, and this is a render path. On a device on runtime 1.0.17,
   after an OTA: open a new report, type ≥10 words, tap **Enhance** while the
   API is failing. Expect an inline amber notice with the fixed copy, **no
   modal**, the typed text still present and editable, and **Submit still
   working**. The last of those is the Tier-2 boundary — if submit is blocked,
   revert.

**Budget isolation is NOT verified by any of the above.** It is console work in
`RUNBOOK-n23-budget-isolation.md`, tracked as **N23**, and until it is applied
the runner and the product still share one credit pool.

### Related items opened

- **N22** — SendGrid migration (card failing, E15).
- **N23** — this; budget isolation still pending.
- **N24** — Vercel Hobby ToS, for Counsel.
- **N25** — **mobile `captureException` produced zero events on a shipped path.**
  Directly relevant here: it is why this incident had no mobile telemetry, and
  until it is resolved, "no mobile Sentry events" means "no information", not
  "no errors".


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
