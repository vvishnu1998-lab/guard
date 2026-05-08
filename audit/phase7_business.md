# Phase 7 — Business logic

## Score: 7/10

The domain model is well-thought-through and tenant isolation is enforced at the query level. The weaknesses are adjacent — chain-of-custody gap on reports (93% no photos), PDF endpoint leaks JWT, and missed-shift / retention flows work but have observability gaps.

## Tenant isolation — strong

- **Admin queries filter on `company_id = req.user!.company_id`** across `admin.ts`, `guards.ts`, `shifts.ts`, `sites.ts`, `clients.ts`, `tasks.ts`, `exports.ts`. Verified at Phase 2 (M1 of Phase 2 section).
- **Client portal queries filter on `site_id = req.user!.site_id`** from JWT — no `req.params.siteId` trust. `clientPortal.ts` consistently sources site scope from the token, so a client user cannot even attempt IDOR by URL manipulation.
- **Super-admin routes (`vishnu` role)** are the escape hatch and are explicitly gated with `requireAuth('vishnu')`.

## Geofence flow — functional

- Polygon stored as JSONB in `site_geofence`.
- `services/geofence.ts` uses ray-casting (`isPointInPolygon`) — standard, correct, no dependencies.
- Violations logged to `geofence_violations`; current count 0 (dev data).
- Pings are still accepted if outside the fence (logged as violation, not rejected) — the right product call, since the ping IS evidence the guard left the site.

## Missed-shift alert — works but brittle

- `missedShiftAlert.ts` runs every 5 minutes, finds shifts with `scheduled_start + 30m < NOW()` and no clock-in, emails super admin + company admin + client, sets `missed_alert_sent_at` to dedupe.
- Dedupe is correct (uses `missed_alert_sent_at IS NULL` in the WHERE).
- **Gap**: if the API restarts during the 5-minute window a missed shift would have been flagged, the window is skipped (already covered in Phase 4 M1). For a customer-facing promise ("we will tell you within 30 minutes"), this is the kind of SLO gap that gets weaponized in a contract dispute.

## Retention flow — well-designed

- 5 distinct touchpoints: day 60 (warning to client), day 89 (final warning), day 90 (`client_access_until` — client portal stops serving), day 140 (warning to super admin), day 150 (hard delete).
- `nightlyPurge.ts` is transactional and deletes in FK-dependency order (photos → reports → violations → sessions → shifts). See Phase 3 "working well".
- Partial indexes `idx_retention_access_until` and `idx_retention_delete_at` cover the hot queries.

## PDF reports — structural quality unknown, auth is broken

- 5-page PDF via `pdfkit` in `routes/exports.ts` and `routes/clientPortal.ts`.
- **Auth bug (Phase 2 C4)**: client-side PDF endpoint accepts JWT via `?token=` query param → leaks into logs and Referer headers. For a document that is, by definition, a record the client paid for and the customer will share, the URL leaking credentials is a real problem.

## Chain-of-custody — gap at the photo layer

**Live DB**: 27 of 29 reports (93%) have zero photos attached.
Possible causes, none good:
1. Clients don't care — then why is `report_photos` table even there? Remove it from the pitch.
2. Upload chain is broken — guards try, fail silently, submit anyway. Needs a Sentry-level event to confirm.
3. Camera permission denied at OS level — mobile should hard-block submission in that case, not allow photoless submit.

For a production pitch against TrackTik / Silvertrac, "photo-verified patrol reports" is a headline feature. 7% is a demo-breaker.

## MAJOR

### M1. No signed audit log for business events
`auth_events` covers login / logout / refresh only (verified in Phase 3). There is no row written when:
- A guard is created, deleted, or deactivated
- A shift is created, modified, or cancelled
- A report is edited after submission
- A site polygon is changed
- An admin's role is escalated

For a security product sold to enterprise, "who changed what and when" is a line-item in the procurement checklist. Today the only answer is `git blame` and "check Postgres log retention" (which is Railway's default — not long).

**Fix**: add `business_events` table (`actor_id, actor_role, action, entity_type, entity_id, payload JSONB, created_at`), write from a middleware or a thin service wrapper.

### M2. Report chain-of-custody is client-trusted
Already called out in Phase 2 M2 — the report POST accepts any `photo_urls` the client supplies, no check that the URL is in `s3://$BUCKET/reports/{company_id}/{guard_id}/...`. A malicious or buggy guard app can submit a colleague's photo, or a photo from another company's bucket, or any public URL.

### M3. Client portal has no "dispute report" workflow
The client can *view* reports. There is no endpoint for "flag this report as inaccurate" or "request clarification from the guard." For a product whose selling point is verifiable patrol records, the absence of a dispute trail means every disagreement escalates to email/phone. Not a bug; a product gap that directly undermines the pitch.

## MINOR

- **No "close company" / offboarding flow** for when a customer cancels. Retention cron runs until day 150 after the last report — fine for data but there's no UX for "account is suspended, show a banner."
- **`login_attempts` only exists for guards** — admin lockout uses no such table (Phase 3 minor). Any admin brute-force is only rate-limited by IP.
- **No rate-limit on `/api/ai/enhance-description`** per user (Phase 4 minor). A guard holding the button can burn the Anthropic budget.

## WORKING WELL

- **Data model is coherent** — 23 tables that map cleanly to the product story (guards, shifts, shift_sessions, sites, reports, photos, tasks, violations, retention). No evidence of a legacy schema being dragged along.
- **Role-partitioned auth** — `guards` / `company_admins` / `clients` / env-based super-admin. Each table stores only what it needs.
- **Retention bookkeeping is first-class** (Phase 3 working well).
- **`clock_in_verifications.shift_session_id` unique constraint** — one verification per session, DB-enforced.
- **Every role has a clearly-scoped JWT** (4 secrets — bloated but intentional — see Phase 4 M2 for rotation concern).
