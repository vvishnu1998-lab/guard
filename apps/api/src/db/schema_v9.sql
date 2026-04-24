-- schema_v9.sql — Week 1 audit fix CB2/CB3 (audit/REPORT.md, audit/WEEK1.md C2)
--
-- Partial unique index: at most one open shift_session per guard at any time.
-- Combined with the FOR UPDATE row-lock added to the clock-in handler and the
-- atomic clock-out transaction, this turns the "two devices, two clock-ins"
-- race condition into a deterministic 23505 conflict the API can return as
-- 409.
--
-- Pre-flight check (audit/WEEK1.md ran 2026-04-19):
--   SELECT guard_id, COUNT(*) FROM shift_sessions
--    WHERE clocked_out_at IS NULL GROUP BY guard_id HAVING COUNT(*) > 1;
--   -- 0 rows → safe to add UNIQUE.
--
-- CONCURRENTLY so it never blocks live writes; cannot be inside a tx block,
-- so this file is single-statement only.  IF NOT EXISTS makes it idempotent.

CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_shift_sessions_one_open_per_guard
  ON shift_sessions (guard_id)
  WHERE clocked_out_at IS NULL;
