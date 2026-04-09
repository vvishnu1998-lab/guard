-- ============================================================
-- Schema v5 — Fix break_sessions.break_type CHECK constraint
-- The old constraint only allowed 'scheduled'/'unscheduled'.
-- The app sends 'meal', 'rest', or 'other'.
-- ============================================================

ALTER TABLE break_sessions
  DROP CONSTRAINT IF EXISTS break_sessions_break_type_check;

ALTER TABLE break_sessions
  ADD CONSTRAINT break_sessions_break_type_check
  CHECK (break_type IN ('meal', 'rest', 'other'));
