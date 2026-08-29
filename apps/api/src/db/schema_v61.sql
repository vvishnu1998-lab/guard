-- schema_v61 — break redesign, EXPAND HALF: relabel to 'break' under a
-- permissive CHECK, widen off_post_events.reason, link off_post_events to
-- break_sessions.
--
-- PAIRS WITH schema_v62, WHICH IS THE CONTRACT HALF. Run v61 now (before the
-- Phase 2 server deploy); run v62 only after Phase 2 is deployed and verified.
-- Neither is applied as of this commit.
--
-- NUMBERING NOTE: v60 (companies.is_test) was the highest entry in migrate.ts
-- AND the highest file on disk; both were re-read at HEAD 4c13932 immediately
-- before writing this, and a drift check found 61 files on disk, 61 entries in
-- the chain, zero orphans and zero missing. Read off migrate.ts at HEAD, never
-- from a brief — this chain has recorded collisions (v46 -> v50, v51 -> v52,
-- v54 taken overnight, v58/v59 both landing while a brief still said v58 was
-- next). A brief handed to this work said "v60 is free"; it was not, and only
-- re-reading the chain caught it.
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through
-- piped psql is a silent no-op in autocommit (learned applying v54).
--
-- ── CORRECTION TO A CLAIM IN v60's HEADER ────────────────────────────────
--
-- v60:43 says "The DDL is idempotent and replays on every deploy". It does
-- NOT. apps/api/railway.json sets buildCommand `npm install && npm run build`
-- and startCommand `node dist/index.js`; neither runs db:migrate, and
-- src/index.ts contains no migrate call. Migrations run ONLY when a human
-- runs `railway run npm run db:migrate`. This file is still written to be
-- idempotent and re-runnable, because replay-from-empty and hand re-runs both
-- happen — but nobody should plan a rollout believing a push applies it.
--
-- ── WHY THIS FILE IS EXPAND-ONLY ─────────────────────────────────────────
--
-- The first draft did expand + backfill + contract in one file. There is no
-- safe order for that, and both directions were reproduced on a throwaway
-- database:
--
--   * contract before the Phase 2 deploy -> the server still sends 'meal',
--     every POST /shifts/break-start raises 23514 and 500s;
--   * deploy Phase 2 before the contract -> the server sends 'break', the
--     old three-value CHECK rejects it, same 23514, same 500.
--
-- Either way guards cannot start a break during the gap, on a live paying
-- customer, and the failure is invisible server-side until someone complains.
-- So the CHECK added here is PERMISSIVE — it accepts the three legacy values
-- AND 'break' — and both server versions are legal against it. v62 removes
-- the legacy values once nothing writes them.
--
-- ── ROW COUNT IS NOT PINNED ──────────────────────────────────────────────
--
-- The brief said "25 existing rows". It was 25, then 26 — a new row landed
-- mid-investigation (e5cb3198, 2026-08-29 19:21Z). At HEAD the table holds 26
-- rows: 23 'meal', 3 'rest', 0 'other', 0 open. The UPDATE below is written
-- WHERE break_type <> 'break' and never asserts a count, so it stays correct
-- however many rows exist when it runs.

SET LOCAL lock_timeout = '3s';

-- ═════════════════════════════════════════════════════════════════════════
-- SECTION 1 — break_sessions.break_type relabelled to 'break' (EXPAND)
-- ═════════════════════════════════════════════════════════════════════════
--
-- Design lock (2026-08-29): ONE break type, label "break", 30 minutes, paid.
-- Allowance comes from scheduled shift length (<=8h -> 1, >8h -> 2), not from
-- the type. The type column therefore no longer carries a decision, only a
-- label, and three labels where one is meant is a lie the UI has to keep
-- explaining.
--
-- NOTHING IS LOST. planned_duration_minutes is a separate NOT NULL column
-- that already records the per-row plan (meal 30, rest 15, other 10) and is
-- untouched here, so the historical distinction survives on every existing
-- row. Verified against prod at HEAD: all 26 rows are meal->30 or rest->15
-- with no exceptions. Column is VARCHAR(20); 'break' is 5 chars, so no width
-- change is needed.

-- ── 1a. Drop the old three-value CHECK ──────────────────────────────────
-- IF EXISTS makes the re-run a no-op.
ALTER TABLE break_sessions
  DROP CONSTRAINT IF EXISTS break_sessions_break_type_check;

-- ── 1b. BACKFILL: every row becomes 'break' ─────────────────────────────
-- Kept in the expand half deliberately, per the split decision: it is
-- harmless under the permissive CHECK below, and it leaves v62 with nothing
-- to backfill — v62 becomes a pure constraint swap that can refuse to run.
--
-- Predicated on <> 'break' so a re-run touches 0 rows. Deliberately not
-- filtered to closed rows: an open break must migrate too, and its
-- planned_duration_minutes still drives breakExpiryCron's auto-close.
UPDATE break_sessions
   SET break_type = 'break'
 WHERE break_type <> 'break';

-- ── 1c. PERMISSIVE CHECK: legacy values AND 'break' ─────────────────────
-- Both the pre-Phase-2 server ('meal'|'rest'|'other') and the post-Phase-2
-- server ('break') are legal against this, which is the entire point of the
-- split. v62 narrows it to 'break' alone.
--
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, hence the guard block.
-- Named chk_break_sessions_break_type rather than reusing the old
-- break_sessions_break_type_check name, so `\d break_sessions` shows at a
-- glance whether a database is pre- or post-v61.
--
-- The NOT EXISTS guard is load-bearing in one non-obvious way: on a database
-- where v62 has ALREADY contracted the constraint, this block must SKIP, not
-- re-expand. A full chain replay runs v61 then v62 in order, so the ordering
-- still lands contracted; a hand re-run of v61 alone against a contracted
-- database leaves it contracted. Both are correct. Do not "fix" this into an
-- unconditional DROP + ADD.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_break_sessions_break_type'
  ) THEN
    ALTER TABLE break_sessions
      ADD CONSTRAINT chk_break_sessions_break_type
      CHECK (break_type IN ('meal', 'rest', 'other', 'break'));
  END IF;
END $$;

COMMENT ON COLUMN break_sessions.break_type IS
  'Relabelled to ''break'' in schema_v61; narrowed to ''break'' only in schema_v62. One paid 30-minute break type; allowance derives from scheduled shift length, not from the type. Historical meal/rest/other rows kept their original duration in planned_duration_minutes.';

-- ═════════════════════════════════════════════════════════════════════════
-- SECTION 2 — off_post_events.reason VARCHAR(16) -> VARCHAR(64)
-- ═════════════════════════════════════════════════════════════════════════
--
-- No ordering constraint. Safe to run at any time, independent of the server
-- version.
--
-- routes/locations.ts:687 passes the 33-character literal
-- 'boundary exit during active break' into a VARCHAR(16). That is a 22001
-- value-too-long error, and the INSERT sits inside the try/catch at
-- locations.ts:680-692 which logs and swallows — so the break-suppression
-- path would silently record no evidence at all, while finalizeOverruns
-- (jobs/breakExpiryCron.ts:101) reads exactly this table as off-post proof.
--
-- This has never fired: prod holds ONE off_post_events row, source
-- 'ping_reject', and zero 'break_exit' rows. So the defect is latent, not
-- active — but Phase 4 makes real code depend on this write succeeding, and
-- widening must land first.
--
-- 64 not 32: the longest literal in flight is 33 chars, and 'reason' also
-- carries validateAtSite's short codes ('both', 'radius', 'polygon'). 64
-- leaves room without inviting prose. Widening a varchar is catalog-only in
-- PG 9.2+ — no table rewrite, no long lock — but the guard keeps a re-run
-- from taking an ACCESS EXCLUSIVE lock for nothing.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'off_post_events'
       AND column_name = 'reason'
       AND character_maximum_length < 64
  ) THEN
    ALTER TABLE off_post_events ALTER COLUMN reason TYPE VARCHAR(64);
  END IF;
END $$;

-- ═════════════════════════════════════════════════════════════════════════
-- SECTION 3 — off_post_events.break_session_id
-- ═════════════════════════════════════════════════════════════════════════
--
-- No ordering constraint. Safe to run at any time, independent of the server
-- version — the column is nullable and nothing writes it until Phase 4.
--
-- Today the only way to tell that an off-post event happened during a break
-- is source = 'break_exit', and that only covers the /violation diversion.
-- A 'ping_reject' row written while a break was open (POST /locations/ping
-- has no break-aware branch and returns 422 PING_OFF_POST regardless) is
-- indistinguishable from one written on duty. Phase 4.3 populates this column
-- on that path so the two become separable after the fact.
--
-- NULLABLE and ON DELETE SET NULL, not CASCADE: off_post_events is an
-- append-only evidence log (schema_v46:3) with its own 1095d retention, while
-- break_sessions rides the session's 1460d. The break row can legitimately be
-- purged first, and losing the link must never delete the evidence.
ALTER TABLE off_post_events
  ADD COLUMN IF NOT EXISTS break_session_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'off_post_events_break_session_id_fkey'
  ) THEN
    ALTER TABLE off_post_events
      ADD CONSTRAINT off_post_events_break_session_id_fkey
      FOREIGN KEY (break_session_id) REFERENCES break_sessions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

COMMENT ON COLUMN off_post_events.break_session_id IS
  'The break that was open when this off-post event was recorded, or NULL if the guard was on duty. Added in schema_v61; populated from Phase 4 forward only — earlier rows are NULL regardless of whether a break was open.';
