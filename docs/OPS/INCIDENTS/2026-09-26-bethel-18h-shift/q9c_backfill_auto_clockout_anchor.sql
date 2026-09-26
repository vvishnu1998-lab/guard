-- =============================================================================
-- Decision 9(c): re-anchor ALL historical auto clock-outs, by rule not by count.
-- DRAFT. NOT EXECUTED. The final statement is ROLLBACK (preview).
--
-- This file is Tier 2: a prod DB write outside a migration.
-- RUN ORDER: only AFTER the U4a code (auto-close records
-- GREATEST(clocked_in_at, scheduled_end)) is deployed and has produced at least
-- one anchor-close. If the old sweep is still live, new rows matching the rule
-- appear during the run and step 5 RAISES. That is deliberate.
--
-- Run (no -1; this file opens its own transaction):
--   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f q9c_backfill_auto_clockout_anchor.sql
--
-- RULE (the only selector; there are no id lists):
--   shift_sessions.clock_out_reason = 'auto'
--   AND clocked_out_at > GREATEST(clocked_in_at, shifts.scheduled_end)
-- Per row:  anchor = GREATEST(clocked_in_at, scheduled_end)
--   clocked_out_at := anchor
--   total_hours    := GREATEST(0, EPOCH(anchor - GREATEST(clocked_in_at,
--                     scheduled_start))/3600.0)
--                     (autoCompleteShifts.ts:154-157, with NOW() -> anchor)
--   clock_out_reason stays 'auto'
--   Breaks the sweep closed (ended_by = 'auto_complete' AND break_end = old
--   clocked_out_at): break_end := GREATEST(break_start, anchor), with duration
--   from autoCompleteShifts.ts:116-122.
--   Violations the sweep resolved (resolved_at = old clocked_out_at): the
--   job's own rule (autoCompleteShifts.ts:216-222) against the anchor.
-- NOT touched:
--   breaks closed by guard or break_expiry, even when they end after the
--   anchor (same as U4a's forward behaviour);
--   violations resolved any other way;
--   manual, handoff and admin_corrected sessions; NULL-reason sessions;
--   shifts rows.
-- Rows on legal hold (session, shift, or any violation on the session) are
-- SKIPPED and counted.
--
-- Census at draft time (prod, read-only, 2026-09-26 ~07:30 PT):
--   206 rows = STARNET SECURITY 25 (12.5041 h) + Star Guard 181 (90.6344 h);
--   every row +30.00..+35.01 min past the anchor; clock-ins 2026-08-24 09:58
--   to 2026-09-25 23:00 PT. Stored total_hours equals the current formula on
--   all 206 (no break-deducted legacy rows). Of the violations, 9 were
--   resolved at clocked_out_at (7 born before the anchor, 2 after); 0 breaks
--   have ended_by auto_complete; 0 rows are on legal hold. The count is NOT
--   hardcoded: new auto-closes keep adding rows until U4a deploys, so the
--   assertions compare against the census taken inside this transaction.
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

-- 1. Capture the targets BY RULE and lock them in the same statement.
CREATE TEMP TABLE bf_sessions (
  session_id      uuid PRIMARY KEY,
  shift_id        uuid NOT NULL,
  company_id      uuid NOT NULL,
  tenant          text NOT NULL,
  clocked_in_at   timestamptz NOT NULL,
  scheduled_start timestamptz NOT NULL,
  scheduled_end   timestamptz NOT NULL,
  old_out         timestamptz NOT NULL,
  old_total       double precision,
  anchor          timestamptz NOT NULL,
  held            boolean NOT NULL
) ON COMMIT DROP;

WITH locked AS (
  SELECT ss.id, ss.shift_id, si.company_id, co.name AS tenant,
         ss.clocked_in_at, sh.scheduled_start, sh.scheduled_end,
         ss.clocked_out_at, ss.total_hours,
         GREATEST(ss.clocked_in_at, sh.scheduled_end) AS anchor,
         (ss.legal_hold OR sh.legal_hold OR EXISTS (
            SELECT 1 FROM geofence_violations v
             WHERE v.shift_session_id = ss.id AND v.legal_hold)) AS held
    FROM shift_sessions ss
    JOIN shifts    sh ON sh.id = ss.shift_id
    JOIN sites     si ON si.id = sh.site_id
    JOIN companies co ON co.id = si.company_id
   WHERE ss.clock_out_reason = 'auto'
     AND ss.clocked_out_at > GREATEST(ss.clocked_in_at, sh.scheduled_end)
     FOR UPDATE OF ss
)
INSERT INTO bf_sessions
SELECT * FROM locked;

-- Lock the child rows this file will rewrite.
DO $$
BEGIN
  PERFORM 1 FROM geofence_violations gv JOIN bf_sessions t ON t.session_id = gv.shift_session_id
   WHERE NOT t.held AND gv.resolved_at = t.old_out
     FOR UPDATE OF gv;
  PERFORM 1 FROM break_sessions b JOIN bf_sessions t ON t.session_id = b.shift_session_id
   WHERE NOT t.held AND b.ended_by = 'auto_complete' AND b.break_end = t.old_out
     FOR UPDATE OF b;
END $$;

-- 2. Census and BEFORE summary, per tenant
\echo '==== CENSUS / BEFORE (per tenant) ===='
SELECT COALESCE(tenant, 'ALL') AS tenant,
       count(*)                                             AS rule_matches,
       count(*) FILTER (WHERE held)                         AS skipped_legal_hold,
       count(*) FILTER (WHERE NOT held)                     AS to_update,
       round(min(EXTRACT(EPOCH FROM (old_out - anchor))/60.0)::numeric, 2) AS min_min_past_anchor,
       round(max(EXTRACT(EPOCH FROM (old_out - anchor))/60.0)::numeric, 2) AS max_min_past_anchor,
       round((sum(old_total) FILTER (WHERE NOT held))::numeric, 4)          AS total_hours_before,
       to_char(min(clocked_in_at) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') AS earliest_in_pt,
       to_char(max(clocked_in_at) AT TIME ZONE 'America/Los_Angeles', 'YYYY-MM-DD HH24:MI') AS latest_in_pt
  FROM bf_sessions
 GROUP BY ROLLUP(tenant)
 ORDER BY tenant NULLS LAST;
\echo '==== CHILD ROWS IN SCOPE ===='
SELECT
  (SELECT count(*) FROM geofence_violations gv JOIN bf_sessions t ON t.session_id = gv.shift_session_id
    WHERE NOT t.held AND gv.resolved_at = t.old_out)                                  AS violations_sweep_resolved,
  (SELECT count(*) FROM geofence_violations gv JOIN bf_sessions t ON t.session_id = gv.shift_session_id
    WHERE NOT t.held AND gv.resolved_at = t.old_out AND gv.occurred_at >= t.anchor)   AS of_which_born_after_anchor,
  (SELECT count(*) FROM break_sessions b JOIN bf_sessions t ON t.session_id = b.shift_session_id
    WHERE NOT t.held AND b.ended_by = 'auto_complete' AND b.break_end = t.old_out)    AS breaks_sweep_closed,
  (SELECT count(*) FROM break_sessions b JOIN bf_sessions t ON t.session_id = b.shift_session_id
    WHERE NOT t.held AND b.break_end > t.anchor AND b.ended_by <> 'auto_complete')    AS breaks_after_anchor_left_as_is,
  (SELECT count(*) FROM shift_sessions WHERE clock_out_reason IS NULL AND clocked_out_at IS NOT NULL) AS null_reason_sessions_untouched;

-- 3. The writes, each with exact-count assertions against the in-transaction census
DO $$
DECLARE
  n_target int; n_held int; n_viol int; n_brk int; n int;
BEGIN
  SELECT count(*) FILTER (WHERE NOT held), count(*) FILTER (WHERE held) INTO n_target, n_held FROM bf_sessions;
  SELECT count(*) INTO n_viol FROM geofence_violations gv JOIN bf_sessions t ON t.session_id = gv.shift_session_id
   WHERE NOT t.held AND gv.resolved_at = t.old_out;
  SELECT count(*) INTO n_brk FROM break_sessions b JOIN bf_sessions t ON t.session_id = b.shift_session_id
   WHERE NOT t.held AND b.ended_by = 'auto_complete' AND b.break_end = t.old_out;
  RAISE NOTICE 'census: % session(s) to update, % skipped on legal hold, % violation(s), % break(s)', n_target, n_held, n_viol, n_brk;

  -- A. Sweep-closed breaks: re-anchor (never before break_start)
  UPDATE break_sessions b
     SET break_end = GREATEST(b.break_start, t.anchor),
         duration_minutes = LEAST(
           GREATEST(
             0,
             ROUND(EXTRACT(EPOCH FROM (GREATEST(b.break_start, t.anchor) - b.break_start)) / 60.0)::INT
           ),
           b.planned_duration_minutes
         )
    FROM bf_sessions t
   WHERE b.shift_session_id = t.session_id
     AND NOT t.held
     AND b.ended_by = 'auto_complete'
     AND b.break_end = t.old_out;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> n_brk THEN RAISE EXCEPTION 'breaks updated = %, census = %', n, n_brk; END IF;

  -- B. Sweep-resolved violations: the job's rule against the anchor
  UPDATE geofence_violations gv
     SET resolved_at = CASE WHEN gv.occurred_at >= t.anchor THEN gv.occurred_at ELSE t.anchor END,
         duration_minutes = GREATEST(0, ROUND(
           EXTRACT(EPOCH FROM (t.anchor - gv.occurred_at)) / 60
         ))::INT
    FROM bf_sessions t
   WHERE gv.shift_session_id = t.session_id
     AND NOT t.held
     AND gv.resolved_at = t.old_out;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> n_viol THEN RAISE EXCEPTION 'violations updated = %, census = %', n, n_viol; END IF;

  -- C. Sessions: clocked_out_at := anchor; total_hours with the job's formula
  UPDATE shift_sessions ss
     SET clocked_out_at = t.anchor,
         total_hours = GREATEST(
           0,
           EXTRACT(EPOCH FROM (t.anchor - GREATEST(ss.clocked_in_at, s.scheduled_start))) / 3600.0
         )
    FROM bf_sessions t
    JOIN shifts s ON s.id = t.shift_id
   WHERE ss.id = t.session_id
     AND NOT t.held
     AND ss.clock_out_reason = 'auto'
     AND ss.clocked_out_at = t.old_out;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> n_target THEN RAISE EXCEPTION 'sessions updated = %, census = %', n, n_target; END IF;
END $$;

-- 4. AFTER summary, per tenant (hours removed)
\echo '==== AFTER (per tenant) ===='
SELECT COALESCE(t.tenant, 'ALL') AS tenant,
       count(*)                                              AS updated,
       round(sum(t.old_total)::numeric, 4)                   AS total_hours_before,
       round(sum(ss.total_hours)::numeric, 4)                AS total_hours_after,
       round(sum(t.old_total - ss.total_hours)::numeric, 4)  AS total_hours_removed,
       round((sum(EXTRACT(EPOCH FROM (t.old_out - ss.clocked_out_at)))/3600.0)::numeric, 4) AS actual_hours_removed
  FROM bf_sessions t
  JOIN shift_sessions ss ON ss.id = t.session_id
 WHERE NOT t.held
 GROUP BY ROLLUP(t.tenant)
 ORDER BY t.tenant NULLS LAST;

-- 5. Post-state assertions
DO $$
DECLARE n int;
BEGIN
  -- every targeted row sits exactly on its anchor, reason unchanged, formula consistent
  SELECT count(*) INTO n FROM bf_sessions t JOIN shift_sessions ss ON ss.id = t.session_id
    JOIN shifts s ON s.id = t.shift_id
   WHERE NOT t.held AND (
         ss.clocked_out_at <> t.anchor
      OR ss.clock_out_reason IS DISTINCT FROM 'auto'
      OR abs(ss.total_hours - GREATEST(0, EXTRACT(EPOCH FROM (t.anchor - GREATEST(ss.clocked_in_at, s.scheduled_start))) / 3600.0)) > 1e-9);
  IF n <> 0 THEN RAISE EXCEPTION 'post: % targeted session(s) not at anchor / reason changed / total_hours inconsistent', n; END IF;

  -- held rows untouched
  SELECT count(*) INTO n FROM bf_sessions t JOIN shift_sessions ss ON ss.id = t.session_id
   WHERE t.held AND (ss.clocked_out_at <> t.old_out OR ss.total_hours IS DISTINCT FROM t.old_total);
  IF n <> 0 THEN RAISE EXCEPTION 'post: % held session(s) were modified', n; END IF;

  -- no impossible children on targeted sessions
  SELECT count(*) INTO n FROM geofence_violations gv JOIN bf_sessions t ON t.session_id = gv.shift_session_id
   WHERE NOT t.held AND (gv.resolved_at < gv.occurred_at OR gv.duration_minutes < 0);
  IF n <> 0 THEN RAISE EXCEPTION 'post: % violation(s) with resolved_at < occurred_at or negative duration', n; END IF;
  SELECT count(*) INTO n FROM break_sessions b JOIN bf_sessions t ON t.session_id = b.shift_session_id
   WHERE NOT t.held AND (b.break_end < b.break_start OR b.duration_minutes < 0);
  IF n <> 0 THEN RAISE EXCEPTION 'post: % break(s) with break_end < break_start or negative duration', n; END IF;

  -- by rule: nothing outside the legal-hold skips may still match. A non-zero
  -- count here means rows appeared that were not in this snapshot, i.e. the
  -- OLD sweep is still live. Deploy U4a first.
  SELECT count(*) INTO n FROM shift_sessions ss JOIN shifts sh ON sh.id = ss.shift_id
   WHERE ss.clock_out_reason = 'auto'
     AND ss.clocked_out_at > GREATEST(ss.clocked_in_at, sh.scheduled_end)
     AND ss.id NOT IN (SELECT session_id FROM bf_sessions WHERE held);
  IF n <> 0 THEN RAISE EXCEPTION 'post: % row(s) still match the rule (old sweep still live?)', n; END IF;

  RAISE NOTICE 'post-state assertions passed';
END $$;

ROLLBACK;   -- PREVIEW. Change to COMMIT only after approval.
