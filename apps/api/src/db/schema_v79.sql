-- Schema v79 — recompute expires_at onto the locked 2026-09-19 tiers
--
-- Data-only. No DDL, no column added or dropped, no constraint changed.
-- Pairs with the constants in services/retention.ts: that commit changes
-- what NEW rows get, this one brings EXISTING rows to the same schedule.
--
-- Adds no purge step and enables no enforcement. RETENTION_DRY_RUN stays
-- unset, so nothing here causes a deletion.
--
-- ── THE RULE ────────────────────────────────────────────────────────────
--
-- Recompute from each row's own EVENT timestamp — reported_at, pinged_at,
-- clocked_in_at, scanned_at, occurred_at, completed_at, window_end — never
-- created_at where they differ, and never NOW(). A row's retention runs from
-- when the thing happened, not from when the row was written or when this
-- migration is applied.
--
-- `shifts` anchors on scheduled_start, which is a FUTURE timestamp on 174 of
-- 712 rows. That is intended: retention runs from the event.
--
-- ── THREE EXCEPTIONS ────────────────────────────────────────────────────
--
-- (1) PING PHOTOS ARE NOT TOUCHED. location_pings.photo_delete_at keeps its
--     7-day value on every existing row. The tier is unchanged and the S3
--     lifecycle rule `ping-7d` is what enforces it (measured 956-of-956
--     firing at 7.0-9.0 days). There is no statement for that column below,
--     deliberately. location_pings.expires_at — the METADATA clock — is a
--     different column and IS recomputed, 365d -> 90d.
--
-- (2) LEGAL HOLD IS ONE-DIRECTIONAL: a held row may be LENGTHENED, never
--     SHORTENED. Every statement on a table carrying legal_hold therefore
--     ends with
--         AND (NOT legal_hold OR <new> > expires_at)
--     A held row must never end up more deletable than it is today, but
--     neither should it end up MORE deletable than an equivalent unheld row
--     — which a blanket "skip all held rows" would have caused, since most
--     of these tiers lengthen.
--     Live effect, measured 2026-09-19: 4 held rows exist (1 report, 1
--     shift_session, 1 shift, 1 location_ping). The report/session/shift all
--     lengthen and are updated; the location_ping is the only row the clause
--     actually blocks, because pings shorten 365d -> 90d.
--
-- (3) missed_pings AND missed_reports ANCHOR ON window_end — not missed_at,
--     not window_start. All three columns differ on all 4,157 / 1,791 rows
--     (window_start differs by exactly the window length, missed_at by the
--     cron's detection lag). window_end is when the miss became a fact.
--
-- ── NULLABLE ANCHORS, HANDLED EXPLICITLY ────────────────────────────────
--
-- vehicle_inspections.completed_at is NULL on 2 of 20 rows while
-- vehicle_inspections.expires_at is NOT NULL. A completed_at-only CASE would
-- yield NULL and raise 23502, which aborts the WHOLE migration — every table
-- below, not those 2 rows. It uses COALESCE(completed_at, created_at), which
-- is also exactly what the existing writer already did for those 2 rows
-- (both currently sit at created_at + 365.0d), so their value does not move.
--
-- shift_sessions.clocked_out_at is nullable and is NULL by construction on an
-- open session. The clock_out_photo_delete_at statement is therefore scoped
-- to rows that already HAVE a clock-out photo timestamp, all 45 of which have
-- a non-NULL clocked_out_at. No NULL can reach the column.
--
-- NO STATEMENT BELOW CAN WRITE NULL INTO expires_at. Every anchor is either
-- NOT NULL or COALESCEd, and reports' CASE is paired with a WHERE that
-- excludes any report_type the CASE does not name — so an unexpected type
-- leaves the row untouched rather than nulling it. A NULL expires_at would be
-- silently and permanently exempt from every purge predicate, because
-- `expires_at < NOW()` is NULL-false.
--
-- ── IDEMPOTENT ──────────────────────────────────────────────────────────
--
-- Every statement carries `WHERE expires_at IS DISTINCT FROM <new>`, so a
-- second run matches zero rows and reports UPDATE 0. IS DISTINCT FROM rather
-- than <> so a NULL current value is treated as different and gets fixed
-- rather than skipped.
--
-- ── AUDITABILITY ────────────────────────────────────────────────────────
--
-- THE INVOCATION, and the flag is not optional:
--
--     psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f src/db/schema_v79.sql
--
-- NOTE THE MISSING `-1`. This file manages its own BEGIN/COMMIT, so it is a
-- single transaction however it is invoked; adding `-1` nests one inside
-- psql's own and emits "there is already a transaction in progress" plus
-- "there is no transaction in progress", which obscures a genuine failure.
-- Same reasoning as docs/OPS/RUNBOOK-phase2-apply.md:81-85, which is the
-- house pattern for a self-transacting script.
--
-- ON_ERROR_STOP=1 IS WHAT MAKES A FAILURE VISIBLE. Without it psql keeps
-- sending after an error, the transaction sits aborted, every later statement
-- returns 25P02, the final COMMIT silently performs a ROLLBACK, and psql
-- EXITS 0 having already printed a screen of `UPDATE n` lines from before the
-- failure. A failed apply would be indistinguishable from a successful one,
-- and the "leaves the database untouched" line below is exactly what would
-- stop anyone looking.
--
-- psql prints `UPDATE n` per statement. Expected counts are in the comment
-- above each one, measured against production 2026-09-19 ~16:58 UTC. A count
-- that does not match its comment means the data moved since — stop and
-- re-measure rather than continuing. Expect this to fire on `shifts` and the
-- ping tables in particular: they are written continuously (114 shifts in the
-- 24h before authoring), so their totals tick upward.
-- The verification SELECT at the end must return all-zero drift.
--
-- SESSION TIMEZONE MUST BE UTC. `timestamptz + INTERVAL 'N days'` is STABLE,
-- not IMMUTABLE — it resolves day arithmetic in the session TimeZone. The
-- server default is Etc/UTC and retention.ts:127 uses setUTCDate, so the two
-- agree exactly; applying this from a host with PGTZ set to a DST-observing
-- zone would write values an hour off on ~1,130 location_pings rows. Do not
-- set PGTZ for this run.
--
-- TO PREVIEW WITHOUT WRITING: change the final COMMIT to ROLLBACK and run it.
-- Every count and the verification table print exactly as they would on a
-- real run, and nothing is kept. The whole file is one transaction, so a
-- failure at any statement leaves the database untouched.
--
-- Replaying on a fresh database is a no-op: the tables are empty, every
-- statement matches zero rows, and the file is idempotent by construction.
--
-- ── DELIBERATELY NOT TOUCHED ────────────────────────────────────────────
--
--   location_pings.photo_delete_at  exception (1)
--   reports.delete_at               dead: 969/969 NULL, written by nothing
--   report_photos.delete_at         dead: 2296/2296 NULL. The "+ photos" half
--                                   of the report tiers is carried by
--                                   report_photos_report_id_fkey ON DELETE
--                                   CASCADE, not by this column.
--   admin_client_previews, revoked_tokens, idempotency_keys,
--   password_reset_tokens           prune-on-expires_at or NO TIER; their
--                                   expires_at is a capability/token window,
--                                   not a retention tier.

BEGIN;

-- ── location_pings.expires_at — 365d -> 90d on pinged_at. Expect UPDATE 1189.
-- The one held ping is excluded by the legal_hold clause: this tier SHORTENS,
-- and exception (2) blocks shortening a held row.
UPDATE location_pings
   SET expires_at = pinged_at + INTERVAL '90 days'
 WHERE expires_at IS DISTINCT FROM pinged_at + INTERVAL '90 days'
   AND (NOT legal_hold OR pinged_at + INTERVAL '90 days' > expires_at);

-- ── missed_pings.expires_at — 365d -> 90d on window_end. Expect UPDATE 4157.
-- No legal_hold column on this table.
UPDATE missed_pings
   SET expires_at = window_end + INTERVAL '90 days'
 WHERE expires_at IS DISTINCT FROM window_end + INTERVAL '90 days';

-- ── missed_reports.expires_at — 365d -> 730d on window_end. Expect UPDATE 1791.
-- No legal_hold column on this table.
UPDATE missed_reports
   SET expires_at = window_end + INTERVAL '730 days'
 WHERE expires_at IS DISTINCT FROM window_end + INTERVAL '730 days';

-- ── reports.expires_at — 730d activity/maintenance, 1500d incident, on
--    reported_at. Expect UPDATE 969 (968 unheld + the 1 held incident, which
--    lengthens 1095d -> 1500d and is therefore allowed).
-- The WHERE pins report_type to the three the CASE names, so a type added to
-- the CHECK later leaves rows untouched instead of nulling expires_at.
UPDATE reports
   SET expires_at = reported_at + (CASE report_type
                                     WHEN 'incident'    THEN INTERVAL '1500 days'
                                     WHEN 'activity'    THEN INTERVAL '730 days'
                                     WHEN 'maintenance' THEN INTERVAL '730 days'
                                   END)
 WHERE report_type IN ('incident', 'activity', 'maintenance')
   AND expires_at IS DISTINCT FROM reported_at + (CASE report_type
                                     WHEN 'incident'    THEN INTERVAL '1500 days'
                                     WHEN 'activity'    THEN INTERVAL '730 days'
                                     WHEN 'maintenance' THEN INTERVAL '730 days'
                                   END)
   AND (NOT legal_hold OR reported_at + (CASE report_type
                                     WHEN 'incident'    THEN INTERVAL '1500 days'
                                     WHEN 'activity'    THEN INTERVAL '730 days'
                                     WHEN 'maintenance' THEN INTERVAL '730 days'
                                   END) > expires_at);

-- ── geofence_violations.expires_at — 1095d -> 365d on occurred_at. Expect UPDATE 44.
UPDATE geofence_violations
   SET expires_at = occurred_at + INTERVAL '365 days'
 WHERE expires_at IS DISTINCT FROM occurred_at + INTERVAL '365 days'
   AND (NOT legal_hold OR occurred_at + INTERVAL '365 days' > expires_at);

-- ── off_post_events.expires_at — 1095d -> 365d on occurred_at. Expect UPDATE 5.
UPDATE off_post_events
   SET expires_at = occurred_at + INTERVAL '365 days'
 WHERE expires_at IS DISTINCT FROM occurred_at + INTERVAL '365 days'
   AND (NOT legal_hold OR occurred_at + INTERVAL '365 days' > expires_at);

-- ── task_completions.expires_at — 365d, re-anchored onto completed_at. Expect UPDATE 4.
UPDATE task_completions
   SET expires_at = completed_at + INTERVAL '365 days'
 WHERE expires_at IS DISTINCT FROM completed_at + INTERVAL '365 days'
   AND (NOT legal_hold OR completed_at + INTERVAL '365 days' > expires_at);

-- ── vehicle_inspections.expires_at — 365d on COALESCE(completed_at, created_at).
--    Expect UPDATE 20. The 2 rows with a NULL completed_at fall back to
--    created_at, which is where the existing writer already put them, so their
--    stored value is unchanged in effect — they are counted because the
--    sub-second recompute differs.
UPDATE vehicle_inspections
   SET expires_at = COALESCE(completed_at, created_at) + INTERVAL '365 days'
 WHERE expires_at IS DISTINCT FROM COALESCE(completed_at, created_at) + INTERVAL '365 days'
   AND (NOT legal_hold OR COALESCE(completed_at, created_at) + INTERVAL '365 days' > expires_at);

-- ── shift_sessions.expires_at — 1460d -> 1500d on clocked_in_at. Expect UPDATE 345.
-- Includes the 1 held session: this tier LENGTHENS, which exception (2) allows.
UPDATE shift_sessions
   SET expires_at = clocked_in_at + INTERVAL '1500 days'
 WHERE expires_at IS DISTINCT FROM clocked_in_at + INTERVAL '1500 days'
   AND (NOT legal_hold OR clocked_in_at + INTERVAL '1500 days' > expires_at);

-- ── shifts.expires_at — 1460d -> 1500d on scheduled_start. Expect UPDATE 712.
-- shifts MUST carry the same tier as shift_sessions: shift_sessions is an
-- ON DELETE CASCADE child of shifts, so a shift expiring first cascades the
-- session and its 1500-day incident reports away early. At 1460/1500 that
-- inverted on 345 of 345 sessions by ~40 days, silently on 670 of 712 shifts.
UPDATE shifts
   SET expires_at = scheduled_start + INTERVAL '1500 days'
 WHERE expires_at IS DISTINCT FROM scheduled_start + INTERVAL '1500 days'
   AND (NOT legal_hold OR scheduled_start + INTERVAL '1500 days' > expires_at);

-- ── shift_sessions.clock_out_photo_delete_at — 365d -> 90d on clocked_out_at.
--    Expect UPDATE 45. Scoped to rows that already carry a value; all 45 have
--    a non-NULL clocked_out_at, so no NULL can reach the column. Nothing reads
--    this column today — it is brought to the locked tier so the value is not
--    a lie when a clock-out photo step is eventually built.
-- The legal_hold term is NOT optional here even though no held row carries a
-- value today. shift_sessions carries legal_hold, and this tier SHORTENS
-- 365d -> 90d on all 45 rows, so it is exactly the shape exception (2) exists
-- to stop. The one held session escapes only because its
-- clock_out_photo_delete_at happens to be NULL — luck, not design, and it
-- stops being true the moment a hold lands on a session that has a clock-out
-- photo. Omitting the clause would have made this the only statement of the
-- nine on hold-bearing tables that can shorten a held row.
UPDATE shift_sessions
   SET clock_out_photo_delete_at = clocked_out_at + INTERVAL '90 days'
 WHERE clock_out_photo_delete_at IS NOT NULL
   AND clocked_out_at IS NOT NULL
   AND clock_out_photo_delete_at IS DISTINCT FROM clocked_out_at + INTERVAL '90 days'
   AND (NOT legal_hold OR clocked_out_at + INTERVAL '90 days' > clock_out_photo_delete_at);

-- ── checkpoint_scans.expires_at — 365d on scanned_at, UNCHANGED tier.
--    Expect UPDATE 0. Kept as an asserted invariant, not a no-op by accident:
--    this column is populated by a hardcoded DEFAULT now() + '365 days'
--    (schema_v44), not by retention.ts. All 585 rows already sit at exactly
--    scanned_at + 365d. If this ever reports a non-zero count, the DEFAULT and
--    the tier have drifted and that is worth knowing.
UPDATE checkpoint_scans
   SET expires_at = scanned_at + INTERVAL '365 days'
 WHERE expires_at IS DISTINCT FROM scanned_at + INTERVAL '365 days'
   AND (NOT legal_hold OR scanned_at + INTERVAL '365 days' > expires_at);

-- ── VERIFICATION — run before COMMIT.
--
-- `drift` must be 0 on EVERY row. A non-zero drift means a statement above did
-- not reach a row it should have.
--
-- `held_blocked` counts held rows the one-directional clause correctly refused
-- to shorten. It is split out on every hold-bearing table, not just
-- location_pings, so that a hold landing on geofence_violations or
-- off_post_events — both of which SHORTEN 1095d -> 365d — surfaces as
-- held_blocked rather than as unexplained drift the operator is told to stop on.
--
-- EXPECTED TODAY: drift = 0 everywhere; held_blocked = 1 on location_pings
-- (ping de9aa0b0, which would shorten 2027-07-13 -> 2026-10-11) and 0 on all
-- others. The held report / shift_session / shift all LENGTHEN, so they are
-- updated rather than blocked and contribute 0 to both columns.
SELECT 'location_pings'      AS tbl,
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM pinged_at + INTERVAL '90 days') AS drift,
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM pinged_at + INTERVAL '90 days') AS held_blocked FROM location_pings
UNION ALL SELECT 'missed_pings',
       COUNT(*) FILTER (WHERE expires_at IS DISTINCT FROM window_end + INTERVAL '90 days'), 0 FROM missed_pings
UNION ALL SELECT 'missed_reports',
       COUNT(*) FILTER (WHERE expires_at IS DISTINCT FROM window_end + INTERVAL '730 days'), 0 FROM missed_reports
UNION ALL SELECT 'reports',
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM reported_at + (CASE report_type WHEN 'incident' THEN INTERVAL '1500 days' WHEN 'activity' THEN INTERVAL '730 days' WHEN 'maintenance' THEN INTERVAL '730 days' END)),
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM reported_at + (CASE report_type WHEN 'incident' THEN INTERVAL '1500 days' WHEN 'activity' THEN INTERVAL '730 days' WHEN 'maintenance' THEN INTERVAL '730 days' END)) FROM reports
UNION ALL SELECT 'geofence_violations',
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM occurred_at + INTERVAL '365 days'),
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM occurred_at + INTERVAL '365 days') FROM geofence_violations
UNION ALL SELECT 'off_post_events',
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM occurred_at + INTERVAL '365 days'),
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM occurred_at + INTERVAL '365 days') FROM off_post_events
UNION ALL SELECT 'task_completions',
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM completed_at + INTERVAL '365 days'),
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM completed_at + INTERVAL '365 days') FROM task_completions
UNION ALL SELECT 'vehicle_inspections',
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM COALESCE(completed_at, created_at) + INTERVAL '365 days'),
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM COALESCE(completed_at, created_at) + INTERVAL '365 days') FROM vehicle_inspections
UNION ALL SELECT 'shift_sessions',
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM clocked_in_at + INTERVAL '1500 days'),
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM clocked_in_at + INTERVAL '1500 days') FROM shift_sessions
UNION ALL SELECT 'shifts',
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM scheduled_start + INTERVAL '1500 days'),
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM scheduled_start + INTERVAL '1500 days') FROM shifts
UNION ALL SELECT 'checkpoint_scans',
       COUNT(*) FILTER (WHERE NOT legal_hold AND expires_at IS DISTINCT FROM scanned_at + INTERVAL '365 days'),
       COUNT(*) FILTER (WHERE     legal_hold AND expires_at IS DISTINCT FROM scanned_at + INTERVAL '365 days') FROM checkpoint_scans
UNION ALL SELECT 'ss.clock_out_photo_delete_at',
       COUNT(*) FILTER (WHERE NOT legal_hold AND clock_out_photo_delete_at IS NOT NULL AND clocked_out_at IS NOT NULL
                          AND clock_out_photo_delete_at IS DISTINCT FROM clocked_out_at + INTERVAL '90 days'),
       COUNT(*) FILTER (WHERE     legal_hold AND clock_out_photo_delete_at IS NOT NULL AND clocked_out_at IS NOT NULL
                          AND clock_out_photo_delete_at IS DISTINCT FROM clocked_out_at + INTERVAL '90 days') FROM shift_sessions
ORDER BY tbl;

-- ── EXCEPTION (1), ASSERTED RATHER THAN ASSUMED.
-- Exception (1) is currently enforced by the ABSENCE of a statement, which is
-- unprovable after the fact. This fingerprints location_pings.photo_delete_at
-- so the operator can see it did not move.
--
-- EXPECTED, measured 2026-09-19T17:05:54Z:
--   rows 1190 · non_null 1190 · fingerprint ff758bbf71c4da7ad10dff45d9349557
--   min 2026-07-20T01:25:17.344Z · max 2026-09-26T13:30:34.377Z
--
-- rows/non_null/max WILL have grown if pings were written between that
-- measurement and the apply — that is expected and harmless. What must NOT
-- change is `min`: a moved floor means a statement touched the column, and
-- this migration must never touch it.
SELECT COUNT(*)                    AS ping_rows,
       COUNT(photo_delete_at)      AS photo_delete_at_non_null,
       md5(string_agg(id::text || '|' || photo_delete_at::text, ',' ORDER BY id)) AS photo_delete_at_fingerprint,
       MIN(photo_delete_at)        AS photo_delete_at_min,
       MAX(photo_delete_at)        AS photo_delete_at_max
  FROM location_pings;

COMMIT;
