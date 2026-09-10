-- ============================================================
-- Schema v5 — Fix break_sessions.break_type CHECK constraint
-- The old constraint only allowed 'scheduled'/'unscheduled'.
-- The app sends 'meal', 'rest', or 'other'.
-- ============================================================
--
-- ── 2026-09-09, N43: GUARDED. The predicate below is UNCHANGED. ─────────
--
-- This file made `npm run db:migrate` unrunnable end-to-end from 2026-08-29
-- until this guard was added. It aborted at file 6 of the chain with
-- SQLSTATE 23514 and migrate.ts process.exit(1)'d, so nothing after it ever
-- applied. Four schema versions (v71-v74) went in by hand because of it.
--
-- WHAT BROKE. schema_v61 relabelled the whole break_type domain — it drops
-- break_sessions_break_type_check, runs
-- `UPDATE break_sessions SET break_type = 'break' WHERE break_type <> 'break'`,
-- and adds a differently-named constraint chk_break_sessions_break_type;
-- schema_v62 then contracts that to `break_type = 'break'` alone. All 31
-- production rows now carry 'break'. Re-running the ADD below therefore asks
-- Postgres to validate a CHECK that every single row violates.
--
-- The predicate is NOT wrong and is NOT touched. It was true when written:
-- break_type was a taxonomy of break kinds with different durations, and the
-- historical durations still survive in planned_duration_minutes (v41). A
-- migration chain read in order should tell the truth about each era. What
-- changed is reachability, not meaning.
--
-- ── WHY THE GUARD IS ON DATA AND NOT ON CATALOG STATE ───────────────────
--
-- The house idiom for making an ADD CONSTRAINT idempotent is
-- `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = ...)`
-- (schema_v71.sql:124-149). THAT IDIOM DOES NOT WORK HERE, and reaching for
-- it produces a fix that fixes nothing.
--
-- break_sessions_break_type_check DOES NOT EXIST in production — schema_v61
-- dropped it and never restored that name. So an existence guard evaluates
-- TRUE, the ADD fires, and the replay dies exactly as before. The DROP on the
-- line above it is likewise a no-op for the same reason.
--
-- The signal has to be the DATA. This is not a novel choice: schema_v62.sql
-- guards itself the same way on this same table and says so at :42-46 —
-- "The signal is data, not configuration: if ANY break_sessions row carries a
-- break_type other than 'break' ...". This file is the mirror of that test.
--
-- ── IDEMPOTENT IN BOTH DIRECTIONS ───────────────────────────────────────
--
-- EMPTY DATABASE: break_sessions is created by schema.sql (file 1) and is
-- empty here, so the NOT EXISTS is vacuously true and the constraint is
-- created. Note schema.sql already declares the same CHECK inline, so on a
-- fresh build this is a drop-and-re-add of an identical constraint — which is
-- what it has always been; the guard does not change that. schema_v61 drops
-- it again 56 files later, so the final schema is unaffected either way.
--
-- PRODUCTION: 31 rows, all break_type = 'break', so the NOT EXISTS is false
-- and the whole block is skipped with a NOTICE. Nothing is dropped, nothing
-- is added, and the constraint that actually governs the column
-- (chk_break_sessions_break_type, from v61/v62) is left untouched.
--
-- DROP AND ADD ARE INSIDE THE SAME DO BLOCK deliberately. A DO block is one
-- statement and rolls back as a unit, so even applied through piped psql in
-- autocommit there is no window in which the table is dropped-but-not-re-added.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM break_sessions WHERE break_type NOT IN ('meal', 'rest', 'other')
  ) THEN
    ALTER TABLE break_sessions
      DROP CONSTRAINT IF EXISTS break_sessions_break_type_check;

    ALTER TABLE break_sessions
      ADD CONSTRAINT break_sessions_break_type_check
      CHECK (break_type IN ('meal', 'rest', 'other'));
  ELSE
    RAISE NOTICE 'schema_v5: break_type domain has moved on (see schema_v61/v62); leaving the historical CHECK unapplied.';
  END IF;
END $$;
