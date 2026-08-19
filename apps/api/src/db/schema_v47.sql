-- schema_v47 — site-level feature toggles (vehicle inspection + checkpoints)
--
-- checkpoints_enabled DEFAULTs TRUE: checkpoints are LIVE at 23000 Cristo
-- Rey (STARNET, site fea19254-6d65-4fbb-9f17-022081cf3472, 5 checkpoint
-- rows) with no toggle today. A TRUE default preserves current behaviour
-- for every existing site — no site with site_checkpoints rows can come
-- out FALSE — and matches the mobile fail-safe (absent flag ⇒ true).
-- NOT NULL + DEFAULT backfills existing rows in the same statement, so no
-- separate UPDATE is needed.
ALTER TABLE sites ADD COLUMN IF NOT EXISTS checkpoints_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- vehicle_inspection_required is opt-in per site (no site does vehicle
-- inspections until an admin turns it on).
ALTER TABLE sites ADD COLUMN IF NOT EXISTS vehicle_inspection_required BOOLEAN NOT NULL DEFAULT FALSE;
