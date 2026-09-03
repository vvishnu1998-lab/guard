-- schema_v66 — position_source becomes NOT NULL. CONTRACT half of v65.
--
-- ╔═══════════════════════════════════════════════════════════════════════╗
-- ║  APPLY ONLY AFTER EVERY WRITER SETS position_source, DEPLOYED.        ║
-- ║                                                                       ║
-- ║  v65 added the column NULLable, backfilled it and constrained its     ║
-- ║  vocabulary. This file removes the NULL. It must not run until the    ║
-- ║  API that names the column in every INSERT is the DEPLOYED commit —   ║
-- ║  not merely merged.                                                   ║
-- ║                                                                       ║
-- ║  WHAT THIS FILE CANNOT CHECK, STATED PLAINLY RATHER THAN IMPLIED:     ║
-- ║  the assertion below proves the DATA is complete. It cannot prove     ║
-- ║  that the deployed CODE fills the column on the next write — SQL has  ║
-- ║  no visibility into which commit Railway is running. That half is a   ║
-- ║  human check:                                                         ║
-- ║                                                                       ║
-- ║    1. the deployed commit contains the Phase 3 API change, AND        ║
-- ║    2. `grep -rn "INSERT INTO \(geofence_violations\|off_post_events\)" ║
-- ║       apps/api/src` shows position_source in EVERY one on that commit ║
-- ║                                                                       ║
-- ║  Getting this wrong does NOT merely reject a write. On                ║
-- ║  geofence_violations a 23502 surfaces as a 500 and the guard's breach ║
-- ║  goes unrecorded. On off_post_events it is worse and quieter:         ║
-- ║  services/offPostEvents.recordOffPostEvent NEVER THROWS BY CONTRACT,  ║
-- ║  so a 23502 there is SWALLOWED and off-post evidence simply stops     ║
-- ║  being written, with no error anywhere. Silent evidence loss, not a   ║
-- ║  loud failure.                                                        ║
-- ╚═══════════════════════════════════════════════════════════════════════╝
--
-- WHY THE BACKFILL IS REPEATED HERE
-- ---------------------------------
-- Rows written between v65 and this file carry NULL by definition: v65 made
-- the column nullable precisely so the then-deployed API could keep writing
-- without naming it. Those rows are real evidence and must be classified by
-- the same rules v65 used, not swept into a guess. The UPDATEs below are
-- byte-equivalent to v65 section 2 minus the two historical by-id rows,
-- which v65 already handled and which are gated IS NULL anyway.
--
-- The rules, restated so this file stands alone:
--   geofence_violations  every gap row came from routes/locations.ts (the
--                        background task, which posts the fence centre) or
--                        routes/reports.ts (off-post incident, device fix).
--                        They are indistinguishable after the fact, so the
--                        catch-all is 'site' — the conservative reading:
--                        'site' means "do not render this as a position",
--                        and mislabelling a real fix as unrenderable loses
--                        detail, whereas the reverse invents a location.
--   off_post_events      source is authoritative and survives the gap:
--                        ping_reject / incident_break -> device -> foreground
--                        break_exit                   -> centre -> site
--
-- REPLAY
-- ------
-- Idempotent: backfills gated on IS NULL, and Postgres accepts SET NOT NULL
-- on a column that already has it. From an empty database every UPDATE
-- matches zero rows, the assertion sees zero NULLs, and the NOT NULL applies
-- to an empty table.
--
-- NOT IN migrate.ts YET. Appending it is the last step of the rollout, once
-- the writers are deployed and this file has been applied. Until then a
-- chain-from-empty produces a NULLable column while prod has NOT NULL —
-- a known, temporary divergence, deliberately preferred to wiring a contract
-- step that would run against an unprepared database on any replay.

SET LOCAL lock_timeout = '3s';

-- ── 1. BACKFILL the gap rows — gated, idempotent ────────────────────────
UPDATE off_post_events SET position_source = 'foreground'
 WHERE source IN ('ping_reject', 'incident_break') AND position_source IS NULL;

UPDATE off_post_events SET position_source = 'site'
 WHERE source = 'break_exit' AND position_source IS NULL;

UPDATE geofence_violations SET position_source = 'site'
 WHERE position_source IS NULL;

-- ── 2. ASSERT — abort rather than let SET NOT NULL decide ───────────────
-- SET NOT NULL would raise on a leftover NULL, but it names only the column.
-- This names the table, the count and the unmapped source, which is what
-- tells you whether a new off_post_events.source value appeared that the
-- rules above do not map. Ordering is load-bearing: it runs BEFORE the
-- contract, so an abort leaves the column nullable and the API writing.
DO $$
DECLARE gv_nulls BIGINT; ope_nulls BIGINT; bad_src TEXT;
BEGIN
  SELECT count(*) INTO gv_nulls  FROM geofence_violations WHERE position_source IS NULL;
  SELECT count(*) INTO ope_nulls FROM off_post_events     WHERE position_source IS NULL;

  IF gv_nulls > 0 OR ope_nulls > 0 THEN
    SELECT string_agg(DISTINCT source, ', ') INTO bad_src
      FROM off_post_events WHERE position_source IS NULL;
    RAISE EXCEPTION
      'schema_v66 REFUSING TO RUN: % geofence_violations and % off_post_events row(s) '
      'still have a NULL position_source after backfill. Unmapped off_post_events '
      'source value(s): %. Add a rule for them rather than widening the catch-all — '
      'guessing a provenance is exactly what this column exists to prevent.',
      gv_nulls, ope_nulls, COALESCE(bad_src, 'none');
  END IF;

  RAISE NOTICE 'schema_v66 pre-flight OK: 0 NULL position_source on both tables.';
END $$;

-- ── 3. CONTRACT ─────────────────────────────────────────────────────────
ALTER TABLE geofence_violations ALTER COLUMN position_source SET NOT NULL;
ALTER TABLE off_post_events     ALTER COLUMN position_source SET NOT NULL;

DO $$
BEGIN
  RAISE NOTICE 'schema_v66: position_source is NOT NULL on both tables. Every writer must now name it.';
END $$;
