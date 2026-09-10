-- schema_v75 — bring a CLEAN BUILD in line with production (2026-09-09)
--
-- NUMBERING: v74 is the highest entry in migrate.ts and the highest file on
-- disk; both were re-read at HEAD (9968179) immediately before writing this.
-- v75 is free. Read the chain off migrate.ts, never from a brief — it has
-- four recorded collisions now (v46 -> v50, v51 -> v52, v54 taken overnight,
-- and v15, which docs/06-IMPLEMENTATION-PLAN.md:100-114 reserved for four
-- orphan tables and which was taken by the shift-reassignment audit table
-- instead. Two of those four tables landed later in v13 and v45; the other
-- two items are in this file, four months on).
--
-- STATEMENT COUNT: seven (SET LOCAL, two DROP NOT NULL, one DO block, CREATE
-- TABLE, CREATE INDEX, COMMENT), and that is fine. The one-statement-per-file rule
-- (schema_v72, schema_v73) exists ONLY for CREATE INDEX CONCURRENTLY, which
-- cannot run inside the implicit transaction that db/migrate.ts:14's
-- simple-protocol client.query(sql) wraps around a multi-statement file.
-- CONFIRMED: THIS FILE CREATES NO INDEX CONCURRENTLY. Its two indexes are
-- plain CREATE INDEX inside a fresh-table branch, so one file is correct and
-- the atomicity of that implicit transaction is something this file WANTS —
-- see the note on the status CHECK below.
--
-- APPLYING BY HAND: `psql -1`. SET LOCAL through piped psql in autocommit is
-- a silent no-op (learned applying v54).
SET LOCAL lock_timeout = '3s';

-- ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
--
-- N43's audit set out to find why `npm run db:migrate` aborts. It does — at
-- schema_v5.sql, now guarded. But fixing only that converts a loud failure
-- into a SILENT WRONG SUCCESS, which is worse, because the chain would then
-- run green and produce a database the product cannot operate on.
--
-- Three pieces of production schema were reached by hand and never committed
-- back. A clean build does not reproduce them:
--
--   1. shifts.guard_id            chain: NOT NULL   prod: nullable, 9 NULL rows
--   2. shifts.status CHECK        chain: 4 values   prod: 6, all 6 in use
--   3. clock_in_verifications
--        .site_photo_url          chain: NOT NULL   prod: nullable, 231/231 NULL
--
-- (1) and (2) together are not cosmetic. The Phase E deactivation override
-- writes status='unassigned', guard_id=NULL; site deactivation writes
-- status='cancelled'. On a clean build the first is a 23502 AND a 23514, the
-- second a 23514. A freshly restored environment could not run the product.
--
-- (3) is the quieter one and was missed until N43: schema.sql:170 declares
-- site_photo_url NOT NULL, and every one of the 231 production rows has it
-- NULL. A clean build produces a column that 100% of real data violates.
--
-- Plus one whole table, below.
--
-- ── IDEMPOTENCY, BOTH DIRECTIONS, STATEMENT BY STATEMENT ────────────────
--
-- Required of every statement here: a no-op against CURRENT PRODUCTION, and
-- correct against an EMPTY DATABASE. They are different tests and each
-- statement is justified against both.
--
--   DROP NOT NULL x2   Empty: the column was just declared NOT NULL by
--                      schema.sql, so this relaxes it — the point of the file.
--                      Prod: already nullable; DROP NOT NULL on an
--                      already-nullable column is a silent no-op, not an
--                      error. Safe to re-run any number of times.
--
--   status CHECK       See the block's own comment. Guarded on the constraint
--                      DEFINITION, not on its existence.
--
--   CREATE TABLE       IF NOT EXISTS. Prod has the table; skipped.
--   + 2 indexes        Empty: created. Indexes likewise IF NOT EXISTS.

ALTER TABLE shifts
  ALTER COLUMN guard_id DROP NOT NULL;

ALTER TABLE clock_in_verifications
  ALTER COLUMN site_photo_url DROP NOT NULL;

-- ── shifts.status: six values ───────────────────────────────────────────
--
-- THE CATALOG-EXISTENCE GUARD IS WRONG HERE, exactly as it is wrong in
-- schema_v5.sql, and for the mirrored reason. schema.sql:7-8 inlines
-- `CHECK (status IN ('scheduled','active','completed','missed'))`, which
-- Postgres auto-names shifts_status_check. So on an EMPTY database the name
-- ALREADY EXISTS by the time this file runs — carrying the four-value
-- predicate. An `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname =
-- 'shifts_status_check')` guard would therefore SKIP on a fresh build and
-- leave the narrow constraint in place, which is precisely the divergence
-- this file exists to close. It would also skip on prod, where the name
-- exists too. It would do nothing, anywhere, forever.
--
-- The test has to be the constraint's DEFINITION. schema_v62.sql:76-92
-- established this on break_sessions for the same reason — two eras sharing
-- one constraint name, where existence cannot distinguish them. 'unassigned'
-- is the discriminator: it appears in the six-value form and cannot appear in
-- the four-value one, and testing for a substring does not depend on
-- whitespace or on how Postgres renders an ARRAY literal.
--
-- DROP AND ADD LIVE INSIDE THE DO BLOCK. If the ADD failed after the DROP,
-- `shifts` would be left with no status constraint at all — a table taking
-- arbitrary strings in a column six code paths branch on. Two things prevent
-- that. A DO block is a single statement and rolls back as a unit, so an
-- exception inside it undoes the DROP even under autocommit. And under
-- migrate.ts the whole FILE is one simple query in an implicit transaction,
-- so a failure anywhere in it rolls back everything above. The failure mode
-- is "nothing changed", never "constraint silently gone".
--
-- The ADD validates against all 519 production rows. Every one holds one of
-- the six values (all six are in use), so validation passes; on an empty
-- database there is nothing to validate.
DO $$
DECLARE cur TEXT;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO cur
    FROM pg_constraint
   WHERE conname = 'shifts_status_check' AND conrelid = 'shifts'::regclass;

  IF cur IS NOT NULL AND position('unassigned' in cur) > 0 THEN
    RAISE NOTICE 'schema_v75: shifts_status_check already carries the six-value domain; skipping.';
  ELSE
    ALTER TABLE shifts DROP CONSTRAINT IF EXISTS shifts_status_check;

    ALTER TABLE shifts
      ADD CONSTRAINT shifts_status_check
      CHECK (status IN ('unassigned','scheduled','active','completed','missed','cancelled'));
  END IF;
END $$;

-- ── password_reset_tokens: captured, NOT dropped ────────────────────────
--
-- This table exists in production and is created by NOTHING in the chain —
-- verified by parsing all 75 files. It is dead schema: 0 rows, and
-- `grep -rn password_reset_tokens apps/` returns nothing, because the
-- implementer switched to a temp-password-direct-update approach and never
-- dropped the table (docs/02-TRD.md:357).
--
-- CAPTURED RATHER THAN DROPPED, deliberately. Dropping is the tidier end
-- state and is defensible, but it is a production write against a table whose
-- absence from the chain is the actual defect. Reproducing it makes a rebuilt
-- database structurally identical to the live one, which is the property
-- disaster recovery is judged on; deciding to delete it is a separate call
-- that can then be made once, in the open, against a chain that already
-- agrees with prod. docs/02-TRD.md:369-371 reached the same conclusion in
-- May and proposed exactly this, in a schema_v15.sql that was never written.
--
-- DDL reproduced from production via pg_attribute + pg_constraint +
-- pg_indexes at HEAD 9968179 (NOT information_schema — under the read-only
-- role it filters by column privilege and silently under-reports; see N76).
-- Column order, types, nullability, defaults and both indexes match.
--
-- gen_random_uuid(), not uuid_generate_v4(), because that is what production
-- has — this table predates nothing and postdates the uuid-ossp convention in
-- schema.sql. Reproducing it faithfully matters more than being consistent
-- with the file next to it; a diff is the acceptance test.
--
-- Note idx_prt_token is REDUNDANT: password_reset_tokens_token_key already
-- creates a unique index on (token). It is reproduced anyway because it is in
-- production and this file's job is parity, not improvement. Removing it is
-- the same separate decision as dropping the table.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT        NOT NULL,
  portal      TEXT        NOT NULL CHECK (portal IN ('admin', 'client', 'vishnu')),
  token       TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prt_token ON password_reset_tokens (token);

COMMENT ON TABLE password_reset_tokens IS
  'DEAD SCHEMA, captured for production parity in schema_v75 (N43). Zero rows and zero code references — the forgot-password flow updates a temp password directly instead. It existed in production from before 2026-05-16 with no committed migration, so a rebuilt database differed from the live one. Reproduced rather than dropped so the chain and production agree; dropping it is a separate, deliberate decision.';
