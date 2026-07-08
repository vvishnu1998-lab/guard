-- ============================================================
-- schema_v21 — Per-site timezone column
-- ============================================================
-- Expand step of an expand-then-extend rollout. The code that will
-- start reading this column ships in a follow-up commit; this file
-- is safe to run against prod first because every existing SELECT
-- ignores the new column and the DEFAULT covers every INSERT.
--
-- Motivation: apps/api/src/services/email.ts fmtDTPacific() and
-- several other date-rendering / date-math sites are hardcoded to
-- America/Los_Angeles. That blocks onboarding any non-Pacific
-- tenant. All 8 currently-active sites are in Pacific, so the
-- DEFAULT keeps behavior byte-identical on this migration.
--
-- Phase 3 (deferred) will drop the DEFAULT after a data-audit pass
-- confirms every row has been explicitly set.
-- ============================================================

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL
    DEFAULT 'America/Los_Angeles';

-- Static shape gate — belt+braces on top of the runtime validation
-- Postgres does when the value hits AT TIME ZONE. Catches operator
-- typos ("America/Los Angeles" with a space, trailing whitespace,
-- lower-case "america/…") at INSERT/UPDATE time instead of at the
-- point of first use.
--
-- Regex intentionally permissive within the shape:
--   * First segment starts with A-Z (all IANA zones do), then
--     letters or underscores.
--   * Optional additional slash-separated segments allowing digits
--     and +/- (covers Etc/GMT+5 style if we ever need it).
-- 'UTC' is called out explicitly since it fails the first-char/no-
-- slash shape.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sites_timezone_shape'
  ) THEN
    ALTER TABLE sites
      ADD CONSTRAINT sites_timezone_shape
        CHECK (timezone ~ '^[A-Z][A-Za-z_]+(/[A-Za-z_0-9+-]+)*$'
               OR timezone = 'UTC');
  END IF;
END $$;
