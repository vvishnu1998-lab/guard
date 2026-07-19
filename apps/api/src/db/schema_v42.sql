-- Schema v42 — admin + vishnu session revocation (Finding #1 prep)
--
-- Adds the tokens_not_before stamp for company_admins (mirrors
-- guards.tokens_not_before / clients.tokens_not_before) and a singleton
-- vishnu_state table so a leaked super-admin token can be revoked without
-- rotating VISHNU_JWT_SECRET (which would kick nothing else, but the point
-- is a targeted "revoke all vishnu sessions" break-glass).
--
-- SAFETY: tokens_not_before defaults to NULL for every existing row.
-- The middleware check is NULL-safe — NULL means "no revocation" — so this
-- migration does NOT invalidate any live admin session on deploy. The code
-- that reads these columns ships separately (Commit 2), so this migration
-- is a silent no-op at runtime until then.
--
-- Idempotent: IF NOT EXISTS on the column/index/table, ON CONFLICT on the
-- singleton seed — safe to replay via the migrate.ts files[] loop.

ALTER TABLE company_admins
  ADD COLUMN IF NOT EXISTS tokens_not_before TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_company_admins_tokens_not_before
  ON company_admins (id, tokens_not_before);

CREATE TABLE IF NOT EXISTS vishnu_state (
  id                INT         PRIMARY KEY DEFAULT 1,
  tokens_not_before TIMESTAMPTZ NULL,
  last_updated_at   TIMESTAMPTZ NULL,
  CONSTRAINT vishnu_state_singleton CHECK (id = 1)
);

INSERT INTO vishnu_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
