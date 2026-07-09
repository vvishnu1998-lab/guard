-- ============================================================
-- schema_v24 — Phase 2a: mid-shift handoff
-- ============================================================
-- Follow-on to v23 (guard-to-guard swap). Phase 2 covers the
-- during-shift handoff where guard A is already clocked in and
-- needs guard B to take over the remainder.
--
-- Three surface changes:
--
--   (1) shift_sessions.clock_out_reason — a nullable free-text
--       reason for a session ending outside the normal "guard
--       tapped CLOCK OUT" path. Populated as
--       "handed_off_to_<guard_id>" when Phase 2 rotates the
--       session. Left NULL for normal clock-outs so existing
--       reports don't need to filter.
--
--   (2) shift_swap_requests.status — v23 only allowed
--       (pending, accepted, declined, expired). Phase 2 adds a
--       fifth terminal state 'cancelled' for the case where
--       either party bails after acceptance but before the new
--       guard's physical clock-in (accepted → cancelled). The
--       Postgres CHECK constraint can't be edited in place;
--       drop-and-recreate is the standard idiom.
--
--   (3) shift_swap_requests.handoff_last_nudge_at /
--       handoff_nudge_count — the nudge cron
--       (handoffNudge.ts, ships alongside this migration in
--       code) reads/writes these to space nudges at 15-min
--       intervals starting 30 min after accepted_at, cap at 4
--       nudges. Nullable last_nudge_at means "never nudged
--       yet"; count defaults to 0 for the same reason.
--
-- Expand step of expand-then-extend. Safe to run before code
-- push: new columns are nullable-with-defaults, and no existing
-- SELECT references clock_out_reason. The CHECK swap is atomic
-- inside a single transaction from psql's perspective — no
-- window where the constraint is missing.
-- ============================================================

BEGIN;

-- (1) session-close reason
ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS clock_out_reason TEXT;

-- (2) status: allow 'cancelled'. Drop-then-recreate the CHECK.
--     Named after the auto-generated name Postgres assigns to
--     v23's CHECK — safe to guard with IF EXISTS.
ALTER TABLE shift_swap_requests
  DROP CONSTRAINT IF EXISTS shift_swap_requests_status_check;
ALTER TABLE shift_swap_requests
  ADD  CONSTRAINT shift_swap_requests_status_check
       CHECK (status IN ('pending','accepted','declined','expired','cancelled'));

-- (3) nudge tracking
ALTER TABLE shift_swap_requests
  ADD COLUMN IF NOT EXISTS handoff_last_nudge_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS handoff_nudge_count   INTEGER NOT NULL DEFAULT 0;

-- Partial index for the every-5-min nudge cron. Only touches
-- rows in the eligible window (accepted, no arrival session yet,
-- initiated as handoff) so the scan stays constant-time.
CREATE INDEX IF NOT EXISTS idx_shift_swap_requests_handoff_pending_arrival
  ON shift_swap_requests (accepted_at)
  WHERE initiated_by = 'guard_handoff'
    AND status       = 'accepted'
    AND to_session_id IS NULL;

COMMIT;
