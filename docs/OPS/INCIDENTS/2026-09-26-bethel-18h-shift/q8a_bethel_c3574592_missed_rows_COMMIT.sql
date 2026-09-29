-- =============================================================================
-- Decision 8-a: delete overnight missed rows, Bethel AME Church, STARNET
-- DRAFT. NOT EXECUTED. The final statement is ROLLBACK (preview).
--
-- This file is Tier 2: a prod DB write outside a migration that touches
-- STARNET data directly.
-- Run it ONLY AFTER q11_bethel_c3574592_correction_COMMIT.sql has committed.
-- The precondition block refuses otherwise.
--
-- Run (no -1; this file opens its own transaction):
--   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f q8a_bethel_c3574592_missed_rows.sql
--
-- Scope: session cc1cf358-5c26-4f6a-9618-d716bacdda6c ONLY.
--   DELETE missed_pings   WHERE window_start >= 2026-09-25 18:00 PT   (expect 24)
--   DELETE missed_reports WHERE window_start >= 2026-09-25 18:00 PT   (expect 12)
--   KEEP   missed_pings   12:30 .. 17:30 PT                           (expect 11)
--   KEEP   missed_reports 16:00 PT                                    (expect 1)
-- Anchor: 2026-09-25 18:00:00 America/Los_Angeles = 2026-09-26 01:00:00+00
--
-- Column names were resolved from pg_attribute, not assumed.
-- Both tables have: id, shift_session_id, site_id, guard_id, window_start,
-- window_end, window_label, missed_at, resolved_at, expires_at.
-- missed_pings adds resolved_by_ping_id; missed_reports adds
-- resolved_by_report_id. Neither has legal_hold or a photo/S3 column.
--
-- Probe results as of 2026-09-26 ~07:00 PT, re-asserted below at run time:
--   - No FK references missed_pings or missed_reports (pg_constraint
--     confrelid: 0 rows), so the delete cannot cascade.
--   - Outgoing FKs are guards, sites, shift_sessions (ON DELETE CASCADE, from
--     the parent side) and location_pings / reports (ON DELETE SET NULL, from
--     the parent side). A delete of the child rows cannot fire any of them.
--   - Triggers: only internal RI triggers (AFTER INSERT/UPDATE). None fires
--     on DELETE, and there are no user triggers.
--   - Soft pointers: 24 'missed_ping' notifications carry data.missedPingId,
--     and 12 'missed_report' notifications carry data.missedReportId, for
--     exactly the rows deleted here. They are NOT orphaned objects:
--     * Guard feed scope admits these types only while their session is
--       open (routes/notifications.ts:96-100). This session is closed.
--     * The auto-erase arms (notifications.ts:178-184, :215-221) test
--       EXISTS(... resolved_at IS NOT NULL). That is false for an unresolved
--       row and false for a missing row, so their result does not change.
--     * No mobile or web code reads either key (git grep: origin/main
--       apps/mobile + apps/web, and 9b05775 apps/mobile: 0 hits).
--   - Re-insert risk after the delete: none. missedPingCron.ts:106-108 and
--     missedReportCron.ts:147-149 scan only open sessions or sessions closed
--     within 15 minutes. After Q11, clocked_out_at is 2026-09-25 18:00 PT,
--     and windows are bounded by the corrected scheduled_end
--     (pingWindows.ts:215, missedReportCron.ts:95).
-- =============================================================================

\set ON_ERROR_STOP 1
\pset pager off

BEGIN;
SET LOCAL lock_timeout = '3s';

-- 0. Prove SET LOCAL took effect.
DO $$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION 'lock_timeout=% (expected 3s): SET LOCAL did not apply', current_setting('lock_timeout');
  END IF;
END $$;

-- 1. Re-assert the structural probes. A schema change since the audit
--    should fail here, not surprise the DELETE.
DO $$
DECLARE n int;
BEGIN
  -- No FK may reference either table (cascade / orphan guard)
  SELECT count(*) INTO n FROM pg_constraint
   WHERE contype = 'f'
     AND confrelid IN ('public.missed_pings'::regclass, 'public.missed_reports'::regclass);
  IF n <> 0 THEN RAISE EXCEPTION 'probe: % FK(s) now reference missed_pings/missed_reports; STOP and re-audit', n; END IF;

  -- No user (non-internal) trigger on either table
  SELECT count(*) INTO n FROM pg_trigger
   WHERE NOT tgisinternal
     AND tgrelid IN ('public.missed_pings'::regclass, 'public.missed_reports'::regclass);
  IF n <> 0 THEN RAISE EXCEPTION 'probe: % user trigger(s) on missed tables; STOP and re-audit', n; END IF;

  -- The window column exists under the name this file uses, and there is
  -- no hold column
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid IN ('public.missed_pings'::regclass, 'public.missed_reports'::regclass)
     AND attname = 'window_start' AND NOT attisdropped;
  IF n <> 2 THEN RAISE EXCEPTION 'probe: window_start missing on one of the tables (found %)', n; END IF;
  SELECT count(*) INTO n FROM pg_attribute
   WHERE attrelid IN ('public.missed_pings'::regclass, 'public.missed_reports'::regclass)
     AND attname IN ('legal_hold', 'legal_hold_at') AND NOT attisdropped;
  IF n <> 0 THEN RAISE EXCEPTION 'probe: missed tables now carry a legal_hold column; STOP and re-audit'; END IF;
END $$;

-- 2. Precondition: Q11 has COMMITTED. Parent rows are locked FOR SHARE so
--    they cannot change underneath this transaction. FOR SHARE does not
--    block FK KEY SHARE locks, so live inserts elsewhere are not stalled.
DO $$
DECLARE
  anchor constant timestamptz := '2026-09-25 18:00:00-07';
  n  int;
  sh record;
  ss record;
BEGIN
  SELECT * INTO sh FROM shifts WHERE id = 'c3574592-3a97-4fe0-a190-bd5f3b435018' FOR SHARE;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'shift rows = %, expected 1', n; END IF;

  SELECT * INTO ss FROM shift_sessions WHERE id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c' FOR SHARE;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'session rows = %, expected 1', n; END IF;

  IF ss.shift_id <> sh.id THEN RAISE EXCEPTION 'session does not belong to the shift'; END IF;

  IF sh.scheduled_end <> anchor THEN
    RAISE EXCEPTION 'precondition: shift scheduled_end is % (expected 2026-09-25 18:00 PT); Q11 has not committed', sh.scheduled_end;
  END IF;
  IF ss.clock_out_reason IS DISTINCT FROM 'admin_corrected' THEN
    RAISE EXCEPTION 'precondition: clock_out_reason is % (expected admin_corrected); Q11 has not committed', ss.clock_out_reason;
  END IF;
  -- These follow from Q11 too; checked so a partial state cannot pass.
  IF ss.clocked_out_at IS DISTINCT FROM anchor OR sh.status <> 'completed' THEN
    RAISE EXCEPTION 'precondition: session/shift not in Q11 end state (clocked_out_at=%, status=%)', ss.clocked_out_at, sh.status;
  END IF;
  -- Hold guard: the missed tables have no hold column, so check the parents.
  IF ss.legal_hold OR sh.legal_hold THEN
    RAISE EXCEPTION 'legal hold on session or shift; refusing to delete';
  END IF;
  RAISE NOTICE 'precondition OK: Q11 committed (end=%, reason=%)', sh.scheduled_end, ss.clock_out_reason;
END $$;

-- 3. BEFORE
\echo '==== BEFORE: counts by side of the 18:00 PT anchor ===='
SELECT 'missed_pings' AS tbl,
       count(*) FILTER (WHERE window_start <  '2026-09-25 18:00:00-07') AS in_shift_keep,
       count(*) FILTER (WHERE window_start >= '2026-09-25 18:00:00-07') AS overnight_delete,
       count(*) FILTER (WHERE resolved_at IS NOT NULL) AS resolved
  FROM missed_pings WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
UNION ALL
SELECT 'missed_reports',
       count(*) FILTER (WHERE window_start <  '2026-09-25 18:00:00-07'),
       count(*) FILTER (WHERE window_start >= '2026-09-25 18:00:00-07'),
       count(*) FILTER (WHERE resolved_at IS NOT NULL)
  FROM missed_reports WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';
\echo '==== BEFORE: rows to delete ===='
SELECT 'missed_pings' AS tbl, id, window_label,
       to_char(window_start AT TIME ZONE 'America/Los_Angeles', 'MM-DD HH24:MI') AS ws_pt,
       resolved_at
  FROM missed_pings
 WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
   AND window_start >= '2026-09-25 18:00:00-07'
UNION ALL
SELECT 'missed_reports', id, window_label,
       to_char(window_start AT TIME ZONE 'America/Los_Angeles', 'MM-DD HH24:MI'),
       resolved_at
  FROM missed_reports
 WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
   AND window_start >= '2026-09-25 18:00:00-07'
 ORDER BY 1, 4;

-- 4. The delete, with exact-count assertions on both sides of the anchor
DO $$
DECLARE
  anchor constant timestamptz := '2026-09-25 18:00:00-07';
  n int;
BEGIN
  -- Pre-delete: the exact audited population, all unresolved
  SELECT count(*) INTO n FROM missed_pings
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c' AND window_start >= anchor;
  IF n <> 24 THEN RAISE EXCEPTION 'pre: overnight missed_pings = %, expected 24', n; END IF;
  SELECT count(*) INTO n FROM missed_reports
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c' AND window_start >= anchor;
  IF n <> 12 THEN RAISE EXCEPTION 'pre: overnight missed_reports = %, expected 12', n; END IF;
  SELECT count(*) INTO n FROM missed_pings
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c' AND window_start >= anchor AND resolved_at IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'pre: % overnight missed_pings are RESOLVED (resolved_by_ping_id set); state changed since audit', n; END IF;
  SELECT count(*) INTO n FROM missed_reports
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c' AND window_start >= anchor AND resolved_at IS NOT NULL;
  IF n <> 0 THEN RAISE EXCEPTION 'pre: % overnight missed_reports are RESOLVED; state changed since audit', n; END IF;

  DELETE FROM missed_pings
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
     AND window_start >= anchor;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 24 THEN RAISE EXCEPTION 'missed_pings deleted = %, expected exactly 24', n; END IF;

  DELETE FROM missed_reports
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
     AND window_start >= anchor;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 12 THEN RAISE EXCEPTION 'missed_reports deleted = %, expected exactly 12', n; END IF;

  -- Post-delete: the in-shift rows survive, exactly
  SELECT count(*) INTO n FROM missed_pings
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';
  IF n <> 11 THEN RAISE EXCEPTION 'post: missed_pings remaining = %, expected 11', n; END IF;
  SELECT count(*) INTO n FROM missed_pings
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
     AND window_start >= '2026-09-25 12:30:00-07' AND window_start <= '2026-09-25 17:30:00-07';
  IF n <> 11 THEN RAISE EXCEPTION 'post: the 11 survivors are not exactly the 12:30..17:30 windows (%)', n; END IF;

  SELECT count(*) INTO n FROM missed_reports
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';
  IF n <> 1 THEN RAISE EXCEPTION 'post: missed_reports remaining = %, expected 1', n; END IF;
  SELECT count(*) INTO n FROM missed_reports
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
     AND window_start = '2026-09-25 16:00:00-07';
  IF n <> 1 THEN RAISE EXCEPTION 'post: the surviving missed_report is not the 16:00 PT window'; END IF;

  RAISE NOTICE 'deleted 24 missed_pings + 12 missed_reports; 11 + 1 in-shift rows intact';
END $$;

-- 5. AFTER
\echo '==== AFTER: surviving rows ===='
SELECT 'missed_pings' AS tbl, id, window_label,
       to_char(window_start AT TIME ZONE 'America/Los_Angeles', 'MM-DD HH24:MI') AS ws_pt
  FROM missed_pings WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
UNION ALL
SELECT 'missed_reports', id, window_label,
       to_char(window_start AT TIME ZONE 'America/Los_Angeles', 'MM-DD HH24:MI')
  FROM missed_reports WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
 ORDER BY 1, 4;
\echo '==== AFTER: soft pointers left dangling (informational; inert per header) ===='
SELECT n.type, count(*) AS notif_rows_pointing_at_deleted_row
  FROM notifications n
 WHERE n.shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
   AND (   (n.type = 'missed_ping'   AND NOT EXISTS (SELECT 1 FROM missed_pings   mp WHERE mp.id::text = n.data->>'missedPingId'))
        OR (n.type = 'missed_report' AND NOT EXISTS (SELECT 1 FROM missed_reports mr WHERE mr.id::text = n.data->>'missedReportId')))
 GROUP BY n.type ORDER BY 1;

COMMIT;
