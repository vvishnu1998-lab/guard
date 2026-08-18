-- schema_v46 — Break enforcement package (2026-08-18)
--
-- 1) off_post_events — append-only evidence log for server-side off-post
--    rejections that previously died in console.log ([ping.reject],
--    locations.ts). Deliberately NOT geofence_violations: that table
--    carries one-open-row-per-session semantics, admin push+email side
--    effects (fireBreachAlerts), and auto-resolve sweeps. A rejection is
--    unconfirmed evidence (possibly GPS noise) and must not wake admins
--    or occupy the open-violation slot. `source` is 'ping_reject' today;
--    'clock_in_reject' / 'clock_out_reject' may join later.
--
-- 2) break_sessions — break enforcement columns:
--    start_lat/lng/accuracy_m  coordinates captured at break start (null =
--                              older binary that doesn't send them)
--    ended_by                  which path closed the break; null = legacy
--                              row closed before v46, or still open
--    overrun_minutes           off-post time after a server auto-close,
--                              recorded for admin review — NEVER enters
--                              total_hours math (wage deduction is a human
--                              decision, by design)
--    overrun_flagged_at        non-null = awaiting admin review
--
-- Idempotent: safe to re-run. migrate.ts replays every file on every deploy.

CREATE TABLE IF NOT EXISTS off_post_events (
  id               UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_session_id UUID             NOT NULL REFERENCES shift_sessions(id) ON DELETE CASCADE,
  guard_id         UUID             NOT NULL,
  site_id          UUID             NOT NULL,
  source           VARCHAR(24)      NOT NULL,
  lat              DOUBLE PRECISION NOT NULL,
  lng              DOUBLE PRECISION NOT NULL,
  accuracy_m       DOUBLE PRECISION,
  distance_m       DOUBLE PRECISION,
  reason           VARCHAR(16),
  occurred_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ,
  legal_hold       BOOLEAN          NOT NULL DEFAULT FALSE
);

-- The expiry+10 "most recent position" lookup and the admin session view
-- both read newest-first within a session.
CREATE INDEX IF NOT EXISTS idx_off_post_events_session_time
  ON off_post_events (shift_session_id, occurred_at DESC);

ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS start_lat          DOUBLE PRECISION;
ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS start_lng          DOUBLE PRECISION;
ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS start_accuracy_m   DOUBLE PRECISION;
ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS ended_by           VARCHAR(16);
ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS overrun_minutes    INTEGER;
ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS overrun_flagged_at TIMESTAMPTZ;

-- Expiry+10 return check (breakExpiryCron): stamped exactly once per
-- auto-closed break so the conditional "still off post" push can never
-- double-fire. outcome ∈ off_post_pushed | onsite | unknown | session_closed.
ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS return_check_at      TIMESTAMPTZ;
ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS return_check_outcome VARCHAR(16);

-- ended_by domain. DO block because ADD CONSTRAINT has no IF NOT EXISTS.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_break_sessions_ended_by'
  ) THEN
    ALTER TABLE break_sessions
      ADD CONSTRAINT chk_break_sessions_ended_by
      CHECK (ended_by IS NULL OR ended_by IN
             ('guard', 'break_expiry', 'clock_out', 'handoff', 'auto_complete'));
  END IF;
END $$;

-- The 1-minute breakExpiryCron scans for open, expired breaks; keep that
-- scan off a seq-scan as break_sessions grows. Partial index stays tiny
-- (only open breaks — normally zero or one row per active session).
CREATE INDEX IF NOT EXISTS idx_break_sessions_open
  ON break_sessions (break_start)
  WHERE break_end IS NULL;
