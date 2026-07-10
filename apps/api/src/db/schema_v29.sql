-- Schema v29 — admin_client_previews audit table
--
-- Every time an admin clicks "PREVIEW AS CLIENT" on the sites page,
-- a row lands here. Gives us:
--   * an audit trail of who impersonated which site's client portal,
--   * TTL bookkeeping (expires_at) if we ever want to force-early-
--     expire a burst of previews,
--   * volume signal for rate-limiting (future).
--
-- No FK on admin_id — company_admins and vishnu can both create rows,
-- and vishnu has no persistent user row. site_id keeps the FK on
-- sites so the audit points at a real site even if we later rotate
-- admins.

CREATE TABLE IF NOT EXISTS admin_client_previews (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id      UUID NOT NULL,
  site_id       UUID NOT NULL REFERENCES sites(id),
  previewed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_client_previews_admin
  ON admin_client_previews (admin_id, previewed_at DESC);
