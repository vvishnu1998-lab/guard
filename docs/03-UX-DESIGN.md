# NetraOps — UI/UX Design Document

> **Status**: Draft v1 · 2026-05-16
> **Audience**: Designers, frontend engineers, anyone building new screens or modifying existing ones.
> **Source of truth**: This document for naming and structure; live code for visual styling. Cite the file when in doubt.

---

## 1. Brand System

NetraOps currently runs two visually distinct brand expressions. The mobile app uses a navy-and-cyan palette (cyan `#00C8FF` as the action color, matching [AGENTS.md:23](AGENTS.md)'s stated brand). The web admin portal uses navy-and-amber (amber `#F59E0B` as the action color, cyan reserved for selective accents). This split is unintentional — the result of independent component build-out on each surface, not a deliberate two-tier brand system. **The canonical brand color is cyan `#00C8FF`**; the web portal's amber-as-primary state is treated as drift to be resolved in a future styling pass. Until then, a security-company admin who demos the admin portal on a laptop and then opens the mobile app on a guard's phone will see two visually different products. The DRIFT FINDINGS section at the bottom of this document captures the specific remediation.

### 1.1 Color Palette

**Mobile palette** (source: [apps/mobile/constants/theme.ts](apps/mobile/constants/theme.ts)):

| Token | Hex | Use |
|---|---|---|
| `bg` / `structure` | `#070D1A` | Deep navy background |
| `surface` / `surface_card` | `#0F1929` | Card surface |
| `surface2` | `#172035` | Elevated cards |
| `border` / `border_card` | `#1E3A5F` | Subtle borders |
| `action` | `#00C8FF` | Cyan — primary accent / CTA |
| `success` | `#00E5A0` | Green confirmations |
| `danger` | `#EF4444` | Red — incidents, violations, clock-out |
| `warning` | `#F59E0B` | Amber — GPS markers, low-battery banner |
| `info` | `#3B82F6` | Blue |
| `textPrimary` / `base` | `#FFFFFF` | Primary text |
| `muted` | `#8899AA` | Subdued text |

**Web palette** (source: [apps/web/app/globals.css:5-16](apps/web/app/globals.css:5)):

| CSS variable | Hex | Use |
|---|---|---|
| `--color-base` | `#F5F3EE` | Off-white text (slightly warmer than mobile's pure white) |
| `--color-structure` | `#0B1526` | Navy background — close to but not identical to mobile's `#070D1A` |
| `--color-action` | `#F59E0B` | **Amber** — primary CTA on web; this is the brand inconsistency |
| `--color-surface` | `#0F1E35` | Surface — close to mobile's `#0F1929` |
| `--color-danger` | `#EF4444` | Red |
| `--color-success` | `#10B981` | Green (different shade than mobile's `#00E5A0`) |
| `--color-muted` | `#6B7280` | Subdued text (different from mobile's `#8899AA`) |
| `--color-border` | `#1A3050` | Border (different from mobile's `#1E3A5F`) |
| `--color-cyan` | `#00C8FF` | Defined but used selectively, not as primary CTA |

The `globals.css` also includes pragmatic fixes for native `input[type="date"|"time"|"datetime-local"]` to render readably against the dark theme — Chromium's shadow DOM pseudo-elements don't reliably inherit `var()` across versions.

### 1.2 Typography

**Mobile**:
- Headings: `BarlowCondensed_700Bold` (loaded via `@expo-google-fonts/barlow-condensed`)
- Heading medium: `BarlowCondensed_500Medium`
- Body: `System` (platform default — SF on iOS, Roboto on Android)

**Web**:
- Single family: `'Inter', system-ui, -apple-system, sans-serif` (declared in `globals.css` body rule)
- No display font on web; the typographic identity comes from Tailwind weight + tracking utilities applied per-component (e.g. `tracking-[0.25em]` for portal-select wordmarks)

This is a second cross-platform divergence: mobile uses BarlowCondensed for headings; web uses Inter for everything. Cosmetic-severity drift.

### 1.3 Spacing Scale

**Mobile** (literal token values, [apps/mobile/constants/theme.ts:32-39](apps/mobile/constants/theme.ts:32)):

| Token | px |
|---|---|
| `xs` | 4 |
| `sm` | 8 |
| `md` | 16 |
| `lg` | 24 |
| `xl` | 32 |
| `xxl` | 48 |

**Web**: Tailwind default 4px base scale — no custom spacing tokens defined. Components use Tailwind utilities directly (`px-6`, `py-16`, `gap-3`, etc.).

### 1.4 Radius

**Mobile** ([apps/mobile/constants/theme.ts:41-47](apps/mobile/constants/theme.ts:41)):

| Token | px |
|---|---|
| `xs` | 4 |
| `sm` | 6 |
| `md` | 12 |
| `lg` | 20 |
| `full` | 9999 |

**Web**: Tailwind defaults (`rounded`, `rounded-md`, `rounded-lg`, `rounded-xl`, `rounded-full`).

### 1.5 Iconography

**Mobile**: `@expo/vector-icons`, specifically the `Ionicons` family. Tab icons use the `name`/`name-outline` pair pattern for focused/unfocused states ([apps/mobile/app/(tabs)/_layout.tsx:12-20](apps/mobile/app/(tabs)/_layout.tsx:12)).

**Web**: SVG inlined per component. No icon library imported — icons are hand-written SVG paths (see [apps/web/app/privacy/page.tsx:11-18](apps/web/app/privacy/page.tsx:11) for an example shield + back-arrow). Pragmatic but not scalable; introducing `lucide-react` or `@heroicons/react` would be a single-PR improvement when icon volume grows.

## 2. Mobile Information Architecture

### 2.1 Tab Bar Structure

Four visible tabs ([apps/mobile/app/(tabs)/_layout.tsx](apps/mobile/app/(tabs)/_layout.tsx)):

| Tab | Route | Ionicons | Notes |
|---|---|---|---|
| HOME | `/(tabs)/home` | `home` / `home-outline` | Default landing after login |
| SCHEDULE | `/(tabs)/schedule` | `calendar` / `calendar-outline` | Upcoming shifts |
| ALERTS | `/(tabs)/notifications` | `notifications` / `notifications-outline` | Notification log; badge from `notificationUnread` |
| CHAT | `/(tabs)/chat` | `chatbubbles` / `chatbubbles-outline` | Admin↔guard rooms; badge from `chatUnread` |

Active tint cyan `#00C8FF`; inactive `#445566`. Tab bar background `#070D1A`, 68px tall, 1px top border `#1E3A5F`.

Four **hidden** tab routes (declared with `href: null`, accessible via `router.push` but not shown in the tab bar):

| Route | Purpose |
|---|---|
| `/(tabs)/reports` | Report history / list |
| `/(tabs)/tasks` | Task list for current shift |
| `/(tabs)/alerts` | **Orphaned working screen** — see note below |
| `/(tabs)/profile` | Guard profile / settings |

**Note on the orphaned `alerts` route**: [apps/mobile/app/(tabs)/alerts.tsx](apps/mobile/app/(tabs)/alerts.tsx) is 198 lines of working code that fetches `GET /api/locations/violations` and renders the guard's own geofence-violation history (open in red, resolved muted). The screen renders correctly when navigated to. However, **no code in `apps/mobile` calls `router.push('/(tabs)/alerts')`** — a grep across the workspace finds zero entry points. The visible "ALERTS" tab in the bottom bar routes to `notifications` (the push-notification log), a different screen. The result: guards cannot view their own geofence-violation history from the UI today, even though the data, API, and rendered screen all exist and work. This is treated as **operational drift** — a missing feature surface, not a broken tab — and is captured in DRIFT FINDINGS with a re-wiring recommendation.

### 2.2 Screen Inventory (every `.tsx` file in `apps/mobile/app/`)

**Auth group** (`apps/mobile/app/(auth)/`):
- `login.tsx` — email + password; biometric-resume if previously enrolled
- `change-password.tsx` — forced when `must_change_password=true` after temp-password issuance
- `forgot-password.tsx` — email-only; triggers temp-password email via SendGrid

**Tabs group** (`apps/mobile/app/(tabs)/`):
- `_layout.tsx` — tab bar configuration (above)
- `home.tsx` — landing screen; shows today's shift, restores active session, starts offline queue sync
- `schedule.tsx` — list of upcoming shifts
- `notifications.tsx` — push notification log (visible as ALERTS tab)
- `chat.tsx` — list of chat rooms
- `reports.tsx` — past reports
- `tasks.tsx` — task list
- `alerts.tsx` — (existence flagged in DRIFT)
- `profile.tsx` — guard profile

**Root-level routes** (`apps/mobile/app/`):
- `index.tsx` — root entry, redirects based on auth state
- `_layout.tsx` — root Stack, session restoration, Sentry init, font loading, location permission, push token registration, background geofence start/stop
- `active-shift/index.tsx` — main shift screen; ping countdown, battery throttle banner, action grid (Ping Now / Report / Tasks / Break), Clock Out CTA
- `break/index.tsx` — break-in-progress timer
- `chat/[roomId].tsx` — per-room conversation view
- `clock-in/step1.tsx` through `step4.tsx` — four-step clock-in flow (detailed below)
- `clock-out/index.tsx` — handover notes + total-hours summary
- `ping/index.tsx` — router that always routes to `/ping/photo` (since the GPS-only ping was retired; comment in source documents the retired alternation)
- `ping/photo.tsx` — GPS+photo capture for periodic pings
- `reports/new.tsx` — **canonical** unified report creation form
- `reports/new/activity.tsx`, `incident.tsx`, `maintenance.tsx` — **dead** per-type forms, marked "no longer routed to" in `reports/new.tsx:14-15` (see DRIFT)
- `tasks/complete/[id].tsx` — single task completion with optional photo proof
- `violation/index.tsx` — geofence violation reporting / acknowledgement

### 2.3 Navigation Patterns

Built on `expo-router` with file-based routing.

- **Root Stack** wraps everything (`apps/mobile/app/_layout.tsx`). Headers hidden globally; each screen draws its own header if needed.
- **Tabs group** is a child of the root Stack; the four visible tabs render at the bottom for any screen inside `(tabs)/`.
- **Standalone routes** (clock-in, active-shift, ping, break, clock-out) live outside the tabs group and use `router.replace` to move between them — they hide the tab bar by virtue of being outside `(tabs)/`.
- **Auth gating**: the root layout's route guard ([apps/mobile/app/_layout.tsx:54-68](apps/mobile/app/_layout.tsx:54)) redirects to `/(auth)/login` if unauthenticated, to `/(auth)/change-password` if `mustChangePassword`, and to `/(tabs)/home` otherwise.
- **Deep-link tap routing**: push notifications open specific screens via [apps/mobile/lib/navigateForNotification.ts](apps/mobile/lib/navigateForNotification.ts) — chat tap → chat room; ping reminder tap → ping flow; geofence breach tap → active shift; etc.

## 3. Mobile Key Flows

Each flow described as a numbered step-by-step. For deeper API behavior (transaction structure, validation order, idempotency replay) see `04-APP-FLOW.md`.

### 3.1 Onboarding & First Login

1. User taps NetraOps icon → app launches.
2. `_layout.tsx` loads fonts, requests Notifications + Location permissions, calls `loadSession()` from `authStore`.
3. If no stored access token: redirect to `/(auth)/login`.
4. User enters email + password, taps Sign In.
5. POST `/api/auth/guard/login` returns `{access, refresh, must_change_password}`.
6. If `must_change_password = true` (admin issued a temp password): redirect to `/(auth)/change-password`. Guard sets a new 6–8 character alphanumeric password.
7. After successful change (or if not required): redirect to `/(tabs)/home`.
8. Background: `_layout.tsx` registers an Expo push token via `getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })` and POSTs it to `/api/auth/guard/fcm-token`.
9. Background: requests `Location.requestForegroundPermissionsAsync()` then `requestBackgroundPermissionsAsync()` so the geofence task can run when a shift activates.

### 3.2 Clock-In (4-step flow)

State persisted in [apps/mobile/store/clockInStore.ts](apps/mobile/store/clockInStore.ts) across the four screens.

1. **Step 1 — GPS verification** ([clock-in/step1.tsx](apps/mobile/app/clock-in/step1.tsx)): Pulsing concentric rings; calls `Location.getCurrentPositionAsync({ accuracy: High })`; haversine pre-check against the assigned site's center+radius (1.5× tolerance) then precise polygon ray-cast; persists lat/lng/accuracy in the store on pass. NEXT button disabled until inside.
2. **Step 2 — Guard selfie** ([clock-in/step2.tsx](apps/mobile/app/clock-in/step2.tsx)): Front camera; gated on `cameraReady` (with 3 s force-enable fallback for Android); `takePictureAsync` then `ImageManipulator.manipulateAsync` to resize 1080px + compress 0.8 quality (the EXIF-strip step). Preview screen with RETAKE / USE PHOTO.
3. **Step 3 — Site photo** ([clock-in/step3.tsx](apps/mobile/app/clock-in/step3.tsx)): Rear camera; same capture + manipulator pipeline as step 2. Some sites display an admin-defined instruction string here.
4. **Step 4 — Confirm & start** ([clock-in/step4.tsx](apps/mobile/app/clock-in/step4.tsx)): Summary card with GPS, selfie, site photo. Lazy `useState(() => uuidv4())` generates a stable Idempotency-Key for this mount. START SHIFT button posts:
   - First the selfie to S3 via presigned POST
   - Then `POST /api/shifts/:id/clock-in` with `lat`, `lng`, `accuracy`, plus the `Idempotency-Key` header
   - Then `POST /api/locations/clock-in-verification` with selfie/site photo URLs + verified GPS
5. On 422 GEOFENCE_FAILED: friendly alert "You appear to be outside the site post. Move to the post entrance and try again." → `router.replace('/clock-in/step1')` to re-fetch GPS. Re-entering step 4 produces a fresh UUID via the new mount.
6. On 409 (already clocked in): alert "Already clocked in on another device. Clock out first."
7. On success: `setActiveSession` populates `shiftStore`; if site has `instructions_pdf_url`, modal offers VIEW INSTRUCTIONS; otherwise `router.replace('/(tabs)/home')`.

### 3.3 Active Shift

[apps/mobile/app/active-shift/index.tsx](apps/mobile/app/active-shift/index.tsx).

State:
- Elapsed timer (1 s tick)
- Next-ping countdown derived from `activeSession.clocked_in_at + pingIntervalMs - now`
- `pingIntervalMs` from `useBatteryThrottle((activeShift.ping_interval_minutes ?? 30) * 60_000)`

UI elements:
- Timer strip (SHIFT ELAPSED, site name)
- **Battery-throttle banner** above the ping card, rendered only when `isThrottled` — amber background `#3A2410`, amber left border `#F59E0B`, text "Low battery — pings reduced to every {N} minutes. Plug in when possible."
- Ping countdown card with NEXT PING IN value; turns urgent (cyan border) when < 5 min remaining
- "NEXT: GPS + PHOTO" subtitle (static, no longer alternates)
- Action grid: PING NOW / REPORT / TASKS / BREAK
- Shift info card: shift ID, started time, scheduled end, guard ID
- CLOCK OUT button (amber outline) at the bottom

Triggers:
- When the countdown rolls over: PING DUE alert ("Your {N}-minute check-in is due. Submit your location now.") with PING NOW and Later (snooze 5 min) actions.
- Background `expo-task-manager` task ([apps/mobile/tasks/locationBackground.ts](apps/mobile/tasks/locationBackground.ts)) ticks every 2.5 min and 50m, computes geofence containment, fires a local breach notification + POSTs `/api/locations/violation` on a fresh inside→outside transition.

### 3.4 Incident Reporting

Through the canonical unified form ([reports/new.tsx](apps/mobile/app/reports/new.tsx)) with `type=incident`:

1. Guard taps REPORT from active-shift OR opens from a push-notification deep link.
2. Unified form: type dropdown (activity / incident / maintenance), description text input.
3. If type=incident: severity picker required (LOW / MEDIUM / HIGH / CRITICAL); at least 1 photo required. Note: the unified form has **removed the severity field per the 2026-05-15 UX simplification**; the per-type incident form retains it but is dead-code (see DRIFT).
4. Photo attach via `usePhotoAttachments` hook — camera or library, manipulator-pipelined, max 5 per report.
5. Submit triggers POST to the offline queue path: tries `/api/reports` first, falls back to local queue on failure.
6. Server: magic-byte validates every photo; on success inserts report row + photo rows + sends instant incident email if `report_type='incident'`.
7. Confirmation banner: "Incident submitted. Client has been notified by email."

### 3.5 Task Completion

[apps/mobile/app/tasks/complete/[id].tsx](apps/mobile/app/tasks/complete/[id].tsx).

1. Guard taps TASKS from active-shift → list of `task_instances` for the current shift.
2. Tap a pending task → completion screen.
3. If `template.requires_photo`: camera capture with manipulator pipeline.
4. Tap MARK COMPLETE → POST `/api/tasks/:instance_id/complete` with optional photo URL + GPS.
5. Server: writes `task_completions` row, marks instance status='completed'.
6. Return to task list with green checkmark on the completed task.

### 3.6 Clock-Out

[apps/mobile/app/clock-out/index.tsx](apps/mobile/app/clock-out/index.tsx).

1. From active-shift, tap CLOCK OUT → confirmation alert.
2. Optional handover notes textarea.
3. Confirm → POST `/api/shifts/:id/clock-out` with `handover_notes`.
4. Server (transactional): closes open shift_session, closes any open break_session, computes `total_hours = max(clocked_out_at, scheduled_start)` math, updates shift `status='completed'`.
5. `clearSession()` in `shiftStore`; background geofence task stopped via root layout effect.
6. Redirect to `/(tabs)/home`.

## 4. Web Admin Information Architecture

### 4.1 Side Navigation

[apps/web/components/admin/AdminNav.tsx](apps/web/components/admin/AdminNav.tsx) renders an 11-item primary nav:

| Label | Route |
|---|---|
| DASHBOARD | `/admin` |
| LIVE STATUS | `/admin/live-map` |
| SITES | `/admin/sites` |
| GUARDS | `/admin/guards` |
| SHIFTS | `/admin/shifts` |
| TASKS | `/admin/tasks` |
| REPORTS | `/admin/reports` |
| ANALYTICS | `/admin/analytics` |
| CLIENT PORTALS | `/admin/clients` |
| BILLING | `/admin/billing` |
| CHAT | `/admin/chat` |

Chat row has an unread-count badge driven by 15-second polling of an admin-side unread endpoint.

### 4.2 Screen Inventory

Every `page.tsx` under `apps/web/app/admin/`:
- `page.tsx` — DASHBOARD: KPI row, RecentAlerts, GuardsOnDuty, ActiveSitesTable, ExportPanel
- `live-map/page.tsx` — Polling-based map with guard pin overlays (Leaflet)
- `sites/page.tsx` — Site list + create/edit (polygon editor for geofence)
- `guards/page.tsx` — Guard roster + create/edit
- `shifts/page.tsx` — Shift scheduling
- `tasks/page.tsx` — Task templates per site
- `reports/page.tsx` — Filtered report feed with photo modal
- `analytics/page.tsx` — Charts + CSV/XLSX downloads
- `clients/page.tsx` — Client portal account management
- `billing/page.tsx` — Billing scaffolding (no Stripe integration; see PRD §6)
- `chat/page.tsx` — Per-site admin↔guard chat rooms
- `login/page.tsx`, `change-password/page.tsx`, `reset-password/page.tsx` — Auth screens

### 4.3 Component Library (admin side)

Components live under [apps/web/components/admin/](apps/web/components/admin/):
- `AdminNav.tsx` — top-level navigation drawer
- `AdminConditionalNav.tsx` — wrapper that hides nav on auth screens
- `KpiRow.tsx`, `RecentAlerts.tsx`, `GuardsOnDuty.tsx`, `ActiveSitesTable.tsx`, `ExportPanel.tsx` — dashboard tiles
- `TaskTemplateModal.tsx` — task template create/edit dialog

Plus repo-shared components:
- [apps/web/components/ActivityLogTable.tsx](apps/web/components/ActivityLogTable.tsx) — used in multiple admin pages
- [apps/web/components/ReportPhotosView.tsx](apps/web/components/ReportPhotosView.tsx) — full-screen photo viewer

## 5. Web Client Portal Information Architecture

Read-only portal scoped to a single `site_id` (the client's JWT carries `site_id` and queries filter on it).

Pages under `apps/web/app/client/`:
- `page.tsx` — landing: KPIs + recent reports for the assigned site
- `download/page.tsx` — daily PDF download UI
- `schedule/page.tsx` — upcoming shifts at this site
- `login/page.tsx`, `change-password/page.tsx`, `reset-password/page.tsx` — auth

Components ([apps/web/components/client/](apps/web/components/client/)):
- `ClientNav.tsx`, `ClientConditionalNav.tsx` — read-only nav
- `ReportsFeed.tsx` — paginated report list with photo preview
- `RetentionNotice.tsx` — banner when `days_until_deletion <= 30`
- `DownloadPanel.tsx` — date-range pickers + download buttons

## 6. Super Admin Portal Information Architecture

Pages under `apps/web/app/vishnu/`:
- `page.tsx` — landing
- `companies/page.tsx` — company list + create
- `sites/page.tsx` — cross-tenant site view + photo limit overrides
- `retention/page.tsx` — retention table with urgent-row highlighting
- `login/page.tsx`, `reset-password/page.tsx`

## 7. Portal-Select Page

[apps/web/app/portal/page.tsx](apps/web/app/portal/page.tsx) is **not a fourth portal**. It's a landing page that displays the NetraOps wordmark and three buttons routing to `/admin`, `/client`, `/vishnu`. Branded for someone who doesn't know which portal they need. Static (`export const dynamic = 'force-static'`).

It uses `bg-amber-500` for the primary CTA (ADMIN DASHBOARD button) — this is one of the places where the web amber-as-primary deviation surfaces.

## 8. Marketing Pages

- [/](apps/web/app/page.tsx) — root marketing landing
- [/privacy](apps/web/app/privacy/page.tsx) — canonical privacy policy (effective 2026-05-13, NetraOps-branded, Tailwind + custom inline icons)
- [/privacy-policy](apps/web/app/privacy-policy/page.tsx) — older "Netra" version (effective 2026-04-14, HTML inline styles); flagged in DRIFT FINDINGS
- [/terms](apps/web/app/terms/page.tsx) — terms of service
- [/not-found](apps/web/app/not-found.tsx) — 404

## 9. Component Library Notes

- **Mobile**: no third-party component library. UI built from `react-native` built-ins (`View`, `Text`, `ScrollView`, `TouchableOpacity`, `TextInput`, `Modal`, `Image`, etc.) with `StyleSheet.create` per-screen. Theme tokens imported from `constants/theme.ts`. Animations via `react-native-reanimated@~4.1.1`.
- **Web**: no shadcn/ui detected in the dependency list ([apps/web/package.json](apps/web/package.json) has no `@radix-ui/*` or `class-variance-authority`). UI is built from Tailwind utility classes directly. `@tanstack/react-query@^5.28.0` powers the data layer. `leaflet` + `react-leaflet` render the admin live map. `jspdf` + `jspdf-autotable` generate client-portal PDFs.

**Cost of staying on raw Tailwind**: every new admin page redefines its own button, card, modal, form-input, and table styles from Tailwind primitives. The admin portal currently has ~11 route files; the duplication is borderline manageable. As the surface grows past ~16 routes (the next 5 admin pages — Billing detail, Client Portal management screens, Continuous Training admin, Resilience Dashboard, plus the missing `quarantined_uploads` review UI), styling drift will compound: button hover states will diverge, modal close-button positions will drift, form-input borders will be 1px in some places and 2px in others. **Recommend introducing shadcn/ui** (already a known-good React component library, Tailwind-native, copy-paste model with no new runtime dependency) **as a focused refactor before the next 5 admin pages ship.** Earlier is cheaper than later — converting 11 pages of utility-class duplication into shared components is a week of work; converting 16 is meaningfully more.

## 10. Accessibility State

Honest assessment:

- **Mobile**: no formal accessibility audit. `expo-router` and the underlying React Native primitives respect platform a11y by default (VoiceOver / TalkBack read text labels). Custom controls (camera shutter, swipeable cards) have not been hand-tested with a screen reader. Color-contrast pairs are mostly white-on-navy and meet WCAG AA at body sizes; the muted token (`#8899AA` on `#070D1A`) is borderline for fine text.
- **Web**: same story. The native date/time picker fixes in `globals.css` (color-scheme dark + explicit input color) ensure typed values are visible against the dark theme — that's the closest the codebase gets to deliberate a11y work. Focus-visible outlines, keyboard navigation across the admin dashboard, screen-reader labels on the live map — none of this has been audited.

**Concrete plan**: a one-day a11y pass run by Vishnu directly, using **axe-core CLI** against each admin and client portal route on the web side (scripted: `npx @axe-core/cli https://app.netraops.com/admin --tags wcag2a,wcag2aa`) plus a **manual VoiceOver pass on iOS** of the four critical mobile flows (login, clock-in step 1–4, active-shift ping, incident report). Output: a punch list of WCAG AA failures with severity tags, fixed in a follow-up week-long sprint. **Trigger**: before the first government or enterprise (≥ $50K ARR) customer demo — procurement teams at those buyers routinely run their own a11y screens, and shipping a known-failing app to that audience would burn the conversation. Not blocking earlier-stage customer onboarding.

---

## DRIFT FINDINGS

| Finding | Severity | Suggested action | Owner |
|---|---|---|---|
| **Brand color split** (also flagged in §1 body): mobile uses cyan `#00C8FF` as primary CTA (`Colors.action`); web uses amber `#F59E0B` as `--color-action` and reserves `--color-cyan` for selective use. [AGENTS.md:23](AGENTS.md) declares "Navy + cyan" as the brand. Web's amber-as-primary is the inconsistency. Most visible at the portal-select page where the ADMIN DASHBOARD button is amber while mobile's primary CTAs are cyan. | Cosmetic (brand consistency); enterprise-demo risk | Update web `--color-action` to `#00C8FF` (cyan) to match canonical brand. Sweep `apps/web/app/portal/page.tsx` `bg-amber-500` and any other amber-as-primary uses, replacing with cyan. Keep amber available as `--color-warning` for genuine warning surfaces. Write the canonical decision into AGENTS.md. | Vishnu (confirms the cyan-canonical direction), then focused commit |
| **Typography split**: mobile uses BarlowCondensed for headings + System body; web uses Inter for everything. No documented rationale. | Cosmetic | Decide whether to keep the split (display font on mobile only, Inter on web for performance) or unify on Inter / SF Pro / a single display family. Document in AGENTS.md. | Vishnu (decision) |
| **Orphaned alerts screen — missing feature surface** (also flagged in §2 body): [apps/mobile/app/(tabs)/alerts.tsx](apps/mobile/app/(tabs)/alerts.tsx) is 198 lines of working code fetching `GET /api/locations/violations` to show the guard's own geofence-violation history. The visible "ALERTS" tab in the bottom bar routes to `notifications` (push-notification log), a different screen. The `alerts` route is `href: null` and no `router.push('/(tabs)/alerts')` exists in the codebase. Guards have no UI path to view their own violation history despite the data, API, and rendered screen all working. | Operational (missing feature surface) | Re-wire entry point. Two options: **(a) primary — add a "VIEW HISTORY" link inside [apps/mobile/app/violation/index.tsx](apps/mobile/app/violation/index.tsx)** so a guard who sees a real-time breach can drill into their full history; **(b) secondary — add a settings-menu entry in [apps/mobile/app/(tabs)/profile.tsx](apps/mobile/app/(tabs)/profile.tsx)**. Vishnu picks the entry point, then ~30-line Claude Code commit. Also goes into Implementation Plan's Immediate Backlog. | Vishnu (entry-point choice), then focused commit |
| **Dead per-type report forms**: [apps/mobile/app/reports/new/activity.tsx](apps/mobile/app/reports/new/activity.tsx), `incident.tsx`, `maintenance.tsx` are not routed to per the explicit comment in `reports/new.tsx:14-15`. They duplicate logic that the unified form already covers and carry features (severity field on the incident form) that the canonical form intentionally removed. | Cosmetic | Delete the three files in a focused commit. Verify with `find apps/mobile/app/reports/new -name "*.tsx"` returns only nothing or just an `_layout.tsx`. | Follow-up cleanup commit |
| **Two privacy pages**: [/privacy](apps/web/app/privacy/page.tsx) is canonical (NetraOps-branded, effective 2026-05-13); [/privacy-policy](apps/web/app/privacy-policy/page.tsx) is older "Netra" content (effective 2026-04-14) and is referenced by Play Store metadata per prior session notes. | Operational | Replace `/privacy-policy` with a server-side redirect to `/privacy`, AND update Play Store metadata to point at `/privacy`. Avoid having two pieces of stale legal content live in production. | Vishnu (Play Store metadata) + focused commit (Next.js redirect) |
| **No component library on web** despite a large admin surface. Component duplication is starting to accumulate in `apps/web/components/admin/*.tsx` (e.g. table styling, modal wrappers). | Cosmetic / DX | Introduce shadcn/ui (free, Tailwind-native, copy-paste model — no new runtime dependency) once the admin surface has 3+ duplicated table or modal patterns. | Vishnu (timing decision), then incremental adoption |
| **Web uses hand-written SVG icons** ([apps/web/app/privacy/page.tsx:11-18](apps/web/app/privacy/page.tsx:11) example: an inline shield SVG). No icon library imported. | Cosmetic | Adopt `lucide-react` (already an industry standard, tree-shakes per icon, matches the brand register) when the icon volume justifies it. Not blocking. | Follow-up |
| **No formal accessibility audit** on either surface. The native date/time picker fix in `globals.css` is the closest thing to deliberate a11y work. | Operational (enterprise procurement) | One-day axe DevTools pass on web + VoiceOver pass on mobile clock-in flow before any enterprise procurement conversation. | Vishnu (timing) |

---

*End of UX Design. Word count: ~2,800. Next document: App Flow.*
