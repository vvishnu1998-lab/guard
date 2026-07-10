-- Schema v30 — reports (site_id, reported_at DESC) index
--
-- Every client-portal reports fetch runs:
--   WHERE r.site_id = $1 ORDER BY r.reported_at DESC LIMIT 200
-- The client PDF export runs the same shape with a wider LIMIT (500).
-- Admin analytics also filters + orders on the same pair.
--
-- Prod today has a few hundred reports total across all sites, so the
-- current seq-scan is fine. The index is a scale hedge — once a busy
-- site's report table crosses ~50k rows this becomes the difference
-- between a millisecond and a full-table sort.

CREATE INDEX IF NOT EXISTS idx_reports_site_reported_at
  ON reports (site_id, reported_at DESC);
