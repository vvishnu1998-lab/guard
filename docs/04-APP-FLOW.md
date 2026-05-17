# NetraOps — App Flow Document

> **Status**: Draft v1 · 2026-05-16
> **Audience**: Support staff, QA, anyone who needs to know "what happens when X."
> **Companion**: Read alongside `02-TRD.md` (architecture + security), `03-UX-DESIGN.md` (screen inventory).

---

Each flow is described with five elements:
- **Trigger** — what initiates it
- **Actor** — who performs it
- **Steps** — numbered, with client behavior and server side-effects interleaved
- **Success criteria** — what "done correctly" looks like
- **Error / edge cases** — failures and how they're surfaced

File-path citations point at the load-bearing code so anyone debugging a flow can land in the right place quickly.

---

## 1. Guard Login (email + password)

**Trigger**: Guard taps Sign In on `/(auth)/login`.

**Actor**: Guard (mobile app).

**Steps**:

1. Mobile collects `email`, `password`, plus the current Expo push token if one is already cached.
2. Mobile POSTs `/api/auth/guard/login` with `{email, password, fcm_token}` ([apps/api/src/routes/auth.ts:63-144](apps/api/src/routes/auth.ts:63)).
3. Server looks up the guard by lowercase-trimmed email, joining `companies` (for company `is_active`) and `guard_site_assignments` + `sites` (to confirm at least one assigned site is still active).
4. Server bcrypts the password against `guards.password_hash`. If the email doesn't exist, bcrypt is still run against a dummy hash to prevent timing-based email enumeration.
5. On bad password OR missing guard: increment `login_attempts.failed_count` (upsert), set `locked_at = NOW()` if count reaches 5, log `login_failed` to `auth_events`. Return 401 "Invalid credentials."
6. On guard `is_active = false`: return 403 "Account deactivated. Contact your supervisor."
7. On company `is_active = false`: return 403 "Your company account has been deactivated…"
8. On all assigned sites inactive: return 403 "Your assigned site has been deactivated…"
9. On lockout (count ≥ 5): return **423 Locked** with `{locked: true}`. Only manual admin unlock recovers.
10. On success: reset `login_attempts.failed_count = 0`, persist the `fcm_token` to `guards.fcm_token` if provided, mint access (8h TTL) + refresh (30d TTL) JWTs via `signTokens` ([auth.ts:40-46](apps/api/src/routes/auth.ts:40)), log `login_success`, return `{access, refresh, must_change_password}`.
11. Mobile stores both tokens in `expo-secure-store` via `authStore.loginWithEmail` ([apps/mobile/store/authStore.ts](apps/mobile/store/authStore.ts)); pushes Sentry user tags via `setUserTags({guardId, companyId, role})` from [apps/mobile/lib/sentry.ts](apps/mobile/lib/sentry.ts).
12. Root layout's route guard redirects based on `must_change_password`: if true, force `/(auth)/change-password`; if false, redirect to `/(tabs)/home`.

**Success criteria**: Mobile lands on home tab with a valid `Authorization: Bearer <access>` header on subsequent requests; `auth_events` row recorded.

**Error / edge cases**:
- **Network failure mid-request**: mobile shows "Network request failed" alert. No partial state; retry is safe.
- **Token expiry mid-session**: 8 hours later, the next API call returns 401; [apps/mobile/lib/apiClient.ts:48-56](apps/mobile/lib/apiClient.ts:48) silently calls `/api/auth/refresh`, retries the original call once. If refresh also fails, `authStore.logout()` runs and the user is bounced to `/(auth)/login`.
- **Refresh-token revocation**: if an admin nuked the guard's tokens via `tokens_not_before`, the next access-token call returns 401 "Session revoked by administrator" ([apps/api/src/middleware/auth.ts:76-83](apps/api/src/middleware/auth.ts:76)).

---

## 2. FCM Token Registration (two paths)

**Trigger**: (a) Login completes, OR (b) auto-login via persisted refresh token on cold start.

**Actor**: Mobile app (background).

**Steps (path A — login)**:

1. Mobile already had a cached Expo push token, sent it in the login body. Server persisted to `guards.fcm_token` in step 10 above.

**Steps (path B — cold-start auto-login)**:

1. Mobile cold start; access token in `expo-secure-store` is still valid (or refresh succeeds).
2. `_layout.tsx` effect fires: `Notifications.requestPermissionsAsync()` → on granted, `Notifications.getExpoPushTokenAsync({ projectId: EAS_PROJECT_ID })` returns an Expo push token shaped `ExponentPushToken[...]`.
3. Mobile POSTs `/api/auth/guard/fcm-token` with `{fcm_token}` ([apps/api/src/routes/auth.ts:173-180](apps/api/src/routes/auth.ts:173)).
4. Server validates the token shape, updates `guards.fcm_token` for the authenticated guard.

**Success criteria**: `guards.fcm_token` matches the device's current Expo push token.

**Edge cases**:
- Permission denied: server is never told. The guard stops receiving pushes silently. No retry until next launch.
- Token rotation by Expo / Apple: `getExpoPushTokenAsync` returns a new value; path B keeps it fresh.

---

## 3. Guard Clock-In (full 4-step flow + server transaction)

**Trigger**: From `/(tabs)/home`, guard taps the assigned shift card → routes to `/clock-in/step1`.

**Actor**: Guard (mobile app); API runs validation + writes inside a transaction.

**Steps**:

1. **Step 1 — GPS** ([apps/mobile/app/clock-in/step1.tsx](apps/mobile/app/clock-in/step1.tsx))
   - Request foreground location permission.
   - `Location.getCurrentPositionAsync({ accuracy: High })` → `{lat, lng, accuracy}`.
   - Client-side haversine pre-check against site polygon center + 1.5× radius; if outside, show "Outside boundary" with a Retry button (no progression).
   - On inside: `setGpsVerified(lat, lng, accuracy)` to `clockInStore`. Accuracy defaults to 30m if the device returns null (iOS simulator / coarse permission).
   - NEXT button enabled → `router.push('/clock-in/step2')`.

2. **Step 2 — Selfie** ([apps/mobile/app/clock-in/step2.tsx](apps/mobile/app/clock-in/step2.tsx))
   - Front camera; capture gated on `cameraReady`.
   - `takePictureAsync` → `ImageManipulator.manipulateAsync(uri, [{resize: {width: 1080}}], {compress: 0.8, format: JPEG})`. The manipulator step is where EXIF is stripped (iOS `UIImage.jpegData`, Android `Bitmap.compress`); see TRD §4.6.
   - Preview screen with RETAKE / USE PHOTO. On USE: `setSelfie({uri, latitude, longitude, takenAt})` → `router.push('/clock-in/step3')`.

3. **Step 3 — Site photo** ([apps/mobile/app/clock-in/step3.tsx](apps/mobile/app/clock-in/step3.tsx))
   - Rear camera; same capture + manipulator pipeline. Shows the site's instruction string (admin-defined per site) if present.
   - On USE: `setSitePhoto({...})` → `router.push('/clock-in/step4')`.

4. **Step 4 — Confirm & Start** ([apps/mobile/app/clock-in/step4.tsx](apps/mobile/app/clock-in/step4.tsx))
   - Lazy `useState(() => uuidv4())` generates one Idempotency-Key per mount. Re-entering the screen after a 422 produces a fresh UUID.
   - Tap START SHIFT → three sequential API calls:

5. **Upload selfie to S3** (via [apps/mobile/lib/uploadToS3.ts](apps/mobile/lib/uploadToS3.ts))
   - POST `/api/uploads/presign` → `{post_url, fields, public_url, max_bytes}`.
   - Build multipart form with fields-first-file-last, POST to S3.
   - S3 enforces content-length-range, Content-Type, key from the policy. Returns 204 on success.
   - On any S3 error, mobile catches and falls back to `selfieUrl = 'pending'` so the clock-in still proceeds (legacy fallback, marked for removal).

6. **POST /api/shifts/:id/clock-in** with body `{lat, lng, accuracy, clock_in_coords}` + header `Idempotency-Key: <uuid>` ([apps/api/src/routes/shifts.ts:215-320](apps/api/src/routes/shifts.ts:215))
   - Idempotency middleware (`idempotent('clock-in')`) checks cache. On hit: replay `{status, body}` with `Idempotent-Replay: true` header.
   - On miss: enter the transaction. `BEGIN`.
   - `SELECT * FROM shifts WHERE id = $1 AND guard_id = $2 AND status = 'scheduled' FOR UPDATE` — row-locks the shift.
   - If no row: ROLLBACK + 404 "Shift not found or not schedulable."
   - Call `validateClockInGeofence({lat, lng, accuracy_m: accuracy}, shift.site_id, client)` using the same PoolClient. Polygon-first + radius+accuracy+50m fallback.
   - **If geofence fails**: ROLLBACK, emit info log `geofence.reject site=<id> guard=<id> shift=<id> distance=<m> accuracy=<m> reason=<polygon|radius|both>`, return **422 GEOFENCE_FAILED** with `{message, distance_m, accuracy_m, reason}`.
   - On pass: `INSERT INTO shift_sessions ...` → if it returns `23505` violating `idx_shift_sessions_one_open_per_guard`, return **409** "Already clocked in on another device." The partial unique index ([apps/api/src/db/schema_v9.sql:17-19](apps/api/src/db/schema_v9.sql:17)) is the data-integrity backstop when the idempotency cache misses.
   - `UPDATE shifts SET status = 'active'`. `COMMIT`.
   - **Outside the transaction**: `generateTaskInstancesForShift(...)` fires async (non-critical; failures logged only).
   - Return 201 with the new `shift_session` row.

7. **POST /api/locations/clock-in-verification** with body `{shift_session_id, selfie_url, site_photo_url, verified_lat, verified_lng, accuracy}` ([apps/api/src/routes/locations.ts](apps/api/src/routes/locations.ts))
   - Magic-byte validates the selfie and site photo URLs via `validatePhotoOrQuarantine`. Sentinel `'pending'` and `null` URLs skip validation (legacy fallback).
   - On magic-byte mismatch: insert `quarantined_uploads` row + return 400 with the detected MIME label.
   - Resolve `site_id` from the session (NEVER trust a client-supplied `site_id`).
   - Re-run `validateClockInGeofence` against the verified coords. Client-supplied `is_within_geofence` is accepted on the wire but **ignored**; server computes its own and writes that to the DB.
   - On geofence fail at this step: 422 GEOFENCE_FAILED (rare in practice; would only happen if the guard moved meaningfully between step 6 and step 7).
   - On success: INSERT `clock_in_verifications` row.

8. **Mobile finalization**:
   - `setActiveSession(shift, session)` in `shiftStore`. Background geofence task starts via `_layout.tsx` effect.
   - If site has `instructions_pdf_url`: show modal offering VIEW INSTRUCTIONS / SKIP.
   - Redirect to `/(tabs)/home`; UI flips into "on shift" mode.

**Success criteria**:
- `shifts.status = 'active'`, one `shift_sessions` row exists with `clocked_out_at IS NULL`, one `clock_in_verifications` row exists with `is_within_geofence = true` (server-computed), task instances generated.
- Sentry `shift_id` tag now populated for subsequent events.

**Error / edge cases**:
- **422 GEOFENCE_FAILED**: friendly alert "You appear to be outside the site post. Move to the post entrance and try again." → `router.replace('/clock-in/step1')` to re-fetch GPS. The new mount produces a fresh Idempotency-Key.
- **409 already-clocked-in**: alert "Already clocked in on another device. Clock out first." User can clock out the other session (mobile shows the active session on home and offers clock-out).
- **Double-tap or in-flight network blip**: same Idempotency-Key on the second POST → server replays cached response with `Idempotent-Replay: true`. No duplicate session.
- **App force-quit mid-S3-upload**: on relaunch, `selfieUrl = 'pending'` fallback fires; clock-in proceeds without a photo URL. Operator sees the gap in the verification record.
- **Magic-byte rejection** (someone deliberately uploads non-image bytes): `quarantined_uploads` row, 400 with detected MIME, no clock-in.

---

## 4. Active Shift — Ping Submission

**Trigger**: Periodic — countdown rolls over (every `pingIntervalMs` from `useBatteryThrottle`), OR the guard taps PING NOW from `/active-shift`.

**Actor**: Guard.

**Steps**:

1. From `/active-shift`, `router.push('/ping')` lands on the ping-router screen ([apps/mobile/app/ping/index.tsx](apps/mobile/app/ping/index.tsx)) which immediately `router.replace('/ping/photo')` (the GPS-only ping was retired).
2. Camera permission check; rear camera mounts.
3. Tap shutter (gated on `cameraReady` with a 3s force-enable fallback).
4. `takePictureAsync` wrapped in 10s `withTimeout` so a hung native call can't strand the shutter.
5. Manipulator: resize 1080px, compress 0.8 quality, JPEG. EXIF stripped.
6. GPS read: `getLastKnownPositionAsync` (instant) falling back to `getCurrentPositionAsync` raced against a 3s timeout. If both fail, ping submits with `latitude: 0, longitude: 0`.
7. Read current throttle reason via `getCurrentThrottleReason()` from [apps/mobile/lib/batteryThrottle.ts](apps/mobile/lib/batteryThrottle.ts). Returns `'low_battery'`, `'low_power_mode'`, or `null`.
8. `submitPing({shift_session_id, latitude, longitude, ping_type: 'gps_photo', photo_url, throttle_reason})` from `offlineStore`. The wrapper tries the API first; on failure, enqueues locally and triggers `syncQueue()`.
9. **POST /api/locations/ping** ([apps/api/src/routes/locations.ts](apps/api/src/routes/locations.ts))
   - Validate `throttle_reason` against the `ALLOWED_THROTTLE_REASONS` set; reject 400 on typo (belts the DB CHECK).
   - Lookup `shift_sessions` by id+guard; reject 403 if not found.
   - `validatePhotoOrQuarantine(photo_url, ctx)` — magic-byte check; quarantine + 400 on mismatch.
   - Server-side geofence reconciliation: read `site_geofence.polygon_coordinates` and `isPointInPolygon(...)` on the supplied lat/lng. Result stored as `is_within_geofence` on the ping row.
   - INSERT `location_pings` row with `photo_delete_at = NOW() + 7 days` (rolling-deletion clock).
10. On success: mobile shows "Ping Submitted — Photo and location saved" alert, suppresses next PING DUE alert for 30 minutes, routes back to `/active-shift`.

**Success criteria**:
- `location_pings` row created with `is_within_geofence` server-computed, `throttle_reason` matches the device state at submit time, S3 object retrievable, countdown resets on `/active-shift`.

**Error / edge cases**:
- **Offline submit**: `submitPing` enqueues to `offlineQueue` (AsyncStorage-backed). `startQueueSync()` drains on shift start; manual sync fires on every enqueue. Replay-safe by virtue of mobile-generated `localId` for optimistic UI.
- **Magic-byte rejection on the ping photo**: 400 with detected MIME; quarantine row inserted. Mobile surfaces error; guard re-takes.
- **GPS timed out (3s)**: ping submits with `(0, 0)`. Server geofence check will mark it as out-of-bounds. Operationally undesirable but better than blocking the shift on a single bad GPS read.
- **Battery throttle changes mid-flow**: ping in flight captures the throttle reason at submit time (Step 7). The `intervalMs` adjustment for the *next* ping cadence picks up the new state on the active-shift screen automatically.

---

## 5. Active Shift — Background Geofence Breach

**Trigger**: Periodic — `expo-task-manager` task fires every 2.5 min OR every 50m movement (whichever first) while the guard is on shift.

**Actor**: Mobile background task; no guard interaction unless they tap the resulting push.

**Steps**:

1. Task body in [apps/mobile/tasks/locationBackground.ts](apps/mobile/tasks/locationBackground.ts) reads stored `active_geofence`, `active_session_id`, `guard_access_token`, and previous state from `SecureStore`.
2. Haversine pre-check; if `distance > radius_meters`, polygon ray-cast confirms.
3. Compare to previous state. If same: no-op (prevents spam on jitter near the boundary).
4. On INSIDE → OUTSIDE transition:
   - `Notifications.scheduleNotificationAsync(...)` — fires a local push "Outside post boundary." Tap routing handled by `navigateForNotification`.
   - POST `/api/locations/violation` with `{shift_session_id, latitude, longitude}` ([apps/api/src/routes/locations.ts:59-116](apps/api/src/routes/locations.ts:59)).
5. Server:
   - Lookup session → site.
   - INSERT `geofence_violations` row (open: `resolved_at IS NULL`).
   - Async fan-out: query the company's active admins for their FCM tokens; `sendGeofenceViolationAlert(...)` pushes "⚠️ Geofence Violation — <site>" to each admin device.
   - `insertNotification(...)` writes a `notifications` row for the guard's notification log: "Outside post boundary — Return to the post."
6. On OUTSIDE → INSIDE transition: state flips back; no notification (the breach record auto-resolves only when an admin or guard explicitly resolves via `PATCH /api/locations/violation/:id/resolve`).

**Success criteria**:
- `geofence_violations` row exists, admin push delivered, guard's notification log has a `geofence_breach` entry.

**Error / edge cases**:
- **Background task killed by OS**: Expo's task manager is best-effort. iOS may suspend tasks under battery pressure or low priority; the foreground service notification on Android keeps the process alive. If the task doesn't fire, no breach is recorded — the per-ping geofence reconciliation (Flow 4) is the secondary signal.
- **No access token in SecureStore** (rare race): the task returns early without posting.
- **Guard cannot view their own violation history from the UI**. The `geofence_violations` row is created and the `GET /api/locations/violations` endpoint serves it, and a working `(tabs)/alerts.tsx` screen renders it — but **no entry point in the mobile UI routes to that screen**. This is the orphaned-alerts finding from UX doc §2 (Note on the orphaned `alerts` route) and DRIFT FINDINGS. Re-wiring is captured in Implementation Plan's Immediate Backlog.

---

## 6. Incident Report Submission

**Trigger**: Guard taps REPORT from `/active-shift`, OR opens from a push-notification deep link (`activity_report_reminder`).

**Actor**: Guard.

**Steps**:

1. Mobile opens the unified report form at [apps/mobile/app/reports/new.tsx](apps/mobile/app/reports/new.tsx). Type dropdown defaults from `useLocalSearchParams` (e.g. push-tap routes here with `type=activity` pre-selected).
2. Guard picks `type = 'incident'`.
3. Description textarea (free text). Optional: tap "✨ Enhance with AI" → calls `POST /api/ai/enhance-description` (Flow 7, below).
4. **Severity selection**: in the unified form, the severity field has been removed entirely (2026-05-15 UX simplification). The DB column is still nullable for historical incidents. The legacy per-type form ([apps/mobile/app/reports/new/incident.tsx](apps/mobile/app/reports/new/incident.tsx)) still has a 4-tier picker but is unrouted dead code (UX doc DRIFT FINDINGS).
5. Photo attach via `usePhotoAttachments` hook — camera or library, manipulator-pipelined to 1080px / 0.8 JPEG with EXIF stripped. Max 5 per report.
6. Server-side validation enforces: incident requires at least 1 photo ([reports.ts:126-133](apps/api/src/routes/reports.ts:126)). This is the V5 chain-of-custody rule — mobile enforces client-side too but the server enforces redundantly so direct API hits can't bypass.
7. Submit → POST `/api/reports` with `{shift_session_id, report_type, description, severity, photo_urls, latitude, longitude}`.
8. Server:
   - Validate `report_type` ∈ `{activity, incident, maintenance}`.
   - Validate description non-empty.
   - Validate `shift_session_id` belongs to guard AND `clocked_out_at IS NULL`.
   - **Magic-byte validate every photo URL** ([reports.ts:143-193](apps/api/src/routes/reports.ts:143)) — same `getS3ObjectHead(key, 16)` + `magicMatches` pattern as elsewhere. On mismatch: quarantine + 400; the report is NOT created and its photo URLs are NOT linked.
   - Geofence-violation check: reject submission if guard has an unresolved `geofence_violations` row (chain-of-custody rule).
   - INSERT `reports` row; INSERT N `report_photos` rows.
   - **If `report_type = 'incident'`**: fire-and-forget call `sendIncidentAlert(report, site_id).catch(console.error)` ([apps/api/src/routes/reports.ts:229-232](apps/api/src/routes/reports.ts:229)). The promise is **not awaited**; any rejection is swallowed into Railway stdout. SendGrid HTML email to the client portal contact: red "INCIDENT ALERT" header, severity badge, description, "View in Client Portal" CTA.
9. Server returns 201 with the report id **immediately**, regardless of the email outcome.
10. Mobile shows confirmation banner: "Incident submitted. Client has been notified by email." *(Note: the banner asserts client notification but the email is fire-and-forget — see error cases below and DRIFT FINDINGS.)*

**Success criteria**:
- `reports` + `report_photos` rows persisted, S3 objects retained, client email delivered within ~60 seconds (no telemetry; intent per NFR table in TRD §3).

**Error / edge cases**:
- **No active session**: 403.
- **Magic-byte mismatch on any photo**: report is rejected entirely; first quarantine row inserted; subsequent photos may not be checked (loop short-circuits on first failure).
- **Unresolved geofence violation**: report submission blocked; guard must resolve the violation first.
- **SendGrid failure (silent customer-facing failure)**: because the email call is fire-and-forget with `.catch(console.error)`, any failure (timeout, quota exceeded, recipient bounce, API outage) is swallowed into Railway stdout. The report row is already committed; the guard sees the 201 success banner that says "Client has been notified by email"; the client portal contact receives nothing; nobody is alerted. Detectable only by manual `grep '[email] sendIncidentAlert: SENDGRID ERROR'` against Railway logs. See DRIFT FINDINGS below.
- **Network failure on submit**: `submitReport` in `offlineStore` enqueues to `offlineQueue`. Reports persist locally and sync when connectivity returns. Note: incident emails fire only on the API path, so an offline-queued incident's email is delayed until sync.

---

## 7. AI Report Enhancement

**Trigger**: Guard or admin taps "✨ Enhance with AI" while composing a report description.

**Actor**: Guard or company admin (both roles accepted).

**Steps**:

1. Mobile/web POSTs `/api/ai/enhance-description` with `{text, report_type}` ([apps/api/src/routes/ai.ts](apps/api/src/routes/ai.ts)).
2. Server validates `text` length ≥ 10 chars; returns 400 otherwise.
3. Server invokes `anthropic.messages.create({model: ANTHROPIC_MODEL, max_tokens: 1024, ...})` with a system prompt that instructs Claude to rewrite the raw description into a professional security-report entry — preserving all facts, no fabrication, past tense first person.
4. Model ID is sourced from env via `process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5-20250929'`. **Production-ops example**: the previous pin `claude-sonnet-4-20250514` was retired by Anthropic on 2026-04-20 and the endpoint started returning 404 with `model: claude-sonnet-4-20250514`. The env-var override let us roll forward to `claude-sonnet-4-5-20250929` without a code deploy. See [ai.ts:12-24](apps/api/src/routes/ai.ts:12) for the full incident comment.
5. On HTTP 529 (Anthropic overloaded): retry with exponential backoff — 1s, 2s, 4s, max 3 attempts. Any other error throws immediately.
6. On success: return `{enhanced: string}`. Mobile/web replaces the description field with the enhanced text; user can edit further or revert.
7. On any failure: return 500 with the error message; mobile/web shows a non-blocking alert. The user can still submit the original description — AI enhancement is optional.

**Success criteria**: Enhanced text appears in the description field; user can accept, edit, or revert.

**Error / edge cases**:
- **Model retired by Anthropic**: env-var override on Railway is the fast path. Set `ANTHROPIC_MODEL=claude-X-Y-Z` and the next request picks it up.
- **Anthropic API key missing**: `anthropic.messages.create` throws at the SDK level; 500 returned to caller.
- **Rate limit (429) or persistent 529**: 3 retries exhaust; 500 returned. User submits the original description.

---

## 8. Task Completion

**Trigger**: From `/active-shift`, guard taps TASKS → `/(tabs)/tasks` → tap a pending task instance → `/tasks/complete/[id]`.

**Actor**: Guard.

**Steps**:

1. Mobile shows pending task instances for the current shift (filtered via `GET /api/tasks/instances?shift_id=X`).
2. Tap a task → completion screen.
3. If `template.requires_photo`: camera capture with manipulator pipeline; otherwise skip.
4. Tap MARK COMPLETE → POST `/api/tasks/instances/:id/complete` with `{completion_lat, completion_lng, photo_url, shift_session_id}` ([apps/api/src/routes/tasks.ts:40-73](apps/api/src/routes/tasks.ts:40)).
5. Server:
   - Fetch the task instance + template, confirm `status = 'pending'`. Reject 404 otherwise.
   - If `template.requires_photo = true` and `photo_url` absent: 400.
   - Transaction: INSERT `task_completions` + UPDATE `task_instances.status = 'completed'`. COMMIT.
   - Return `{success: true}`.
6. Mobile re-fetches the task list (task disappears from pending; appears in completed).

**Success criteria**: `task_completions` row, `task_instances.status = 'completed'`.

**Error / edge cases**:
- **Photo required but missing**: 400 with the message; UI prompts to capture.
- **Task already completed** (e.g. completed on another device, or admin manually marked it): 404.
- **Magic-byte not enforced on task completion photos**: the task-completion endpoint does NOT call `validatePhotoOrQuarantine`. Coverage gap relative to reports / ping / clock-in-verification. Worth flagging for follow-up coverage extension. (Noted in DRIFT FINDINGS below.)

---

## 9. Guard Clock-Out

**Trigger**: From `/active-shift`, tap CLOCK OUT → confirm.

**Actor**: Guard.

**Steps**:

1. `/clock-out/index.tsx`: optional handover notes textarea.
2. Tap Confirm → POST `/api/shifts/:id/clock-out` with `{handover_notes}` ([apps/api/src/routes/shifts.ts:329-396](apps/api/src/routes/shifts.ts:329)).
3. Server transaction (`BEGIN`):
   - `UPDATE shift_sessions SET clocked_out_at = NOW() WHERE shift_id = $1 AND guard_id = $2 AND clocked_out_at IS NULL RETURNING ...` (joined with `shifts` to pull `scheduled_start`).
   - If no row: ROLLBACK + 404 "Active session not found."
   - Close any open `break_sessions` row: `UPDATE break_sessions SET break_end = NOW(), duration_minutes = ...` for rows with `break_end IS NULL`.
   - Compute totals: sum break minutes, then `total_hours = max(0, gross_hours - break_hours)` where `gross_hours = max(0, (clock_out - max(clock_in, scheduled_start)) / 3_600_000)`. Early arrivals don't earn pay before scheduled_start; late stays still count ("Option C" math, matching `autoCompleteShifts.ts` for consistency).
   - `UPDATE shift_sessions SET total_hours = $1, handover_notes = $2`.
   - `UPDATE shifts SET status = 'completed'`. COMMIT.
4. Server returns the session with `total_hours` and `handover_notes`.
5. Mobile: `clearSession()` in `shiftStore`. Sentry `shift_id` tag cleared. Background geofence task stopped via `_layout.tsx` effect.
6. Redirect to `/(tabs)/home`.

**Success criteria**:
- `shifts.status = 'completed'`, `shift_sessions.clocked_out_at` populated, `total_hours` computed, any open break closed, mobile back on home in "off shift" state.

**Error / edge cases**:
- **No active session**: 404 (guard tried to clock out without clocking in, or session already closed elsewhere).
- **Transaction error mid-flight**: ROLLBACK; nothing partially mutates. 500 returned; guard retries.
- **Auto-complete cron firing in parallel** ([apps/api/src/jobs/autoCompleteShifts.ts](apps/api/src/jobs/autoCompleteShifts.ts)): the cron closes shifts whose `scheduled_end` is in the past; if both fire at the same time, the second loses (no row to UPDATE). Idempotent on the shift level.

---

## 10. Admin — Schedule a Shift

**Trigger**: Admin opens `/admin/shifts` in the Admin Portal.

**Actor**: Company admin.

**Steps**:

1. UI presents a calendar/list view with a "Schedule shift" button.
2. Admin picks: guard (from company roster), site, scheduled_start, scheduled_end, optional `repeat_days` for recurring.
3. POST `/api/shifts` with `{guard_id, site_id, scheduled_start, scheduled_end, repeat_days}` ([apps/api/src/routes/shifts.ts:9 onward](apps/api/src/routes/shifts.ts:9)).
4. Server validates required fields, verifies site belongs to admin's company, inserts one or N `shifts` rows depending on `repeat_days`.
5. UI re-fetches; new shift appears in the calendar.

**Success criteria**: `shifts` row(s) present with `status = 'scheduled'`; guard sees the shift on `/(tabs)/schedule` next time they refresh.

**Error / edge cases**:
- **Site not in admin's company**: 403.
- **Conflict with existing shift**: no automatic conflict detection today; the system will accept overlapping shifts assigned to the same guard. Admin-side responsibility.

---

## 11. Admin — Live Status Monitoring

**Trigger**: Admin opens `/admin/live-map`.

**Actor**: Company admin.

**Steps**:

1. Leaflet map mounts with the company's sites as polygons.
2. Page polls the API every N seconds (interval defined in [apps/web/components/admin/AdminNav.tsx](apps/web/components/admin/AdminNav.tsx) as `CHAT_POLL_MS = 15_000` for chat; live-map likely uses a similar interval — confirm in the live-map page source for the exact value).
3. Each poll: `GET /api/admin/active-shifts` (or similar) returns currently-active sessions with the latest `location_pings.latitude/longitude` per session.
4. Map renders one guard pin per active session, colored by `is_within_geofence` (green inside, red outside).
5. Admin can tap a pin → drawer with guard name, site, shift duration, link to recent reports.

**Success criteria**: Pins update every poll cycle; out-of-bounds guards visually distinct.

**Error / edge cases**:
- **No active shifts**: empty state — map renders with sites only.
- **Browser tab inactive**: polling continues but at degraded frequency (modern browsers throttle background timers).

---

## 12. Admin — Incident Triage

**Trigger**: Incident email arrives in admin/client inbox, OR admin opens `/admin/reports` with `type=incident` filter.

**Actor**: Company admin (primarily).

**Steps**:

1. Admin opens the report from email link OR from the filtered list.
2. `GET /api/reports/:id` returns the report with photos array ([reports.ts:57-105](apps/api/src/routes/reports.ts:57)). Authorization: admin sees reports only for their company.
3. Admin reviews description, photos, severity badge.
4. Today: no in-app follow-up action surface. Admin acts via phone, email, or chat with the guard.

**Success criteria**: Admin has seen the incident within minutes of submission; out-of-band follow-up triggered.

**Edge cases / gaps**:
- **No incident-acknowledge / triage workflow** in the app. The admin can read but cannot mark an incident "reviewed" or "escalated." Workflow happens in external tools.
- **Severity-based routing** (Tier-1 audit deferred item): all severities go to the same email recipient list. No paging for `critical` outside business hours.

---

## 13. Client Portal Access (read-only)

**Trigger**: Client receives the 9 AM daily digest email or an instant incident alert, taps "View in Client Portal."

**Actor**: End client (site owner / property manager).

**Steps**:

1. Client lands at `/client/login`, signs in with email + password.
2. POST `/api/auth/client/login` ([apps/api/src/routes/auth.ts:245-288](apps/api/src/routes/auth.ts:245)).
3. Server validates against `clients.password_hash`. Joins `sites` + `companies` to confirm both still active.
4. **Retention check**: reads `data_retention_log.client_star_access_disabled` — if true, 403 "Access to this site has expired. Contact your security provider." This is the day-90 boundary enforced.
5. On success: site-scoped JWT (`{sub: client.id, role: 'client', site_id: client.site_id}`), 8h TTL.
6. UI lands on `/client` — KPIs + recent reports for the assigned site.
7. Client can: view reports (`/client` page), see schedule (`/client/schedule`), download daily PDF (`/client/download`).
8. Every query is `site_id`-scoped server-side. A client cannot read another site's data even if they tamper with URLs.

**Success criteria**: Client sees only their site's data; daily PDF generates with the date range; report photos render via presigned GET URLs.

**Error / edge cases**:
- **Day-90 retention disabled**: login blocked with the expiration message.
- **Site inactive**: 403 "Your site access has been deactivated."
- **Client portal account inactive** (admin disabled): 401.

---

## 14. Daily 9 AM Client Digest Email

**Trigger**: `cron '0 9 * * *'` in `America/Los_Angeles` ([apps/api/src/jobs/dailyShiftEmail.ts:18-19](apps/api/src/jobs/dailyShiftEmail.ts:18)).

**Actor**: Cron, no human.

**Steps**:

1. At 9:00 PT: query `shifts WHERE status = 'completed' AND daily_report_email_sent = false AND scheduled_end >= NOW() - INTERVAL '36 hours' AND scheduled_end < NOW() - INTERVAL '1 hour'`.
2. For each shift, call `sendDailyShiftReport(shift.id)` ([apps/api/src/services/email.ts:115 onward](apps/api/src/services/email.ts:115)).
3. SendGrid delivers an HTML digest with site name, guard, shift duration, report counts, photo gallery.
4. Mark `shifts.daily_report_email_sent = true, daily_report_email_sent_at = NOW()`.
5. Log `[daily-email] Done — sent: N, failed: M`.

**Success criteria**: Each completed shift in the window gets exactly one digest email.

**Error / edge cases**:
- **DST flip**: handled automatically by the cron's `timezone: 'America/Los_Angeles'` option. Verified to fire correctly across the 2026-03 flip.
- **SendGrid down**: per-shift error logged, retry happens on the next 9 AM run (the `daily_report_email_sent = false` filter catches the failed shift the next day).

---

## 15. Push Notification Delivery

**Trigger**: Server-side event that warrants notifying a guard or admin (chat message, ping reminder, geofence breach, task reminder).

**Actor**: API server.

**Steps**:

1. The originating route or cron calls `sendPushNotification({token, title, body, data})` ([apps/api/src/services/firebase.ts:54-110](apps/api/src/services/firebase.ts:54)).
2. **Token routing**:
   - If token starts with `ExponentPushToken[`: POST to Expo Push API (`https://exp.host/--/api/v2/push/send`). This is the path for all mobile guard devices.
   - Otherwise: Firebase Admin SDK `admin.messaging().send(...)`. Reserved for raw FCM tokens (admins' web push tokens, future use cases).
3. Expo Push API forwards to APNs / FCM as appropriate.
4. Mobile receives:
   - **Foreground**: `Notifications.setNotificationHandler` ([apps/mobile/app/_layout.tsx:31-39](apps/mobile/app/_layout.tsx:31)) shows banner + plays sound + sets badge.
   - **Background or killed**: OS handles delivery via system notification UI.
5. Mobile-side `addNotificationReceivedListener` ([apps/mobile/app/_layout.tsx:123-135](apps/mobile/app/_layout.tsx:123)) optimistically bumps the unread-badge counter and re-syncs from the server 500ms later.
6. **Tap routing**: `addNotificationResponseReceivedListener` ([apps/mobile/app/_layout.tsx:112-118](apps/mobile/app/_layout.tsx:112)) reads `notification.request.content.data.type` and routes via `navigateForNotification` ([apps/mobile/lib/navigateForNotification.ts](apps/mobile/lib/navigateForNotification.ts)) — chat tap opens the room, geofence tap opens active-shift, etc.
7. **Server-side notification log**: alongside the push, the originating call site invokes `insertNotification({guardId, type, title, body, data})` ([apps/api/src/services/notifications.ts](apps/api/src/services/notifications.ts)) so the in-app Notifications tab also has a record.

**Success criteria**: Push arrives within seconds; in-app log row created; tap routing lands on the right screen.

**Error / edge cases**:
- **Expo push 200 with `data.status: 'error'`**: logged as `[expo-push] Delivery error`. Common causes: DeviceNotRegistered (token rotated; clear from `guards.fcm_token`), MessageRateExceeded.
- **Firebase admin not initialized**: warned `[firebase] Admin SDK not initialized — skipping raw FCM push`. Path A (Expo tokens) still works.
- **`insertNotification` fails**: logged but doesn't throw — push delivery isn't blocked by log persistence.

---

## 16. Background Location Pings (configurable cadence + battery throttle)

**Trigger**: Continuous while a shift is active. Cadence = `pingIntervalMs = (sites.ping_interval_minutes ?? 30) * 60_000 * batteryMultiplier`.

**Actor**: Mobile (foreground prompt + manual ping submission) and the `expo-task-manager` background task (geofence monitoring).

**Steps**: See Flow 4 (ping submission) for the on-demand path and Flow 5 (background geofence) for the silent path. The cadence orchestration on `/active-shift`:

1. On screen mount, `useBatteryThrottle(baseIntervalMs)` returns `{intervalMs, throttleReason, isThrottled}`.
2. `baseIntervalMs = (activeShift.ping_interval_minutes ?? 30) * 60_000` — captured ONCE at mount per Q37 semantics. Admin edits mid-shift do NOT disturb the active shift; the new cadence is picked up at the next clock-in.
3. `useBatteryThrottle` runs a hysteresis state machine ([apps/mobile/lib/batteryThrottle.ts](apps/mobile/lib/batteryThrottle.ts)):
   - `normal` (1×) when battery > 30% AND low-power-mode off
   - `throttled_2x` when battery < 20% OR low-power-mode on; recovery requires battery > 30% AND low-power off
   - `throttled_3x` when battery < 10%; recovery requires battery > 15%
4. Every state transition emits a **Sentry breadcrumb** (NOT event) with `{from, to, battery_pct, low_power_mode, effective_interval_ms}`. Well-tuned hysteresis → 1-2 transitions per shift; flapping would be visible as 50+ breadcrumbs in any subsequent event's trail.
5. While throttled (state ≠ `normal`): amber banner on `/active-shift` reads "Low battery — pings reduced to every {N} minutes. Plug in when possible." N is the effective cadence (base × multiplier), interpolated dynamically.
6. Countdown rolls over → PING DUE alert → guard taps PING NOW → Flow 4 fires. Submitted ping carries `throttle_reason: getCurrentThrottleReason()` from the module-level singleton.
7. Server writes `throttle_reason` to `location_pings.throttle_reason`. Client portal / admin can distinguish "throttled" from "missed."

**Success criteria**:
- Cadence respects per-site config + battery state; throttle reason written to every affected ping; banner accurately reflects the multiplier.

**Error / edge cases**:
- **`expo-battery` init failure on simulator / older Android**: hook stays in `normal` state (no throttle phantom-low). Logged `[battery] init failed (assuming normal state)`.
- **Tiebreaker** (battery < 20% AND low-power-mode on): `throttle_reason = 'low_battery'` (more actionable for the operator — phone about to die signals SOS escalation).

---

## 17. Error Reporting (Sentry capture path)

**Trigger**: Any uncaught exception, unhandled promise rejection, or native crash on mobile; any thrown error on the API.

**Actor**: Sentry SDK + the API/mobile Sentry init.

**Steps**:

1. **Mobile** ([apps/mobile/lib/sentry.ts](apps/mobile/lib/sentry.ts)):
   - Init at module load (before any component mounts) via `initSentry()`. Gated on `EXPO_PUBLIC_SENTRY_DSN`.
   - `sampleRate: 1.0` for errors, `tracesSampleRate: 0.05` for performance.
   - Tags pushed: `env`, `device_os`, `app_version`, `build_number` at init; `company_id`, `role`, `shift_id` from store subscriptions; `Sentry.setUser({id: guardId})` on login/logout.
   - `beforeSend` scrubs `password`, `token`, `secret`, `api_key`, `authorization`, `access`/`refresh` tokens, `email`, `fcm_token`, and `X-Amz-*` / `Signature` / `Policy` / `Credential` query params from S3 URLs.

2. **API** ([apps/api/src/services/sentry.ts](apps/api/src/services/sentry.ts)):
   - Init MUST run before `express` is imported (v8 auto-instrumentation patches the prototype). `import { Sentry } from './services/sentry'` is the first import in `src/index.ts`.
   - `Sentry.setupExpressErrorHandler(app)` runs after all routes; captures errors and delegates to Express's default 500 handler (clients still get the standard 500 response).
   - Per-request tagging via `tagRequest(req, payload)` in `requireAuth` ([apps/api/src/middleware/auth.ts:88](apps/api/src/middleware/auth.ts:88)): `user_id`, `role`, `company_id`, `endpoint`. v8's express integration creates a per-request isolation scope so tags don't leak across requests.
   - Same scrubber set as mobile, plus `JWT_SECRET`, `AWS_SECRET_ACCESS_KEY`, `SENDGRID_API_KEY`.

3. **Breadcrumb trail**:
   - Battery throttle transitions (Flow 16) emit `category: 'battery_throttle'` breadcrumbs.
   - Mobile route changes auto-instrumented by `@sentry/react-native/expo`.
   - HTTP requests on API auto-instrumented by `Sentry.httpIntegration()`.

4. **Verification status as of 2026-05-16**: Sentry is live and capturing real events. First real bug caught on initial install: `watchPositionImplAsync` failure due to missing location permission (handled error, not crash). Tagged correctly: `device=iPhone 17 Pro arm64`, `OS=iOS 26.3.1`, `release=1.0.0 (17)`, `env=production`. Source-map upload status is **unverified** — see TRD DRIFT FINDINGS for the Sentry project-slug discrepancy that may have caused silent upload failures.

**Success criteria**: Errors land in Sentry within seconds; user tags populated; PII / secrets scrubbed.

**Error / edge cases**:
- **DSN absent in dev**: `initSentry` no-ops. Local development produces no Sentry noise.
- **Unhandled throws in API**: caught by `setupExpressErrorHandler` AND by Express's default error handler. Sentry sees the error; client still gets the standard 500 response. (Note: these throws bypass the idempotency middleware's response cache by design — see TRD §4.4.)
- **Sentry org/project slug mismatch**: source-map upload may silently fail. Detected and flagged in TRD DRIFT FINDINGS; verification action in Implementation Plan.

---

## DRIFT FINDINGS

Documented during the App Flow read pass. Cross-references existing entries in PRD / TRD / UX where applicable rather than duplicating.

| Finding | Severity | Suggested action | Owner |
|---|---|---|---|
| **Task-completion endpoint skips magic-byte validation — security regression hole.** `POST /api/tasks/instances/:id/complete` ([apps/api/src/routes/tasks.ts:40-73](apps/api/src/routes/tasks.ts:40)) accepts a `photo_url` directly into INSERT with **no byte validation whatsoever**. Verified by grep: `validatePhotoOrQuarantine`, `isAllowedContentType`, `magicMatches`, `getS3ObjectHead`, `s3KeyFromPublicUrl` — none referenced in `tasks.ts`. Mobile path ([apps/mobile/app/tasks/complete/[id].tsx:107](apps/mobile/app/tasks/complete/[id].tsx:107)) uses the identical presigned-POST architecture as reports and pings: a guard with a valid JWT can call `/api/uploads/presign`, POST arbitrary bytes (PHP, HTML, ZIP) up to the 5 MiB cap to S3, then submit the resulting URL to task completion. The bad bytes link into `task_completions.photo_url` in the data plane — exactly the attack vector that commit `16c3ee6` closed for ping and clock-in-verification. Task completion was missed during that rollout. | **Security — regression hole** | Extend `validatePhotoOrQuarantine` coverage to the task-completion endpoint; same one-file change as commit `16c3ee6` extended to a fourth route. ~15-line addition mirroring the ping and clock-in-verification call sites. | **Focused commit in next session, before any new customer rollout.** Add to Implementation Plan's Immediate Backlog with high urgency; referenced from TRD's Known Technical Debt in a follow-up TRD-alignment commit. |
| **Incident email is fire-and-forget — silent customer-facing failure.** `sendIncidentAlert(report, site_id).catch(console.error)` at [apps/api/src/routes/reports.ts:231](apps/api/src/routes/reports.ts:231) is **not awaited**; rejections are swallowed into Railway stdout. When an incident occurs at a customer site and the instant-alert email to the client fails (SendGrid timeout, quota exceeded, recipient bounce, API outage), the report is still written to the database and the guard sees a success banner. The client portal contact, who is paying for "instant incident notification" as part of the platform's value proposition, receives nothing. The failure is detectable only by manual Railway log inspection (`grep '[email] sendIncidentAlert: SENDGRID ERROR'`). The customer-facing promise — "you will be notified the moment an incident occurs at your site" — silently fails. No retry, no fallback, no operator alert. | **Operational — silent customer-facing failure** (higher than "SLA risk" — SLA implies measurable degradation; silent failure is undetectable degradation) | Minimum-viable email queue. Two acceptable shapes: **(a)** add a `pending_emails` table + a cron job that retries with exponential backoff up to 24 hours; **(b)** wire SendGrid Event Webhooks to detect bounces/blocks and trigger retries plus an operator alert. Both are post-launch work, but the current state needs to be visible in docs so the next session can prioritize. | Vishnu picks (a) vs (b); then focused commit. Add to Implementation Plan's Near-term Backlog. |
| **No incident-acknowledge / triage workflow.** Admin can read incidents but cannot mark "reviewed" / "escalated" / "resolved" in the app. All triage state is external. | Cosmetic (feature gap, not a bug) | Add a `incident_status` enum + admin UI for triage state. Tier-2 roadmap. | Roadmap, no immediate commit. |
| **No automatic conflict detection on shift scheduling.** `POST /api/shifts` accepts overlapping shifts for the same guard without warning. | Cosmetic (admin convenience) | Add a server-side check: if any existing `shifts` row for `guard_id` overlaps `(scheduled_start, scheduled_end)`, return 400 with the conflicting shift id. Admin can override by re-submitting with `force=true`. | Follow-up commit. |
| **Live-map polling interval is unverified in this pass.** [apps/web/components/admin/AdminNav.tsx](apps/web/components/admin/AdminNav.tsx) shows a 15-second poll for chat unread; the live-map polling cadence is referenced in Flow 11 as "every N seconds" but I didn't open the live-map page to confirm the exact value. | Cosmetic (doc precision) | Open `apps/web/app/admin/live-map/page.tsx` during the next doc-alignment pass and pin the value. | Doc-alignment follow-up. |
| **Orphaned alerts screen** (also documented in UX doc DRIFT FINDINGS and surfaced in Flow 5). Documented here for cross-reference; remediation owned by UX + Implementation Plan. | Operational (missing feature surface) | See UX doc §2 + DRIFT FINDINGS. Re-wire entry point from `violation/index.tsx` "VIEW HISTORY" link or `profile.tsx` settings entry. | Vishnu (entry-point choice), then ~30-line commit. Tracked in Implementation Plan's Immediate Backlog. |

---

*End of App Flow. Word count: ~4,400. Next document: Backend Schema.*
