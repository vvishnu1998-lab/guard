-- schema_v45.sql — retrofit of two objects that existed only in production
--
-- Both were created directly against the production database and never had
-- DDL in this repo. Unlike chat_rooms (retrofitted into schema_v13, which had
-- to go there because that file's own FK depended on it), neither of these is
-- referenced by any earlier schema file, so the migration chain replayed past
-- them without error and their absence was invisible until the 2026-08-04
-- drift audit. A fresh environment would have migrated "successfully" and
-- then failed at runtime.
--
-- 1) monthly_hours_reports — one generated hours report per company per
--    month. Written by jobs/monthlyHoursReport.ts, read by routes/billing.ts.
--
-- 2) sites.instructions_pdf_url — S3 key for a site's instructions PDF,
--    presigned on read by routes/sites.ts and routes/shifts.ts.
--
-- Definitions were read back out of production (information_schema,
-- pg_constraint, pg_indexes) and transcribed as-is. uuid_generate_v4() below
-- is deliberate and NOT modernised to gen_random_uuid(): the purpose of this
-- file is to describe production as it is, not as it should have been.
--
-- Idempotent: safe to re-run. migrate.ts replays every file on every deploy
-- against a production database where both objects already exist.

CREATE TABLE IF NOT EXISTS monthly_hours_reports (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id    UUID         NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  month         INTEGER      NOT NULL CHECK (month >= 1 AND month <= 12),
  year          INTEGER      NOT NULL,
  s3_url        TEXT         NOT NULL,
  generated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, month, year)
);

CREATE INDEX IF NOT EXISTS idx_monthly_hours_reports_company
  ON monthly_hours_reports (company_id, year DESC, month DESC);

ALTER TABLE sites ADD COLUMN IF NOT EXISTS instructions_pdf_url TEXT;
