-- Schema v37 — Geofence rebuild (EXPAND phase, server-only)
--
-- Prep migration for the geofence + ping + late-clock-in rebuild
-- (Phase 1A, 2026-07-12 walk-test regression). All shape only —
-- code paths that read/write these columns land in a follow-up
-- Commit A on branch feat/geofence-rebuild-server. Expand-then-
-- extend per project rule: schema is idempotent, additive, safe
-- to leave in place if Commit A rolls back.
--
--   ① missed_pings — one row per (session, 30-min window) INSERTED
--      by the new missedPingCron.ts when a window closes with no
--      corresponding location_pings row. resolved_at + resolved_
--      by_ping_id are filled when a late ping lands via the
--      window-aware POST /api/locations/ping extension. window_
--      start is the anchor; UNIQUE(shift_session_id, window_start)
--      is the cron's ON CONFLICT dedup key (per R6 — prevents the
--      every-5-min cron from spamming a push on each tick).
--
--   ② shifts — three dedup columns for the late-clock-in
--      escalation ladder (T+10 guard push, T+15 guard push, T+30
--      admin email). Mirrors the existing missed_alert_sent_at /
--      start_reminder_sent_at / pre_shift_reminder_sent_at
--      convention on this table — one column per event, cron
--      UPDATEs to NOW() after firing, `WHERE col IS NULL` gates
--      the next fire.
--
--   ③ location_pings — window_label + submitted_late. window_label
--      is the HH:MM label of the 30-min window a late ping is
--      backfilling; NULL means the ping arrived in real time (not
--      late). Column name mirrors missed_pings.window_label rather
--      than the bare `window` we tried first — WINDOW is a Postgres
--      reserved keyword (OVER (WINDOW …) window-function clause)
--      and the v37 migration aborted with a syntax error before
--      any DDL landed. submitted_late is a denorm boolean for
--      admin activity-log filter speed — could be derived from
--      window_label IS NOT NULL AND pinged_at > window_end, but
--      the flag makes the activity feed query trivially indexable.
--
-- All ADDs use IF NOT EXISTS so the migrate.ts loop (which re-runs
-- every migration on every deploy) stays idempotent. No columns
-- are dropped or renamed — Contract phase is a separate future
-- migration.

CREATE TABLE IF NOT EXISTS missed_pings (
  id                     UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_session_id       UUID          NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
  site_id                UUID          NOT NULL REFERENCES sites(id),
  guard_id               UUID          NOT NULL REFERENCES guards(id),
  window_start           TIMESTAMPTZ   NOT NULL,
  window_end             TIMESTAMPTZ   NOT NULL,
  window_label           VARCHAR(8)    NOT NULL,
  missed_at              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  resolved_at            TIMESTAMPTZ,
  resolved_by_ping_id    UUID          REFERENCES location_pings(id) ON DELETE SET NULL,
  expires_at             TIMESTAMPTZ   NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_missed_pings_session_window
  ON missed_pings (shift_session_id, window_start);

CREATE INDEX IF NOT EXISTS idx_missed_pings_unresolved
  ON missed_pings (shift_session_id) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_missed_pings_guard_missed_at
  ON missed_pings (guard_id, missed_at DESC);

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS late_10_reminder_sent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS late_15_reminder_sent_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS late_admin_email_sent_at         TIMESTAMPTZ;

ALTER TABLE location_pings
  ADD COLUMN IF NOT EXISTS window_label      VARCHAR(8),
  ADD COLUMN IF NOT EXISTS submitted_late    BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_location_pings_session_window
  ON location_pings (shift_session_id, window_label)
  WHERE window_label IS NOT NULL;
