-- Schema v36 — Multi-site clients (EXPAND phase)
--
-- A single client account can now be linked to N sites. This migration
-- adds the junction table + a permanent tenant-anchor column on clients
-- and backfills both from the existing single-column `clients.site_id`.
--
--   ① CREATE TABLE client_sites (client_id, site_id, ...) — the junction.
--     UNIQUE (client_id, site_id) so the same client can't be linked
--     to the same site twice. ON DELETE CASCADE on both FKs so removing
--     a client or a site cleans up the link rows automatically.
--
--   ② ADD COLUMN clients.company_id — permanent tenant anchor. Derived
--     from sites.company_id via clients.site_id today, but we materialize
--     it so cross-tenant checks + retention queries don't need the
--     joins-through-junction dance. Populated in step ④; SET NOT NULL
--     in step ⑤ once populated.
--
--   ③ Backfill client_sites from every existing clients row. ON CONFLICT
--     DO NOTHING is defensive — a re-run of this migration is a no-op.
--
--   ④ Backfill clients.company_id from sites.company_id via
--     clients.site_id (still NOT NULL through EXPAND).
--
--   ⑤ SET NOT NULL on clients.company_id now that every row has a value.
--
-- CONTRACT phase (schema_v37+, later): drop clients.site_id once every
-- write-path is on the junction. Nothing in this migration removes
-- state — a downgrade window is preserved.

CREATE TABLE IF NOT EXISTS client_sites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id  UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  site_id    UUID NOT NULL REFERENCES sites(id)   ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NULL,
  UNIQUE (client_id, site_id)
);

CREATE INDEX IF NOT EXISTS idx_client_sites_client_id ON client_sites(client_id);
CREATE INDEX IF NOT EXISTS idx_client_sites_site_id   ON client_sites(site_id);

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE CASCADE;

INSERT INTO client_sites (client_id, site_id, created_at)
  SELECT id, site_id, created_at FROM clients WHERE site_id IS NOT NULL
  ON CONFLICT (client_id, site_id) DO NOTHING;

UPDATE clients c
   SET company_id = s.company_id
  FROM sites s
 WHERE s.id = c.site_id
   AND c.company_id IS NULL;

ALTER TABLE clients
  ALTER COLUMN company_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_clients_company_id ON clients(company_id);
