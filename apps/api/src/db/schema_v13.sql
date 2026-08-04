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
-- RETROFIT 2026-08-04: chat_rooms and chat_messages were created directly
-- against production and never had DDL in this repo, so the chain could not
-- replay from an empty database — chat_room_reads' FK below failed with
-- `relation "chat_rooms" does not exist`. Their definitions were read back
-- out of production (information_schema / pg_constraint) and added here
-- rather than in a new schema_v45, because this file runs long before v45
-- and would still fail on its own FK. This edit to a historical file is a
-- correction of an omission, not a change of intent.
--
-- Two deliberate inconsistencies with the rest of this file, both because
-- these statements describe production as it actually is:
--   - gen_random_uuid() rather than uuid_generate_v4()
--   - created_at nullable rather than NOT NULL
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

-- One room per (site, guard) pair; the admin side of the conversation is
-- implicit in company_id. Must precede chat_messages and chat_room_reads,
-- both of which FK into it.
CREATE TABLE IF NOT EXISTS chat_rooms (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  site_id     UUID         NOT NULL REFERENCES sites(id)     ON DELETE CASCADE,
  guard_id    UUID         NOT NULL REFERENCES guards(id)    ON DELETE CASCADE,
  created_at  TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (site_id, guard_id)
);

-- sender_id is polymorphic across company_admins and guards, discriminated by
-- sender_role, so it deliberately carries NO foreign key.
CREATE TABLE IF NOT EXISTS chat_messages (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id      UUID         NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  sender_role  TEXT         NOT NULL CHECK (sender_role = ANY (ARRAY['admin', 'guard'])),
  sender_id    UUID         NOT NULL,
  message      TEXT         NOT NULL,
  created_at   TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created
  ON chat_messages (room_id, created_at DESC);

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
