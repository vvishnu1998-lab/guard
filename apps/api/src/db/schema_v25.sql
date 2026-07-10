-- Schema v25 — Indexes for admin violations history filters
--
-- /admin/live-status "RECENT BREACHES" gains site + guard + date-range
-- filters (see apps/web/app/admin/live-status/page.tsx). The backing query
-- now filters by company (via s.company_id join), optionally by site_id
-- and/or guard_id, and always ORDERs by occurred_at DESC.
--
-- Prod row count today is ~3; these indexes are a scale hedge, not a
-- current hot-path optimisation. The partial index on open breaches
-- covers the "status=open" chip which is the most common filter combo.
--
-- Non-concurrent build: migrate.ts wraps its multi-statement queries in
-- an implicit transaction, and CREATE INDEX CONCURRENTLY refuses to run
-- inside one. At current row counts (~3) the resulting ACCESS EXCLUSIVE
-- lock lasts milliseconds. If this table grows large before the next
-- migration lands, split these two CREATEs into a separate one-statement
-- file to enable CONCURRENTLY at that point.

CREATE INDEX IF NOT EXISTS idx_gv_site_occurred
  ON geofence_violations (site_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_gv_open_by_site
  ON geofence_violations (site_id, occurred_at DESC)
  WHERE resolved_at IS NULL;
