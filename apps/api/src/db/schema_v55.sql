-- schema_v55 — clock-out photo column (2026-08-24)
--
-- NUMBERING NOTE: v54 is the highest entry in migrate.ts and the highest
-- applied in production (durable idempotency + chk_file_size 5120 + the
-- break uniqueness index, applied 2026-08-24T03:11:58Z). v55 is free. The
-- number was read off migrate.ts at HEAD, never from a brief or from
-- memory — three numbering collisions are already on record in this chain
-- (v46 -> v50, v51 -> v52, and v54 was taken the night before this file).
--
-- ── LOCKING ──────────────────────────────────────────────────────────────
--
-- migrate.ts runs each file as a single client.query(sql), which Postgres
-- executes as one implicit transaction, so SET LOCAL is scoped to this file
-- and does not leak into the migrations that follow it on the same pooled
-- client (a bare SET would).
--
-- APPLYING THIS BY HAND: piping a file containing SET LOCAL through psql is
-- a SILENT NO-OP unless it is wrapped in an explicit BEGIN/COMMIT — psql
-- runs statements in autocommit and SET LOCAL outside a transaction block
-- only emits a warning. Learned applying v54 on 2026-08-23. Wrap it.
SET LOCAL lock_timeout = '3s';

-- ── Clock-out photo ──────────────────────────────────────────────────────
--
-- Back-camera photo captured at manual clock-out. Stores the S3 public URL,
-- exactly like every other photo column in this schema.
--
-- TYPE MATCHES clock_in_verifications.site_photo_url — verified against
-- information_schema rather than assumed: character varying(1000), NULL
-- allowed. Every photo URL column in this database is varchar(1000)
-- (selfie_url, site_photo_url, location_pings.photo_url,
-- report_photos.storage_url, task_completions.photo_url,
-- geofence_violations.photo_url), so this is the house shape, not a guess.
--
-- ── NULLABLE BY DESIGN. DO NOT ADD NOT NULL. ─────────────────────────────
--
-- The photo is SKIPPABLE and a camera failure must never block a clock-out.
-- A NULL here is not missing data — it is a recorded outcome, and
-- shift_sessions.clock_out_reason carries WHY: 'manual_no_photo' or
-- 'manual_no_photo_no_gps'. Adding NOT NULL would make a guard with a
-- broken camera unable to end their shift, which is the exact failure the
-- skippable design exists to prevent.
--
-- It is also NULL for every row closed by autoCompleteShifts ('auto') and
-- by the handoff path, neither of which captures a photo at all.
ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS clock_out_photo_url VARCHAR(1000);

COMMENT ON COLUMN shift_sessions.clock_out_photo_url IS
  'S3 public URL of the back-camera photo taken at manual clock-out. NULL is '
  'a valid recorded outcome (photo skipped, camera failed, auto-closed, or '
  'handed off) — see clock_out_reason. Never make this NOT NULL.';

-- ── Retention driver for that photo ──────────────────────────────────────
--
-- The agreed retention for a clock-out photo is 365 days. It CANNOT be
-- inherited: this column lives on shift_sessions, whose expires_at is
-- RETENTION.SHIFT_SESSION_DAYS = 1460 (4 years, services/retention.ts:28).
-- Without a separate driver the photo would outlive its tier by three years.
--
-- Shape follows the only existing precedent for a photo on a shorter clock
-- than its parent row: location_pings.photo_delete_at (schema.sql:188),
-- consumed by nightlyPurge step 1. Nullable rather than NOT NULL because the
-- photo itself is optional — NULL here means "no photo to delete", which is
-- the case for every skipped, auto-closed and handed-off row.
--
-- Set in routes/shifts.ts at clock-out: NOW() + INTERVAL '365 days' when a
-- photo arrives, NULL when it does not. Written in the same statement as
-- clock_out_photo_url so the two can never disagree.
--
-- DELIBERATELY NOT INDEXED. location_pings.photo_delete_at carries an index
-- because a purge step actually scans it. Nothing scans this column yet, and
-- an index on a column with no reader is write cost for no benefit. Add one
-- WITH the purge step, not before it.
ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS clock_out_photo_delete_at TIMESTAMPTZ;

COMMENT ON COLUMN shift_sessions.clock_out_photo_delete_at IS
  'When the clock-out photo becomes eligible for deletion (set to NOW() + 365 '
  'days at clock-out; NULL when no photo was taken). '
  'INERT AS OF schema_v55 — READ THIS BEFORE RELYING ON IT: (1) nothing reads '
  'this column; no purge step consumes it. (2) jobs/nightlyPurge.ts runs with '
  'RETENTION_DRY_RUN unset on Railway and the code default is '
  '`!== ''false''`, i.e. TRUE in production, so every purge step reports '
  'candidates and deletes NOTHING. (3) S3 bucket guard-media-prod has '
  'versioning ENABLED with no NoncurrentVersionExpiration rule, so even a '
  'live purge only writes a delete marker — the object bytes remain and stay '
  'billed, and are still retrievable via GetObjectVersion. Wiring a purge '
  'here therefore needs all three fixed, not just a cron step. Add an index '
  'on this column at the same time as the purge that scans it.';

-- ── clock_out_reason: DELIBERATELY NO CHECK CONSTRAINT ───────────────────
--
-- The approved vocabulary for the clock-out paths is:
--   'manual' | 'manual_no_photo' | 'manual_no_gps' |
--   'manual_no_photo_no_gps' | 'auto'
--
-- DO NOT add a CHECK enforcing that list. It would be wrong, not merely
-- restrictive: the handoff path at routes/shifts.ts:1792 writes
-- `handed_off_to_<guard_uuid>` — a dynamic value built from the incoming
-- guard's id, so the set of legal strings is unbounded and unknowable at
-- schema time. Any enum CHECK would reject every future handoff and fail
-- the clock-out of guard A the moment guard B arrives on site.
--
-- The column stays TEXT with no constraint. The vocabulary is enforced in
-- the route that owns each path, which is the only layer that knows which
-- path it is on.
--
-- Historical note: this column has existed since schema_v24 and, as of this
-- migration, has NEVER been written in production — 0 of 58 rows. The only
-- writer is the handoff path, and no handoff has ever completed. From v55
-- onward both the manual and auto paths populate it, and NULL should stop
-- being produced by either.
