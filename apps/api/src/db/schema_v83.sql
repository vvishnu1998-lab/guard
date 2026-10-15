-- schema_v83 — pending_password_resets (N207, 2026-10-15)
--
-- NUMBERING: v82 is the highest entry in migrate.ts and the highest file on
-- disk. Both were re-read on fix/n169-process-handlers (b6e227a, on main
-- 2324b59) immediately before writing this. Production has v82 applied
-- (company_profile_audit and companies.logo_url present) and no
-- pending_password_resets, read through postgres-readonly on 2026-10-15. No
-- ref and no worktree holds a schema_v83 or higher. Read the chain off
-- migrate.ts, never from a brief.
--
-- Expand-only DDL: one new table. No data change, no backfill, and no lock on
-- any existing table (no foreign key).
--
-- APPLYING BY HAND: wrap it in an explicit BEGIN/COMMIT, as
-- scripts/ops/v83_pending_password_resets.sql does. SET LOCAL through piped
-- psql is a silent no-op in autocommit (learned applying v54).
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
