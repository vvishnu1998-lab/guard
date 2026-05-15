-- schema_v13.sql — guard notification log + chat read-state tracking
--
-- 1) notifications table — persistent log of every push the server fires at
--    a guard (ping reminder, activity-report reminder, task reminder, chat,
--    geofence breach). The mobile Notifications tab reads from this; read_at
--    marks when the guard tapped/viewed it. Purged at 30 days by nightlyPurge.
--
-- 2) chat_room_reads — per (room_id, user_id, user_role) last_read_at
--    timestamp. GET /api/chat/rooms now derives unread_count by comparing
--    chat_messages.created_at against this row, so "guard opens room" can
--    actually mark the room read.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS notifications (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  guard_id    UUID         NOT NULL REFERENCES guards(id) ON DELETE CASCADE,
  type        VARCHAR(40)  NOT NULL,
  title       TEXT         NOT NULL,
  body        TEXT         NOT NULL,
  data        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_guard_created
  ON notifications (guard_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_guard_unread
  ON notifications (guard_id) WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS chat_room_reads (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  room_id       UUID         NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id       UUID         NOT NULL,
  user_role     VARCHAR(20)  NOT NULL CHECK (user_role IN ('guard','admin')),
  last_read_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (room_id, user_id, user_role)
);

CREATE INDEX IF NOT EXISTS idx_chat_room_reads_lookup
  ON chat_room_reads (room_id, user_id, user_role);
