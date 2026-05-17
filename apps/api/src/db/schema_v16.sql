-- Schema v16 — Shift-scoped notifications
--
-- Adds notifications.shift_session_id so the mobile Notifications tab can
-- filter to "only items from the currently active shift session." Chat
-- notifications stay NULL on purpose — they're shift-agnostic and the
-- Notifications tab query keeps them visible regardless of session state
-- via an OR-clause on type='chat'.
--
-- Nullable + no backfill: pre-v16 rows stay NULL and become invisible to
-- the new shift-scoped view, which matches the spec (only current-shift
-- items). The 89 legacy rows in prod at the time of this migration are
-- all reminder types tied to long-completed shifts — hiding them is the
-- intended behavior, not a data loss.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS shift_session_id UUID
    REFERENCES shift_sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_notifications_session_created
  ON notifications (shift_session_id, created_at DESC);
