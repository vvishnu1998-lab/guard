-- ============================================================
-- GUARD MANAGEMENT APP — PostgreSQL Schema
-- 19 tables, UUID primary keys, all timestamps in UTC
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================================
-- LAYER 1 — ACCESS AND STRUCTURE
-- ============================================================

CREATE TABLE IF NOT EXISTS companies (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                VARCHAR(255) NOT NULL,
  default_photo_limit INTEGER     NOT NULL DEFAULT 5,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS company_admins (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_primary    BOOLEAN      NOT NULL DEFAULT false,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Enforce only one primary admin per company
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_admins_one_primary
  ON company_admins (company_id)
  WHERE is_primary = true;

CREATE TABLE IF NOT EXISTS sites (
  id                        UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id                UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                      VARCHAR(255) NOT NULL,
  address                   VARCHAR(500) NOT NULL,
  photo_limit_override      INTEGER,          -- NULL = use company default
  is_active                 BOOLEAN      NOT NULL DEFAULT true,
  contract_start            DATE         NOT NULL,
  contract_end              DATE         NOT NULL,
  client_access_disabled_at TIMESTAMPTZ,
  created_at                TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clients (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id       UUID         NOT NULL REFERENCES sites(id) ON DELETE CASCADE UNIQUE,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guards (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  badge_number  VARCHAR(100) NOT NULL UNIQUE,
  is_active     BOOLEAN      NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS guard_site_assignments (
  id             UUID  PRIMARY KEY DEFAULT uuid_generate_v4(),
  guard_id       UUID  NOT NULL REFERENCES guards(id) ON DELETE CASCADE,
  site_id        UUID  NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  assigned_from  DATE  NOT NULL,
  assigned_until DATE,          -- NULL = open-ended
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_guard_site_active UNIQUE (guard_id, site_id, assigned_from)
);

-- ============================================================
-- LAYER 2 — SHIFTS, REPORTS AND OPERATIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS shifts (
  id                         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id                    UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  guard_id                   UUID        NOT NULL REFERENCES guards(id) ON DELETE CASCADE,
  scheduled_start            TIMESTAMPTZ NOT NULL,
  scheduled_end              TIMESTAMPTZ NOT NULL,
  status                     VARCHAR(20) NOT NULL DEFAULT 'scheduled'
                               CHECK (status IN ('scheduled','active','completed','missed')),
  daily_report_email_sent    BOOLEAN     NOT NULL DEFAULT false,
  daily_report_email_sent_at TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS shift_sessions (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_id        UUID          NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  guard_id        UUID          NOT NULL REFERENCES guards(id),   -- denormalized
  site_id         UUID          NOT NULL REFERENCES sites(id),    -- denormalized
  clocked_in_at   TIMESTAMPTZ   NOT NULL,
  clocked_out_at  TIMESTAMPTZ,
  total_hours     DOUBLE PRECISION,                               -- net after breaks
  clock_in_coords VARCHAR(100)  NOT NULL,                        -- "lat,lng"
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reports (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_session_id  UUID        NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
  site_id           UUID        NOT NULL REFERENCES sites(id),   -- denormalized
  report_type       VARCHAR(20) NOT NULL
                      CHECK (report_type IN ('activity','incident','maintenance')),
  description       TEXT        NOT NULL,
  severity          VARCHAR(20)
                      CHECK (severity IN ('low','medium','high','critical')), -- incident only
  reported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delete_at         TIMESTAMPTZ NOT NULL,  -- contract_end + 150 days
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS report_photos (
  id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  report_id    UUID         NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  storage_url  VARCHAR(1000) NOT NULL,
  file_size_kb INTEGER      NOT NULL,  -- enforced max 800KB at upload
  photo_index  SMALLINT     NOT NULL,  -- 1-5 ordering within report
  delete_at    TIMESTAMPTZ  NOT NULL,  -- same as parent report's delete_at
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_file_size CHECK (file_size_kb <= 800),
  CONSTRAINT chk_photo_index CHECK (photo_index BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS data_retention_log (
  id                          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id                     UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE UNIQUE,
  client_star_access_until    TIMESTAMPTZ NOT NULL,  -- day 90 from contract_end
  data_delete_at              TIMESTAMPTZ NOT NULL,  -- day 150
  warning_60_sent             BOOLEAN     NOT NULL DEFAULT false,
  warning_89_sent             BOOLEAN     NOT NULL DEFAULT false,
  warning_140_sent            BOOLEAN     NOT NULL DEFAULT false,
  client_star_access_disabled BOOLEAN     NOT NULL DEFAULT false,
  data_deleted                BOOLEAN     NOT NULL DEFAULT false,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- LAYER 3 — GEOFENCING AND VERIFICATION
-- ============================================================

CREATE TABLE IF NOT EXISTS site_geofence (
  id                  UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id             UUID             NOT NULL REFERENCES sites(id) ON DELETE CASCADE UNIQUE,
  polygon_coordinates JSONB            NOT NULL,  -- [{lat, lng}, ...]
  center_lat          DOUBLE PRECISION NOT NULL,
  center_lng          DOUBLE PRECISION NOT NULL,
  radius_meters       INTEGER          NOT NULL,
  created_by_admin    UUID             NOT NULL REFERENCES company_admins(id),
  updated_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clock_in_verifications (
  id                  UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_session_id    UUID             NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE UNIQUE,
  guard_id            UUID             NOT NULL REFERENCES guards(id),
  site_id             UUID             NOT NULL REFERENCES sites(id),
  selfie_url          VARCHAR(1000)    NOT NULL,
  site_photo_url      VARCHAR(1000)    NOT NULL,
  verified_lat        DOUBLE PRECISION NOT NULL,
  verified_lng        DOUBLE PRECISION NOT NULL,
  is_within_geofence  BOOLEAN          NOT NULL,
  verified_at         TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS location_pings (
  id                 UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_session_id   UUID             NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
  guard_id           UUID             NOT NULL REFERENCES guards(id),
  site_id            UUID             NOT NULL REFERENCES sites(id),
  latitude           DOUBLE PRECISION NOT NULL,
  longitude          DOUBLE PRECISION NOT NULL,
  is_within_geofence BOOLEAN          NOT NULL,
  ping_type          VARCHAR(20)      NOT NULL
                       CHECK (ping_type IN ('gps_only','gps_photo')),
  photo_url          VARCHAR(1000),   -- NULL on gps_only pings
  photo_delete_at    TIMESTAMPTZ      NOT NULL,  -- pinged_at + 7 days
  pinged_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS geofence_violations (
  id                  UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_session_id    UUID             NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
  guard_id            UUID             NOT NULL REFERENCES guards(id),
  site_id             UUID             NOT NULL REFERENCES sites(id),
  violation_lat       DOUBLE PRECISION NOT NULL,
  violation_lng       DOUBLE PRECISION NOT NULL,
  occurred_at         TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  resolved_at         TIMESTAMPTZ,     -- NULL while violation is open
  duration_minutes    INTEGER,         -- calculated on resolution
  notification_sent   BOOLEAN          NOT NULL DEFAULT false,
  photo_url           VARCHAR(1000),   -- auto-captured evidence, 150-day retention
  created_at          TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- ============================================================
-- LAYER 4 — TASKS AND BREAKS
-- ============================================================

CREATE TABLE IF NOT EXISTS task_templates (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id             UUID        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  created_by_admin    UUID        NOT NULL REFERENCES company_admins(id),
  title               VARCHAR(255) NOT NULL,
  description         TEXT        NOT NULL,
  scheduled_time      TIME        NOT NULL,
  recurrence          VARCHAR(50) NOT NULL
                        CHECK (recurrence IN ('daily','weekdays','weekends','custom')),
  requires_photo      BOOLEAN     NOT NULL DEFAULT false,
  is_active           BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_instances (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_id  UUID        NOT NULL REFERENCES task_templates(id),
  shift_id     UUID        NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  site_id      UUID        NOT NULL REFERENCES sites(id),   -- denormalized
  title        VARCHAR(255) NOT NULL,                       -- copied from template at generation
  due_at       TIMESTAMPTZ NOT NULL,
  status       VARCHAR(20) NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','completed','overdue')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS task_completions (
  id                UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  task_instance_id  UUID             NOT NULL REFERENCES task_instances(id) ON DELETE CASCADE UNIQUE,
  shift_session_id  UUID             NOT NULL REFERENCES shift_sessions(id),
  guard_id          UUID             NOT NULL REFERENCES guards(id),
  completion_lat    DOUBLE PRECISION NOT NULL,
  completion_lng    DOUBLE PRECISION NOT NULL,
  photo_url         VARCHAR(1000),   -- required if template.requires_photo = true
  completed_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS break_sessions (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_session_id  UUID        NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
  guard_id          UUID        NOT NULL REFERENCES guards(id),
  site_id           UUID        NOT NULL REFERENCES sites(id),
  break_start       TIMESTAMPTZ NOT NULL,
  break_end         TIMESTAMPTZ,     -- NULL until break ends
  duration_minutes  INTEGER,         -- calculated on break end
  break_type        VARCHAR(20) NOT NULL
                      CHECK (break_type IN ('meal','rest','other')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- INDEXES — per Section 11.1 implementation notes
-- ============================================================

-- location_pings: highest volume table
CREATE INDEX IF NOT EXISTS idx_location_pings_session_time
  ON location_pings (shift_session_id, pinged_at DESC);

CREATE INDEX IF NOT EXISTS idx_location_pings_photo_delete
  ON location_pings (photo_delete_at)
  WHERE photo_url IS NOT NULL;

-- reports: primary query pattern
CREATE INDEX IF NOT EXISTS idx_reports_site_time
  ON reports (site_id, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_delete_at
  ON reports (delete_at);

-- shift_sessions: monthly hour calculations
CREATE INDEX IF NOT EXISTS idx_shift_sessions_site_clockin
  ON shift_sessions (site_id, clocked_in_at DESC);

CREATE INDEX IF NOT EXISTS idx_shift_sessions_shift
  ON shift_sessions (shift_id);

-- data_retention_log: nightly purge jobs
CREATE INDEX IF NOT EXISTS idx_retention_delete_at
  ON data_retention_log (data_delete_at)
  WHERE data_deleted = false;

CREATE INDEX IF NOT EXISTS idx_retention_access_until
  ON data_retention_log (client_star_access_until)
  WHERE client_star_access_disabled = false;

-- shifts: daily email job
CREATE INDEX IF NOT EXISTS idx_shifts_email_pending
  ON shifts (scheduled_end)
  WHERE daily_report_email_sent = false AND status = 'completed';

-- guards: company scoping
CREATE INDEX IF NOT EXISTS idx_guards_company
  ON guards (company_id)
  WHERE is_active = true;

-- geofence violations: open violations lookup
CREATE INDEX IF NOT EXISTS idx_violations_open
  ON geofence_violations (shift_session_id, occurred_at)
  WHERE resolved_at IS NULL;

-- task_instances: shift task lookup
CREATE INDEX IF NOT EXISTS idx_task_instances_shift
  ON task_instances (shift_id, status);

-- report_photos: cascade delete support
CREATE INDEX IF NOT EXISTS idx_report_photos_report
  ON report_photos (report_id);
