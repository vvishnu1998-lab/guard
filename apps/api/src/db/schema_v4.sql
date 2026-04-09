-- ============================================================
-- Schema v4 — Missed shift alert tracking
-- ============================================================

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS missed_alert_sent_at TIMESTAMPTZ;
