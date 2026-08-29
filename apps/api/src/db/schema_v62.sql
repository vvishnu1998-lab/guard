-- schema_v62 — break redesign, CONTRACT HALF: narrow break_sessions.break_type
-- to 'break' alone.
--
-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  APPLY ONLY AFTER THE PHASE 2 SERVER IS DEPLOYED AND VERIFIED.        ║
-- ║                                                                       ║
-- ║  This is the contract half of the v61/v62 pair. v61 widened the CHECK ║
-- ║  so that BOTH the old server ('meal'|'rest'|'other') and the new one   ║
-- ║  ('break') are legal. This file removes the legacy values. Running it  ║
-- ║  while any server that still sends 'meal' is live turns every          ║
-- ║  POST /shifts/break-start into a 23514 and a 500 — guards cannot take  ║
-- ║  a break, and nothing in the server logs says why until someone        ║
-- ║  complains.                                                           ║
-- ║                                                                       ║
-- ║  Preconditions, all three:                                            ║
-- ║    1. schema_v61 applied.                                             ║
-- ║    2. Phase 2 API deployed — constants/breakDurations.ts exports a     ║
-- ║       single 'break' type and routes/shifts.ts sends it.               ║
-- ║    3. Verified in prod: a real break-start has written a 'break' row.  ║
-- ╚═══════════════════════════════════════════════════════════════════════╝
--
-- NUMBERING NOTE: written in the same commit as v61, immediately after
-- re-reading migrate.ts at HEAD 4c13932 (highest entry v60, drift check
-- clean). v62 is the next free number after v61. Both are appended to the
-- chain in this commit; neither is applied.
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through
-- piped psql is a silent no-op in autocommit (learned applying v54).
--
-- Note also that migrations do NOT run on deploy — apps/api/railway.json
-- runs `npm run build` then `node dist/index.js`, and src/index.ts has no
-- migrate call. Pushing this file applies nothing. A human must run
-- `railway run npm run db:migrate`, and doing so replays the WHOLE chain,
-- including this file. That is the realistic way this fires early by
-- accident, which is why the guard below exists.

SET LOCAL lock_timeout = '3s';

-- ── PRE-FLIGHT GUARD — refuse to run against a database an old server is
--    still writing to ────────────────────────────────────────────────────
--
-- The signal is data, not configuration: if ANY break_sessions row carries a
-- break_type other than 'break', then either v61's backfill has not run or
-- something wrote a legacy value after it did — and the only thing that
-- writes legacy values is a pre-Phase-2 server. Either way, contracting now
-- would break that server's next break-start.
--
-- RAISE EXCEPTION, not RAISE WARNING: this must abort the transaction and
-- leave the permissive constraint in place. A warning would scroll past in a
-- chain replay and the constraint would be swapped anyway, which is the exact
-- outcome the guard exists to prevent.
--
-- Ordering is load-bearing — this block runs BEFORE the DROP. Checking after
-- dropping would leave the table unconstrained on abort.
DO $$
DECLARE
  offenders BIGINT;
  sample    TEXT;
BEGIN
  SELECT count(*) INTO offenders
    FROM break_sessions WHERE break_type <> 'break';

  IF offenders > 0 THEN
    SELECT string_agg(DISTINCT break_type, ', ') INTO sample
      FROM break_sessions WHERE break_type <> 'break';
    RAISE EXCEPTION
      'schema_v62 REFUSING TO RUN: % break_sessions row(s) still carry a break_type other than ''break'' (found: %). '
      'This means schema_v61''s backfill has not run, or a pre-Phase-2 server is still writing legacy values. '
      'Contracting the CHECK now would 500 every break-start on that server. '
      'Apply schema_v61, deploy the Phase 2 API, confirm a real ''break'' row lands, then re-run.',
      offenders, sample;
  END IF;
END $$;

-- ── CONTRACT: 'break' and nothing else ──────────────────────────────────
--
-- Idempotency is decided by the CURRENT constraint definition rather than by
-- its mere existence, because v61 and v62 deliberately share the constraint
-- name chk_break_sessions_break_type (so `\d break_sessions` stays the single
-- pre/post tell). Existence alone cannot distinguish the permissive form from
-- the contracted one.
--
-- The test is 'does the rendered definition still mention meal'. The
-- permissive form is
--   CHECK (((break_type)::text = ANY ((ARRAY['meal'::character varying, ...
-- and the contracted form is
--   CHECK (((break_type)::text = 'break'::text))
-- so the substring is a reliable discriminator and does not depend on exact
-- whitespace or on how Postgres chooses to render an ARRAY literal.
--
-- A missing constraint (cur IS NULL) falls through to the ADD, which is what
-- a replay-from-empty needs if v61's guard has already skipped.
DO $$
DECLARE cur TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO cur
    FROM pg_constraint WHERE conname = 'chk_break_sessions_break_type';

  IF cur IS NOT NULL AND position('meal' in cur) = 0 THEN
    RAISE NOTICE 'schema_v62: chk_break_sessions_break_type is already contracted; skipping.';
    RETURN;
  END IF;

  ALTER TABLE break_sessions
    DROP CONSTRAINT IF EXISTS chk_break_sessions_break_type;

  ALTER TABLE break_sessions
    ADD CONSTRAINT chk_break_sessions_break_type
    CHECK (break_type = 'break');
END $$;

COMMENT ON COLUMN break_sessions.break_type IS
  'Always ''break'' from schema_v62. One paid 30-minute break type; allowance derives from scheduled shift length, not from the type. Historical meal/rest/other rows were relabelled in schema_v61 — their original duration survives in planned_duration_minutes.';
