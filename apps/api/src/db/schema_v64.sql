-- schema_v64 — drop the guards.fcm_token mirror. CONTRACT half of v63.
--
-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  APPLY ONLY AFTER A DEPLOYED SERVER WITH ZERO READERS OF THE COLUMN.  ║
-- ║                                                                       ║
-- ║  v63 created guard_devices and made guards.fcm_token a trigger-        ║
-- ║  maintained mirror so the 18 dispatch READ sites kept working during   ║
-- ║  the transition. c67298a moved every one of those reads onto           ║
-- ║  guard_devices (ACTIVE_PUSH_TOKEN_SQL + getActivePushToken*), so the   ║
-- ║  mirror now has no consumers and this file removes it.                 ║
-- ║                                                                       ║
-- ║  WHAT THIS FILE CANNOT CHECK, STATED PLAINLY RATHER THAN IMPLIED:      ║
-- ║  the pre-flight below asserts the DATA is safe to drop. It cannot      ║
-- ║  assert that no CODE still reads the column — SQL has no visibility    ║
-- ║  into which commit Railway is running. That half is a human check:     ║
-- ║                                                                       ║
-- ║    1. the deployed commit contains c67298a or later, AND               ║
-- ║    2. `grep -rnE "SELECT[^;]*fcm_token|g\.fcm_token" apps/api/src`     ║
-- ║       returns nothing on that commit.                                  ║
-- ║                                                                       ║
-- ║  If a reader is still deployed, dropping the column does NOT merely    ║
-- ║  stop pushes. In the eight batch crons the token is one column of a    ║
-- ║  query that also selects the guard, site and session rows the job      ║
-- ║  needs, so a 42703 kills the WHOLE job — missedPingCron and            ║
-- ║  missedReportCron would stop WRITING their rows, and those rows are    ║
-- ║  what the client ping ratio and the guard hours PDF are computed from. ║
-- ║  Silent data loss, not missing notifications.                          ║
-- ╚═══════════════════════════════════════════════════════════════════════╝
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through piped
-- psql is a silent no-op in autocommit (learned applying v54, re-confirmed on
-- v62 and v63). Migrations do NOT run on deploy — apps/api/railway.json runs
-- `node dist/index.js` and src/index.ts has no migrate call — so committing
-- this file applies nothing. A human must run it.
--
-- ── THE REPLAY HAZARD, AND WHY THE CHAIN SURVIVES IT ─────────────────────
--
-- migrate.ts replays the ENTIRE chain on every run, and three earlier files
-- reference guards.fcm_token: schema_auth.sql:34 adds it, and schema_v63.sql
-- writes it (trigger body), reads it (backfill + the NOTICE block) and
-- COMMENTs on it. A replay after this file has dropped the column would seem
-- certain to fail at v63 with 42703 — Postgres parses and plans a statement
-- in full before executing, so v63's backfill would raise even though its
-- `NOT EXISTS (SELECT 1 FROM guard_devices)` gate is false.
--
-- It does not fail, and the reason is ORDERING. schema_auth.sql runs SECOND
-- in the chain, long before v63, and its statement is
--
--     ALTER TABLE guards ADD COLUMN IF NOT EXISTS fcm_token TEXT;
--
-- so a replay RE-CREATES the column (empty, every row NULL) before v63 is
-- reached. v63 then finds the column present and all four of its references
-- succeed; its backfill inserts 0 rows because guard_devices is non-empty;
-- and this file drops the column again at the end. The chain is idempotent
-- as a WHOLE even though no single file is idempotent in isolation.
--
-- THEREFORE: schema_auth.sql and schema_v63.sql MUST NOT be edited to remove
-- their fcm_token references. "Tidying" the dropped column out of them is the
-- change that would actually break the replay, by removing the ADD COLUMN
-- that makes v63 legal. The stale-looking references are load-bearing.
--
-- The re-created column also drives the shape of the pre-flight below — see
-- the NULL note there.

SET LOCAL lock_timeout = '3s';

-- ── PRE-FLIGHT GUARD — refuse to drop a column that still holds information
--
-- The signal is data, not configuration. Two shapes would mean the column
-- knows something guard_devices does not, and dropping it would discard the
-- only record that the two ever disagreed:
--
--   mirror_mismatch       the guard has an active device AND a non-null
--                         column that names a DIFFERENT token
--   mirror_without_device the column names a token but the guard has no
--                         active device row at all
--
-- BOTH TESTS ARE DELIBERATELY RESTRICTED TO A NON-NULL COLUMN, and that is
-- not a weakening. The assertion exists to prevent INFORMATION LOSS, and a
-- NULL column carries no information — there is nothing to lose. The
-- restriction is also what makes a chain replay possible at all: after
-- schema_auth.sql re-creates the column empty, every guard with an active
-- device has a NULL column, so an `IS DISTINCT FROM` formulation would count
-- all of them as mismatches and abort this file on EVERY future replay,
-- bricking the chain from that point on. Verified against a real replay
-- before this wording was settled.
--
-- RAISE EXCEPTION, not RAISE WARNING: this must abort the transaction and
-- leave the column and trigger in place. A warning would scroll past in a
-- chain replay and the column would be dropped anyway, which is the exact
-- outcome the guard exists to prevent.
--
-- Ordering is load-bearing — this block runs BEFORE the drops. Checking after
-- dropping would leave the mirror gone on abort.
DO $$
DECLARE
  has_col   BOOLEAN;
  mismatch  BIGINT;
  orphan    BIGINT;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'guards' AND column_name = 'fcm_token'
  ) INTO has_col;

  IF NOT has_col THEN
    RAISE NOTICE 'schema_v64: guards.fcm_token already dropped; pre-flight skipped.';
    RETURN;
  END IF;

  EXECUTE $q$
    SELECT count(*) FROM guards g
      JOIN guard_devices d ON d.guard_id = g.id AND d.revoked_at IS NULL
     WHERE g.fcm_token IS NOT NULL AND g.fcm_token <> d.push_token
  $q$ INTO mismatch;

  EXECUTE $q$
    SELECT count(*) FROM guards g
     WHERE g.fcm_token IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM guard_devices d
                        WHERE d.guard_id = g.id AND d.revoked_at IS NULL)
  $q$ INTO orphan;

  IF mismatch > 0 OR orphan > 0 THEN
    RAISE EXCEPTION
      'schema_v64 REFUSING TO RUN: the mirror still holds information guard_devices does not. '
      '% guard row(s) name a DIFFERENT token than their active device, and % name a token with no '
      'active device at all. Dropping guards.fcm_token now would discard the only record that the '
      'two disagreed. Resolve the desync first — a claim from the affected handset repoints it, or '
      'clear the column deliberately — then re-run.',
      mismatch, orphan;
  END IF;

  RAISE NOTICE 'schema_v64 pre-flight OK: 0 mismatched, 0 orphaned.';
END $$;

-- ── DROP, in dependency order ───────────────────────────────────────────
--
-- Trigger before function: the trigger depends on the function, and DROP
-- FUNCTION without CASCADE would fail while it exists. Both use IF EXISTS so
-- a replay after the column is already gone is a clean no-op rather than an
-- error — v63 re-creates both on the same pass, so on a replay these do have
-- something to drop.
DROP TRIGGER  IF EXISTS trg_guard_devices_sync_mirror ON guard_devices;
DROP FUNCTION IF EXISTS guard_devices_sync_mirror();

-- No index, constraint or view depends on the column (checked against prod
-- 2026-09-03: zero rows from pg_indexes / pg_constraint / pg_depend), so a
-- plain DROP COLUMN suffices and CASCADE is deliberately NOT used — CASCADE
-- here would silently take anything a future migration had attached.
ALTER TABLE guards DROP COLUMN IF EXISTS fcm_token;

DO $$
BEGIN
  RAISE NOTICE 'schema_v64: mirror removed. guard_devices is now the only push-token store.';
END $$;

COMMENT ON TABLE guard_devices IS
  'One row per push-token claim, and since schema_v64 the ONLY store of a guard''s push token. revoked_at IS NULL means active; the two partial unique indexes enforce one active device per guard and one active guard per device, which is what makes claiming a token REPOINT it rather than duplicate it. Rows are revoked, not deleted, so device history survives. Read via services/deviceRegistry (ACTIVE_PUSH_TOKEN_SQL for batch queries, getActivePushToken / getActivePushTokens for point lookups); written only through that module.';
