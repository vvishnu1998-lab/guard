-- Schema v38 — missed_reports mirror of missed_pings (EXPAND phase)
--
-- Prep migration for Commit A2 of the geofence rebuild. Same shape as
-- schema_v37's missed_pings, mirrored for reports:
--
--   ① missed_reports — one row per (session, 1-hour window) INSERTed
--      by the new missedReportCron.ts when the window closes with no
--      corresponding reports row. UNIQUE(shift_session_id, window_
--      start) is the cron's ON CONFLICT dedup key (R6 in Phase 1A),
--      so the every-5-min tick does not spam a push. resolved_at +
--      resolved_by_report_id are filled when a late report lands via
--      the window-aware POST /api/reports extension.
--
--      Window cadence: HOURLY (60 min slots) rather than pings' 30
--      min. Matches the existing pingReminder.ts activity-report
--      cadence — an activity report is expected once per hour.
--
--   ② reports — window_label + submitted_late. Same shape and same
--      naming (window_label, not `window`) as location_pings after
--      the v37 rename. Denorm submitted_late powers a trivial admin
--      activity-log filter without recomputing from window_end +
--      reported_at on every scan.
--
-- All ADDs use IF NOT EXISTS so the migrate.ts loop stays idempotent
-- across deploys. No columns dropped or renamed; Contract is a later
-- migration.

CREATE TABLE IF NOT EXISTS missed_reports (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_session_id       UUID          NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
  site_id                UUID          NOT NULL REFERENCES sites(id),
  guard_id               UUID          NOT NULL REFERENCES guards(id),
  window_start           TIMESTAMPTZ   NOT NULL,
  window_end             TIMESTAMPTZ   NOT NULL,
  window_label           VARCHAR(8)    NOT NULL,
  missed_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at            TIMESTAMPTZ,
  resolved_by_report_id  UUID          REFERENCES reports(id) ON DELETE SET NULL,
  expires_at             TIMESTAMPTZ   NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_reports_session_window
  ON missed_reports (shift_session_id, window_start);

CREATE INDEX IF NOT EXISTS idx_missed_reports_unresolved
  ON missed_reports (shift_session_id) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_missed_reports_guard_missed_at
  ON missed_reports (guard_id, missed_at DESC);

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS window_label    VARCHAR(8),
  ADD COLUMN IF NOT EXISTS submitted_late  BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_reports_session_window
  ON reports (shift_session_id, window_label)
  WHERE window_label IS NOT NULL;
