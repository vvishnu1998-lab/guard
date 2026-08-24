-- schema_v54 — durable idempotency, photo-size limit alignment, and a
--               uniqueness backstop for open breaks (2026-08-24)
--
-- NUMBERING NOTE: v53 is the highest entry in migrate.ts and the highest
-- applied in production (verified by object probe: offline_dead_letters
-- exists). v54 is free. Two collisions are already on record — v50 was
-- dispatched as "v46" and v52 as "v51" — so the number was read off
-- migrate.ts at HEAD rather than from a brief or from memory.
--
-- ── LOCKING ──────────────────────────────────────────────────────────────
--
-- migrate.ts runs each file as a single client.query(sql), which Postgres
-- executes as one implicit transaction — the whole file commits or none of
-- it does. SET LOCAL is therefore scoped to this file and does not leak
-- into the migrations that run after it on the same pooled client, which a
-- bare SET would. This is the first migration in the chain to set a lock
-- timeout; every statement below touches a live table, and waiting
-- indefinitely behind a guard's in-flight write is worse than failing and
-- retrying.
SET LOCAL lock_timeout = '3s';

-- ── 1. Durable idempotency ───────────────────────────────────────────────
--
-- services/idempotency.ts keeps its cache in a process-local Map. That is
-- not idempotency across a restart, a redeploy, or a second instance — and
-- Railway redeploys on every push. The middleware's own docblock already
-- names the ceiling: "If we ever hit that ceiling, we're at a scale where
-- this should be Redis, not in-process." Postgres is already here, already
-- durable, and already the thing the request is talking to.
--
-- cache_key is the same string the Map used: '<guard_id>:<scope>:<key>'.
-- Keeping the shape identical is what makes the port a drop-in rather than
-- a parallel mechanism.
--
-- body is JSONB because the middleware caches whatever the handler passed
-- to res.json(), including 4xx bodies — a replayed rejection must return
-- the same rejection, not re-execute.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  cache_key   TEXT        PRIMARY KEY,
  status      INTEGER     NOT NULL,
  body        JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- 30 minutes: long enough to cover an offline queue that reconnects after
  -- a shift-length signal gap, short enough that the table stays small.
  -- The old Map used 10 minutes, which is shorter than the gaps this is
  -- meant to survive.
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 minutes'
);

-- Reads filter on expires_at; the sweep deletes on it. Both want this.
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_expires
  ON idempotency_keys (expires_at);

-- ── 2. Align the photo size limit ────────────────────────────────────────
--
-- Three places, two values, and the mismatch is load-bearing:
--   services/s3.ts          MAX_UPLOAD_BYTES = 5 MiB   (what S3 accepts)
--   schema.sql:131          chk_file_size    <= 800 KB (what the row accepts)
--   routes/reports.ts       MAX_PHOTO_KB     = 800     (what the API accepts)
--
-- A photo between 800 KB and 5 MiB uploaded to S3 cleanly and was then
-- rejected by Postgres, which is how vamshi's 919 KB photo became an S3
-- orphan on 2026-08-22 while its report kept the other three.
--
-- 5120 KB is chosen to equal MAX_UPLOAD_BYTES exactly, so the row can hold
-- anything S3 was willing to take. The CHECK is KEPT, not dropped — it
-- still bounds the column, it just stops disagreeing with the gate in front
-- of it. routes/reports.ts MAX_PHOTO_KB moves to 5120 in the same ship;
-- the comment there already says the two must be changed together.
--
-- ADD CONSTRAINT has no IF NOT EXISTS, and migrate.ts replays this file on
-- every deploy, so the change is guarded on the constraint's current
-- definition. Re-running finds 5120 already in place and does nothing —
-- no repeated ACCESS EXCLUSIVE lock, no repeated full-table revalidation.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.report_photos'::regclass
       AND conname  = 'chk_file_size'
       AND pg_get_constraintdef(oid) LIKE '%5120%'
  ) THEN
    ALTER TABLE report_photos DROP CONSTRAINT IF EXISTS chk_file_size;
    ALTER TABLE report_photos
      ADD CONSTRAINT chk_file_size CHECK (file_size_kb <= 5120);
  END IF;
END $$;

-- ── 3. One open break per session ────────────────────────────────────────
--
-- POST /break-start protects against a double-tap with a SELECT for an open
-- row followed by an INSERT, and its own comment concedes the gap: "no
-- UNIQUE constraint on the table today, but the mobile client is the sole
-- writer per guard and this SELECT + INSERT window is O(1ms)".
--
-- The only index on the table is idx_break_sessions_open, a PLAIN btree on
-- (break_start) WHERE break_end IS NULL — a lookup aid, not a constraint.
-- Compare shift_sessions, which carries idx_shift_sessions_one_open_per_
-- guard as its UNIQUE backstop; services/idempotency.ts explicitly calls
-- that index "the last-line defense" for exactly this failure.
--
-- Verified read-only before writing this migration: 13 break_sessions rows
-- total, 0 currently open, 0 sessions with more than one open row, and 0
-- overlapping pairs in the entire history. The index builds clean and
-- rejects nothing that already exists — the race has never actually fired.
--
-- PAIRED CODE CHANGE, NOT OPTIONAL: break-start's catch is a blanket
-- res.status(500). Adding this index without a 23505 handler would convert
-- a losing double-tap into a 500, and the mobile offline queue replays a
-- 5xx — the precise failure this whole ship exists to remove. The handler
-- returns the existing open row as 200, matching the route's own idempotent
-- branch and the 23505 handling already used for
-- idx_shift_sessions_one_open_per_guard.
CREATE UNIQUE INDEX IF NOT EXISTS uq_break_sessions_one_open_per_session
  ON break_sessions (shift_session_id)
  WHERE break_end IS NULL;
