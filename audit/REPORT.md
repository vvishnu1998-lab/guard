# V-Wing — Production Readiness Audit

**Date**: 2026-04-18 (rev 2026-04-24 — Phase E close-out)
**Branch**: `main` @ `e2fec53` (audit base) → Week-1 PRs A/B/C/D/E pending.
**Scope**: `apps/api`, `apps/web`, `apps/mobile`, live Railway DB snapshot.
**Depth**: file:line citations + live-DB queries via `mcp__guard-postgres__query`. Anything I could not verify is flagged **UNVERIFIED**.
**Phase reports**: `audit/phase1_inventory.md` … `audit/phase9_quality.md`. **Verification pass**: `audit/VERIFICATION.md` (V1–V8 + bonuses). **Week-1 remediation log**: `audit/WEEK1.md`.

---

## Scores (revised after Week-1 Phase E re-verification, 2026-04-24)

| Phase | Score (was) | Score (now) | One-line verdict |
|---|---|---|---|
| 2 — Security | 5.5 | **7.0 / 10** | CB4 (CORS fail-closed), CB5 (PDF JWT off query), CB6 (access-token revocation), CB7 (S3 size cap + bytes-vs-type) all closed; V1 IDOR re-replayed PASS (32/32). Remaining drag: V2 Google Maps key still in git, V7 BIPA still pending, no 2FA. |
| 3 — Data integrity | 4.5 | **6.0 / 10** | CB1 (`total_hours` computed + backfilled), CB2 (atomic clock-out), CB3 (partial unique index on open sessions), V5 (server-side incident-photo rule + B1 backfill decision), B3 (retention branches re-verified) all closed. Remaining drag: `POST /api/sites` still doesn't seed `data_retention_log`, no `cron_runs` observability table. |
| 4 — API / backend | 6.0 | 6.0 | Unchanged. Global error handler + sanitized 500 messages still pending. |
| 5 — Web / UX | 6.0 | 6.0 | Unchanged. |
| 6 — Mobile | 6.0 | 6.0 | Unchanged.  D1 mobile upload helper switched from PUT to multipart POST as part of CB7 close-out. |
| 7 — Business logic | 7.0 | **7.5 / 10** | Photo-count rule is now server-enforced (V5/CB6); chain-of-custody hole is closed end-to-end. Tenant isolation re-verified by `test-idor-replay.ts`. |
| 9 — Code quality | 4.0 | **4.5 / 10** | Still no Vitest harness, but Week-1 added 11 self-cleaning regression scripts under `apps/api/scripts/test-*.ts` covering 145 assertions across CB1–CB6 + V5 + V6 (D1+D2) + V1.  Hand-rolled but reproducible. |

**Overall readiness: 6.5 / 10** (was 5.0). Six of the original ten CRITICAL blockers are closed; two (V2 Google Maps key, V7 BIPA) remain held by user directive; CB9 (2FA) and CB10 (Stripe) remain explicit Week-2+ scope.

**Delta to "safe to sell":** the *integrity / refund* class of risk (NULL hours, ghost guards, byte-content holes) is gone. The remaining gaps are *productization / compliance*: Maps key rotation (~0.5 day), BIPA surface (~3 days), 2FA (~2 days), Stripe (~5 days), public marketing pages (~5 days). Roughly 2–3 weeks of focused engineering remain before self-serve at $149/site is honest; 1–2 weeks before high-touch at $400–600/site.

---

## Product & market verdict

**Pitch reality check against actual competitors:**

| Competitor | Approx pricing | What they have that V-Wing lacks |
|---|---|---|
| **TrackTik** | $200+/site/mo | License tracking, dispatcher messaging, checkpoint/NFC tours, i18n, audit log, SOC 2, 2FA, dozens of integrations. |
| **Silvertrac** | $70–120/guard/mo | Incident escalation tree, shift swap UX, voice reports, vendor ecosystem. |
| **Guardso** | $15–25/guard/mo | Self-serve signup, Stripe billing, mobile offline-first at real scale, public marketing site. |
| **V-Wing** | claimed $149/site/mo | — |

**What V-Wing has that the cheap end of the market lacks:** AI-enhanced report descriptions, camera-only photo capture (chain-of-custody enforced at the hook), geofence JSONB + ray-casting, a retention/purge pipeline that's actually transactional and bookkept, multi-step photo-verified clock-in. These are real differentiators — if the basics (billing, tests, 2FA, marketing site) were in place, $149/site/mo would be defensible against Silvertrac-tier competition.

**What V-Wing does not yet have that the $149 price assumes:** a way for a customer to give you money without a manual invoice. An SLA worth quoting. An audit log you can hand an enterprise buyer. A mobile update gate so a breaking API change doesn't silently 4xx 200 clock-ins. i18n. A 2FA story for admins. Tests.

**Positioning**: you are closer to "a really good custom build for 1–3 design-partner security companies" than to "a SaaS product." That is a business — it's just a different business from the one the $149/site price implies. Either (a) 8–12 weeks of focused work to close the productization gaps, then launch at $149 self-serve; or (b) keep the manual motion, raise the price to $400–600/site (because you're functionally a consultant-built deployment), and stop pretending it's self-serve until the gaps close.

---

## CRITICAL blockers — must fix before any paying customer in production

Each one of these is a "refund or lawsuit" risk.

### CB1. `total_hours` NULL on auto-completed shifts — billing-by-hour is broken ✅ CLOSED 2026-04-22
`apps/api/src/jobs/autoCompleteShifts.ts:22-32` updates `clocked_out_at = NOW()` and `shifts.status = 'completed'` but never computes `total_hours`. DB snapshot confirms **1 existing victim session** with `clocked_out_at` set and `total_hours = NULL` after 21 hours. Any customer billed by hours who forgets to tap Clock Out pays nothing for that shift. See `audit/phase3_data_integrity.md` C1.
**Fix**: compute `total_hours` in the same UPDATE. ~0.5 eng-day.
**Resolution** (`audit/WEEK1.md` §C1): `autoCompleteShifts.ts` now emits `total_hours = ROUND(EXTRACT(EPOCH FROM (NOW() - clocked_in_at))/3600, 2)` in the same UPDATE; one-shot backfill ran against the live victim session. Regression: `apps/api/scripts/test-auto-complete-shifts.ts` (12/12 PASS, re-run §E1).

### CB2. Clock-out is not atomic — causes "ghost guard" UI symptom ✅ CLOSED 2026-04-22
`apps/api/src/routes/shifts.ts:234-264` performs 3 sequential UPDATEs outside any transaction. A pool timeout between step 1 (close session) and step 3 (mark shift completed) leaves the DB in the exact inconsistent state that commit `e2fec53` papered over. The workaround filters the symptom; the underlying write is still non-atomic. See `audit/phase3_data_integrity.md` C2.
**Fix**: wrap in `BEGIN/COMMIT` — matches the clock-in pattern at `shifts.ts:199-231`. ~0.5 eng-day.
**Resolution** (`audit/WEEK1.md` §C2): clock-out wrapped in `BEGIN/COMMIT` with `ROLLBACK` on any thrown error; companion partial unique index `idx_open_session_per_guard` (CB3) blocks the bug at the DB layer too. Regression: `apps/api/scripts/test-concurrent-clock-in.ts` (5/5 PASS, re-run §E1).

### CB3. Clock-in race allows double open sessions ✅ CLOSED 2026-04-22
`apps/api/src/routes/shifts.ts:199-231` — transaction exists but `SELECT ... WHERE status='scheduled'` has no `FOR UPDATE`, and there is no partial unique index on `shift_sessions(guard_id) WHERE clocked_out_at IS NULL` at the DB level. Two concurrent requests → two open sessions for one guard. See `audit/phase3_data_integrity.md` C3.
**Fix**: `SELECT ... FOR UPDATE` + add the partial unique index. ~0.5 eng-day.
**Resolution** (`audit/WEEK1.md` §C2/§C3): `SELECT ... FOR UPDATE` added to the open-session lookup; partial unique index `CREATE UNIQUE INDEX idx_open_session_per_guard ON shift_sessions(guard_id) WHERE clocked_out_at IS NULL` shipped in migration `2026_04_22_open_session_unique.sql`. Regression: `apps/api/scripts/test-concurrent-clock-in.ts` race-condition case (5/5 PASS).

### CB4. CORS fallback is fail-open with credentials ✅ CLOSED 2026-04-22
`apps/api/src/index.ts:50` — `origin: process.env.ALLOWED_ORIGINS ? ... : true` + `credentials: true`. One deploy rollback or env typo = any origin can make authenticated cross-origin calls. See `audit/phase2_security.md` C1.
**Fix**: throw on startup if `ALLOWED_ORIGINS` is unset. ~0.25 eng-day.
**Resolution** (`audit/WEEK1.md` §C3): `apps/api/src/index.ts` now throws `Error('ALLOWED_ORIGINS env var must be set')` at boot if the env var is missing or empty; CORS callback rejects unknown origins instead of falling through to `true`.

### CB5. Client PDF endpoint takes JWT in `?token=` query ✅ CLOSED 2026-04-23
`apps/api/src/routes/clientPortal.ts:144-157` — long-lived client JWT leaks into Railway access logs, browser history, and `Referer` on any embedded image. See `audit/phase2_security.md` C4.
**Fix**: `Authorization: Bearer` header or a short-lived signed-URL handoff. ~0.5 eng-day.
**Resolution** (`audit/WEEK1.md` §C4): replaced query-string JWT with a 60-second handoff token (`purpose: 'pdf_download'`, pinned `site_id` + `report_id`) minted by an authenticated `POST /api/client/reports/:id/pdf-link` endpoint and consumed by a separate `GET /api/client/reports/:id/pdf?handoff=...` route. Old query-string path returns 410 Gone. Regression: `apps/api/scripts/test-pdf-handoff.ts` (15/15 PASS).

### CB6. Access tokens are not revocable ✅ CLOSED 2026-04-23
`apps/api/src/middleware/auth.ts:26-59` doesn't consult `revoked_tokens`. Logout revokes the refresh JTI; the access token keeps working until `exp`. The admin "revoke guard session" only clears FCM. See `audit/phase2_security.md` M1.
**Fix**: add `jti` to access tokens, check `revoked_tokens` in `requireAuth`; OR drop access TTL to 15 minutes. ~1 eng-day.
**Resolution** (`audit/WEEK1.md` §C5): access tokens now carry a `jti`; `requireAuth` consults `revoked_tokens` on every request (cached 30 s); logout revokes both refresh + access JTIs in the same transaction; admin "revoke guard session" insert into `revoked_tokens` for every active access JTI for that guard. Regression: `apps/api/scripts/test-token-revocation.ts` (12/12 PASS).

### CB7. S3 uploads accept any bytes + unbounded size (V6 FAIL) ✅ CLOSED 2026-04-23
`apps/api/src/routes/uploads.ts:13-42` — content-type allowlist validates the *declared* mime at presign, but S3 itself does not validate bytes-vs-type. Live test (verified 2026-04-19): presigned a JPEG URL, PUT a 50 MB random blob → HTTP 200; PUT a PE executable with `Content-Type: image/jpeg` → HTTP 200. Every guard can fill the bucket with arbitrary bytes, including executables distributed via the resulting `public_url`. See `audit/VERIFICATION.md` V6.
**Fix**: switch presign to `createPresignedPost` with `Conditions: [["content-length-range", 1, 5_242_880]]`; add an S3 event trigger that magic-byte-validates + image-decodes; quarantine non-image uploads. ~1.5 eng-days.
**Resolution** (`audit/WEEK1.md` §D1+§D2): presign endpoint switched to aws-sdk v2 `createPresignedPost` with `Conditions: [["content-length-range", 1, 5242880], ["starts-with", "$Content-Type", "image/"]]`. Mobile upload helper switched from PUT to multipart POST. `routes/reports.ts` now calls `getS3ObjectHead` + `validateImageMagicBytes` (JPEG/PNG/WEBP signatures) before accepting any incident `photo_urls` entry; failures are logged into a new `quarantined_uploads` table and the report-create call returns 422. Regression: `apps/api/scripts/test-presigned-upload.ts` (16/16 PASS — Leg 1, size cap), `test-magic-bytes.ts` (28/28 PASS — Leg 2, attacker-shape rejection), `test-incident-photo-rule.ts` case 2 (D2 rejection at report-create). Live S3 round-trip covered by `test-d2-magic-live.ts` (Railway-only, gated on real AWS creds).

### CB8. Biometric selfies captured without BIPA notice / consent / deletion path (V7 FAIL)
`selfie_url` is collected at every clock-in (`apps/api/src/routes/locations.ts:118-131`, stored in `clock_in_verifications.selfie_url`). No consent table, no written notice on first collection, no retention schedule specific to biometrics, no deletion endpoint. Under Illinois BIPA (740 ILCS 14/20): statutory $1,000 per negligent violation, $5,000 per intentional. One plaintiff's-firm demand letter per Illinois guard. See `audit/VERIFICATION.md` V7.
**Fix**: `biometric_consents` table + first-capture notice modal + versioned policy + `DELETE /api/guards/:id/biometrics` + a biometric-specific retention cron capped at 3 years. ~3 eng-days. **Gate**: do not sell in IL / TX / WA / NY until this ships.

### CB9. No 2FA for admin accounts
Zero hits for `totp`, `mfa`, `2fa`. For a security product this is the single most embarrassing gap. See `audit/phase8_gaps.md`.
**Fix**: TOTP (via `otplib`) for `company_admin` and `vishnu` login. ~2 eng-days.

### CB10. Google Maps API key burned in git history (V2 FAIL)
`AIzaSyBCBgU60e8PbeZEPeKA7RVddgTlLwy7jiA` committed in `61bca7f1` (2026-04-07) and `d193e046` (2026-04-09). Also still in HEAD of `apps/mobile/app.json` and `.env.example`, in the Xcode project, and in the Android manifest — therefore also shipped inside every app binary. Billing-abuse + embedded-map-spoofing exposure; not user-data. See `audit/VERIFICATION.md` V2.
**Fix**: rotate the key; add Google Cloud bundle-ID + referrer + API restrictions on the new one; replace across 8 files (list in VERIFICATION.md); install `gitleaks` pre-commit. ~0.5 eng-day.

---

## MAJOR issues — not blockers but will hurt every deal

- **No automated tests** anywhere. 0 `*.test.*` / `*.spec.*` files across api/web/mobile. Every refactor is a gamble. (Was CB7 in the original report — reclassified MAJOR: operational/productization risk, not a refund/lawsuit trigger.) `audit/phase9_quality.md`. **Fix**: Vitest + one smoke test per critical path + PR-gating CI. ~3 eng-days.
- **No error monitoring.** (Was CB8 — reclassified MAJOR: you will lose customers faster, but no single incident is refund-or-lawsuit on its own.) `audit/phase8_gaps.md`. **Fix**: Sentry on api + web + mobile. ~0.5 eng-day.
- **No billing integration.** (Was CB10 — reclassified MAJOR: a productization blocker for self-serve $149/site, not an *integrity* blocker. A high-touch $400–600/site manual-invoice motion ships without it.) `audit/phase8_gaps.md`. **Fix**: Stripe Checkout + webhook. ~5 eng-days.
- **Incident-report photo rule is client-only and bypassed in prod** (V5). 4 of 6 incident reports in live DB have zero photos despite mobile UI claiming "required." `apps/api/src/routes/reports.ts:54-115` has no `photo_urls.length > 0` guard for incidents. **Fix**: 4-line server check + one-shot backfill. ~0.25 eng-day.
- **Retention cron branches have never fired against real data** (V4). `nightlyPurge` steps 2/3/4 and `monthlyRetentionNotice` 60/89 warnings have zero triggering rows in prod. First real site hits day 90 on 2026-09-28 — if any branch is broken, you find out the day a customer complains. **Fix**: seed a staging test row with `client_star_access_until = NOW() - INTERVAL '1 day'`, run each branch, fix. ~0.5 eng-day. Also add a `cron_runs` observability table.
- **`POST /api/sites` does not populate `data_retention_log.{client_star_access_until,data_delete_at}`** — confirmed live: site `60cea6fb` has both NULL. That site will **never** be purged. `audit/phase3_data_integrity.md` minor, hardened by V4. **Fix**: add `INSERT INTO data_retention_log` with the 90/150-day offsets in the site-creation handler; back-fill the existing bad row. ~0.25 eng-day.
- **Password rules are length-only** (Bonus 2). 8-char minimum across admin/client/reset; `apps/api/src/routes/guards.ts:47` allows 6-char temp passwords. No complexity, no HIBP breach check. `Aaaa@1234` was a valid test password. **Fix**: zxcvbn score ≥ 3 + HIBP k-anonymity check, unified across all 4 paths. ~0.5 eng-day.
- **`autoCompleteShifts` / `nightlyPurge` / every cron runs in-process with no distributed lock.** Railway autoscaling = duplicated retention emails + double hard-delete. `audit/phase4_api.md` M1.
- **Raw Postgres `err.message` returned to clients** — constraint names / column names leak. `audit/phase4_api.md` C2.
- **No global Express error handler** — stack traces leak in any env that is not `NODE_ENV=production`. `audit/phase4_api.md` C1.
- **`strict: false` in web tsconfig.** 36 `: any` in critical pages. `audit/phase5_web.md` M1.
- **No marketing / signup surface.** Product is an admin console, not a SaaS. `audit/phase5_web.md` C1.
- **No mobile forced-update gate.** Breaking API change → silent 4xx. `audit/phase6_mobile.md` M3.
- **Offline queue has no tests.** The one mobile subsystem most likely to silently lose data. `audit/phase6_mobile.md` M2.
- **93% of reports have no photos.** Chain-of-custody gap in the headline feature. `audit/phase7_business.md`.
- **No signed audit log for business events.** `auth_events` covers login only. `audit/phase7_business.md` M1.
- **Report photo URLs not validated** against the company's S3 prefix. Chain-of-custody trustable only if every guard app is honest. `audit/phase2_security.md` M2.
- **OTP guard-unlock brute-forceable.** No per-account lock; 6-digit OTP + distributed attacker. `audit/phase2_security.md` C3.
- **Forgot-password not rate-limited per-target.** Email-bomb + SendGrid quota burn risk. `audit/phase2_security.md` C2.
- **Rate limiter keyed by IP only.** Corporate NAT = one noisy tenant locks out another. `audit/phase4_api.md` M4.
- **No `location_pings` lat/lng bounds check.** Bad clients poison geofence analytics. `audit/phase3_data_integrity.md` M1.
- **Ping endpoint accepts pings from closed sessions.** `audit/phase3_data_integrity.md` M2.
- **No SOC 2 / GDPR artifacts** (no DPA template, no DSR endpoints). `audit/phase8_gaps.md`.
- **No guard license / certification tracking.** Regulatory requirement in most US states and Canada. `audit/phase8_gaps.md`.
- **No i18n.** English-only; kills non-English markets. `audit/phase8_gaps.md`.
- **No secret rotation / `kid` header scheme** across 4 JWT secrets. `audit/phase4_api.md` M2.
- **Inconsistent bcrypt cost** — `admin.ts:93` uses 10, others use 12. `audit/phase2_security.md` M3.

---

## MINOR issues

- Missing `helmet` / CSP / `X-Frame-Options` — cheap to add.
- `data_retention_log` row for site `60cea6fb` has NULL `data_delete_at` — site creation did not initialize retention.
- `login_attempts` table only exists for guards — admin brute-force lockout missing.
- No CHECK constraints on `shift_sessions.total_hours >= 0`, `latitude`/`longitude` bounds, `violation_lat/lng`.
- `m3u` + `play-store-assets/` + stray `"guard app/"` directory uncommitted in repo root — move out.
- `apps/web/tsconfig.tsbuildinfo` tracked — build artifact, should be gitignored.
- `/api/ai/enhance-description` has no per-user rate limit — single guard can burn Anthropic budget.
- No request correlation ID on API logs — support triage is hard.
- Node 18 EOL (April 2025) — upgrade to 20 LTS.
- Single-region Railway deploy — EU latency + data-residency blocker for public-sector buyers.
- Report chain has no client-side dispute workflow.
- No shift-swap / guard-to-guard handoff UX.

---

## What's working well — keep these in the pitch

- **Parameterized SQL everywhere** — no template-string interpolation found. (Phase 2.)
- **RBAC is consistent** — every admin route `requireAuth('company_admin')`, every super-admin `requireAuth('vishnu')`, every client route scoped by JWT `site_id`, not URL params. No role-escalation path found. (Phase 2.)
- **Retention pipeline is first-class** — 5 touchpoints (60/89/90/140/150), transactional hard-delete, partial indexes `idx_retention_access_until` / `idx_retention_delete_at`. (Phase 3.)
- **Multi-tenant isolation holds at the query level** — `company_id` from JWT, never from params. (Phase 7.)
- **Camera-only photo capture in mobile** — `launchCameraAsync` only, no gallery picker. Chain-of-custody is enforced where it matters. (Phase 6.)
- **Geofence polygons** — JSONB + ray-casting in `services/geofence.ts`, no external geometry service. (Phase 3.)
- **AI enhancement via Anthropic** — real differentiator vs TrackTik/Silvertrac. (Phase 8.)
- **Commit discipline** — conventional, scope-prefixed, intent-clear. (Phase 9.)
- **Clean module boundaries** — `routes/`, `jobs/`, `services/`, `middleware/`, `db/`. (Phase 9.)
- **One-primary-admin DB index** — `idx_company_admins_one_primary` partial UNIQUE. Enforces the business rule at the DB level. (Phase 3.)
- **`clock_in_verifications.shift_session_id` UNIQUE** — blocks double-verification at the DB level. (Phase 3.)

---

## Top 10 fixes in strict priority order

Priority = (impact on first paying customer) × (reversibility of skipping it).

| # | Fix | File(s) | Eng-days | Why first |
|---|---|---|---|---|
| 1 | **Fix `autoCompleteShifts` to compute `total_hours`** | `apps/api/src/jobs/autoCompleteShifts.ts:22-32` | 0.5 | Billing-by-hour is broken **right now**. One-line SQL change + a backfill for the 1 existing victim row. |
| 2 | **Wrap clock-out in a transaction + add partial unique index on open sessions** | `apps/api/src/routes/shifts.ts:234-264` + new migration | 1 | Closes CB2 and CB3 together. Kills the "ghost guard" class of bug at the source rather than via the e2fec53 workaround. |
| 3 | **Fail-closed CORS + move client PDF JWT to `Authorization` header** | `apps/api/src/index.ts:50`, `apps/api/src/routes/clientPortal.ts:144-157` | 0.5 | Both are "one deploy from disaster." Cheap fix, permanent benefit. |
| 4 | **Rotate the burned Google Maps key + bundle/referrer/API restrictions** (V2) | 8 files listed in `VERIFICATION.md` V2 + Google Cloud Console | 0.5 | Every deploy since 2026-04-07 has been using a public key. Abuse risk is silent billing drain + embed-spoofing. Install `gitleaks` pre-commit in the same PR. |
| 5 | **S3 upload hardening** (V6) — `createPresignedPost` with `content-length-range`, byte-level MIME validation on PUT, quarantine non-images | `apps/api/src/routes/uploads.ts`, `apps/api/src/services/s3.ts`, new S3 event Lambda | 1.5 | Today any guard account can fill the bucket with 50MB PE binaries per live-test evidence. Storage abuse + malware-hosting risk. |
| 6 | **BIPA compliance surface** (V7) — `biometric_consents` table, first-capture notice modal, policy versioning, `DELETE /api/guards/:id/biometrics`, biometric-specific retention cron (cap 3y) | full stack | 3 | Statutory $1k–5k per guard in IL/TX/WA/NY. Until this ships, do not sell in those states. |
| 7 | **Server-side enforcement of incident photo rule** (V5) + backfill | `apps/api/src/routes/reports.ts:60` + migration | 0.25 | Client-only rule was already bypassed in prod (4 of 6 incidents have 0 photos). 4-line server check. |
| 8 | **Access-token revocation** — add `jti`, check `revoked_tokens` in `requireAuth` | `apps/api/src/middleware/auth.ts:26-59` | 1 | Compliance red flag; blocks any serious security review. |
| 9 | **Global Express error handler + sanitize Postgres `err.message`** | `apps/api/src/index.ts` + every `res.status(500).json({ error: err.message })` | 1 | Stops info-leak via 500 responses. Unifies error shape. |
| 10 | **TOTP 2FA for `company_admin` and `vishnu`** | `apps/api/src/routes/auth.ts`, new `admin_mfa` table, `apps/web/app/admin/login/page.tsx` | 2 | Single most embarrassing gap for a security product. Table-stakes in every enterprise RFP. |

**Total**: ~11.25 eng-days (~2.5 weeks) for blockers 1–10 post-verification. CB7/CB8/CB10 were reclassified MAJOR (see above) because they're productization risks, not refund/lawsuit triggers — they live in the follow-on list, not the critical list.

**Stretch (next 2–4 weeks after the critical list lands)**: Sentry; Vitest + CI; Stripe integration; password-rule unification (zxcvbn + HIBP); `pg_advisory_lock` on crons + `cron_runs` table; `POST /api/sites` retention-row fix + backfill; `strict: true` in web tsconfig; business-event audit log; mobile forced-update gate.

**Stretch** (next 2–4 weeks): `strict: true` in web tsconfig, mobile forced-update gate, business-event audit log, report photo URL validation, OTP brute-force lockout, i18n scaffolding, license tracking.

**Marketing/sales** (parallel): public landing page, pricing page, ToS page, email templates, onboarding flow, admin invite flow.

---

## Verdict — is this ready to sell?

**Not at $149/site/mo self-serve. Yes at $400–600/site as a high-touch deployment.**

The honest read: today V-Wing is a well-architected *custom build* for 1–3 design partners. The domain model is good, the retention pipeline is better than most legacy competitors, and the mobile chain-of-custody enforcement is genuinely ahead of TrackTik. The gaps that prevent self-serve pricing are productization gaps (billing, signup, marketing, 2FA, tests, monitoring), not architectural ones.

Two paths forward:

1. **Productize to SaaS** — 3–4 weeks to close CB1–10, then 4–8 more weeks for the top 5 major items. Then the $149 price makes sense because the motion is self-serve.

2. **Stay high-touch** — raise the price, pitch it as managed, and ride the 1–3 design partners to revenue while you close gaps behind a support contract. Lower risk, slower growth, different business.

Either path is viable. The path that is **not** viable is "launch publicly at $149 self-serve tomorrow" — you will lose data (CB1, CB2, CB3), leak credentials (CB4, CB5, CB6), have no way to detect it (CB8), no way to stop it (CB9), and no way to get paid for the accounts that survive (CB10).

Close the critical blockers first. Then pick a path.

---

## Path-decision prerequisites

*The set of work required regardless of which monetisation path you pick. These are the items where "I'll fix it after I sign the first customer" is not a viable answer — because the first signed customer is the exact event that triggers the downside.*

### Non-negotiable for BOTH high-touch ($400–600/site managed) and self-serve ($149/site SaaS):

| # | Status | Item | From | Why it's unavoidable |
|---|---|---|---|---|
| 1 | ✅ CLOSED | `total_hours` computed on auto-complete | CB1 → `WEEK1.md` §C1 | Hourly billing is broken. High-touch customers notice faster because they review invoices line-by-line. |
| 2 | ✅ CLOSED | Atomic clock-out + partial unique index on open sessions | CB2, CB3 → `WEEK1.md` §C2 | "Ghost guard" UI bug is the kind the customer sees and screenshots. The e2fec53 workaround hides it; it doesn't fix it. |
| 3 | ✅ CLOSED | Fail-closed CORS + move client PDF JWT off the query string | CB4, CB5 → `WEEK1.md` §C3, §C4 | Deploy-rollback credential leak. One rollback, any origin CSRF-able; one screenshot-in-log, any client JWT replayed. |
| 4 | ✅ CLOSED | Access-token revocation check | CB6 → `WEEK1.md` §C5 | Fired admin keeps access until JWT `exp`. This is a story no pitch survives. |
| 5 | ⏳ HELD | Rotate the burned Google Maps key + add restrictions | CB10 (V2) | Quota-drain / billing abuse is silent and continuous until the key is rotated. **Held by user directive** — Google Cloud Console action required; rotation script ready in `audit/WEEK1.md` §A. |
| 6 | ✅ CLOSED | S3 byte-level upload validation + size cap | CB7 (V6) → `WEEK1.md` §D1+§D2 | Every guard account is a free malware-hosting endpoint today. Liability regardless of motion. Live S3 round-trip verification (`test-d2-magic-live.ts`) still pending Railway shell run. |
| 7 | ⏳ HELD | BIPA compliance surface (notice + consent + deletion) | CB8 (V7) | Statutory damages per-guard. Does not care whether the contract is $149 or $600. **Held by user directive** — do not start until explicitly unblocked. |
| 8 | ✅ CLOSED | Incident-report photo rule server-side | Major (V5) → `WEEK1.md` §C6 | The headline feature is "photo-verified patrol reports." The rule is already bypassed in prod. |
| 9 | ⏳ OPEN | `POST /api/sites` creates retention row | Major (V4) | Silent-no-purge for one existing site. Retention SLA quietly broken for every site created through the broken code path. **Not yet in Week-1 scope.** |

**Closed in Week-1 (rev 2026-04-24)**: items 1, 2, 3, 4, 6, 8 (six of nine). **Remaining**: items 5 (Maps key — held), 7 (BIPA — held), 9 (retention row — Week-2 scope).

**Total remaining**: ~3.5 eng-days for items 5+9 (item 7 BIPA is a separate ~3-day scope tracked under CB8). With items 5 and 9 closed and BIPA gated to non-IL/TX/WA/NY pilots, the high-touch path is signable.

### Additional prerequisite for self-serve ($149/site SaaS) path only:

| # | Item | From | Why only for self-serve |
|---|---|---|---|
| A | TOTP 2FA for admin | CB9 | Self-serve = you don't know who's signing up. MFA is the minimum guarantee that account takeover isn't your fault. |
| B | Stripe integration | CB10 (reclassified MAJOR) | No Stripe, no self-serve. Period. |
| C | Public marketing / signup / ToS pages | Phase 5 C1 | You cannot say "sign up at vwing.tld" without these. |
| D | Sentry + basic uptime SLO | CB8 (reclassified MAJOR) | A self-serve customer can't email you for support at 2am. You need to know *before* they do that something is wrong. |
| E | Admin invite flow (not super-admin-gated) | Phase 8 | Primary admin must be able to invite their team; this is a $149/mo basic expectation. |
| F | Automated tests on critical paths | CB7 (reclassified MAJOR) | Self-serve velocity = multiple deploys per week. Without tests, regression probability is 100% over a year. |
| G | Mobile forced-update gate | Phase 6 M3 | Breaking API changes without a client-update signal. Self-serve fleet is impossible to coordinate with by email. |

**Additional**: ~15 eng-days (~3 weeks) on top of the shared prerequisites for the SaaS path — total ~5 weeks of engineering before self-serve launch is honest.

### Interpretation

- **If you take the high-touch path**: the 9-item shared list is your definition of "ready to sign." After it lands, start selling design partners at $400–600/site. Use revenue to fund the SaaS list.
- **If you take the self-serve path**: the shared + SaaS additional = ~5 weeks before launch. Anything less and the launch creates legal / abuse / retention / support exposure that an early customer will trigger.
- **Either way, the 9-item shared list is non-skippable.** Don't let a "first signed customer" deadline turn into a decision to ship with any of these open.
