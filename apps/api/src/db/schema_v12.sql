-- schema_v12.sql — extends must_change_password to admin + client accounts.
--
-- Forgot-password flow now generates an 8-char temp password, hashes it onto
-- the user row, and flips must_change_password=true. On next login, the
-- frontend forces the user to set a new password before accessing any route.
-- guards.must_change_password already exists (schema_auth.sql); this adds the
-- matching column to company_admins and clients so all three portals share
-- the same flag-driven force-change behaviour.
--
-- Idempotent: safe to re-run.

ALTER TABLE company_admins
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
