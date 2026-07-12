-- Schema v33 — Retention rebuild, EXPAND phase
--
-- Adds `expires_at TIMESTAMPTZ` + `legal_hold BOOLEAN` to every
-- retention-eligible table. Adds partial indexes for the nightly
-- purge scan. Backfills expires_at on existing rows using the tier
-- defaults from apps/api/src/services/retention.ts.
--
-- Migration ② (schema_v34) drops the retired `data_retention_log`
-- table and stays gated behind the code that stops reading it.
--
-- Constants (keep in sync with apps/api/src/services/retention.ts):
--   Activity / Maintenance reports: 365d
--   Incident reports + geofence violations: 1095d (3y)
--   Ping metadata: 365d
--   Task completions: 365d
--   Shift sessions + shifts: 1460d (4y)

-- ── Columns ─────────────────────────────────────────────────────────────────
ALTER TABLE reports              ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE reports              ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE location_pings       ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE location_pings       ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE task_completions     ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE task_completions     ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE shift_sessions       ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE shift_sessions       ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE shifts               ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE shifts               ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE geofence_violations  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE geofence_violations  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

-- ── Indexes ─────────────────────────────────────────────────────────────────
-- Partial indexes so held rows never enter the purge scan.
CREATE INDEX IF NOT EXISTS idx_reports_expires_at
  ON reports (expires_at) WHERE legal_hold = false;

CREATE INDEX IF NOT EXISTS idx_pings_expires_at
  ON location_pings (expires_at) WHERE legal_hold = false;

CREATE INDEX IF NOT EXISTS idx_task_completions_expires_at
  ON task_completions (expires_at) WHERE legal_hold = false;

CREATE INDEX IF NOT EXISTS idx_shift_sessions_expires_at
  ON shift_sessions (expires_at) WHERE legal_hold = false;

CREATE INDEX IF NOT EXISTS idx_shifts_expires_at
  ON shifts (expires_at) WHERE legal_hold = false;

CREATE INDEX IF NOT EXISTS idx_geofence_violations_expires_at
  ON geofence_violations (expires_at) WHERE legal_hold = false;

-- ── Backfill on existing test data ──────────────────────────────────────────
-- Only touches rows where expires_at IS NULL so the migration is safe
-- to re-run. Some rows may roll off the retention window immediately —
-- acceptable per RC (all rows here are test data).

UPDATE reports SET expires_at =
  reported_at + CASE report_type
    WHEN 'incident'    THEN INTERVAL '1095 days'
    WHEN 'activity'    THEN INTERVAL '365 days'
    WHEN 'maintenance' THEN INTERVAL '365 days'
    ELSE INTERVAL '365 days'
  END
WHERE expires_at IS NULL;

UPDATE location_pings   SET expires_at = pinged_at        + INTERVAL '365 days'  WHERE expires_at IS NULL;
UPDATE task_completions SET expires_at = completed_at     + INTERVAL '365 days'  WHERE expires_at IS NULL;
UPDATE shift_sessions   SET expires_at = clocked_in_at    + INTERVAL '1460 days' WHERE expires_at IS NULL;
UPDATE shifts           SET expires_at = scheduled_start  + INTERVAL '1460 days' WHERE expires_at IS NULL;
UPDATE geofence_violations SET expires_at = occurred_at   + INTERVAL '1095 days' WHERE expires_at IS NULL;
