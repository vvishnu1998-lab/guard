-- =============================================================================
-- Q11 — decision 1-a correction, Bethel AME Church, STARNET SECURITY
-- DRAFT. NOT EXECUTED. Final statement is ROLLBACK (preview).
--
-- Switch the last line to COMMIT only after approval (Tier 2: prod DB write
-- outside a migration, touching STARNET data directly).
--
-- Run (no -1 — this file opens its own transaction):
--   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f q11_bethel_c3574592_correction.sql
--
-- Targets, by uuid literal only (from Q1):
--   shift   c3574592-3a97-4fe0-a190-bd5f3b435018
--   session cc1cf358-5c26-4f6a-9618-d716bacdda6c
-- Anchor: 2026-09-25 18:00:00 America/Los_Angeles = 2026-09-26 01:00:00+00
--
-- Accepts BOTH starting states:
--   (a) session still open: clocked_out_at NULL, reason NULL, shift 'active'
--   (b) already swept by autoCompleteShifts: reason 'auto', shift
--       'completed'. The sweep fires on the 06:30 PT tick
--       (scheduled_end 06:00 + 30 min).
-- Refuses anything else, e.g. a human clock-out or a re-run.
--
-- Formulas are copied from apps/api/src/jobs/autoCompleteShifts.ts with
-- NOW() replaced by the anchor:
--   breaks      :114-123
--   session     :152-157
--   violations  :215-222  (see note C)
--
-- expires_at is NOT re-anchored, because neither column derives from
-- scheduled_end. Measured on these two rows:
--   shifts.expires_at         - scheduled_start = exactly 1500 days
--   shift_sessions.expires_at - clocked_in_at   = 1500 days + 22 ms
-- The writer's file:line is in the report (Q7).
-- There are no user triggers on shifts, shift_sessions, break_sessions,
-- geofence_violations or missed_pings (pg_trigger, NOT tgisinternal:
-- 0 rows).
-- =============================================================================

\set ON_ERROR_STOP 1
\pset pager off

BEGIN;
SET LOCAL lock_timeout = '3s';

-- 0. Prove SET LOCAL took effect. Outside a transaction block it is a silent
--    no-op, and piped psql has done exactly that here before.
DO $$
BEGIN
  IF current_setting('lock_timeout') <> '3s' THEN
    RAISE EXCEPTION 'lock_timeout=% (expected 3s): SET LOCAL did not apply', current_setting('lock_timeout');
  END IF;
END $$;

-- 1. Lock both rows, then assert the preconditions. Taking the locks first
--    makes a concurrent autoCompleteShifts tick queue behind this
--    transaction. After a COMMIT, that tick re-checks its predicates and
--    finds nothing to do; after a ROLLBACK it proceeds as normal.
DO $$
DECLARE
  n int;
  sh record;
  ss record;
BEGIN
  SELECT * INTO sh FROM shifts
   WHERE id = 'c3574592-3a97-4fe0-a190-bd5f3b435018' FOR UPDATE;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'shift rows locked = %, expected 1', n; END IF;

  SELECT * INTO ss FROM shift_sessions
   WHERE id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c' FOR UPDATE;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'session rows locked = %, expected 1', n; END IF;

  -- identity: the session belongs to this shift, guard and site; the site is
  -- Bethel AME Church; the tenant is STARNET
  IF ss.shift_id <> sh.id
     OR ss.guard_id IS DISTINCT FROM sh.guard_id
     OR ss.site_id  <> sh.site_id
     OR sh.site_id  <> '53c71c64-1973-4f82-be9c-98e4800beece'
     OR sh.guard_id IS DISTINCT FROM '4a71d17d-d74a-4437-8269-cb1da0802d0d'::uuid THEN
    RAISE EXCEPTION 'identity mismatch: shift/session/guard/site do not line up';
  END IF;
  PERFORM 1 FROM sites
   WHERE id = sh.site_id AND company_id = '27c4d404-8769-49ca-bfd6-93cb9b890067';
  IF NOT FOUND THEN RAISE EXCEPTION 'site is not STARNET SECURITY'; END IF;

  -- times as observed in Q1
  IF sh.scheduled_start <> '2026-09-25 19:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'scheduled_start moved: %', sh.scheduled_start;
  END IF;
  IF sh.scheduled_end = '2026-09-26 01:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'scheduled_end already 18:00 PT: correction appears applied';
  END IF;
  IF sh.scheduled_end <> '2026-09-26 13:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'scheduled_end is % (expected 2026-09-26 13:00:00+00); state changed since audit', sh.scheduled_end;
  END IF;
  IF date_trunc('milliseconds', ss.clocked_in_at) <> '2026-09-25 19:05:13.737+00'::timestamptz THEN
    RAISE EXCEPTION 'clocked_in_at is %; not the audited session', ss.clocked_in_at;
  END IF;

  -- starting state: (a) open or (b) swept by the cron. Never overwrite a
  -- human close.
  IF NOT (
       (ss.clocked_out_at IS NULL AND ss.clock_out_reason IS NULL AND sh.status = 'active')
    OR (ss.clocked_out_at IS NOT NULL AND ss.clock_out_reason = 'auto' AND sh.status = 'completed')
  ) THEN
    RAISE EXCEPTION 'unexpected start state: status=% clocked_out_at=% reason=%',
      sh.status, ss.clocked_out_at, ss.clock_out_reason;
  END IF;

  RAISE NOTICE 'start state: status=% clocked_out_at=% reason=% total_hours=%',
    sh.status, ss.clocked_out_at, ss.clock_out_reason, ss.total_hours;
  IF sh.daily_report_email_sent THEN
    RAISE NOTICE 'WARNING: daily_report_email_sent = true (at %). The client email for this shift has ALREADY gone out with the uncorrected data; this correction does not recall it.',
      sh.daily_report_email_sent_at;
  ELSE
    RAISE NOTICE 'daily_report_email_sent = false: the 09:00 PT dailyShiftEmail run will read the CORRECTED row';
  END IF;
END $$;

-- 2. BEFORE rows
\echo '==== BEFORE: shift ===='
SELECT id, status, scheduled_start, scheduled_end, expires_at,
       daily_report_email_sent, daily_report_email_sent_at
  FROM shifts WHERE id = 'c3574592-3a97-4fe0-a190-bd5f3b435018';
\echo '==== BEFORE: session ===='
SELECT id, clocked_in_at, clocked_out_at, clock_out_reason, total_hours,
       clock_out_reminder_sent_at, expires_at
  FROM shift_sessions WHERE id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';
\echo '==== BEFORE: breaks (0 rows at audit time) ===='
SELECT id, break_start, break_end, duration_minutes, planned_duration_minutes, ended_by
  FROM break_sessions WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
 ORDER BY break_start;
\echo '==== BEFORE: geofence_violations (1 open row at audit time) ===='
SELECT id, occurred_at, resolved_at, duration_minutes, position_source
  FROM geofence_violations WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';

-- 3. The writes. Every row count is asserted.
DO $$
DECLARE
  anchor constant timestamptz := '2026-09-25 18:00:00-07';
  n int;
BEGIN
  -- A. Open breaks, closed at the anchor. The formula is
  --    autoCompleteShifts.ts:114-123 with NOW() -> anchor. Also re-anchors
  --    a break the cron has already closed past the anchor. The ended_by
  --    CHECK (chk_break_sessions_ended_by) has no admin value, so this keeps
  --    'auto_complete', the value the cron would have written. 0 rows
  --    expected: the session has no break_sessions rows.
  PERFORM 1 FROM break_sessions
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
     AND (break_end IS NULL OR (ended_by = 'auto_complete' AND break_end > anchor))
     AND break_start > anchor;
  IF FOUND THEN RAISE EXCEPTION 'a targeted break STARTED after the anchor; review by hand'; END IF;

  UPDATE break_sessions
     SET break_end = anchor,
         duration_minutes = LEAST(
           GREATEST(
             0,
             ROUND(EXTRACT(EPOCH FROM (anchor - break_start)) / 60.0)::INT
           ),
           planned_duration_minutes
         ),
         ended_by = 'auto_complete'
   WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
     AND (break_end IS NULL OR (ended_by = 'auto_complete' AND break_end > anchor));
  GET DIAGNOSTICS n = ROW_COUNT;
  RAISE NOTICE 'breaks closed/re-anchored: %', n;
  IF n > 0 THEN RAISE NOTICE 'NOTE: expected 0 breaks at audit time; % changed', n; END IF;

  -- B. The session. The formula is autoCompleteShifts.ts:152-157 with
  --    NOW() -> anchor:
  --      total_hours = GREATEST(0, anchor - GREATEST(clocked_in_at, scheduled_start))
  --    Expected value: 5.9128506280555556 (computed read-only).
  --    clock_out_reason: 'admin_corrected'. There is no CHECK on this column
  --    (by design, schema_v55.sql:92-105), so a distinct value is allowed.
  --    Consequence: hoursExport.ts:321 raises AUTO_CLOSED only on
  --    = 'auto', so the hours XLSX will carry NO flag for this row.
  --    To keep that flag instead, write 'auto'.
  UPDATE shift_sessions ss
     SET clocked_out_at   = anchor,
         clock_out_reason = 'admin_corrected',
         total_hours = GREATEST(
           0,
           EXTRACT(EPOCH FROM (anchor - GREATEST(ss.clocked_in_at, s.scheduled_start))) / 3600.0
         )
    FROM shifts s
   WHERE ss.shift_id = s.id
     AND ss.id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
     AND s.id  = 'c3574592-3a97-4fe0-a190-bd5f3b435018';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'session rows updated = %, expected exactly 1', n; END IF;

  -- C. Geofence violations on this session. The resolution rule is
  --    autoCompleteShifts.ts:215-222 verbatim, run against the NEW
  --    clocked_out_at. Outside the 1-a list, but required for consistency:
  --    - still open: the cron's next tick would resolve it with this same
  --      rule anyway (its violation step has no recency bound).
  --    - already swept at 06:30: the cron wrote resolved_at = 06:30 and
  --      duration_minutes = ~744 (12.4 h off-post) and will never revisit
  --      it. Only this step undoes that.
  --    Row 201fea51 (occurred 18:05:45 PT, i.e. after the anchor) takes the
  --    post-clock-out branch: resolved_at = occurred_at, duration 0.
  --    Exactly 1 row expected.
  UPDATE geofence_violations gv
     SET resolved_at = CASE WHEN gv.occurred_at >= ss.clocked_out_at
                            THEN gv.occurred_at
                            ELSE ss.clocked_out_at
                       END,
         duration_minutes = GREATEST(0, ROUND(
           EXTRACT(EPOCH FROM (ss.clocked_out_at - gv.occurred_at)) / 60
         ))::INT
    FROM shift_sessions ss
   WHERE gv.shift_session_id = ss.id
     AND ss.id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
     AND (gv.resolved_at IS NULL OR gv.resolved_at > anchor);
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'violation rows updated = %, expected exactly 1 (201fea51); state changed since audit', n; END IF;

  -- D. The shift. Shrinking the range cannot violate shifts_no_guard_overlap,
  --    and 'completed' falls outside that constraint's WHERE (it covers only
  --    scheduled and active).
  UPDATE shifts
     SET scheduled_end = anchor,
         status        = 'completed'
   WHERE id = 'c3574592-3a97-4fe0-a190-bd5f3b435018'
     AND site_id = '53c71c64-1973-4f82-be9c-98e4800beece';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'shift rows updated = %, expected exactly 1', n; END IF;
END $$;

-- 4. Post-state assertions
DO $$
DECLARE
  sh record; ss record; open_breaks int; gv record;
BEGIN
  SELECT * INTO sh FROM shifts WHERE id = 'c3574592-3a97-4fe0-a190-bd5f3b435018';
  SELECT * INTO ss FROM shift_sessions WHERE id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';
  SELECT count(*) INTO open_breaks FROM break_sessions
   WHERE shift_session_id = ss.id AND break_end IS NULL;
  SELECT * INTO STRICT gv FROM geofence_violations WHERE shift_session_id = ss.id;  -- STRICT: exactly one row or raise

  IF sh.scheduled_end <> '2026-09-26 01:00:00+00'::timestamptz OR sh.status <> 'completed' THEN
    RAISE EXCEPTION 'post: shift not corrected (end=%, status=%)', sh.scheduled_end, sh.status;
  END IF;
  IF sh.scheduled_start <> '2026-09-25 19:00:00+00'::timestamptz THEN
    RAISE EXCEPTION 'post: scheduled_start changed';
  END IF;
  IF ss.clocked_out_at <> '2026-09-26 01:00:00+00'::timestamptz
     OR ss.clock_out_reason <> 'admin_corrected'
     OR abs(ss.total_hours - 5.9128506280555556) > 0.0000001 THEN
    RAISE EXCEPTION 'post: session not as expected (out=%, reason=%, hours=%)',
      ss.clocked_out_at, ss.clock_out_reason, ss.total_hours;
  END IF;
  IF open_breaks <> 0 THEN RAISE EXCEPTION 'post: % open break(s) remain', open_breaks; END IF;
  IF gv.resolved_at IS DISTINCT FROM gv.occurred_at OR gv.duration_minutes <> 0 THEN
    RAISE EXCEPTION 'post: violation not resolved at occurred_at/0 (resolved=%, dur=%)',
      gv.resolved_at, gv.duration_minutes;
  END IF;
  RAISE NOTICE 'post-state assertions passed';
END $$;

-- 5. AFTER rows
\echo '==== AFTER: shift ===='
SELECT id, status, scheduled_start, scheduled_end, expires_at,
       daily_report_email_sent, daily_report_email_sent_at
  FROM shifts WHERE id = 'c3574592-3a97-4fe0-a190-bd5f3b435018';
\echo '==== AFTER: session ===='
SELECT id, clocked_in_at, clocked_out_at, clock_out_reason, total_hours,
       clock_out_reminder_sent_at, expires_at
  FROM shift_sessions WHERE id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';
\echo '==== AFTER: breaks ===='
SELECT id, break_start, break_end, duration_minutes, ended_by
  FROM break_sessions WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
 ORDER BY break_start;
\echo '==== AFTER: geofence_violations ===='
SELECT id, occurred_at, resolved_at, duration_minutes
  FROM geofence_violations WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';

-- 6. Rows this file does NOT touch, printed so the preview shows the residue
\echo '==== NOT TOUCHED: stored rows still attributed to this session ===='
SELECT 'missed_pings' AS tbl, count(*) AS total,
       count(*) FILTER (WHERE window_start >= '2026-09-26 01:00:00+00') AS window_at_or_after_1800pt,
       count(*) FILTER (WHERE resolved_at IS NULL) AS unresolved
  FROM missed_pings WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
UNION ALL
SELECT 'missed_reports', count(*),
       count(*) FILTER (WHERE window_start >= '2026-09-26 01:00:00+00'),
       count(*) FILTER (WHERE resolved_at IS NULL)
  FROM missed_reports WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c'
UNION ALL
SELECT 'notifications', count(*),
       count(*) FILTER (WHERE created_at >= '2026-09-26 01:00:00+00'),
       count(*) FILTER (WHERE read_at IS NULL)
  FROM notifications WHERE shift_session_id = 'cc1cf358-5c26-4f6a-9618-d716bacdda6c';

ROLLBACK;   -- PREVIEW. Change to COMMIT only after approval.
