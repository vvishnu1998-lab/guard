-- Schema v43 — admin + vishnu login brute-force lockout (Finding #9 prep)
--
-- Mirrors the guard lockout model (login_attempts.failed_count / locked_at,
-- schema_auth.sql) but stores the counters directly on company_admins and on
-- the vishnu_state singleton (schema_v42). The login handlers that read these
-- columns ship separately (Commit 2), so this migration is a silent no-op at
-- runtime until then.
--
-- SAFETY: failed_login_count defaults to 0 and locked_at to NULL for every
-- existing row, so NO admin is pre-locked on deploy. The handler's lock check
-- is `locked_at IS NOT NULL AND failed_login_count >= 5`, which is false for
-- all current rows.
--
-- Idempotent: IF NOT EXISTS on every column/index — safe to replay via the
-- migrate.ts files[] loop.

ALTER TABLE company_admins
  ADD COLUMN IF NOT EXISTS failed_login_count SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE company_admins
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_company_admins_locked_at
  ON company_admins (locked_at)
  WHERE locked_at IS NOT NULL;

ALTER TABLE vishnu_state
  ADD COLUMN IF NOT EXISTS failed_login_count SMALLINT NOT NULL DEFAULT 0;

ALTER TABLE vishnu_state
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ NULL;
