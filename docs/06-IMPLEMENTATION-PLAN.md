# NetraOps — Implementation Plan

> **Status**: Draft v1 · 2026-05-16
> **Audience**: Future Vishnu, future Claude Code sessions, anyone joining the team and asking "what's next."
> **Companion**: Read alongside `01-PRD.md` (product framing), `02-TRD.md` (technical state), `03-UX-DESIGN.md`, `04-APP-FLOW.md`, `05-BACKEND-SCHEMA.md` (the substrate). This document is the synthesis layer — what's done, what's owed, what's next.

---

## 1. Current State

### What's shipped (as of commit `948da3d`, 2026-05-16)

**Eleven code commits** from the prior session, all on `main`, all verified to build:

| SHA | Subject |
|---|---|
| `7f64a1f` | `feat(mobile): wire Sentry crash reporting with user context tags` |
| `e0516b6` | `feat(api): wire Sentry error reporting with request context` |
| `6613d85` | `fix(mobile): remove stale ping alternation label` |
| `0656df7` | `fix(api,mobile): server-side geofence validation at clock-in and verification` |
| `e036482` | `docs(mobile): document EXIF strip contract on photo upload paths` |
| `bd3efee` | `feat(api,mobile): idempotency on clock-in via Idempotency-Key header` |
| `16c3ee6` | `fix(api): magic-byte validation on ping and clock-in-verification photo uploads` |
| `d3f37b1` | `docs: align AGENTS.md ping description with current behavior` |
| `5a21320` | `feat(api,mobile): configurable ping cadence per site (schema_v14)` |
| `16d9649` | `feat(mobile,api): battery-aware ping throttling with low-battery banner` |
| `fa01481` | `fix(mobile): correct Sentry org slug to netraopscom` |

**Plus seven documentation commits** in this session, all on branch `docs/platform-documentation`:

| SHA | Doc |
|---|---|
| `5ef5d20` | `docs: PRD for NetraOps platform` |
| `3185f08` | `docs(prd): add server-side AI report enhancement to in-scope features` |
| `35279c9` | `docs: TRD covering architecture, security, observability` |
| `de88034` | `docs: UI/UX design system and screen inventory` |
| `c02ba7b` | `docs(trd): note task-completion magic-byte coverage gap` |
| `9cff40b` | `docs(trd): widen chat-table orphan finding to four tables; correct PG version` |
| `d509f2c` | `docs(trd): correct password_reset_tokens characterization in §10.1` |
| `706e3e7` | `docs: end-to-end app flows for guard / admin / client` |
| `948da3d` | `docs: backend schema and migration history` |

### The documentation-writing process surfaced five production findings that were not in any prior audit

This is the headline of the Immediate Backlog. The docs effort wasn't paperwork — it was an audit-by-fresh-read with concrete, actionable output. The five findings, in order of discovery:

1. **Migration runner doesn't auto-run on Railway deploys** — caught the night of the May 16 merge when `5a21320` shipped before its `schema_v14.sql` ran. Manual resolution via `railway run npm run db:migrate`; permanent fix is a one-line `package.json` edit.
2. **Four production tables have no committed migration file** — `chat_rooms`, `chat_messages`, `monthly_hours_reports`, `password_reset_tokens`. Three are live and code-referenced; one is dead schema. Original scope was 2 tables; widening discovered during the Schema doc read pass doubled it.
3. **`shifts.status` CHECK constraint widened in production without a migration** — `'unassigned'` is actively written by the shift-creation route; `'cancelled'` is half-implemented scaffolding. Same root cause as the orphan tables; bundles into the `schema_v15.sql` work.
4. **Task-completion endpoint skips magic-byte validation** — security regression hole. Three of four photo-upload endpoints run the validator; the fourth was missed during commit `16c3ee6`'s rollout.
5. **Railway rolled their managed PG floor from 16 to 18.3** between TRD authoring and the Schema doc's verification — `pg_dump 14` (the local client) can no longer dump from production. Operational caveat for the doc set and for any future schema-reproduction work.

All five are in §3 Immediate Backlog with concrete remediation, verification protocols, and "before what" triggers.

---

## 2. Verified vs. Unverified Work

Honest separation between what's been seen working in production versus what's still owed a real-device confirmation.

### Verified working

- **Sentry mobile capture path.** First real bug captured cleanly on initial install: a `watchPositionImplAsync` failure due to missing location permission. Tagged correctly with `device=iPhone 17 Pro arm64`, `OS=iOS 26.3.1`, `release=1.0.0 (17)`, `env=production`. The wiring is live; the scrubber is active.
- **SDK 54 baseline stability.** Mobile builds and runs on iOS via TestFlight without the Reanimated 4.x / Podfile crashes that plagued build #6.
- **Pre-existing audit-closing commits** (commits in the V6 audit thread before this session, e.g. presigned POST hardening, partial unique index on `shift_sessions`, JWT revocation, CORS fail-closed) — verified by the platform running for months.
- **Daily 9 AM PT email cron** — verified to fire correctly across the 2026-03 DST flip.
- **Configurable ping cadence (`schema_v14`)** — verified to work end-to-end after the manual `railway run npm run db:migrate` recovery; the May 16 incident's root cause was deploy timing, not the feature itself.

### Unverified, owed a TestFlight pass

The full list lives in the prior session's summary; restating here for the synthesis context:

| Item | Verification needed |
|---|---|
| Server-side geofence at clock-in (Item 3) | 3 scenarios: inside, 500m spoof, edge-of-radius — on real device |
| EXIF strip via ImageManipulator pipeline (Item 4) | Pull a fresh S3 photo, run `exiftool`, confirm no GPS/device metadata |
| Idempotency-Key replay on clock-in (Item 5) | 3 scenarios including the fresh-UUID confirmation via temporary console.log |
| Magic-byte validation on ping + clock-in-verification (Item 6) | Real photo path + deliberate bad-bytes path + legacy sentinel path |
| Battery-aware ping throttling (Item 7) | 4 scenarios: LPM toggle, drain to <10%, recovery above 30%, flapping check via Sentry breadcrumbs |
| Cadence per-site (Item 8) | Set site to non-default cadence, verify mobile reads + countdown updates; verify mid-shift edits do NOT disturb in-flight |
| Sentry source-map upload | Deliberately throw a JS error from a TestFlight build, confirm Sentry shows readable stack trace (not minified). Critical because of the project-slug discrepancy in app.json |

---

## 3. Immediate Backlog (0–2 weeks)

The five docs-surfaced findings plus operator-side launch tasks. Each item has a concrete trigger ("before what") and a verification protocol.

### 3.1 Migration runner doesn't auto-run on Railway deploys

**The incident**: On 2026-05-16, a production deploy of `main` shipped code referencing `sites.ping_interval_minutes` before the migration that added it ran. Railway's start command is `npm start`, which does not invoke `db:migrate`. Mobile showed "No scheduled shift" for an active James Vince shift while the admin portal showed it as active. Resolution: manually running `railway run npm run db:migrate` from the developer machine.

**Permanent fix**: edit [apps/api/package.json](apps/api/package.json) — change `"start": "node dist/index.js"` to `"start": "npm run db:migrate && node dist/index.js"`. This makes every deploy idempotent. Migrations that have already run are no-ops (every migration file is `IF NOT EXISTS`).

**Trigger**: **before the next deploy.** Single-file change.
**Verification**: deploy a change-of-no-consequence to `main`, watch Railway logs for `Running migrations... → schema.sql → ... → schema_v14.sql → All migrations complete.` before the API boot line.

### 3.2 `schema_v15.sql` — five distinct production-vs-migration drift items

**Scope** (more than doubled since the original 2-table framing):
- 3 live-orphan tables: `chat_rooms`, `chat_messages`, `monthly_hours_reports`
- 1 dead-schema-orphan table: `password_reset_tokens` (included for production parity, not because anything depends on it)
- 1 live CHECK widening: `shifts.status` — add `'unassigned'` (live writer at [apps/api/src/routes/shifts.ts:33](apps/api/src/routes/shifts.ts:33)) and `'cancelled'` (web scaffolding) to the enum

**Why this is one migration**: all five surfaced from the same root cause — hand-modified production schema not committed back. The remediation discipline is identical (`psql \d+` reconstruction since local `pg_dump 14` can't read PG 18.3) and verification is one operation (fresh local Postgres → `npm run db:migrate` → app boots end-to-end with `/health` returning ok + admin creates an unassigned shift without 23514).

**Header comment on the migration file** (per TRD §10.1):
> "These items existed in production as of 2026-05-16 but had no committed migration counterpart. Captured via `psql` against Railway production. Fresh-deploy reproduction depends on this file. The original timestamps and any historical rows for these tables are NOT in this migration — this file reproduces the schema, not the data. Data restoration is via Railway snapshots."

**Trigger**: **before disaster recovery is needed**. The current state is "if the Railway snapshot restore happens today, the chat surface, monthly-hours cron, forgot-password (silently — table is dead), and admin shift creation all break until a developer hand-runs the missing schema."

**Verification protocol**: Docker `postgres:18-alpine` container locally → `DATABASE_URL` pointed at it → `npm run db:migrate` runs cleanly → `npm start` → curl `/health` returns ok → via admin web, create a shift without a guard (expects `status='unassigned'` insert without 23514) → via mobile or psql, confirm chat tables exist and the chat route returns 200 (not 500) for a guard with an existing room. If all six checks pass, the migration is good.

### 3.3 Task-completion magic-byte coverage gap

**Finding**: `POST /api/tasks/instances/:id/complete` ([apps/api/src/routes/tasks.ts:40-73](apps/api/src/routes/tasks.ts:40)) accepts a `photo_url` directly into INSERT with zero byte validation. Verified by grep: `validatePhotoOrQuarantine`, `isAllowedContentType`, `magicMatches`, `s3KeyFromPublicUrl` — none referenced in `tasks.ts`. Same presigned-POST architecture as reports/ping/clock-in-verification, so a guard with a valid JWT can POST arbitrary bytes (PHP, HTML, ZIP) to S3 and link them into `task_completions.photo_url`.

**Remediation**: extend `validatePhotoOrQuarantine` to the task-completion endpoint. ~15-line addition mirroring the pattern in `apps/api/src/routes/locations.ts` (ping + clock-in-verification). Same `quarantineIfBadMagic`-then-INSERT structure.

**Trigger**: **before any new customer rollout.** Existing customer (single, in onboarding) is low risk; expanding the user base raises the abuse surface.
**Verification**: deliberately upload non-image bytes (rename a `.txt` to `.jpg`, raw-curl to a presigned POST URL, submit to task-completion). Expect 400 + `quarantined_uploads` row inserted.

### 3.4 `quarantined_uploads` admin review UI

**Finding**: three endpoints now write to this table (reports, ping, clock-in-verification — and a fourth after §3.3 ships). No admin surface exists to review the rows. Today's only access is direct SQL: `SELECT * FROM quarantined_uploads ORDER BY detected_at DESC LIMIT 50;`.

**Why urgency increased**: at three (soon four) writers, the table accumulates rows that no operator reads. The first time a customer asks "is my guard trying to upload malicious files?", the answer requires a Vishnu psql session. Better to have a one-page admin view.

**Remediation**: a single page in the Super Admin Portal (`/vishnu/quarantine`) listing the last 50 rows with filters by `guard_id` / `company_id` / `detected_magic`. Read-only forensics view; no edit capability needed.

**Trigger**: **before SOC 2 readiness program**. Auditors will ask "how do you review suspected malicious uploads?" Direct-SQL answer fails the audit.

### 3.5 Admin API + UI for `ping_interval_minutes`

**Finding**: per-site cadence (Item 8) is settable today only via direct SQL: `UPDATE sites SET ping_interval_minutes = N WHERE id = '<uuid>';`. The schema enforces 5–240 minute bounds, but no API endpoint or web form exists.

**Remediation**: `PATCH /api/sites/:id` accepting `{ ping_interval_minutes }` with role gate `requireAuth('company_admin')` and `requirePrimaryAdmin` for non-default values. Admin form in `/admin/sites/[id]/edit` exposing the field with a labeled input "Ping cadence (minutes)" plus range slider 5–240.

**Trigger**: **when more than one paying customer needs per-site tuning**. With one customer, direct SQL works. Two customers means the operator is bottleneck.

### 3.6 Operator-side launch tasks (no code work; tracked here for completeness)

- **App Store iOS submission** — pending Apple Developer approval per `PRODUCTION_CHECKLIST.md` section 7. Once approved: fill `eas.json` submit credentials, run `eas build --profile production`, submit via `eas submit`.
- **Google Play closed-testing track** → production track promotion. Currently in internal testing; need staged rollout (10–20% first).
- **TestFlight expansion** — invite the verification list (the table in §2) and run through scenarios on real iOS device.
- **Sentry project slug rename** — rename `react-native` → `netraops-mobile` in Sentry UI to match `apps/mobile/app.json:80-81`. Then verify source-map upload by deliberately throwing a JS error from a TestFlight build and checking the stack trace is readable.

### 3.7 Re-wire the orphaned `alerts` screen

**Finding** (from UX doc §2 + App Flow §5): [apps/mobile/app/(tabs)/alerts.tsx](apps/mobile/app/(tabs)/alerts.tsx) is 198 lines of working code rendering the guard's geofence-violation history. The visible "ALERTS" tab routes to `notifications` (push log); `alerts` is `href: null` and no `router.push('/(tabs)/alerts')` exists anywhere. Guards have no UI path to their own violation history.

**Remediation**: pick one entry point — recommended (a) "VIEW HISTORY" link inside [apps/mobile/app/violation/index.tsx](apps/mobile/app/violation/index.tsx) so a guard who sees a real-time breach can drill into their history, OR (b) settings-menu entry in [apps/mobile/app/(tabs)/profile.tsx](apps/mobile/app/(tabs)/profile.tsx). ~30-line commit.

**Trigger**: **before any labour-relations or shift-dispute scenario** ("you said I left the post at 2 AM"). Today, the guard has to ask their admin.

---

## 4. Near-term Backlog (2–8 weeks)

### 4.1 Stripe billing integration

Admin Portal has `/admin/billing` page scaffolded; payment processing not wired. Per-site monthly billing model (~$149/site → $69/site at 25+ sites per AGENTS.md). Twilio is also installed as a dependency but unwired — note that paid SMS for incident alerts is a downstream Stripe-tier feature.

### 4.2 2FA on admin web

JWT + password only today. Admin web is the priority target (a compromised admin credential leaks an entire company's data). TOTP via Authy/Google Authenticator is the simplest first cut; SMS-OTP via Twilio is the second tier (and requires §4.1 + Twilio wiring).

### 4.3 Twilio SMS OTP — production wiring

The `twilio@^5.13.1` dependency is installed but no code path uses it. Needed for: (a) admin SMS OTP if §4.2 picks that path, (b) SOS / panic-button outbound to supervisor (a Tier-1 feature from the earlier audit roadmap), (c) optional SMS incident alerts as a premium tier.

### 4.4 3-strike geofence escalation screen (Item 3b — deferred from prior session)

Server-side geofence validation is live (Item 3a in commit `0656df7`). The UX layer — "you appear to be outside, retry" → "still outside, second retry" → "contact your supervisor" with `tel:` link + written exception submit — is deferred. Mobile-side only: new escalation screen + step4 wires a 3-strike counter. ~6 files, one focused commit.

### 4.5 Continuous Training Module (working title — shaping language for a deferred feature)

1–3 minute briefing video or text card pushed to the guard at shift start; acknowledgement required before clock-in completes; trackable in admin portal for compliance audits. Per PRD §6, the name is internal shaping language — review before any external publication.

Implementation shape: new `shift_briefings` table (`site_id`, `version`, `content_url`, `created_at`), new `briefing_acknowledgements` table (`shift_session_id`, `acknowledged_at`), modal in clock-in step1 that the API requires before issuing the clock-in transaction.

### 4.6 Visual Intelligence — positioning / web pages, not new features

Per PRD §4.1, "Visual Intelligence" is a marketing label for the shipped trustworthy-photo-evidence pipeline. The work here is web content: a feature page at `app.netraops.com/visual-intelligence` explaining the four properties (geofence-validated, EXIF-stripped, byte-validated, audit-bound) for sales conversations. No new code in the platform; pure marketing.

### 4.7 Resilience Dashboard (working title — future-state framing)

Per PRD §6, an admin-side view of system health from the operator's perspective: missed pings explained by `throttle_reason`, devices in low-battery state, geofence violations vs. exceptions. Implementation shape: new `/admin/resilience` page aggregating data from `location_pings.throttle_reason`, `geofence_violations`, and an inferred "missed ping" calculation. Read-only, polling-based, similar architecture to `/admin/live-map`.

### 4.8 SOC 2 readiness program kickoff

Not a commit; a workstream. Per PRD §9, will commence prior to first enterprise (revenue ≥ $50K ARR) customer contract. First step: engage a SOC 2 auditor for a gap analysis; identify which controls are already met (audit log, JWT revocation, magic-byte validation, retention model) and which require new work (access reviews, RLS or query-filter audit, formal incident response runbook).

### 4.9 Incident-email retry queue

From App Flow DRIFT FINDINGS: `sendIncidentAlert(...).catch(console.error)` at [apps/api/src/routes/reports.ts:231](apps/api/src/routes/reports.ts:231) is fire-and-forget. Silent customer-facing failure when SendGrid fails. Two acceptable shapes: (a) `pending_emails` table + retry cron with exponential backoff up to 24h; (b) SendGrid Event Webhooks for bounce/block detection. Vishnu picks (a) vs (b).

---

## 5. Mid-term Roadmap (2–6 months)

| Item | Trigger | Notes |
|---|---|---|
| Stripe go-live for first paying customer | First contracted customer signature | Per-site monthly billing per AGENTS.md model. |
| SOC 2 Type II audit | After readiness program identifies gaps | Multi-month process. Required for upper-mid-market and enterprise procurement. |
| Healthcare / HIPAA-readiness | Vertical commitment | BAA agreements with all subprocessors (Railway, AWS, SendGrid, Anthropic, etc.). Significant operational + legal lift; gate on a healthcare customer signal. |
| Twilio production migration | After §4.3 wiring + Stripe billing surfaces it as a paid tier | Phone-number provisioning, opt-in/opt-out flows, A2P 10DLC registration. |
| Retention cron firing against real data | **Deadline: September 2026** (oldest records cross day 150) | The nightly purge has never processed real customer data crossing the 150-day boundary. Pre-flight verification protocol: replay the cron against a copy of the production DB, audit which rows would be deleted, dry-run with a `DELETE...WHERE false` shell, then live. **Required before first cron tick crosses the boundary.** |
| BIPA / state biometric privacy decision | Before enrolling any Illinois customer | Per PRD §9, the determination is pending. Even Face ID/Touch ID on-device may warrant a consent screen in some states. |
| Sentry source-map upload verified at scale | After §3.6 operator task | A few weeks of TestFlight + production usage to confirm source maps consistently render readable stack traces. |
| Admin UI for compliance / SOP library | After Continuous Training Module ships | Admins author/upload SOPs; module surfaces them in the clock-in flow. |

---

## 6. Long-term Vision (6–18 months)

Not committed, not scoped — direction-setting only.

- **AI-driven anomaly detection / Predictive Alerting tier.** Use the `location_pings`, `geofence_violations`, and `shift_sessions` data to flag patterns: a guard whose violations spike, a site whose missed-ping rate climbs, a device whose battery throttle fires every shift. Premium tier. Builds on the existing Anthropic integration for natural-language summarization of the patterns ("Guard X had 3 unresolved violations in the past week at Site Y").
- **Multi-region deployment.** US East only today. Latency + data-residency for EU / APAC customers requires Railway regional Postgres + API replicas, plus S3 cross-region replication for `starguard-media`.
- **Visitor management module.** Adjacent product. Same identity primitives, same audit trail, different workflows. Potential cross-sell into the existing security-company customer base.
- **Public API + webhook system.** Internal API only today. Customers want to push events (incidents, shift starts) into their own systems (Slack, PagerDuty, JIRA, badge readers).
- **Industry verticals**: Healthcare, Corporate Real Estate, Hotels/Hospitality, Construction. Each requires vertical-specific compliance posture (HIPAA, JCAHO, OSHA, etc.) and some UI customization.
- **White-label / co-branded mobile apps.** Larger security-company customers want their own brand in the App Store / Play Store. Significant lift — separate build profiles per tenant, separate app-store listings, separate Sentry projects per brand.

---

## 7. Risk Register

What could derail the roadmap, ordered by urgency.

1. **`schema_v15.sql` delay = next Railway DB recovery is undefined behavior.** Until the migration ships, restoring from any Railway snapshot to a fresh Postgres instance leaves the platform partially broken (chat, monthly-hours cron, admin shift creation, dead `password_reset_tokens` parity). Operational recovery becomes a developer-led firefight rather than a runbook execution. **Mitigation**: §3.2 — ship within 2 weeks; rehearse the restore in staging.

2. **Migration runner gap is one deploy away from a repeat incident.** Until [apps/api/package.json:8](apps/api/package.json:8) is fixed to chain `db:migrate`, any future schema change has the same May-16-incident risk: code referencing a column the production DB doesn't have yet. **Mitigation**: §3.1 — single-line fix, ship today.

3. **Task-completion magic-byte gap is a security regression hole.** Active attack surface for any guard with a valid JWT. Risk is low today (single customer in onboarding, no known abuse) but grows linearly with customer count. **Mitigation**: §3.3 — ship before customer #2.

4. **Sentry trial expires approximately 2026-05-30.** ~14 days from this doc's authoring. Decision required: upgrade to Business Plan, downgrade to Developer (free tier — 5k events/month), or migrate to alternative. Current sample rates (1.0 errors, 0.05 traces) should fit free-tier volume comfortably at current scale, but the decision must be made before the trial lapses or telemetry goes dark.

5. **App Store first submission is unknown territory.** Apple Developer approval is pending; review timeline for new bundle IDs is typically 1–7 days but can stretch. Build #6's pre-splash crashes are resolved (verified post-SDK 54 upgrade), but a first-submission rejection on Apple's myriad metadata/UX/privacy checks is a non-trivial possibility. Mitigation: have the verification list complete before submission so a rejection-then-resubmit cycle is fast.

6. **`@v-wing/api` and `@v-wing/web` legacy package names** are a recurring distraction. Coordinated rename to `@netraops/*` requires updating internal imports, possibly Railway service name, and any CI references. Risk is procurement-facing — a sharp-eyed reviewer asking "why does your API package call itself v-wing?" undermines confidence. Mitigation: focused PR before any enterprise demo.

7. **PRODUCTION_CHECKLIST.md is significantly stale.** Pre-NetraOps-rebrand, references the wrong domain, wrong S3 bucket, wrong ping cadence, includes broken SQL (`INSERT INTO vishnu_admins`). New operator following the checklist would hit immediate errors. Mitigation: rewrite (or delete-and-replace) as a focused follow-up doc commit.

8. **Retention cron never fired against real data.** September 2026 deadline. The risk is not that the cron fails — it's that the cron silently does something *unexpected*: deletes more rows than intended (FK cascade surprises), leaves S3 objects orphaned (delete order matters), or misfires the day-140 warning email. Mitigation: §5 — pre-flight verification protocol against a production copy.

9. **No horizontal scaling means a single API instance is a SPOF.** Current scale (one customer) makes this comfortable; growth changes the calculus. Mitigation: Redis-backed idempotency cache + Railway autoscaling when 100+ concurrent shifts becomes the daily reality.

10. **No RLS, tenant isolation is route-layer convention.** A single route that omits the `company_id` / `site_id` filter on a tenant-scoped query leaks cross-tenant data. No active known bug. Mitigation: either add RLS policies (substantial work) or add a CI grep-check that fails the build on missing filters.

---

## 8. Decisions Pending Vishnu Input

Items the documentation surfaced that need explicit decisions before action.

| Decision | What needs deciding | Where it surfaced |
|---|---|---|
| Canonical brand color: cyan or amber | Web uses amber as primary CTA; mobile uses cyan. AGENTS.md says cyan is the brand. Pick one canonical and update the other. | UX §1, DRIFT FINDINGS |
| Sentry mobile project slug | Rename Sentry project `react-native` → `netraops-mobile` (matches `app.json`), or change `app.json` to match the existing `react-native` slug | TRD DRIFT FINDINGS |
| Tier-2 feature names | "Continuous Training Module" / "Visual Intelligence" / "Resilience Dashboard" are working titles. Marketing/naming review before external publication. | PRD §6 |
| Incident-email retry mechanism | (a) `pending_emails` table + cron retry vs. (b) SendGrid Event Webhooks | App Flow DRIFT |
| `password_reset_tokens` table fate | Include in `schema_v15.sql` for parity (recommended) AND/OR drop in `schema_v16.sql` (optional cleanup) | TRD §10.1 |
| Alerts orphan entry point | (a) "VIEW HISTORY" link in violation/index.tsx vs. (b) settings entry in profile.tsx | UX DRIFT |
| BIPA stance | Pursue, defer, or rule out Illinois enrollment | PRD §9 |
| Healthcare vertical | Pursue, defer, or rule out (drives SOC 2 scope + HIPAA timeline) | PRD §6 |
| Sentry trial outcome | Upgrade to Business / downgrade to free / migrate | Risk Register #4 |
| RLS vs. CI grep-check for tenant isolation | (a) Add Postgres RLS policies (work) vs. (b) CI check that fails on missing `company_id` filters (lighter) | Schema DRIFT |
| Stripe go-live timeline | When is first paying customer expected to close? Drives §4.1 prioritization | §5 |
| `@v-wing/*` rename | Coordinated PR timing — pre-enterprise-demo or whenever convenient | §6 Risk Register |

---

*End of Implementation Plan. Word count: ~2,900. End of doc set.*
