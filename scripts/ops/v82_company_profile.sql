-- v82_company_profile[_COMMIT].sql — the preview ends in ROLLBACK and changes
-- nothing; the _COMMIT copy differs from it in the final line only.
--
-- Applies apps/api/src/db/schema_v82.sql (eight NULLable columns on companies,
-- table company_profile_audit) inside one explicit transaction, with a
-- precondition and a postcondition asserted in-transaction. The statements
-- between the BEGIN V82 and END V82 markers are schema_v82.sql's, byte for
-- byte: its SET LOCAL line, then everything from ALTER TABLE to the end of the
-- file. Its header comment is left out.
--
-- v82_company_profile_COMMIT.sql is this file with ONE line changed: the final
-- ROLLBACK is COMMIT. Run this preview first; run the COMMIT copy only after
-- the preview printed the summary row and ROLLBACK.
--
-- WHEN: immediately before merging the PR that carries schema_v82.sql, in the
-- same deploy window (expand-then-extend). See schema_v82.sql "ORDER": that PR
-- lists companies.logo_url in POINTER_COLUMNS, and the purge's reference check
-- fails closed against a database without the column.
--
-- HOW (Vishnu, by hand; ON_ERROR_STOP so a failed assertion stops the file):
--   railway connect Postgres  … then  \i scripts/ops/v82_company_profile.sql
--   or pipe it:  psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f <file>
--
-- RE-RUN: the precondition refuses a database that already has any v82 column
-- or the audit table, so the COMMIT copy cannot run twice. (schema_v82.sql
-- itself is idempotent for db/migrate.ts replays; this script is the one-shot.)
--
-- LOCK: ADD COLUMN with no DEFAULT is a catalog-only change on companies (no
-- table rewrite; proven on a local PG 18.6 by an unchanged relfilenode), under
-- ACCESS EXCLUSIVE; the audit table's FK takes SHARE ROW EXCLUSIVE on
-- companies. Both are held until COMMIT/ROLLBACK, milliseconds. lock_timeout
-- 3s means it gives up rather than queue behind a long transaction that holds
-- companies; if it does, re-run.

BEGIN;

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION 'v82 preflight: lock_timeout is %, not 3s', current_setting('lock_timeout');
  END IF;
END $$;

-- PRECONDITION: companies is exactly the six pre-v82 columns, and nothing is
-- named company_profile_audit. Both held in prod on 2026-10-06.
DO $$
DECLARE cols text;
BEGIN
  SELECT string_agg(attname, ',' ORDER BY attnum) INTO cols
    FROM pg_attribute
   WHERE attrelid = 'companies'::regclass AND attnum > 0 AND NOT attisdropped;
  IF cols <> 'id,name,default_photo_limit,is_active,created_at,is_test' THEN
    RAISE EXCEPTION 'v82 precondition: companies columns are %', cols;
  END IF;
  IF to_regclass('public.company_profile_audit') IS NOT NULL THEN
    RAISE EXCEPTION 'v82 precondition: company_profile_audit already exists';
  END IF;
  RAISE NOTICE 'v82 precondition: companies has its six pre-v82 columns; no company_profile_audit';
END $$;

-- ── BEGIN V82 (schema_v82.sql, verbatim) ──────────────────────────────────
SET LOCAL lock_timeout = '3s';
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
-- ── END V82 ───────────────────────────────────────────────────────────────

-- POSTCONDITION: the eight columns exist with these types, NULLable, with no
-- DEFAULT; the audit table carries its CHECK, FK and index; no companies row
-- gained a value.
DO $$
DECLARE cols text; chk text; fk text; n bigint;
BEGIN
  SELECT string_agg(attname || ' ' || format_type(atttypid, atttypmod)
                    || CASE WHEN attnotnull THEN ' NOT NULL' ELSE '' END, ', ' ORDER BY attnum) INTO cols
    FROM pg_attribute
   WHERE attrelid = 'companies'::regclass AND attnum > 6 AND NOT attisdropped;
  IF cols IS DISTINCT FROM 'contact_email character varying(255), phone character varying(32), address text, licence_number character varying(64), website character varying(255), logo_url text, logo_updated_at timestamp with time zone, updated_at timestamp with time zone' THEN
    RAISE EXCEPTION 'v82 postcondition: new companies columns are %', cols;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_attrdef WHERE adrelid = 'companies'::regclass AND adnum > 6) THEN
    RAISE EXCEPTION 'v82 postcondition: a new companies column has a DEFAULT';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO chk FROM pg_constraint
   WHERE conrelid = 'company_profile_audit'::regclass AND contype = 'c';
  IF chk IS DISTINCT FROM 'CHECK ((field = ANY (ARRAY[''contact_email''::text, ''phone''::text, ''address''::text, ''licence_number''::text, ''website''::text, ''logo_url''::text])))' THEN
    RAISE EXCEPTION 'v82 postcondition: unexpected field CHECK %', chk;
  END IF;
  SELECT pg_get_constraintdef(oid) INTO fk FROM pg_constraint
   WHERE conrelid = 'company_profile_audit'::regclass AND contype = 'f';
  IF fk IS DISTINCT FROM 'FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE' THEN
    RAISE EXCEPTION 'v82 postcondition: unexpected FK %', fk;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE indexname = 'company_profile_audit_company_id_idx'
                    AND indexdef LIKE '%(company_id, created_at DESC)') THEN
    RAISE EXCEPTION 'v82 postcondition: company_profile_audit_company_id_idx missing or different';
  END IF;
  SELECT count(*) INTO n FROM companies
   WHERE num_nonnulls(contact_email, phone, address, licence_number, website,
                      logo_url, logo_updated_at, updated_at) > 0;
  IF n <> 0 THEN
    RAISE EXCEPTION 'v82 postcondition: % companies rows already hold a v82 value', n;
  END IF;
  RAISE NOTICE 'v82 postcondition: 8 NULLable columns without DEFAULT; audit table CHECK, FK and index as written';
END $$;

-- What the operator sees before the last line runs. The last column is only
-- reported, not asserted: prod's default ACL (FOR ROLE postgres IN SCHEMA
-- public) grants claude_readonly SELECT on tables postgres creates, so it is
-- true when this runs as postgres. NULL where the role does not exist.
SELECT (SELECT count(*) FROM pg_attribute
         WHERE attrelid = 'companies'::regclass AND attnum > 0 AND NOT attisdropped) AS companies_columns,
       to_regclass('public.company_profile_audit') IS NOT NULL                    AS audit_table,
       (SELECT count(*) FROM companies)                                            AS companies_rows,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly')
            THEN has_table_privilege('claude_readonly', 'company_profile_audit', 'SELECT')
       END                                                                         AS readonly_can_read_audit;

ROLLBACK;
