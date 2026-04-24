-- ============================================================
-- schema_v10.sql — CB6 / audit/WEEK1.md §C5
--
-- Two additions that harden session revocation:
--
-- 1. guards.tokens_not_before
--    Stamped by POST /api/auth/admin/revoke-guard/:id to a fresh NOW().
--    The auth middleware refuses any JWT whose `iat * 1000` is older
--    than this timestamp.  This gives us a cheap "nuke every active
--    session for this guard, right now" primitive without having to
--    enumerate issued JTIs.
--
-- 2. idx_revoked_tokens_expires (already present in schema_auth.sql,
--    restated here with IF NOT EXISTS for defence-in-depth after any
--    manual index drop).
--
-- Both operations are idempotent; safe to re-run.
-- ============================================================

ALTER TABLE guards
  ADD COLUMN IF NOT EXISTS tokens_not_before TIMESTAMPTZ;

-- Reassert the index used by the revoked-tokens blocklist lookup on every
-- request.  Was added in schema_auth.sql but kept here so a fresh environment
-- that somehow applied v10 without v_auth still gets it.
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti
  ON revoked_tokens (jti);
