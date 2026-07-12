-- Schema v35 — Vishnu Portal v2 retention wiring
--
-- ① legal_hold_at TIMESTAMPTZ on the two tables that expose a "PLACE
--    ON HOLD" surface. Populated to NOW() on hold, cleared to NULL on
--    release. Powers the "HELD SINCE" column in the new
--    /vishnu/compliance LEGAL HOLDS section. Only these two tables get
--    the timestamp — cascade parents (shift_sessions, shifts,
--    location_pings, task_completions) keep the boolean `legal_hold`
--    only, since no UI surfaces "when" for them.
--
-- ② DROP NOT NULL on the retired retention field `delete_at` on
--    `reports` + `report_photos`. Session I / v33 replaced this signal
--    with the tiered `expires_at` + `legal_hold` scan in nightlyPurge.
--    No consumer reads `delete_at` any more, but writes still populate
--    it with `new Date(site.contract_end).setDate(+150)` — which
--    silently stamps 1970-05-31 on every insert whenever contract_end
--    is NULL. Drop NOT NULL so the code can stop writing it. Column
--    itself is preserved (contract-phase drop lands in a later
--    release cycle).
--
-- Expand-safe: additive columns are nullable; DROP NOT NULL is
-- permissive; no existing row is touched.

ALTER TABLE reports              ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;
ALTER TABLE geofence_violations  ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;

ALTER TABLE reports        ALTER COLUMN delete_at DROP NOT NULL;
ALTER TABLE report_photos  ALTER COLUMN delete_at DROP NOT NULL;
