-- v81_shifts_end_after_start[_COMMIT].sql — the preview ends in ROLLBACK and
-- changes nothing; the _COMMIT copy differs from it in the final line only.
--
-- Applies apps/api/src/db/schema_v81.sql (CHECK scheduled_end > scheduled_start
-- on shifts) inside one explicit transaction, with a precondition and a
-- postcondition asserted in-transaction. The statements between the BEGIN V81
-- and END V81 markers are schema_v81.sql's, byte for byte.
--
-- v81_shifts_end_after_start_COMMIT.sql is this file with ONE line changed:
-- the final ROLLBACK is COMMIT. Run this preview first; run the COMMIT copy
-- only after the preview printed the constraint row and ROLLBACK.
--
-- WHEN: before PR merge (expand-then-extend). The routes' 422s do not need the
-- constraint, so the order is safe either way, but the constraint is what
-- makes the invariant hold for every writer.
--
-- HOW (Vishnu, by hand; ON_ERROR_STOP so a failed assertion stops the file):
--   railway connect Postgres  … then  \i scripts/ops/v81_shifts_end_after_start.sql
--   or pipe it:  psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f <file>
--
-- LOCK: ADD CONSTRAINT … NOT VALID takes ACCESS EXCLUSIVE on shifts for a
-- catalog change; VALIDATE scans (837 rows on 2026-09-28) inside the same
-- transaction, so the ACCESS EXCLUSIVE lock is held until COMMIT/ROLLBACK —
-- milliseconds at this size. lock_timeout 3s means it gives up rather than
-- queue behind a long transaction; if it does, re-run.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION 'v81 preflight: lock_timeout is %, not 3s', current_setting('lock_timeout');
  END IF;
END $$;

-- PRECONDITION: no existing row violates the rule. 0 on 2026-09-28 15:43 PT.
DO $$
DECLARE n bigint;
BEGIN
  SELECT count(*) INTO n FROM shifts WHERE NOT (scheduled_end > scheduled_start);
  IF n <> 0 THEN
    RAISE EXCEPTION 'v81 precondition: % shift(s) have scheduled_end <= scheduled_start', n;
  END IF;
  RAISE NOTICE 'v81 precondition: 0 violating shifts';
END $$;

-- ── BEGIN V81 (schema_v81.sql, verbatim) ──────────────────────────────────
SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'shifts_end_after_start'
       AND conrelid = 'shifts'::regclass
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT shifts_end_after_start
      CHECK (scheduled_end > scheduled_start) NOT VALID;
  END IF;
END $$;

ALTER TABLE shifts VALIDATE CONSTRAINT shifts_end_after_start;
-- ── END V81 ───────────────────────────────────────────────────────────────

-- POSTCONDITION: the constraint exists, is validated, and says what it should.
DO $$
DECLARE v boolean; d text;
BEGIN
  SELECT convalidated, pg_get_constraintdef(oid) INTO v, d
    FROM pg_constraint
   WHERE conname = 'shifts_end_after_start' AND conrelid = 'shifts'::regclass;
  IF v IS NOT TRUE THEN
    RAISE EXCEPTION 'v81 postcondition: shifts_end_after_start missing or not validated';
  END IF;
  IF d <> 'CHECK ((scheduled_end > scheduled_start))' THEN
    RAISE EXCEPTION 'v81 postcondition: unexpected definition %', d;
  END IF;
END $$;

SELECT conname, convalidated, pg_get_constraintdef(oid) AS def
  FROM pg_constraint
 WHERE conname = 'shifts_end_after_start' AND conrelid = 'shifts'::regclass;

ROLLBACK;
