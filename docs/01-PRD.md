# NetraOps — Product Requirements Document

> **Status**: Draft v1 · 2026-05-16
> **Audience**: Product stakeholders, investors, new hires, procurement teams.
> **Source of truth**: This document. When it conflicts with `AGENTS.md` or `PRODUCTION_CHECKLIST.md`, prefer this PRD; treat those legacy files as historical.

---

## 1. Executive Summary

NetraOps is a multi-tenant SaaS platform for the operations side of physical-security work: scheduling, tracking, verifying, and reporting on guard shifts. It replaces the patchwork of paper logs, SMS check-ins, and spreadsheets that mid-market security companies still rely on with a single mobile + web system that proves where guards were, when, and what they observed.

The platform serves three distinct user roles: **security-company admins** (who run the operation), **guards** (who walk the posts), and **end clients** (who hire the security company and want auditable proof of service). All three groups touch the same shifts and reports from different angles, with strict tenant isolation by `company_id` and read-only scoping for clients.

NetraOps is built for the company that doesn't have a TrackTik-sized budget but has outgrown shared spreadsheets — typically 10 to 200 guards, 5 to 50 sites, on monthly recurring contracts with their end clients. The competitive thesis: most incumbents focus on the guard-facing time-clock; NetraOps focuses on the proof layer (photos, geofence-bound coordinates, magic-byte-verified uploads, idempotent transactions) that turns "we say the guard was there" into something a client can audit.

## 2. Problem Statement

Mid-market security companies operate in an evidence gap. They bill their clients on the promise that a guard was at the post, on time, in uniform, and responsive to incidents — but the evidence chain is usually a paper log, a WhatsApp message, or a screenshot of an SMS. When something goes wrong — a slip-and-fall at the protected property, a theft on the watch, a labour-relations complaint about hours worked — neither the security company nor the client has tamper-evident proof of what happened.

Existing solutions don't close this gap cleanly for mid-market companies:

- **TrackTik, Silvertrac, Trackforce** dominate the upper mid-market and enterprise tier. They have the features but their pricing, onboarding cost, and configuration complexity assume an in-house ops team. A 30-guard company can't justify the lift.
- **Generic time-and-attendance apps** (Deputy, When I Work) handle the clock-in but have no geofence enforcement, no photo proof, no incident reporting, and no client-facing portal.
- **Paper logs and shared spreadsheets** are still the baseline at the small end. They scale until the first lawsuit.

The specific operational gaps NetraOps targets:

1. **Proof of presence** that survives challenge — server-side geofence validation against site polygons, GPS + photo at every clock-in and ping, EXIF GPS stripped from uploaded images so the photo's only location signal is the server-verified one.
2. **Tamper resistance on the upload pipeline** — magic-byte validation against declared MIME, presigned POST policies that pin Content-Type and size, quarantine-on-mismatch with forensics trail.
3. **A read-only client portal** so end clients can pull their own daily report, see live guards-on-duty, and download incident PDFs without having to call the security company.
4. **Configurable cadence and battery-aware throttling** so a 5-minute-cadence high-risk site and a 60-minute-cadence quiet residential site can run on the same platform, and a guard's phone making fewer pings under low battery is reported as "throttled" instead of "missed."

## 3. Target Users

### 3.1 Security-Company Admin (Operations Manager / Dispatcher)

**Goals**: Schedule shifts, monitor live status, triage incidents, generate client invoices, prove SLA compliance.

**Pain points before NetraOps**:
- "Did the guard actually show up?" — relies on a phone call, hopes the guard answers.
- Incident reporting arrives by text or in person, with no photo trail and no timestamp.
- Client demands a "report" — produces a manual export from a spreadsheet that the client can't verify.

**Primary workflows**: Schedule shift → Assign guard → Watch live map → Receive incident push → Triage incident → Approve/escalate → Daily report sent to client at 9 AM.

**Where they live in the product**: Admin Portal at `/admin/*` on the web app. Routes include dashboard, live-map, sites, guards, shifts, tasks, reports, analytics, clients (client-portal account management), billing, chat.

### 3.2 Guard (Field Worker)

**Goals**: Clock in on time, complete required photo proofs without friction, submit reports when something happens, get paid for the hours worked.

**Pain points before NetraOps**:
- Manual time sheets that the company sometimes disputes ("we didn't see you on duty between 2 and 4 AM").
- No structured way to report what they observed during the shift — relies on memory and a phone call.
- No visibility into their own schedule and pay calculation.

**Primary workflows**: Login → See today's shift → Walk to post → 4-step clock-in (GPS verification → selfie → site photo → confirm) → Active shift with 30-minute (configurable) ping prompts → Submit incident or activity reports as needed → Complete assigned tasks → Clock out with handover notes.

**Where they live in the product**: Mobile app (iOS via TestFlight, Android via Google Play internal track). Built on Expo SDK 54 / React Native 0.81.

### 3.3 End Client (Site Owner / Property Manager)

**Goals**: Confirm guards were on duty, see incident reports as they happen, pull a daily PDF for their own records, get a heads-up before the 90-day data window closes.

**Pain points before NetraOps**:
- The security company sends a monthly invoice with no underlying evidence — the client either trusts it or doesn't.
- Incidents are reported by phone, with no log of who reported what when.
- Clients running multiple security contracts have no way to compare service quality.

**Primary workflows**: Receive daily 9 AM summary email → Open client portal when something looks off → View reports scoped to their own site only → Download daily PDF → Receive instant email on incident submission.

**Where they live in the product**: Client Portal at `/client/*` — read-only, site-scoped JWT, no edit capability.

### 3.4 Super Admin / Platform Operator (Vishnu)

**Goals**: Onboard new security companies, monitor data retention compliance, manage platform-wide settings, handle escalations.

**Workflows**: Onboard a new company → Create the primary admin account → Watch the retention table for sites approaching the 60/90/150-day boundaries → Override defaults (photo limits, instructions PDFs) per-site when needed.

**Where they live in the product**: Super Admin Portal at `/vishnu/*`. Authentication is intentionally distinct from the company-admin path — uses env-var credentials (`VISHNU_EMAIL` / `VISHNU_PASSWORD_HASH`) and a sentinel UUID, not a row in a users table. Single operator today; future multi-operator is a roadmap item, not a current capability.

## 4. Core Value Propositions

What NetraOps does well that the incumbents and the generic apps don't:

### 4.1 Proof That Survives Challenge

NetraOps doesn't ship a "Visual Intelligence" product feature. It ships **trustworthy photo evidence**. Every photo — ping, clock-in selfie, site photo, incident attachment, task-completion proof — is:

- Captured within a geofence-validated location context (server-side polygon + radius check at clock-in; per-ping geofence reconciliation)
- Stripped of EXIF metadata before it reaches the server (native pipeline in `expo-image-manipulator` re-encodes the bitmap and discards GPS / device fields as a side effect, confirmed by source analysis of iOS `UIImage.jpegData` and Android `Bitmap.compress`)
- Validated server-side at the byte level against its declared MIME ([apps/api/src/services/imageMagic.ts](apps/api/src/services/imageMagic.ts)) — bytes that claim to be `image/jpeg` but look like ZIP, HTML, or PHP get quarantined ([apps/api/src/db/schema_v11.sql](apps/api/src/db/schema_v11.sql)) and never enter the data plane
- Bound to a shift session with a full audit trail (who, when, where, what device, what cadence)

That capability bundle is what we call **Visual Intelligence** in marketing. *It is a positioning frame for capability already shipped, not a separate feature.* No code is gated behind the name; no roadmap item builds it; it is shorthand for the existing pipeline described above.

### 4.2 Operational Resilience

The platform assumes the field is messy: phones die, signal drops, guards double-tap. The platform handles these without dropping data or double-charging.

- **Idempotency-Key header on clock-in** ([apps/api/src/services/idempotency.ts](apps/api/src/services/idempotency.ts)): retried POSTs replay the cached response instead of creating a duplicate shift.
- **Partial unique index** on `shift_sessions(guard_id) WHERE clocked_out_at IS NULL` ([apps/api/src/db/schema_v9.sql:17-19](apps/api/src/db/schema_v9.sql:17)): data-integrity backstop when the cache misses.
- **Battery-aware ping throttling** ([apps/mobile/lib/batteryThrottle.ts](apps/mobile/lib/batteryThrottle.ts)): under 20% battery or Low Power Mode → cadence doubles; under 10% → triples. Throttle reason is stamped on each ping row, so a client portal can show "throttled due to low battery" instead of "missed ping."
- **Offline queue** on mobile: failed submissions persist locally and sync when connectivity returns ([apps/mobile/lib/offlineQueue.ts](apps/mobile/lib/offlineQueue.ts)).

### 4.3 Configurable Cadence Per Site

The platform doesn't assume one cadence fits every site. `sites.ping_interval_minutes` (5–240, default 30) ([apps/api/src/db/schema_v14.sql](apps/api/src/db/schema_v14.sql)) lets an admin dial high-risk sites to 5-minute pings and quiet sites to 60-minute pings. The mobile reads the cadence at clock-in time and persists it for the shift's lifetime — admin edits mid-shift don't disturb in-flight work.

### 4.4 Tenant-Isolated Multi-Tenancy

Every data-bearing query scopes by `company_id`. A security company's admins cannot see another company's guards, sites, or reports. Clients cannot see another client's reports — JWTs are site-scoped. Super admin is the only role with cross-tenant read.

## 5. In-Scope Features (Tier 1 — Shipped)

The following are present in the codebase as of commit `fa01481` (2026-05-16), with eleven recent commits closing prior-session audit findings.

| Capability | Where shipped | Evidence |
|---|---|---|
| Three-portal web app | `/admin`, `/client`, `/vishnu` Next.js routes | `apps/web/app/` |
| Mobile guard app on Expo SDK 54 / RN 0.81 | iOS via TestFlight, Android via Play internal track | `apps/mobile/package.json` |
| JWT auth (access + refresh) with revocation list | All three portals + mobile | `apps/api/src/routes/auth.ts`, `apps/api/src/middleware/auth.ts` |
| Server-side geofence validation at clock-in + verification | Polygon-first ray-cast + center/radius fallback with accuracy budget | Commit `0656df7` |
| Photo upload pipeline | S3 presigned POST (content-length + Content-Type pinned), magic-byte validation, EXIF stripped by ImageManipulator native pipeline, quarantine table | Commits `e036482`, `16c3ee6` |
| Idempotency on clock-in | `Idempotency-Key` header with in-process LRU cache | Commit `bd3efee` |
| Configurable ping cadence per site | `sites.ping_interval_minutes` (5–240, default 30) | Commit `5a21320` |
| Battery-aware ping throttling | Hysteresis state machine, banner UX, `throttle_reason` written to each ping | Commit `16d9649` |
| Sentry crash and error reporting | Both mobile and API, with scrubber for PII / secrets / S3 signatures | Commits `7f64a1f`, `e0516b6` |
| Incident reports with severity | 4-tier (`low`/`medium`/`high`/`critical`), instant client email on submit | `apps/api/src/db/schema.sql:116-117`, `apps/api/src/routes/reports.ts` |
| Activity & maintenance reports | Optional photos, queued for daily 9 AM client digest | `apps/mobile/app/reports/new.tsx` (unified form) |
| Task templates and instances | Per-site recurring tasks, photo proof when required | `apps/api/src/services/tasks.ts`, schema task_* tables |
| Real-time admin ↔ guard chat | Per-site rooms, push notifications, unread badge | `apps/api/src/routes/chat.ts` |
| Push notifications via FCM | Foreground + background, tap routing into specific screens | `apps/api/src/services/firebase.ts`, `apps/mobile/lib/navigateForNotification.ts` |
| Background geofence monitoring | expo-task-manager + breach push | `apps/mobile/tasks/locationBackground.ts` |
| Daily 9 AM client digest email | SendGrid, anchored to America/Los_Angeles wall clock | `apps/api/src/jobs/dailyShiftEmail.ts` |
| Live map (admin portal) | Polling-based guard location display | `apps/web/app/admin/live-map/page.tsx` |
| PDF + XLSX export | Admin can pull a report range; client can pull daily PDF | `apps/api/src/routes/exports.ts` |
| Server-side AI report enhancement | `POST /api/ai/enhance-description` proxies to Claude Sonnet 4.5 (model ID overridable via `ANTHROPIC_MODEL` env without redeploy); rewrites a guard's raw description into a professional security-report entry. Available to guard + company_admin roles. Optional — if the upstream call fails, the guard can still submit the raw description and the report goes through. | `apps/api/src/routes/ai.ts` |
| Data retention model | 90-day client window, 60-day admin window, 150-day delete | schema_v3-v7, `apps/api/src/jobs/nightlyPurge.ts` |
| Privacy policy + terms pages | Public, BIPA-aware language for biometric login | `apps/web/app/privacy/page.tsx`, `apps/web/app/terms/page.tsx` |

## 6. Out-of-Scope Features (Tier 2 / Deferred)

Explicitly not in the platform today. Some are planned; some are intentional non-goals for now.

| Feature | Status | Notes |
|---|---|---|
| Stripe billing integration | Deferred | Admin Portal has a `/admin/billing` page scaffolded; payment processing not wired |
| 2FA on admin or super admin | Deferred | JWT + password only today; admin web is the priority target |
| Twilio SMS OTP | Deferred | Forgot-password uses email-only flow |
| Photo annotation tool (draw circles/arrows on photos) | Deferred indefinitely | No customer ask yet |
| 3-strike geofence escalation screen | Deferred | Server-side validation is in; the supervisor-contact UX layer is a follow-up |
| Admin UI to set `ping_interval_minutes` | Deferred | Operator workaround: direct SQL `UPDATE sites SET ping_interval_minutes = N WHERE id = '<uuid>'` |
| Admin UI for `quarantined_uploads` review | Deferred but urgency raised | Three endpoints now write to this table; SQL review is the only access today |
| Continuous Training Module *(working title — shaping language for a deferred feature)* | Roadmap | Not yet built. Intended shape: 1–3 minute briefing video or text card pushed to the guard at shift start, acknowledgement required before clock-in completes; trackable in admin portal for compliance audits. The "Continuous Training Module" name is internal shaping language; it will be reviewed before any external publication and is not a shipping product name today. |
| Resilience Dashboard *(working title — future-state framing for capability not yet built)* | Roadmap | Not yet built. Intended shape: admin-side view of system health from the operator's perspective — missed pings explained by `throttle_reason`, devices in low-battery state, geofence violations vs. exceptions. The "Resilience Dashboard" name describes a future product surface that does not exist today; it is positioning language, not an in-scope feature. |
| Retention cron firing against real data | Deferred until September 2026 | The cron exists (`apps/api/src/jobs/nightlyPurge.ts`) and runs nightly, but no records have crossed the 150-day boundary yet because the platform is younger than that |
| AI-driven anomaly detection / predictive alerting | Long-term | Not started |
| Multi-region deployment | Long-term | US East only |
| Visitor management module | Long-term | Adjacent product, not in current scope |
| Public API + webhooks | Long-term | Internal API only today |
| White-label / co-branded mobile apps | Long-term | Single tenant brand (NetraOps) |
| SOC 2 Type II audit | Roadmap | Readiness program not yet kicked off |
| HIPAA-readiness for healthcare vertical | Long-term, vertical-gated | No healthcare customer yet |
| BIPA compliance for biometric-on-device | Deferred decision | Mobile uses Face ID/Touch ID locally; biometric templates never transmitted; the formal BIPA stance is still pending Vishnu's decision |

## 7. Success Metrics

What "working" looks like, per persona:

**Security-Company Admin**
- Time from clock-in to seeing a guard on the live map: under 10 seconds.
- Daily 9 AM digest delivered before the admin's first cup of coffee, no manual export.
- Incident from submission to admin push notification: under 60 seconds.
- Per-site monthly billing recoverable from the platform without spreadsheet work — pending Stripe integration.

**Guard**
- 4-step clock-in flow completable in under 90 seconds on a real device.
- Zero "Clock-In Failed" alerts for a guard who is physically at the post — the 422 GEOFENCE_FAILED only fires for off-post attempts.
- Battery throttling visible (banner present, banner cadence accurate) when triggered, so the guard understands why the ping interval changed.
- Offline queue drains within 30 seconds of connectivity returning.

**End Client**
- Daily PDF arrives at the registered email address by 9:05 AM local time.
- Incident email arrives within 60 seconds of guard submission.
- Client portal load-to-readable-report under 3 seconds on a desktop browser.
- Zero data leakage across sites (verified by IDOR-style test, [apps/api/scripts/test-idor-replay.ts](apps/api/scripts/test-idor-replay.ts)).

**Super Admin / Platform Operator**
- Onboarding a new security company is a single-evening operation: company row, primary admin, first site, geofence polygon.
- Retention table on `/vishnu/retention` accurately reflects the 60/90/150-day boundaries for every site.
- Sentry signal-to-noise is right: errors get captured, expected events (geofence rejections, idempotent replays) do not pollute the issue feed.

## 8. Competitive Positioning

> **DRAFT — needs Vishnu sign-off against v2 deck.** This section is reconstructed from the Tier-1 audit conversation and should be reconciled with `NetraOps_Competitive_Strategy_v2.pptx` before being treated as final.

Primary competitors in the guard-management SaaS category: **TrackTik**, **Silvertrac**, **Trackforce**. All three are well-established, enterprise-sales-led, and price for the upper-mid-market. Generic time-tracking apps (Deputy, When I Work) are the substitute in the small end of the market.

The messaging arc for NetraOps moves through three positioning frames as the product and the customer conversation evolve:

1. **"Military Precision"** *(early stage)* — emphasizes the hardness of the proof layer: geofence-bound photo, magic-byte upload validation, transactional clock-in, idempotency. Lands well with security companies whose clients are insurance-conscious.
2. **"Visual Intelligence"** *(current stage)* — frames the existing photo-handling pipeline as a category-defining capability: every clock-in, every ping, every incident anchored to a server-verified location and a tamper-validated image. The competitors have time-stamps; NetraOps has provenance.
3. **"Operational Resilience"** *(forward stage)* — repositions configurable cadence, battery throttle reporting, offline queue, and idempotency as operator-grade reliability. The pitch shifts from "we prove the guard was there" to "we run a platform that doesn't drop data when the field is messy."

The seven-gap analysis from the v2 deck (AI/predictive alerting, IT-OT convergence, ESG reporting, etc.) is the long-horizon roadmap that justifies a higher-than-incumbent price for the segment of mid-market companies whose end clients (corporate real estate, healthcare, regulated industrial) demand audit-grade evidence.

## 9. Compliance & Trust Posture

**Current state (honestly):**

| Area | Status |
|---|---|
| SOC 2 | Not started. Pre-revenue platform. SOC 2 Type II readiness will commence prior to first enterprise (revenue ≥ $50K ARR) customer contract. |
| GDPR alignment | Privacy policy is GDPR-aware (data subject rights, retention disclosure, third-party listing). No active EU users; no DPO appointed. |
| BIPA / state biometric privacy | NetraOps captures biometric-adjacent data (selfies, geolocation tied to identity) in some workflows. We have not yet made a determination on whether Illinois BIPA, Texas CUBI, or similar state-level biometric privacy statutes apply to our use case. We have not enrolled customers in Illinois pending this decision. Face ID / Touch ID on the mobile app is local-only — biometric templates remain on-device and are never transmitted. |
| HIPAA | Not in scope. No healthcare customer; HIPAA-readiness is a vertical-gated future investment. |
| Data retention | The retention model — 90 days full client + admin access → 60 days admin-only → permanent deletion at day 150, plus a separate 7-day rolling deletion for ping photos — is implemented in code (schema + `apps/api/src/jobs/nightlyPurge.ts`). **The scheduled job has not yet processed real customer data.** The first scheduled run that crosses the 150-day boundary occurs in September 2026, at which point the retention model becomes load-bearing. Pre-flight verification of the cron behaviour against real data is on the Implementation Plan. |
| Encryption at rest | Railway-managed Postgres encryption; AWS S3 default encryption on `starguard-media` bucket. |
| Encryption in transit | HTTPS-only across all surfaces; CORS fail-closed via `ALLOWED_ORIGINS` ([apps/api/src/index.ts:63-71](apps/api/src/index.ts:63)). |
| Photo metadata stripping | EXIF removed by the Expo `ImageManipulator` native pipeline (iOS `UIImage.jpegData`, Android `Bitmap.compress`), confirmed by source-code analysis. Empirical verification (run exiftool on a fresh S3 object) is on the TestFlight verification list. |
| Idempotency / data integrity | At-most-once semantics on clock-in via `Idempotency-Key` header + 10-minute in-process LRU; partial unique index on `shift_sessions` as the data-integrity backstop. |
| Error monitoring / observability | Sentry on both mobile and API with PII scrubber (passwords, tokens, Authorization headers, S3 presigned-URL signatures, JWT secrets, AWS keys, SendGrid keys). Sentry Business Plan Trial active, expires approximately 2026-05-30 — decision to upgrade or downgrade required before that date. |

## 10. Open Questions

Items where the codebase or the brief leaves ambiguity that needs Vishnu's call:

1. **Competitive positioning section** is reconstructed from prior conversation, not from the v2 deck file. Should be reconciled before this PRD is shown externally.
2. **BIPA stance** is unwritten. The mobile app may need an explicit consent screen / in-app disclosure for IL/TX/WA users even though biometrics stay on-device.
3. **Stripe billing timeline** is named in the Implementation Plan but no first-customer date is committed. Affects how aggressively the `/admin/billing` page is built out.
4. **Continuous Training Module / Visual Intelligence / Resilience Dashboard** are working titles only. Marketing/naming review pending before docs reference them as canonical.
5. **Retention cron firing against real data** has a September 2026 deadline (oldest records cross the 150-day mark). The cron has never fired against real production data — when it does, the first run is a one-way operation. Pre-flight verification plan needed.
6. **Healthcare/HIPAA vertical** decision: pursue, defer, or rule out. Has implications for SOC 2 scope and BAA requirements.

---

## DRIFT FINDINGS

Documentation drift discovered during research for this PRD. Each entry is actionable — not for this session, but for follow-up alignment commits.

| Finding | Severity | Suggested action | Owner |
|---|---|---|---|
| Two production tables (`chat_rooms`, `chat_messages`) exist in the live Railway database but are not reproducible from the committed migration files. See **TRD §Known Technical Debt** and **Implementation Plan §Immediate Backlog** for depth. | Operational + Recovery | Treated in TRD and Implementation Plan | TRD covers root cause; Implementation Plan covers the `schema_v15.sql` remediation |
| `AGENTS.md` Week-1 phase status (lines 48–54) lists Phase C "IN PROGRESS" and Phase D "PENDING"; both shipped (Phase C via prior CB-fix commits, Phase D via `e036482` + `16c3ee6` + the prior s3.ts hardening). | Operational | Focused alignment commit removing/updating the "Current focus" block | Follow-up session — same pattern as `d3f37b1` |
| `AGENTS.md:10` claims "22 tables." `PRODUCTION_CHECKLIST.md:30` claims "19-table schema." Real count is 25 (see Schema doc for full enumeration). | Cosmetic | Update both files to 25 in the AGENTS.md alignment commit | Follow-up session |
| `PRODUCTION_CHECKLIST.md` is significantly stale: references `guard.com` domain (real: `netraops.com`), `guard-media-prod` S3 bucket (real: `starguard-media`), 5-minute ping cadence (real: 30 default, configurable per site), no mention of Sentry, idempotency, magic-byte validation, server-side geofence. | Operational | Rewrite `PRODUCTION_CHECKLIST.md` to reflect current state — NetraOps branding, `starguard-media` bucket, 30-min default cadence, current schema, Sentry, idempotency, magic-byte validation, server-side geofence, current 11-commit baseline. Treat the existing file as legacy and not authoritative. | Focused follow-up commit (decision needed: full rewrite vs. delete-and-replace) |
| `PRODUCTION_CHECKLIST.md:33` instructs operators to seed super admin via `INSERT INTO vishnu_admins (...)`. No `vishnu_admins` table exists. Super admin auth uses env vars (`VISHNU_EMAIL`, `VISHNU_PASSWORD_HASH`) and a sentinel UUID — see [apps/api/src/routes/auth.ts:316-331](apps/api/src/routes/auth.ts:316). | Operational | Remove the SQL from the checklist; document the env-var path in the rewritten version | Same follow-up commit as the broader rewrite |
| Sentry mobile project slug: `apps/mobile/app.json:80-81` declares `project: "netraops-mobile"` but the actual Sentry project slug is `react-native` (Sentry default). Source-map upload may have been silently failing since the first build. | Operational | Rename the Sentry project to `netraops-mobile` in Sentry's UI to match the code. Add to Implementation Plan's Immediate Backlog to verify source-map upload works after the rename. | Vishnu (operator-side action in Sentry UI) |
| Both `apps/api/package.json` and `apps/web/package.json` are still named `@v-wing/*` (legacy V-Wing branding). Mobile is `@guard/mobile`. Three naming conventions in one monorepo. | Cosmetic | Coordinated rename to `@netraops/api` and `@netraops/web` (and consider renaming `@guard/mobile` → `@netraops/mobile` for full consistency). Requires updating internal imports, possibly Railway service name, CI references. | Focused PR, requires Vishnu's call on the target naming convention |
| Three Tier-2 features (Visual Intelligence, Continuous Training Module, Resilience Dashboard) are working titles only — used in this PRD but not yet reviewed for marketing/naming. | Cosmetic | Marketing/naming review before any external publication. Tag remains "working title" until reviewed. | Vishnu |

---

*End of PRD. Word count: ~2,400. Next document: TRD (Technical Requirements Document).*
