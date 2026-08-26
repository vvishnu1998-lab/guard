-- schema_v60 — companies.is_test, so exports can exclude non-customer tenants.
--
-- NUMBERING NOTE: v59 (swap halfway-reminder claim) is the highest entry in
-- migrate.ts and the highest file on disk; both were re-read at HEAD 0d7500e
-- immediately before writing this, and a drift check found no .sql on disk
-- missing from the chain. v60 is free. Read off migrate.ts at HEAD, never
-- from a brief — this chain has recorded collisions (v46 -> v50, v51 -> v52,
-- v54 taken overnight, and v58/v59 both landed while a brief still said v58
-- was next).
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through
-- piped psql is a silent no-op in autocommit (learned applying v54).
SET LOCAL lock_timeout = '3s';

-- ── Why this column exists ───────────────────────────────────────────────
--
-- Four tenants exist and only two are customers:
--
--   b7c7d32d  Star Guard         8 sites, 52 sessions   REAL
--   27c4d404  STARNET SECURITY   3 sites, 25 sessions   REAL (paying)
--   1bba063e  starnet            1 site,   0 sessions   stale duplicate
--   7637ef73  test company       0 sites,  0 sessions   scratch tenant
--
-- Nothing distinguished them. companies carried only id, name,
-- default_photo_limit, is_active, created_at — and all four are is_active,
-- because is_active means "not decommissioned", not "is a customer". So
-- jobs/monthlyHoursReport.ts, which iterates WHERE is_active = true,
-- generated and uploaded an empty XLSX to guard-media-prod for both junk
-- tenants every month. Both already have a monthly_hours_reports row.
--
-- The two rejected alternatives, recorded so they are not re-proposed:
--
--   * A hardcoded allowlist of the two real company ids. No migration, but
--     it puts tenant identity in source and fails silently and invisibly on
--     the day a third real customer signs — the failure mode is a missing
--     customer, which is worse than a spurious empty file.
--   * A heuristic (zero sessions, or a name matching /test/i). "test
--     company" has zero sessions today and so does every customer on the
--     morning they sign.
--
-- ── Deliberately NOT backfilled here ─────────────────────────────────────
--
-- The DDL is idempotent and replays on every deploy; a backfill inside it
-- would re-assert those two rows forever, so flipping one back to false by
-- hand would silently revert on the next push. Marking a tenant as test is
-- an operational decision with an operational lifetime, not a schema fact.
--
-- The backfill is therefore a separate, gated one-off write: a pre-verify
-- SELECT proving exactly two rows match, then an UPDATE in one explicit
-- transaction expecting `UPDATE 2`. Same shape as the 0633b82b correction.
--
-- DEFAULT false is the safe direction: a tenant added after this migration
-- is a customer until somebody says otherwise, so the failure mode of
-- forgetting to set the flag is a spurious empty file, never a missing
-- customer.

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT false;

-- Exports and the monthly cron filter on this on every run, and the table is
-- tiny, so the index is about intent rather than speed: it documents that
-- `WHERE is_test = false` is the expected access path.
CREATE INDEX IF NOT EXISTS idx_companies_real
  ON companies (id) WHERE is_test = false;

COMMENT ON COLUMN companies.is_test IS
  'True for scratch/duplicate tenants that must be excluded from customer-facing exports and the monthly hours cron. Not the same as is_active, which means "not decommissioned".';
