-- schema_v11.sql — D2 / audit/WEEK1.md §D2.
--
-- Forensics trail for upload attempts that failed magic-byte validation.
-- Populated by POST /api/reports when a photo URL points at a real S3
-- object whose first bytes don't match its declared Content-Type.
--
-- The S3 object itself is left in place (it will be deleted by the
-- bucket's 180-day lifecycle) — this table records WHO uploaded WHAT
-- and WHY it was rejected, so we can spot abuse patterns without
-- combing CloudTrail.
--
-- Idempotent: safe to re-run.

CREATE TABLE IF NOT EXISTS quarantined_uploads (
  id                    UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  s3_key                TEXT        NOT NULL,           -- the object key inside the bucket
  declared_content_type TEXT        NOT NULL,           -- what the client said it was (mirror of the presigned policy)
  detected_magic        TEXT        NOT NULL,           -- describeMagic() output: 'image/jpeg' / 'zip' / 'hex:00112233' …
  guard_id              UUID                NULL REFERENCES guards(id)        ON DELETE SET NULL,
  company_id            UUID                NULL REFERENCES companies(id)     ON DELETE SET NULL,
  shift_session_id      UUID                NULL REFERENCES shift_sessions(id) ON DELETE SET NULL,
  detected_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Useful for "show me everything that guard X has tried to slip past"
CREATE INDEX IF NOT EXISTS idx_quarantined_uploads_guard ON quarantined_uploads (guard_id, detected_at DESC);

-- Useful for "show me the last week of attempts across the whole tenant"
CREATE INDEX IF NOT EXISTS idx_quarantined_uploads_company_time ON quarantined_uploads (company_id, detected_at DESC);
