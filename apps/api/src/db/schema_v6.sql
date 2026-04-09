-- ============================================================
-- Schema v6 — Add handover_notes to shift_sessions
-- ============================================================

ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS handover_notes TEXT;
