-- v83_pending_password_resets[_COMMIT].sql — the preview ends in ROLLBACK and
-- changes nothing; the _COMMIT copy differs from it in the final line only.
--
-- Applies apps/api/src/db/schema_v83.sql (table pending_password_resets, N207)
-- inside one explicit transaction, with a precondition and a postcondition
-- asserted in-transaction. The statements between the BEGIN V83 and END V83
-- markers are schema_v83.sql's, byte for byte: everything from its SET LOCAL
-- line to the end of the file. Its header comment is left out.
--
-- WHO AND WHEN (Vishnu, 2026-10-15): "you run the migration yourself when
-- ready, preview with ROLLBACK first, then ask me for a yes before COMMIT."
-- So: this preview first; the COMMIT copy only after the preview printed the
-- summary row and ROLLBACK, and after Vishnu's yes. Before the merge of the PR
-- that carries schema_v83.sql (expand-then-extend): its sign-in and
-- forgot-password code reads and writes the table.
--
-- HOW (ON_ERROR_STOP, so a failed assertion stops the file):
--   railway connect Postgres  … then  \i scripts/ops/v83_pending_password_resets.sql
--
-- RE-RUN: the precondition refuses a database that already has the table, so
-- the COMMIT copy cannot run twice. (schema_v83.sql itself is idempotent for
-- db/migrate.ts replays; this script is the one-shot.)
--
-- LOCK: a new table with no foreign key. Nothing existing is locked.

\set ON_ERROR_STOP on

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION 'v83 preflight: lock_timeout is %, not 3s', current_setting('lock_timeout');
  END IF;
END $$;

-- PRECONDITION: v82 is the tip (company_profile_audit exists) and nothing is
-- named pending_password_resets. Both held in prod on 2026-10-15.
DO $$
BEGIN
  IF to_regclass('public.company_profile_audit') IS NULL THEN
    RAISE EXCEPTION 'v83 precondition: company_profile_audit (v82) is missing';
  END IF;
  IF to_regclass('public.pending_password_resets') IS NOT NULL THEN
    RAISE EXCEPTION 'v83 precondition: pending_password_resets already exists';
  END IF;
  RAISE NOTICE 'v83 precondition: v82 present; no pending_password_resets';
END $$;

-- ── BEGIN V83 (schema_v83.sql, verbatim) ──────────────────────────────────
SET LOCAL lock_timeout = '3s';

-- ── Why ──────────────────────────────────────────────────────────────────
--
-- POST /api/auth/forgot-password overwrote the account's password_hash with
-- the emailed temporary password at once. Anyone who knew an email could end
-- its owner's password: a guard could not sign in for a shift, and a signed-in
-- admin was held on the change-password page (N194).
--
-- Decisions, Vishnu 2026-10-15: 1a, the temporary password waits in a new
-- table, "hashed (bcrypt, same cost as passwords), never plain", and sign-in
-- takes the current password or an unexpired temporary one; 2a, it works for
-- 24 hours; 3a, at most one reset email per account per 15 minutes.
-- services/pendingPasswordReset.ts holds every read and write.
--
-- ── Shape ────────────────────────────────────────────────────────────────
--
-- One row per account: (role, account_id). account_id names a row in
-- company_admins, clients or guards, by role. So there is no foreign key, and
-- nothing locks those tables. A row is deleted when its temporary password is
-- used, or when the account signs in with its current password or gets a new
-- one. An unused row stops signing in at expires_at and is replaced by the
-- account's next request.
--
-- created_at is the time of the last reset email, and it paces the next one.
-- password_hash is a bcrypt hash (cost 12), never the password.
--
-- ── The read-only role ───────────────────────────────────────────────────
--
-- In production, postgres's default privileges give claude_readonly SELECT on
-- every new table in public (pg_default_acl, 2026-10-15). password_hash is a
-- credential. So, like scripts/ops/readonly-column-revoke.sql for the other
-- credential tables, the table-level grant is swapped for a column-level one
-- that leaves it out. The role does not exist on a fresh local database,
-- hence the guard.

CREATE TABLE IF NOT EXISTS pending_password_resets (
  role          TEXT        NOT NULL CHECK (role IN ('company_admin', 'client', 'guard')),
  account_id    UUID        NOT NULL,
  password_hash TEXT        NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (role, account_id)
);

COMMENT ON TABLE pending_password_resets IS
  'N207 (schema_v83): an emailed temporary password, bcrypt-hashed, waiting beside the account''s password until it is used, the account signs in with its password or gets a new one, or it expires. One row per account; created_at paces the reset emails. services/pendingPasswordReset.ts.';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    REVOKE ALL ON pending_password_resets FROM claude_readonly;
    GRANT SELECT (role, account_id, expires_at, created_at) ON pending_password_resets TO claude_readonly;
  END IF;
END $$;
-- ── END V83 ───────────────────────────────────────────────────────────────

-- POSTCONDITION: the five columns with these types, all NOT NULL; the role
-- CHECK; the primary key (role, account_id); no foreign key; no rows. Where
-- claude_readonly exists: it can read every column but password_hash, and has
-- no table-level SELECT.
DO $$
DECLARE cols text; chk text; pk text; n bigint;
BEGIN
  SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod)
                    || CASE WHEN attnotnull THEN ' NOT NULL' ELSE '' END, ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute
   WHERE attrelid = 'pending_password_resets'::regclass AND attnum > 0 AND NOT attisdropped;
  IF cols IS DISTINCT FROM 'role text NOT NULL, account_id uuid NOT NULL, password_hash text NOT NULL, expires_at timestamp with time zone NOT NULL, created_at timestamp with time zone NOT NULL' THEN
    RAISE EXCEPTION 'v83 postcondition: columns are %', cols;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO chk FROM pg_constraint
   WHERE conrelid = 'pending_password_resets'::regclass AND contype = 'c';
  IF chk IS DISTINCT FROM 'CHECK ((role = ANY (ARRAY[''company_admin''::text, ''client''::text, ''guard''::text])))' THEN
    RAISE EXCEPTION 'v83 postcondition: unexpected role CHECK %', chk;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO pk FROM pg_constraint
   WHERE conrelid = 'pending_password_resets'::regclass AND contype = 'p';
  IF pk IS DISTINCT FROM 'PRIMARY KEY (role, account_id)' THEN
    RAISE EXCEPTION 'v83 postcondition: unexpected primary key %', pk;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pending_password_resets'::regclass AND contype = 'f') THEN
    RAISE EXCEPTION 'v83 postcondition: a foreign key exists';
  END IF;
  SELECT count(*) INTO n FROM pending_password_resets;
  IF n <> 0 THEN
    RAISE EXCEPTION 'v83 postcondition: % rows', n;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    IF has_table_privilege('claude_readonly', 'pending_password_resets', 'SELECT')
       OR has_column_privilege('claude_readonly', 'pending_password_resets', 'password_hash', 'SELECT')
       OR NOT has_column_privilege('claude_readonly', 'pending_password_resets', 'role', 'SELECT')
       OR NOT has_column_privilege('claude_readonly', 'pending_password_resets', 'account_id', 'SELECT')
       OR NOT has_column_privilege('claude_readonly', 'pending_password_resets', 'expires_at', 'SELECT')
       OR NOT has_column_privilege('claude_readonly', 'pending_password_resets', 'created_at', 'SELECT') THEN
      RAISE EXCEPTION 'v83 postcondition: claude_readonly''s privileges are not every column but password_hash';
    END IF;
  END IF;
  RAISE NOTICE 'v83 postcondition: five NOT NULL columns, role CHECK, primary key (role, account_id), no FK, 0 rows; the read-only role cannot read password_hash';
END $$;

-- What the operator sees before the last line runs. NULL in the last two
-- columns where claude_readonly does not exist.
SELECT to_regclass('public.pending_password_resets') IS NOT NULL                   AS pending_table,
       (SELECT count(*) FROM pending_password_resets)                               AS pending_rows,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly')
            THEN has_column_privilege('claude_readonly', 'pending_password_resets', 'password_hash', 'SELECT')
       END                                                                          AS readonly_reads_hash,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly')
            THEN has_column_privilege('claude_readonly', 'pending_password_resets', 'expires_at', 'SELECT')
       END                                                                          AS readonly_reads_expiry;

ROLLBACK;
