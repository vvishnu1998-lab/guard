-- Schema v31 — multiple clients per site + last_login_at
--
-- 1. Drop UNIQUE (site_id) — Session C lets an admin add several client
--    portal accounts to the same site (property manager + accountant +
--    security director all get read-only visibility).
--    Prod pre-check: no site has >1 client row today, so the constraint
--    drop is a metadata-only ALTER.
--
-- 2. Add last_login_at so the CLIENTS AT THIS SITE list can render
--    "Last login: 3 days ago" / "Never logged in". Populated by the
--    /api/auth/client/login handler on every successful auth.
--
-- Both changes are additive and idempotent.

ALTER TABLE clients DROP CONSTRAINT IF EXISTS clients_site_id_key;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ NULL;
