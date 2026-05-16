-- schema_v14.sql — Item 8 (configurable ping cadence) + Item 7 prep
--                  (battery throttle telemetry column on location_pings)
--
-- Two ALTER TABLE adds, both metadata-only on existing rows:
--   - Postgres 11+ stores DEFAULT as catalog metadata for existing rows,
--     so adding a NOT NULL DEFAULT column does not rewrite the table.
--     Railway is PG 16. New INSERTs / UPDATEs evaluate the column
--     normally.
--
-- 1) sites.ping_interval_minutes — drives Item 8's per-site cadence.
--    Default 30 matches the prior hardcoded PING_INTERVAL_MS in
--    apps/mobile/app/active-shift/index.tsx, so existing sites behave
--    identically on deploy (no behavioural change for installed
--    fleets). The CHECK constraint pins the 5-240 min envelope at the
--    DB layer — belt to the route-handler validation's suspenders.
--
-- 2) location_pings.throttle_reason — set by Item 7's battery throttle
--    when the mobile dropped the cadence due to low battery or low-
--    power mode. NULL means "normal cadence — no throttle applied".
--    The CHECK enumerates the valid non-null values so future drift
--    (typos, new throttle reasons added without schema update) is
--    caught at INSERT time. Allowed: 'low_battery', 'low_power_mode'.
--    'low_power_mode' normalizes iOS "Low Power Mode" and Android
--    battery-saver into a single value — both surface via the same
--    expo-battery Battery.isLowPowerModeEnabledAsync() check, and the
--    DB doesn't need to track the platform separately.
--
-- Reversibility: this migration system has no down migrations (see
-- migrate.ts — runs each .sql file forward only, no tracking table,
-- no rollback hook). To reverse: either restore from backup, or write
-- a forward schema_vN.sql migration that ALTER TABLE DROP COLUMN
-- explicitly (destructive of any data already written to those
-- columns).
--
-- Idempotent: ADD COLUMN IF NOT EXISTS on each column. Safe to re-run.

ALTER TABLE sites
  ADD COLUMN IF NOT EXISTS ping_interval_minutes INTEGER NOT NULL DEFAULT 30
    CHECK (ping_interval_minutes BETWEEN 5 AND 240);

ALTER TABLE location_pings
  ADD COLUMN IF NOT EXISTS throttle_reason VARCHAR(50)
    CHECK (throttle_reason IS NULL OR throttle_reason IN ('low_battery', 'low_power_mode'));
