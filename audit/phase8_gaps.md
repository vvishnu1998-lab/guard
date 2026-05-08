# Phase 8 — Gap analysis (what a production SaaS needs that V-Wing is missing)

Not scored — this is a checklist. Items marked **[BLOCKER]** are things I would refuse to sell without; **[MAJOR]** are things a prospect will ask about in the first demo; **[MINOR]** are nice-to-have.

## Revenue & onboarding

- **[BLOCKER] No billing integration.** Grep confirms: no Stripe, no `subscription`, no `invoice` table. The only `billing` / `payment` hits are 1 in `admin.ts` (likely a comment or column name — worth checking), 1 in `vishnu/page.tsx`, 4 in `mobile/lib/offlineQueue.ts` (probably unrelated string match). No Stripe webhook handler, no Stripe customer ID on `companies`, no plan tiers. You cannot charge $149/site/month without this. Either integrate Stripe or use Stripe Checkout + manual invoicing.
- **[BLOCKER] No self-service signup.** No `/signup` page, no company creation API that a non-super-admin can hit. Every new customer requires manual onboarding by Vishnu. Fine for 1–3 design partners; catastrophic at 20.
- **[BLOCKER] No admin invite flow.** Primary admin is created by super-admin. Additional admins (`POST /api/admin/companies/:id/admins`) are also super-admin-only (`vishnu` role). There is no "primary admin invites their team" endpoint.
- **[MAJOR] No trial / free-tier mechanism.** Enterprise sales motion works (manual proof-of-concept), but SMB sales (the $149/site target) needs self-serve trial. None exists.

## Security & compliance

- **[BLOCKER] No 2FA for admin accounts.** No TOTP, no SMS, no backup codes. `mfa_secret` / `totp` / `2fa` — zero hits in grep. For a security product, this is the single most embarrassing gap.
- **[MAJOR] No SOC 2 / GDPR artifacts in repo.** No DPA template, no DSR endpoints (`/api/gdpr/export`, `/api/gdpr/erase`), no data map, no privacy impact assessment. Enterprise RFP asks for these.
- **[MAJOR] No audit log for business events** (Phase 7 M1) — compliance red flag.
- **[MAJOR] Access tokens not revocable** (Phase 2 M1).
- **[MAJOR] No WAF / bot protection at the edge.** Relying entirely on `express-rate-limit` keyed by IP.
- **[MINOR] No secret rotation scheme** (Phase 4 M2).

## Operational readiness

- **[BLOCKER] No error monitoring.** No Sentry, no Datadog, no New Relic import found. `console.error` to Railway logs is it. Any prod bug beyond what the user manually reports is invisible.
- **[BLOCKER] No uptime monitoring / SLO tracking.** Customers will ask for 99.9%. You can't promise what you can't measure.
- **[MAJOR] No cron execution log** (Phase 3 M4, Phase 4 M1). "Did nightly purge run last Tuesday?" is unanswerable.
- **[MAJOR] No backup / DR story documented.** Railway does point-in-time recovery for Postgres, but there's no script to verify restores, no documented RTO/RPO.
- **[MAJOR] No staging environment confirmed.** `.env` is dev; Railway hosts prod. The pre-prod gap is where bugs ship.
- **[MAJOR] Single-region.** US East (Railway default) — a UK customer gets 100ms added latency to every ping, and data residency is a non-starter for EU public-sector buyers.
- **[MINOR] No feature flags.** Changes ship atomically to everyone — no gradual rollout, no kill switch.

## Product depth (vs competitors)

- **[MAJOR] No guard license / certification tracking.** Grep: `license_number` = 0 hits. TrackTik and Silvertrac both expose this; security-guard licensing is a regulatory requirement in most US states and all of Canada.
- **[MAJOR] No incident escalation tree.** Missed-shift alert emails super admin + company admin + client (good) but there's no "if no ack in 5 min, also SMS the regional manager." Alert → email → hope is not an escalation policy.
- **[MAJOR] No dispatch / messaging.** No way for company admin to send a targeted message to an on-duty guard. Every competitor has this.
- **[MAJOR] No shift swap / guard-to-guard handoff.** Guard calls in sick → scheduler has to manually reassign in the admin portal. No UI for guards to request coverage.
- **[MAJOR] No i18n.** `i18n` = 0 hits. English-only. Kills every non-English market (French Canada, Hispanic US contract-guard workforces, etc.).
- **[MAJOR] No mobile forced-update gate** (Phase 6 M3).
- **[MINOR] No checkpoint / NFC / QR tour enforcement.** Geofence says "guard was near the site"; it doesn't say "guard walked the required route." Competitors implement NFC/QR tags at patrol points.
- **[MINOR] No offline-first story beyond the existing queue.** Guard in a basement loses hours of logs if the queue misbehaves (Phase 6 M2).
- **[MINOR] No dispatcher-facing live map filters.** Admin/live-map exists; not evaluated for usability.

## Data integrity & retention gaps

Already covered in Phase 3; summarising the product-relevant ones:
- **[BLOCKER] `total_hours` NULL after auto-complete** (Phase 3 C1) — breaks billing-by-hour.
- **[MAJOR] No DB CHECK on lat/lng** — one malformed client can pollute geofence analytics.
- **[MAJOR] `data_retention_log` row with NULL `data_delete_at`** — one site has no retention schedule; purge will never fire for it.

## Testing & quality

- **[BLOCKER] Zero test files** (Phase 9 — api, web, mobile all have 0 tests). Every claim of "this works" is based on manual testing only. Any refactor is a gamble. For a system that handles money (billing, once Stripe lands) and evidence (reports, photos), this is not defensible.
- **[MAJOR] No CI other than Vercel/Railway build.** No `npm run lint` gate, no `tsc --noEmit` gate on PRs (if PRs even exist — solo dev repo). One typo → prod.
- **[MAJOR] `strict: false` in web `tsconfig`** (Phase 5 M1).

## Marketing & legal

- **[BLOCKER] No marketing site.** Public web tree is login + privacy-policy. No `/pricing`, no `/demo`, no `/contact`. Any prospect landing on `https://vwing.tld/` sees… whatever `app/page.tsx` renders (likely a redirect to `/admin`).
- **[MAJOR] No Terms of Service page.** Privacy policy exists. ToS is the other half of the checkbox.
- **[MAJOR] No email template repo / branded transactional emails.** SendGrid is used; templates are almost certainly inline strings in the API. Hard to audit or version.

## What V-Wing *has* that many competitors lack

Keep these in the pitch:
- **Real S3 photo pipeline with 5-min presigned URLs.** Many legacy competitors still use base64-in-DB.
- **Geofence JSONB polygons with ray-casting** — no geometry-service dependency.
- **Clean retention bookkeeping** with partial indexes and a transactional purge.
- **Role-partitioned auth** — more secure than the common "one `users` table with a role column" pattern (harder to accidentally leak a field cross-role).
- **AI-enhanced report descriptions** via Anthropic. Modern differentiator.
- **Multi-step clock-in wizard with photo verification.** UX is ahead of TrackTik's clock-in (which is a single screen).
