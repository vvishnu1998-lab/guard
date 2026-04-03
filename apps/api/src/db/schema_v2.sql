-- ============================================================
-- Schema v2 — Pre-Phase 3 improvements
-- Safe to run against existing DB (all IF NOT EXISTS / IF EXISTS guards)
-- ============================================================

-- 1. LOCATION_PINGS — retain_as_evidence
--    Marks a ping photo as preserved beyond the 7-day rolling delete.
--    Set to true when the ping is referenced by an open geofence violation.
ALTER TABLE location_pings
  ADD COLUMN IF NOT EXISTS retain_as_evidence BOOLEAN NOT NULL DEFAULT false;

-- 2. SITE_GEOFENCE — grace_radius_meters
--    Buffer zone added to polygon boundary before a violation is raised.
--    Prevents false positives from GPS drift. Default 50 m.
ALTER TABLE site_geofence
  ADD COLUMN IF NOT EXISTS grace_radius_meters INTEGER NOT NULL DEFAULT 50;

-- 3. GEOFENCE_VIOLATIONS — supervisor_override + override_by
--    Allows a company admin to manually mark a violation as excused.
--    override_by references the admin who performed the override.
ALTER TABLE geofence_violations
  ADD COLUMN IF NOT EXISTS supervisor_override BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE geofence_violations
  ADD COLUMN IF NOT EXISTS override_by UUID REFERENCES company_admins(id) ON DELETE SET NULL;

-- 4. GUARDS — phone_number
--    Used for SMS-based self-service unlock when account is locked.
ALTER TABLE guards
  ADD COLUMN IF NOT EXISTS phone_number VARCHAR(20);

-- Supporting index: find violations that have been supervisor-overridden
CREATE INDEX IF NOT EXISTS idx_violations_override
  ON geofence_violations (override_by)
  WHERE supervisor_override = true;

-- Supporting index: find pings retained as evidence
CREATE INDEX IF NOT EXISTS idx_pings_evidence
  ON location_pings (shift_session_id)
  WHERE retain_as_evidence = true;
