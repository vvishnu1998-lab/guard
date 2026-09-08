-- schema_v69 -- bound shift_sessions.ping_interval_minutes to the same
-- 5..240 range sites has carried since schema_v14.
--
-- WHY THIS IS NEEDED BEFORE PHASE E
-- --------------------------------
-- schema_v68 added the column with no CHECK, deliberately: the constraint was
-- to land with the picker that defines the allowed set. That was correct while
-- nothing read the column. Phase E changes the calculus.
--
-- VIOLATION_HOURS_ROW_SQL (services/shiftHours.ts) currently interpolates
-- PING_WINDOW_MS into a generate_series as a COMPILE-TIME CONSTANT. Phase E
-- makes that step DATA-DRIVEN, read from this column. Postgres raises
--
--     ERROR:  step size cannot equal zero
--
-- on a zero interval, and a negative step yields an empty series. So after
-- Phase E a single bad row does not produce a wrong number -- it THROWS,
-- inside the daily client email and the XLSX hours export. This constraint
-- makes that row unwritable.
--
-- WHY 5..240 AND NOT THE PICKER SET (15/30/45, DECISIONS D15)
-- ----------------------------------------------------------
-- sites.ping_interval_minutes permits 5..240 (schema_v14.sql:39) and the
-- clock-in snapshot copies the site value verbatim. A session CHECK narrower
-- than the sites CHECK would make that INSERT throw for any site an admin had
-- legitimately set outside the picker -- and the INSERT is the clock-in
-- transaction, so the failure mode is A GUARD WHO CANNOT START THEIR SHIFT.
-- The two ranges must agree, or the narrower one becomes an outage.
--
-- Narrowing to the picker set is possible only by narrowing BOTH tables
-- together, after confirming no site sits outside it. That is a separate
-- decision with a different blast radius; it is not this migration.
--
-- NULL IS ADMITTED
-- ----------------
-- NULL means "session predates schema_v68" -- 210 of 213 rows at write time.
-- The `IS NULL OR` is written explicitly rather than relying on the fact that
-- a CHECK passes when its expression evaluates to NULL. Both forms behave
-- identically in Postgres; the explicit one states the intent so nobody
-- "simplifies" it later believing they are changing something.
--
-- VERIFIED BEFORE WRITING: all 213 rows satisfy this. 210 NULL, 3 non-null,
-- every non-null value 30, zero violations. Re-verify before applying -- the
-- table grew by 2 rows between the audit and this migration.
--
-- Idempotent: ADD CONSTRAINT has no IF NOT EXISTS in Postgres, and migrate.ts
-- replays every file in the array on every invocation, so the DO-block guard
-- is load-bearing rather than decorative. Same shape as schema_v26.sql:34 and
-- schema_v46.sql:60.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_shift_sessions_ping_interval_minutes'
  ) THEN
    ALTER TABLE shift_sessions
      ADD CONSTRAINT chk_shift_sessions_ping_interval_minutes
      CHECK (ping_interval_minutes IS NULL
             OR ping_interval_minutes BETWEEN 5 AND 240);
  END IF;
END $$;
