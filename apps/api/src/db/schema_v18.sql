-- Schema v18 — Ping accuracy column + open-violation uniqueness (audit Tier 1)
--
-- (1) location_pings.accuracy_meters for T1-B
--     Mobile already reads coords.accuracy from expo-location but threw it
--     away because there was no column. Now the ping handler can pass it
--     to validateClockInGeofence (services/geofence.ts), which expands the
--     effective radius by (accuracy + 50m safety) mirroring clock-in.
--     NULLable — Build 24 and older clients that don't send the field get
--     a NULL row and the handler falls back to accuracy=0.
--
-- (2) Partial unique index on open geofence_violations for T1-A de-dup
--     Two near-simultaneous off-site pings on a multi-instance Railway
--     deploy could each pass a SELECT-then-INSERT de-dup check and create
--     two violation rows for the same session. The partial unique index
--     (filtered to open violations only — closed ones can repeat per
--     return-to-post cycle) serializes the INSERT at the DB layer. The
--     ping handler uses ON CONFLICT (shift_session_id) WHERE
--     resolved_at IS NULL DO NOTHING RETURNING id, treating the absence
--     of a returned row as "duplicate, alert already fired, skip push."
--
-- Pre-flight verified: zero existing duplicate open violations in prod
-- (probe ran 2026-05-17 before this migration was amended).
--
-- Expand-then-extend: migration applies to prod BEFORE the matching code
-- ships. See feedback_expand_then_extend.md.

ALTER TABLE location_pings
  ADD COLUMN IF NOT EXISTS accuracy_meters DOUBLE PRECISION;

CREATE UNIQUE INDEX IF NOT EXISTS idx_geofence_violations_one_open_per_session
  ON geofence_violations (shift_session_id)
  WHERE resolved_at IS NULL;
