-- schema_v82 — company profile columns + company_profile_audit (Phase A, 2026-10-06)
--
-- NUMBERING: v81 is the highest entry in migrate.ts and the highest file on
-- disk; both were re-read at origin/main daa8379 immediately before writing
-- this, and prod confirms v81 applied (shifts_end_after_start present and
-- validated). No local or remote branch and no worktree holds a schema_v82
-- or higher. Read the chain off migrate.ts, never from a brief.
--
-- Tier 1 (docs/OPS/POLICY.md): expand-only DDL. Eight NULLable columns on
-- companies with no DEFAULT, and one new table. No data change, no backfill.
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through piped
-- psql is a silent no-op in autocommit (learned applying v54).
SET LOCAL lock_timeout = '3s';

-- ── Why ──────────────────────────────────────────────────────────────────
--
-- `companies` holds a name and three flags: 6 columns, attnum 1..6
-- contiguous, none dropped (prod, 2026-10-06). There is nowhere to put a
-- company's contact email, phone, mailing address, licence number, website or
-- logo, and no tenant-side company API exists: the only writes are the
-- super-admin's POST and PATCH /api/admin/companies (routes/admin.ts:125,
-- :136).
--
-- Phase A adds a Company Profile that the PRIMARY company admin edits from
-- /admin/settings. Phase B (one shared report letterhead) reads these columns.
-- Nothing reads them yet.
--
-- Decisions, Vishnu 2026-10-06: 1b the five text fields plus a logo, all
-- NULLable; 2a only the primary admin edits, re-checked from the DB on every
-- write; 3a `name` stays super-admin-only, so it is not a field here and is
-- not audited by this table.
--
-- ── Columns ──────────────────────────────────────────────────────────────
--
-- All NULL, no DEFAULT. ADD COLUMN with no default is a catalog-only change:
-- existing rows (4 in prod) are not rewritten, and ACCESS EXCLUSIVE on
-- companies is held only for the catalog update, bounded by lock_timeout.
--
--   contact_email    varchar(255)  same width as company_admins.email.
--   phone            varchar(32)
--   address          text          the API caps it at 500 characters.
--   licence_number   varchar(64)   free text, e.g. a state PPO licence.
--   website          varchar(255)  the API admits only http(s) URLs.
--   logo_url         text          FULL URL of an S3 object, never a bare key.
--   logo_updated_at  timestamptz   when logo_url last changed.
--   updated_at       timestamptz   last write through the profile routes.
--
-- NULL means "not provided". The API stores an empty string as NULL, so
-- absence has one representation. Format rules (email shape, phone
-- characters, http(s) website) live in the API, not in CHECKs: a CHECK would
-- duplicate each rule in a second place that must change in step with it.
--
-- ── logo_url is a media pointer: POINTER_COLUMNS changes in the same commit
--
-- services/mediaOwnership.ts assertPointerColumnsCurrent() flags any public
-- text column whose name matches (url|photo|selfie|image|s3|pdf|storage) and
-- is not listed in POINTER_COLUMNS, and jobs/nightlyPurge.ts then skips EVERY
-- S3 sweep (Sentry 'retention_pointer_column_drift'). logo_url matches. None of
-- the other seven columns does, and neither does any column of
-- company_profile_audit. The entry ['companies', 'logo_url'] ships in the same
-- commit as this file.
--
-- ORDER. The probe looks one way only. Code that lists companies.logo_url,
-- run against a database without the column, makes keysStillReferenced()
-- error and fail closed (it deletes nothing). A database with the column, run
-- with code that lacks the entry, makes the probe skip every sweep. Both are
-- safe and neither is intended: apply this file by hand immediately before
-- merging the PR that carries it, in the same deploy window (v81 precedent).
--
-- It is a full URL because deleteS3Object (services/s3.ts:141) deletes only a
-- URL on the configured bucket host and skips a bare key as 'malformed', and
-- every other pointer column already stores full URLs.
--
-- ── company_profile_audit ────────────────────────────────────────────────
--
-- companies has no history, so without this table a profile edit leaves no
-- trace: the gap schema_v70 closed for site configuration. Conventions follow
-- site_config_audit (v70) and shift_schedule_audit (v58): uuid id, the entity
-- as a FK ON DELETE CASCADE, an actor uuid that is NOT a FK, a CHECK naming
-- exactly the values that exist, and a newest-first index per entity.
--
-- Deliberate departures, decided 2026-10-06:
--   * One row per CHANGED FIELD (field, old_value, new_value as text), not one
--     jsonb before/after per edit. A logo upload or removal is a row with
--     field = 'logo_url' holding the old and new URLs.
--   * actor_admin_id instead of changed_by + changed_by_role. Every writer is
--     the primary company_admin, so the uuid always resolves in
--     company_admins. A super-admin writer would need a role column first,
--     which means a migration.
--   * No reason column.
--
-- actor_admin_id has no FK, matching the actor column of every existing audit
-- table (v15, v20, v58, v70). Their stated reason, that actors live in more
-- than one table, does not apply here. The one that does is lifetime: a FK
-- would either block deleting an admin row (RESTRICT) or take the history
-- with it (CASCADE). An audit row must outlive what it names.
--
-- Retention: none, permanent by construction, as in v70. No nightlyPurge step
-- touches companies or this table, and the application never deletes a
-- company (only test harnesses delete their own marker tenants). The CASCADE
-- is what lets those harnesses clean up.
--
-- ── Idempotent ───────────────────────────────────────────────────────────
--
-- db/migrate.ts re-runs every file on every invocation. ADD COLUMN IF NOT
-- EXISTS, CREATE TABLE IF NOT EXISTS (which covers the FK and CHECK declared
-- inside it), CREATE INDEX IF NOT EXISTS and COMMENT ON are all re-runnable.
-- Nothing here is a bare ADD CONSTRAINT on an existing table, so no DO-block
-- guard is needed (contrast v71, v81).
--
-- The cost of IF NOT EXISTS, as in v70: a pre-existing column or table of the
-- same name but a different shape is silently kept. Verified against
-- production 2026-10-06 before writing: none of the eight column names exist,
-- no relation or constraint is named company_profile_audit*, uuid-ossp is
-- installed, companies.id is uuid, and the server is PostgreSQL 18.6.
--
-- ── Rollback ─────────────────────────────────────────────────────────────
--
--   DROP TABLE company_profile_audit;
--   ALTER TABLE companies
--     DROP COLUMN contact_email,  DROP COLUMN phone,
--     DROP COLUMN address,        DROP COLUMN licence_number,
--     DROP COLUMN website,        DROP COLUMN logo_url,
--     DROP COLUMN logo_updated_at, DROP COLUMN updated_at;
--
-- Then remove this file from migrate.ts, or the next db:migrate re-adds it
-- all, and remove the companies entry from POINTER_COLUMNS, or the purge's
-- reference check errors and deletes nothing. Once any logo has been
-- uploaded, dropping logo_url orphans its object: list company-logos/ first.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS contact_email   varchar(255),
  ADD COLUMN IF NOT EXISTS phone           varchar(32),
  ADD COLUMN IF NOT EXISTS address         text,
  ADD COLUMN IF NOT EXISTS licence_number  varchar(64),
  ADD COLUMN IF NOT EXISTS website         varchar(255),
  ADD COLUMN IF NOT EXISTS logo_url        text,
  ADD COLUMN IF NOT EXISTS logo_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at      timestamptz;

CREATE TABLE IF NOT EXISTS company_profile_audit (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      uuid        NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_admin_id  uuid        NOT NULL,
  field           text        NOT NULL
    CHECK (field IN ('contact_email', 'phone', 'address',
                     'licence_number', 'website', 'logo_url')),
  old_value       text,
  new_value       text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- A company's profile history, newest first.
CREATE INDEX IF NOT EXISTS company_profile_audit_company_id_idx
  ON company_profile_audit (company_id, created_at DESC);

COMMENT ON COLUMN companies.logo_url IS
  'Full https URL of the company logo in the media bucket (key company-logos/{company_id}/{uuid}.{ext}), never a bare key: deleteS3Object skips bare keys. Registered in POINTER_COLUMNS (services/mediaOwnership.ts). NULL = no logo.';

COMMENT ON COLUMN companies.logo_updated_at IS
  'When logo_url last changed, by upload or removal. NULL = never set.';

COMMENT ON COLUMN companies.updated_at IS
  'Last write through the company-profile routes (Phase A). NULL = never edited there. The super-admin PATCH /api/admin/companies/:id does not set it.';

COMMENT ON TABLE company_profile_audit IS
  'One row per changed company-profile field, written in the same transaction as the companies UPDATE. The only record of a profile edit: companies keeps no history. Permanent; no purge step.';

COMMENT ON COLUMN company_profile_audit.actor_admin_id IS
  'company_admins.id of the primary admin who made the change. NOT a FK, like every audit actor column (v15, v20, v58, v70): the row must outlive the admin row it names.';

COMMENT ON COLUMN company_profile_audit.field IS
  'Which companies column changed. The CHECK admits exactly the six profile columns; name is super-admin-only and not audited here. A logo upload or removal is field = logo_url.';

COMMENT ON COLUMN company_profile_audit.old_value IS
  'Value before the change, as text. NULL = was not set.';

COMMENT ON COLUMN company_profile_audit.new_value IS
  'Value after the change, as text. NULL = cleared.';
