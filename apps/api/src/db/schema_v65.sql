-- schema_v65 — position_source on geofence_violations and off_post_events
--
-- WHY
-- ---
-- The admin live map (3769baf) draws a red ring at geofence_violations
-- .violation_lat/lng and presents it as "where the guard was". It is not.
-- Since Build 34 the mobile background task is native OS region monitoring
-- (Location.startGeofencingAsync), and its Exit handler POSTs
-- region.latitude/region.longitude — THE FENCE CENTRE the app registered,
-- echoed back by the OS. The task never calls getCurrentPositionAsync. The
-- map has therefore been drawing the centre of the post as the guard's
-- position at the moment they left it.
--
-- Build 49 will start sending the device's real position on Exit. The
-- server must be able to tell the two apart from the first row of the new
-- build, so this column exists BEFORE that build ships, not after.
--
-- 'site'       the coordinate IS the fence centre; it locates the post,
--              not the guard. Do not render it as a position.
-- 'background' a real device fix taken by a background/headless task.
-- 'foreground' a real device fix taken while the app was in use (a ping,
--              an incident report).
--
--
-- WHAT THE EXISTING ROWS ACTUALLY ARE (measured against prod 2026-09-03)
-- ---------------------------------------------------------------------
-- geofence_violations, 34 rows. 32 are coordinate-identical to their
-- site's site_geofence centre. The other TWO are real device positions,
-- and the reason matters because it is not only history:
--
--   7e772bd8-90b9-4e92-b836-5159ea082760  2026-07-13 01:44:16Z
--     463.6 m off centre, carries a photo_url so it came from
--     routes/locations.ts. Dated before Build 34, when the task was
--     periodic Location.startLocationUpdatesAsync and posted the DEVICE's
--     position. Backfilled 'background'.
--
--   bea80874-0c44-47d5-8482-e92736f7c9fa  2026-07-13 05:15:34Z
--     123.8 m off centre, coordinate-identical to incident report
--     d57b1119-155c-42ca-8fe0-f92688132e5f filed 15 ms earlier. Written by
--     routes/reports.ts:739, the off-post incident path. Backfilled
--     'foreground'.
--
-- THAT SECOND WRITER IS LIVE CODE, NOT LEGACY. geofence_violations has two
-- INSERT sites — routes/locations.ts:731 and routes/reports.ts:739 — and
-- the reports one binds the guard's own latitude/longitude. Any scheme that
-- assumed "every violation coordinate is the fence centre" would mislabel
-- every future off-post incident report. It is why this column has no
-- DEFAULT: see below.
--
-- off_post_events, 3 rows, ALL THREE real device positions, all off centre,
-- all source='ping_reject' (coordinates come from the rejected ping body).
-- Backfilled 'foreground'. The type admits two more sources that no row has
-- reached yet but currently-deployed code can write at any moment:
--   break_exit      written from the /violation body -> centre -> 'site'
--   incident_break  written from the report body    -> device -> 'foreground'
-- Both are backfilled here even though they match zero rows today, because
-- a row landing between this file being written and being applied must not
-- abort the assertion below.
--
--
-- NO DEFAULT, DELIBERATELY
-- ------------------------
-- Nullable -> backfill -> SET NOT NULL, and no DEFAULT ever. A DEFAULT is
-- what turns a forgotten writer into silently wrong evidence; without one,
-- a writer that forgets the column fails loudly with 23502 instead of
-- stamping a device position as 'site'. Every INSERT site must name it.
--
-- SPLIT EXPAND / CONTRACT — THIS FILE IS THE EXPAND HALF ONLY
-- ----------------------------------------------------------
-- The column stays NULLABLE here. The two SET NOT NULL statements live in
-- schema_v66.sql and are applied only after the writers are deployed.
--
-- The reason is not stylistic. A NOT NULL landing ahead of the writers
-- breaks every write path:
--   * POST /api/locations/violation      -> 23502, 500 to the handset, the
--                                           guard's breach is not recorded
--   * routes/reports.ts off-post incident -> 23502 inside its SAVEPOINT;
--                                           report survives, violation lost
--   * services/offPostEvents.recordOffPostEvent -> 23502, and that function
--                                           NEVER THROWS BY CONTRACT, so the
--                                           failure is SWALLOWED and off-post
--                                           evidence silently stops recording
-- That last one is why the split is not optional: on off_post_events a
-- premature NOT NULL fails QUIETLY, which is the opposite of the property
-- the no-DEFAULT design was chosen for.
--
-- As written, this file is safe against the currently-deployed API. Every
-- existing INSERT omits position_source, the column accepts NULL, and the
-- CHECK below passes on NULL (SQL CHECK treats an UNKNOWN result as
-- satisfied). Nothing that runs today changes behaviour.
--
-- v66 re-runs this file's backfill first — gated and idempotent — because
-- rows written between the two applies carry NULL by definition.
--
--
-- REPLAY
-- ------
-- migrate.ts replays the entire chain every run, so every statement here is
-- idempotent: ADD COLUMN IF NOT EXISTS, backfills gated on IS NULL, and
-- constraints guarded by a pg_constraint lookup. From an empty database
-- every backfill matches zero rows and the report emits its zero-NULL
-- notice.
--
-- Unrelated but load-bearing for anyone reading the chain: commit 777f273's
-- subject says schema_v64 is "(NOT APPLIED)". That was true when written and
-- is FALSE now — v64 was applied to prod on 2026-09-03. guards.fcm_token,
-- trg_guard_devices_sync_mirror and guard_devices_sync_mirror() are all gone
-- from production. Do not re-apply v64 expecting it to be pending.

SET LOCAL lock_timeout = '3s';

-- ── 1. EXPAND — nullable, no default ────────────────────────────────────
ALTER TABLE geofence_violations ADD COLUMN IF NOT EXISTS position_source TEXT;
ALTER TABLE off_post_events     ADD COLUMN IF NOT EXISTS position_source TEXT;

-- ── 2. BACKFILL — every UPDATE gated on IS NULL so a replay is a no-op ──
UPDATE geofence_violations SET position_source = 'background'
 WHERE id = '7e772bd8-90b9-4e92-b836-5159ea082760' AND position_source IS NULL;

UPDATE geofence_violations SET position_source = 'foreground'
 WHERE id = 'bea80874-0c44-47d5-8482-e92736f7c9fa' AND position_source IS NULL;

-- Everything else is centre-identical. Runs last so the two rows above keep
-- the value they were just given.
UPDATE geofence_violations SET position_source = 'site'
 WHERE position_source IS NULL;

UPDATE off_post_events SET position_source = 'foreground'
 WHERE source IN ('ping_reject', 'incident_break') AND position_source IS NULL;

UPDATE off_post_events SET position_source = 'site'
 WHERE source = 'break_exit' AND position_source IS NULL;

-- ── 3. REPORT — visibility only; NOT an abort ──────────────────────────
-- With a nullable column a leftover NULL is not an error, so this reports
-- rather than raises. The abort lives in v66, where NULLs actually matter.
DO $$
DECLARE gv_nulls BIGINT; ope_nulls BIGINT; bad_src TEXT;
BEGIN
  SELECT count(*) INTO gv_nulls  FROM geofence_violations WHERE position_source IS NULL;
  SELECT count(*) INTO ope_nulls FROM off_post_events     WHERE position_source IS NULL;
  SELECT string_agg(DISTINCT source, ', ') INTO bad_src
    FROM off_post_events WHERE position_source IS NULL;

  IF gv_nulls > 0 OR ope_nulls > 0 THEN
    RAISE NOTICE 'schema_v65: % geofence_violations and % off_post_events row(s) left NULL '
                 '(unmapped off_post_events source(s): %). Expected only for rows written '
                 'after this backfill ran; v66 will map them before it contracts.',
                 gv_nulls, ope_nulls, COALESCE(bad_src, 'none');
  ELSE
    RAISE NOTICE 'schema_v65 backfill OK: 0 NULL position_source on both tables.';
  END IF;
END $$;

-- ── 4. CHECK constraints — guarded, ADD CONSTRAINT is not idempotent ────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_gv_position_source') THEN
    ALTER TABLE geofence_violations
      ADD CONSTRAINT chk_gv_position_source
      CHECK (position_source IN ('site', 'background', 'foreground'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_ope_position_source') THEN
    ALTER TABLE off_post_events
      ADD CONSTRAINT chk_ope_position_source
      CHECK (position_source IN ('site', 'background', 'foreground'));
  END IF;
END $$;

COMMENT ON COLUMN geofence_violations.position_source IS
  'Provenance of violation_lat/lng. ''site'' = the fence centre, echoed back by the OS region monitor — it locates the post, NOT the guard, and must never be rendered as a position. ''background'' = a real device fix from a headless task. ''foreground'' = a real device fix taken with the app in use (routes/reports.ts off-post incident path). No DEFAULT on purpose: every writer names it. NULLable in v65 (expand); schema_v66 adds NOT NULL once the writers are deployed, after which a writer that forgets fails 23502 rather than mislabelling evidence.';

COMMENT ON COLUMN off_post_events.position_source IS
  'Provenance of lat/lng, same vocabulary as geofence_violations.position_source. source=''ping_reject''/''incident_break'' carry a real device fix; source=''break_exit'' carries the fence centre because it is written from the /violation body.';
