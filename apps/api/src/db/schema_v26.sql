-- Schema v26 — Per-company badge_number uniqueness
--
-- Badges are moving from admin-typed free-form strings to server-generated
-- GRD#### sequences that are scoped PER COMPANY. The existing table-level
-- UNIQUE (badge_number) constraint (guards_badge_number_key) enforces
-- global uniqueness across every tenant, which conflicts with the new
-- scheme — Starnet's GRD0001 would collide with any other company's
-- GRD0001.
--
-- Pre-flight probe (2026-07-10):
--   SELECT company_id, badge_number, COUNT(*) FROM guards GROUP BY 1,2
--   HAVING COUNT(*) > 1;  ⇒  0 rows.
-- So swapping the constraint is safe — no existing pair collides.
--
-- Grandfathered rows keep their current badge (grd01, 002, grd041, etc.).
-- The server-side generator ignores any badge that doesn't match
-- ^GRD\d{4}$ when computing the next sequence number, so the mixed set
-- stays valid.
--
-- Also grep'd every WHERE / JOIN / auth lookup in apps/api/src +
-- apps/mobile: badge_number is only ever SELECTed as a display column;
-- nothing keys off it. Dropping the global uniqueness has zero read-path
-- impact.
--
-- No CONCURRENTLY: adds are idempotent via IF NOT EXISTS / IF EXISTS and
-- migrate.ts runs multi-statement queries in an implicit transaction.
-- Guard-count today is small enough that the ACCESS EXCLUSIVE window on
-- both ALTERs is milliseconds; safe to run in-line with a code deploy.

ALTER TABLE guards DROP CONSTRAINT IF EXISTS guards_badge_number_key;

-- ADD CONSTRAINT has no IF NOT EXISTS in Postgres; guard it manually so
-- migrate.ts can re-run the full schema set idempotently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_guard_badge_per_company'
  ) THEN
    ALTER TABLE guards
      ADD CONSTRAINT uq_guard_badge_per_company UNIQUE (company_id, badge_number);
  END IF;
END
$$;
