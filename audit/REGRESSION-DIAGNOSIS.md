# Regression Diagnosis — 2026-04-24 Mobile Bugs

**Date**: 2026-04-24
**Reporter**: operator (manual S25 smoke after the §6 Week-1 install)
**Build under test**: `/tmp/vwing-guard.apk`, sha256 `6e9e7aef…d0da` (the
versionCode-10 APK from `audit/BUILD-2026-04-24.md` §1–§7)

Two on-device errors appeared during smoke testing of the Week-1 build:

1. **"Upload Failed: Cannot convert undefined value to object"** — guard
   tap on report-photo upload.
2. **"Enhancement Failed: 404 model: claude-sonnet-4-20250514"** — guard
   tap on the AI rewrite button on a report description.

Both are critical: the guard cannot complete a report flow on the
shipped APK.

---

## 1. Bug 1 — Upload Failed (cryptic TypeError)

### 1.1 Symptom
On-device toast: `Upload Failed: Cannot convert undefined value to object`.
No further detail. The error short-circuits the report submission so the
guard cannot ship a clock-in or incident with a photo attached.

### 1.2 Root cause — protocol mismatch between mobile and API tiers

D1 (audit/WEEK1.md §D1) switched the upload service from a
**PUT-presigned URL** (returns `{ url }`) to a **POST-presigned multipart
form** (returns `{ post_url, fields, public_url, key, max_bytes }`).
Both sides of the wire — `apps/api/src/services/s3.ts` +
`apps/api/src/routes/uploads.ts` on the API, and
`apps/mobile/lib/uploadToS3.ts` on the mobile — were modified together
and pass the in-process tests (`test-presigned-upload.ts`,
`test-magic-bytes.ts`, etc.).

But on 2026-04-24 the prod state was:

| Tier | Code revision in production |
| --- | --- |
| Mobile (versionCode 10 APK) | post-D1 (multipart-POST shape) |
| API (Railway deployment) | **pre-D1, audit base `e2fec53`** (PUT-presigned shape) |

The Week-1 D1 patches were in the developer's working tree but **never
committed**, so the Railway auto-deploy never picked them up.

When the mobile uploader calls `POST /api/uploads/presign` against the
prod API, the API returns the legacy `{ url }` shape. The mobile then
runs:

```ts
for (const [k, v] of Object.entries(presign.fields)) { ... }
//                                ^^^^^^^^^^^^^^^^
//                                undefined on the legacy shape
```

`Object.entries(undefined)` raises the V8 TypeError "Cannot convert
undefined value to object", which surfaces in the toast with no useful
location info.

### 1.3 Why this didn't show in CI

- `test-presigned-upload.ts` exercises only the API side (decodes the
  Policy field bytes; doesn't drive the mobile uploader).
- The mobile-side helper had no contract test pinning the response
  shape to a hard-coded list of required keys.
- The in-process tests boot Express in-process so they always hit the
  current source; they cannot detect deployment skew between tiers.

There was no test that would fail if the API regressed to the old shape
*while the mobile shipped the new one*.

### 1.4 Fix plan

Two-part fix because the root cause has two faces (mobile-side
debuggability + API-side correctness):

| Layer | Fix | File |
| --- | --- | --- |
| Mobile | Defensive shape guard before `Object.entries(presign.fields)`. Throws an actionable error ("Upload service returned an unexpected response shape. The API may need to be redeployed with the latest upload changes. Please contact your administrator.") instead of TypeError. | `apps/mobile/lib/uploadToS3.ts` |
| API | Commit + deploy the D1 patches (already in working tree). | `apps/api/src/services/s3.ts`, `apps/api/src/routes/uploads.ts` |
| CI | New 36-assertion contract test that mirrors the mobile-side `buildMobileMultipart` against every API response, across all 3 upload contexts, plus all defensive failure modes. Catches future skew at CI time. | `apps/api/scripts/test-upload-flow-mobile.ts` |

### 1.5 Verification plan

1. Run `npx tsx apps/api/scripts/test-upload-flow-mobile.ts` locally → expect 36/36 PASS.
2. Rebuild APK with the defensive uploader and reinstall on S25.
3. Deploy the API (commit + push triggers Railway auto-deploy).
4. On S25: log in → take a clock-in / report photo → submit. Confirm:
   - HTTP 200 from `POST /api/reports`,
   - Row in `reports` with non-null `photo_urls`,
   - Object exists in S3 under the company's prefix with correct `Content-Type`.
5. Dual-skew safety: with the API rolled back to pre-D1 deliberately
   (or before deploy), the same on-device flow should now show the
   actionable message — not the cryptic TypeError. (We tested this
   structurally via the integration test's "legacy shape" assertion;
   live verification is optional.)

---

## 2. Bug 2 — AI Enhancement 404 (deprecated model string)

### 2.1 Symptom
On-device toast: `Enhancement Failed: 404 model: claude-sonnet-4-20250514`.
Triggered by tapping "Enhance with AI" on a report description ≥ 10 chars.

### 2.2 Root cause — Anthropic retired the pinned model

`apps/api/src/routes/ai.ts` had:

```ts
model: 'claude-sonnet-4-20250514',
```

Anthropic retired this snapshot on **2026-04-20**. The next call to
`anthropic.messages.create({ model: '...20250514' })` returns HTTP 404
with a body referencing the retired ID. The error surfaces verbatim in
the mobile toast.

This is a model-version pinning hazard, not a logic bug. The endpoint
worked correctly for ~11 months and only broke when the upstream
provider retired the pin.

### 2.3 Why this didn't show in CI

- The API has no unit test that pings the live Anthropic endpoint with
  the configured model (would require a real API key in CI).
- A model retirement is an external-state change with no signal in the
  repo until the next request fires.

### 2.4 Fix plan

Two-part fix:

| Change | Rationale | File |
| --- | --- | --- |
| Replace the retired pin with `claude-sonnet-4-5-20250929` (Sonnet 4.5 GA) as the default. | Latest GA Sonnet snapshot at the time of fix; in the same model family the prompt was tuned for. | `apps/api/src/routes/ai.ts` |
| Extract `ANTHROPIC_MODEL` env var, default to the new pin. | Lets the next retirement be handled with a single Railway env-var change — no code deploy. | same file |

There are **no other occurrences** of `claude-*-20250514` in the
codebase (checked via grep across all of `apps/`); this was the only
pin needing rotation.

### 2.5 Verification plan

1. Boot the API in-process locally and POST `/api/ai/enhance-description`
   — expect SDK to accept the model string (a downstream
   `ANTHROPIC_API_KEY` 401 confirms the model lookup happened, since
   the SDK validates auth *after* model resolution). Done locally.
2. Deploy the API to Railway.
3. On S25 (or via curl with a real guard JWT against prod): submit a
   report description ≥ 10 chars and tap Enhance. Expect 200 with
   enhanced text within ~5 s.

---

## 3. Why neither fix landed in the previous build

The Week-1 audit work (Phases A–E in `audit/WEEK1.md`) lived **entirely
in the developer's working tree** at audit-base commit `e2fec53`.
Operator notes from `audit/BUILD-2026-04-24.md` §1 confirm:

> **Important**: HEAD is the audit base. The Week-1 fixes are present
> in the working tree but **uncommitted** at the time of this build.

Because Railway deploys on push to `main`, the absence of any commit
meant Railway kept running the audit-base API. The mobile build
(EAS-local) DID pick up the working-tree mobile changes (D1 multipart
POST helper), so the APK was post-D1 while the API was pre-D1 —
classic deployment skew.

Bug 2 was independent of Week-1 entirely: Anthropic retired the model
string on 2026-04-20, four days before this build. Even if Week-1 had
been deployed cleanly, Bug 2 would still have surfaced.

---

## 4. Combined fix sequence (2026-04-24)

| Step | Action | Status |
| --- | --- | --- |
| 1 | Add defensive shape guard to `apps/mobile/lib/uploadToS3.ts`. | ✅ in working tree |
| 2 | Replace `claude-sonnet-4-20250514` → `process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929'` in `apps/api/src/routes/ai.ts`. | ✅ in working tree |
| 3 | Write `apps/api/scripts/test-upload-flow-mobile.ts` (36 assertions). | ✅ in working tree, run green |
| 4 | Rebuild APK with defensive uploader; install + launch on S25 (clean). | ✅ done — see `audit/BUILD-2026-04-24.md` §11 |
| 5 | Commit Week-1 + regression triple to `week1-fixes` branch. | ⏳ in progress (this commit pile) |
| 6 | Push `week1-fixes` → trigger Railway auto-deploy of API. | ⏳ |
| 7 | Curl-verify `/api/ai/enhance-description` on prod. | ⏳ |
| 8 | Operator-driven end-to-end smoke on S25 (real upload + real enhance). | ⏳ |
| 9 | Append §5 verification log to this file. | ⏳ |

---

## 5. Verification log

(Populated after step 9 above.)

### 5.1 `test-upload-flow-mobile.ts` local run
_(filled in)_

### 5.2 Railway deploy log
_(filled in)_

### 5.3 Prod curl — `/api/ai/enhance-description`
_(filled in)_

### 5.4 S25 end-to-end smoke
_(filled in — DB row, S3 listing, logcat excerpt, screenshots if any)_

---

## 6. Lessons / preventive notes

1. **Never let cross-tier protocol changes ride together as
   uncommitted working-tree changes.** Either commit + deploy the
   server side first, then ship the client; or version the API
   surface and ship them in either order. The audit-base hold-on-main
   trapped both sides into a skew that nobody noticed until S25
   smoke.
2. **Externally-pinned model IDs are a known failure surface** —
   Anthropic posts retirement schedules but the dev cycle here didn't
   surface them. The new env-var pattern lets us roll forward with
   no deploy (Railway env edit + service restart). Set a calendar
   reminder ~30 d before any pinned model's published retirement
   date.
3. **Add a contract test for any cross-tier shape change going
   forward.** `test-upload-flow-mobile.ts` is the template:
   in-process the API, mirror the client's parsing logic, assert
   shape end-to-end. Catches deployment skew at CI time.
