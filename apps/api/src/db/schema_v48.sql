-- schema_v48 — vehicle roster + vehicle inspections (Phase 4)
--
-- site_vehicles: per-site patrol vehicle roster, admin CRUD. Soft retire
-- via is_active (past inspections keep a valid FK). plate is NULLABLE —
-- golf carts / ATVs / unplated site vehicles exist; label is the picker
-- identity. odometer_unit lives on the VEHICLE (a property of the
-- instrument) so mileage-per-shift math joins one column, and readings
-- stay interpretable.
CREATE TABLE IF NOT EXISTS site_vehicles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       UUID NOT NULL REFERENCES sites(id),
  label         VARCHAR(120) NOT NULL,
  plate         VARCHAR(20),
  make_model    VARCHAR(120),
  odometer_unit VARCHAR(2) NOT NULL DEFAULT 'mi',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_site_vehicles_odometer_unit CHECK (odometer_unit IN ('mi', 'km'))
);

-- No two ACTIVE vehicles with the same plate at one site; retired plates
-- can be re-added. Scoped to non-null plates (unplated vehicles exempt).
CREATE UNIQUE INDEX IF NOT EXISTS uq_site_vehicles_active_plate
  ON site_vehicles (site_id, LOWER(plate))
  WHERE is_active AND plate IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_site_vehicles_site ON site_vehicles (site_id);

-- vehicle_inspections: ONE row per shift session (UNIQUE), created at
-- vehicle selection and filled progressively — each photo PATCHes its
-- slot as it uploads, which is what makes partial progress survive an
-- app force-quit (and even a device swap) server-side. completed_at is
-- stamped by the server when all five photos + odometer_reading are
-- present; "inspection-incomplete" ≡ completed_at IS NULL.
--
-- No guard_id / site_id — derive via shift_sessions (same rule as
-- task_instances). Retention: 365 days ('vehicle_inspection' kind,
-- maintenance-report parity — these photos ARE the evidence artifact,
-- deliberately NOT the 7-day ping_photo tier).
CREATE TABLE IF NOT EXISTS vehicle_inspections (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_session_id         UUID NOT NULL UNIQUE REFERENCES shift_sessions(id),
  vehicle_id               UUID NOT NULL REFERENCES site_vehicles(id),
  odometer_reading         INTEGER,
  photo_front_url          TEXT,
  photo_rear_url           TEXT,
  photo_driver_side_url    TEXT,
  photo_passenger_side_url TEXT,
  photo_odometer_url       TEXT,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at               TIMESTAMPTZ NOT NULL,
  legal_hold               BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT chk_vehicle_inspections_odometer
    CHECK (odometer_reading IS NULL OR (odometer_reading >= 0 AND odometer_reading <= 9999999))
);

CREATE INDEX IF NOT EXISTS idx_vehicle_inspections_vehicle ON vehicle_inspections (vehicle_id);

-- nightlyPurge scan support (expires_at < NOW() AND legal_hold = false).
CREATE INDEX IF NOT EXISTS idx_vehicle_inspections_expiry
  ON vehicle_inspections (expires_at)
  WHERE legal_hold = FALSE;
