# Phase 3 — Data integrity

## Score: 5/10

Schema is thoughtfully constrained in places (retention bookkeeping, photo index range, role check constraints) but the operational write paths have gaps that have already produced bad data.

## CRITICAL

### C1. `autoCompleteShifts` cron sets `clocked_out_at` but never computes `total_hours`
**File**: `apps/api/src/jobs/autoCompleteShifts.ts:22-32`
The cron updates `shift_sessions.clocked_out_at = NOW()` and `shifts.status = 'completed'`, but it does NOT compute `total_hours`. Only the explicit clock-out endpoint at `shifts.ts:246-256` computes it.

**Evidence**: live-DB query returned 1 such session:
```
id=35014638-bfce-4bec-8c70-6f9a4bb972b9
clocked_in_at=2026-04-18T05:06:26, clocked_out_at=2026-04-19T02:37:22, total_hours=NULL
```
That's a 21-hour "auto-closed" session with no hours recorded. Billing by hours is broken for any guard who forgets to tap Clock Out.

**Fix**: compute `total_hours = EXTRACT(EPOCH FROM (clocked_out_at - clocked_in_at))/3600 - SUM(break_minutes)/60` inside the cron's UPDATE, or extract the clock-out helper to a DB function both paths call.

### C2. Clock-out is NOT atomic — causes "ghost guard" UI symptom
**File**: `apps/api/src/routes/shifts.ts:234-264`
Three sequential UPDATEs (session, hours, shift.status) outside any transaction. A pool exhaustion / timeout between the first and third leaves `shift_sessions.clocked_out_at IS NOT NULL` but `shifts.status = 'active'`, or the reverse. That inconsistency is exactly what commit `e2fec53` papered over in the live-guards dashboard query — it added `AND sh.status NOT IN ('completed', 'cancelled', 'missed')` but the underlying write is still non-atomic.

**Fix**: wrap in `BEGIN/COMMIT` (matches the clock-in handler at shifts.ts:202-230).

### C3. Clock-in race allows double open sessions
**File**: `apps/api/src/routes/shifts.ts:199-231`
Transaction exists, but inside it:
1. `SELECT ... WHERE status='scheduled'` — no `FOR UPDATE`
2. `INSERT shift_sessions` — no check for existing open session
3. `UPDATE shifts SET status='active'`

Two concurrent requests both see `status='scheduled'`, both INSERT, both UPDATE. Result: two open `shift_sessions` for the same guard.

No DB-level guard either — **there is no partial unique index** `ON shift_sessions (guard_id) WHERE clocked_out_at IS NULL`.

**Fix** (defence-in-depth):
- Add `SELECT ... FOR UPDATE` on the shift row.
- Add `CREATE UNIQUE INDEX shift_sessions_one_open_per_guard ON shift_sessions (guard_id) WHERE clocked_out_at IS NULL`.

## MAJOR

### M1. `location_pings` stores whatever lat/lng the client sends
**File**: `apps/api/src/routes/locations.ts:25-55`
No bounds check on latitude/longitude (should be `BETWEEN -90 AND 90` / `-180 AND 180`). DB has no CHECK constraint either (verified against `pg_constraint`). A malformed or malicious client can pollute the table and skew dashboard / geofence math.

### M2. Ping endpoint accepts pings from closed sessions
**File**: `apps/api/src/routes/locations.ts:28-32`
Session lookup does NOT require `clocked_out_at IS NULL`. A guard's app can continue pinging after clock-out (e.g. a stale background task). Storage grows, dashboard math risks drift.

**Fix**: add `AND clocked_out_at IS NULL` to the session check.

### M3. `clock_in_verification` doesn't bind session to caller
**File**: `apps/api/src/routes/locations.ts:124-131`
```sql
INSERT ... SELECT $1, ss.guard_id, ss.site_id, ...
FROM shift_sessions ss WHERE ss.id = $1
```
No `AND ss.guard_id = req.user.sub`. If a guard guesses/leaks another guard's session_id before verification lands (race: from clock-in response to upload), they could plant a verification row. Low impact — unique constraint on `shift_session_id` blocks a second attempt — but still a correctness issue.

### M4. Retention cron is in-process node-cron, single-instance assumed
**File**: `apps/api/src/jobs/nightlyPurge.ts:16` — `cron.schedule('0 0 * * *', ...)`
No distributed lock. If Railway ever scales the API to >1 instance, each instance fires the hard-delete at 00:00 UTC concurrently — at best redundant S3 deletes, at worst double `UPDATE data_retention_log SET data_deleted=true` races. Also no `cron_runs` table, so "did it actually run last night?" is unanswerable without log archaeology.

## MINOR

- **`data_retention_log` row for site `60cea6fb-91e8-4e7d-b03d-99de2194cdf8` has NULL `data_delete_at` / `client_star_access_until`** — the site was created but the retention init is incomplete. Verify sites.ts POST handler populates these on creation.
- **No CHECK constraints on `shift_sessions.total_hours >= 0`**, on `latitude`/`longitude` bounds, or on `violation_lat`/`violation_lng`.
- **`auth_events` is auth-only** — grep confirms writes happen only in `routes/auth.ts`. No row is written for guard creation, shift changes, permission grants, etc. This is a legitimate audit log gap for SOC 2 / regulatory scrutiny.
- **`login_attempts` is keyed only to `guard_id`** — there is no equivalent lockout for admins or clients.

## WORKING WELL

- Hard-delete helper (`nightlyPurge.ts:108-181`) is transactional with proper dependency-order DELETEs.
- Retention bookkeeping (`idx_retention_access_until`, `idx_retention_delete_at` partial indexes) is well-designed.
- `clock_in_verifications.shift_session_id` unique constraint prevents double-verification.
- `idx_company_admins_one_primary` correctly enforces "one primary admin per company" at the DB level.
- Geofence polygon stored as JSONB with `isPointInPolygon` ray-casting in `services/geofence.ts`.

## Live-DB snapshot (2026-04-19)

```
shift_sessions with NULL total_hours despite clocked_out_at set: 1
orphan open sessions > 24h:                                      0
duplicate open sessions per guard:                               0
open sessions right now:                                         0
ghost candidates (is_active=true, no open session):              5  (expected; is_active is account flag, not duty flag)
pings with (0,0) coords:                                         0
pings out of -90..90 / -180..180:                                0
reports without any photos:                                     27 / 29 (93%)
```

`reports_no_photos: 27/29` → either clients don't care about photos OR the client isn't uploading them OR a bug in the upload chain. Worth investigation for the production pitch (clients will ask "where are the photos?").
