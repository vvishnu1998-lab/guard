-- readonly-column-revoke.sql
--
-- NOT A MIGRATION. This file is deliberately absent from the migrate.ts chain.
-- It changes GRANTS, not schema, and it requires an owner/superuser role that
-- the application user does not have. Vishnu runs it by hand, once, per
-- docs/OPS/RUNBOOK-phase2-apply.md.
--
-- WHAT IT DOES
-- ------------
-- claude_readonly currently holds table-level SELECT on all 48 public tables,
-- which includes every credential column in the database: password hashes for
-- guards / company_admins / clients, Expo push tokens, password-reset tokens,
-- revoked-JWT jtis and OTP hashes. This narrows that to column-level SELECT
-- on the eight tables that hold secrets, dropping exactly the secret columns
-- and keeping everything else readable.
--
-- Table-level SELECT on the other 40 tables is untouched.
--
-- ============================================================================
-- CAVEAT -- READ BEFORE ANY FUTURE ALTER TABLE ON THESE EIGHT TABLES
-- ============================================================================
-- Column-level grants DO NOT extend to columns added later. After this runs,
-- any ALTER TABLE ADD COLUMN on guards, company_admins, clients,
-- guard_devices, password_reset_tokens, revoked_tokens, login_attempts or
-- vishnu_state produces a column that claude_readonly CANNOT read, and the
-- failure is a runtime permission error on a query that used to work --
-- typically a SELECT * that silently becomes a 42501.
--
-- Any migration adding a column to one of these eight tables must therefore
-- carry its own GRANT SELECT (new_column) ON <table> TO claude_readonly, or
-- deliberately withhold it if the new column is itself a secret. Tracked as
-- N10 in docs/OPS/OPEN-ITEMS.md.
-- ============================================================================
--
-- IDEMPOTENT. REVOKE of a privilege not held is a no-op; GRANT of a privilege
-- already held is a no-op. Safe to re-run. Wrapped in a single transaction so
-- a failure part-way cannot leave the role with some tables narrowed and
-- others wide open.
--
-- The role guard exists because this file is also readable on a fresh local
-- database where claude_readonly does not exist.
--
-- TABLE-EXISTENCE GUARD (added 2026-09-05, Phase 4)
-- ------------------------------------------------
-- password_reset_tokens exists in PRODUCTION but is created by NO migration:
-- it appears in zero schema_v*.sql files, is referenced by zero TypeScript
-- files, and a full replay of the migrate.ts chain into an empty database
-- produces 48 tables without it (production has 49). It is an out-of-band
-- orphan with 0 rows. Tracked as N15 in docs/OPS/OPEN-ITEMS.md.
--
-- Without the guards below, this script aborts on any database where that
-- table is absent -- which is every fresh one. Each block is therefore
-- conditional on the table actually existing.

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly') THEN
  RAISE EXCEPTION 'role claude_readonly does not exist -- wrong database?';
END IF;
END
$$;

-- guards: revoking password_hash, tokens_not_before
DO $$
BEGIN
IF to_regclass('public.guards') IS NULL THEN
  RAISE NOTICE 'skipping guards: table does not exist in this database';
ELSE
  REVOKE SELECT ON guards FROM claude_readonly;
  EXECUTE 'GRANT SELECT (id, company_id, name, email, badge_number, is_active, created_at, must_change_password, phone_number) ON guards TO claude_readonly';
END IF;
END
$$;

-- company_admins: revoking password_hash, tokens_not_before
DO $$
BEGIN
IF to_regclass('public.company_admins') IS NULL THEN
  RAISE NOTICE 'skipping company_admins: table does not exist in this database';
ELSE
  REVOKE SELECT ON company_admins FROM claude_readonly;
  EXECUTE 'GRANT SELECT (id, company_id, name, email, is_primary, is_active, created_at, must_change_password, failed_login_count, locked_at) ON company_admins TO claude_readonly';
END IF;
END
$$;

-- clients: revoking password_hash, tokens_not_before
DO $$
BEGIN
IF to_regclass('public.clients') IS NULL THEN
  RAISE NOTICE 'skipping clients: table does not exist in this database';
ELSE
  REVOKE SELECT ON clients FROM claude_readonly;
  EXECUTE 'GRANT SELECT (id, site_id, name, email, is_active, created_at, must_change_password, last_login_at, company_id) ON clients TO claude_readonly';
END IF;
END
$$;

-- guard_devices: revoking push_token
DO $$
BEGIN
IF to_regclass('public.guard_devices') IS NULL THEN
  RAISE NOTICE 'skipping guard_devices: table does not exist in this database';
ELSE
  REVOKE SELECT ON guard_devices FROM claude_readonly;
  EXECUTE 'GRANT SELECT (id, guard_id, platform, client, claimed_at, last_seen_at, revoked_at, revoked_reason) ON guard_devices TO claude_readonly';
END IF;
END
$$;

-- password_reset_tokens: revoking token
DO $$
BEGIN
IF to_regclass('public.password_reset_tokens') IS NULL THEN
  RAISE NOTICE 'skipping password_reset_tokens: table does not exist in this database';
ELSE
  REVOKE SELECT ON password_reset_tokens FROM claude_readonly;
  EXECUTE 'GRANT SELECT (id, email, portal, expires_at, used_at, created_at) ON password_reset_tokens TO claude_readonly';
END IF;
END
$$;

-- revoked_tokens: revoking jti
DO $$
BEGIN
IF to_regclass('public.revoked_tokens') IS NULL THEN
  RAISE NOTICE 'skipping revoked_tokens: table does not exist in this database';
ELSE
  REVOKE SELECT ON revoked_tokens FROM claude_readonly;
  EXECUTE 'GRANT SELECT (id, revoked_at, expires_at) ON revoked_tokens TO claude_readonly';
END IF;
END
$$;

-- login_attempts: revoking otp_hash
DO $$
BEGIN
IF to_regclass('public.login_attempts') IS NULL THEN
  RAISE NOTICE 'skipping login_attempts: table does not exist in this database';
ELSE
  REVOKE SELECT ON login_attempts FROM claude_readonly;
  EXECUTE 'GRANT SELECT (id, guard_id, failed_count, locked_at, unlocked_by, updated_at, otp_expires_at) ON login_attempts TO claude_readonly';
END IF;
END
$$;

-- vishnu_state: revoking tokens_not_before
DO $$
BEGIN
IF to_regclass('public.vishnu_state') IS NULL THEN
  RAISE NOTICE 'skipping vishnu_state: table does not exist in this database';
ELSE
  REVOKE SELECT ON vishnu_state FROM claude_readonly;
  EXECUTE 'GRANT SELECT (id, last_updated_at, failed_login_count, locked_at) ON vishnu_state TO claude_readonly';
END IF;
END
$$;

COMMIT;

-- Verify with scripts/ops/readonly-column-revoke.verify.sql:
--   every should_be_false must be f, every should_be_true must be t.
