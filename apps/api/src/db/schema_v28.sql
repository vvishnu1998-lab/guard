-- Schema v28 — clients.tokens_not_before (session-nuke stamp)
--
-- Mirrors the guards.tokens_not_before pattern. When the admin disables
-- the client portal for a site, deactivates the site, or the nightly
-- retention job flips the retention flag, we bump this column to NOW()
-- for every client of that site. The auth middleware rejects any client
-- JWT with `iat * 1000 < tokens_not_before` — kicking active sessions
-- immediately rather than waiting for the token to expire.
--
-- The (id, tokens_not_before) composite index lets the middleware read
-- both columns from a single index scan on the hot path (every
-- authenticated client request).

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS tokens_not_before TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_clients_tokens_not_before
  ON clients (id, tokens_not_before);
