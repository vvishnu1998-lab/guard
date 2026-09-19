-- Schema v78 — legal_hold_at on the cascade tables
--
-- Adds the nullable `legal_hold_at TIMESTAMPTZ` to the seven tables that
-- carry `legal_hold` but have no timestamp for it:
--
--   checkpoint_scans, location_pings, off_post_events, shift_sessions,
--   shifts, task_completions, vehicle_inspections
--
-- `reports` and `geofence_violations` already have it (v35) and are the
-- two hold ORIGINS — the only tables with a "PLACE ON HOLD" surface.
--
-- ── THIS REVERSES A DECISION v35 RECORDED DELIBERATELY ──────────────────
--
-- schema_v35.sql states: "cascade parents (shift_sessions, shifts,
-- location_pings, task_completions) keep the boolean `legal_hold` only,
-- since no UI surfaces 'when' for them."
--
-- That held while the cascade was write-only. It stops holding once
-- release becomes symmetric: a cascade row can now be cleared as well as
-- set, so `legal_hold = true` without a timestamp is a state with no
-- provenance and no way to tell a hold placed this morning from one
-- placed in July. The boolean answers "is it held"; the timestamp is what
-- answers "since when", which is the question an e-discovery request
-- actually asks.
--
-- DELIBERATELY NOT INCLUDED: a `held_by_report_id` provenance column.
-- Every FK action for it is wrong in a different way — CASCADE lets a
-- purged report silently erase the explanation for every row it held,
-- SET NULL leaves an unexplained hold, NO ACTION makes the causing report
-- undeletable. That needs its own decision and is not resolved here.
--
-- Expand-safe / Tier 1 (docs/OPS/POLICY.md:21): every column is nullable,
-- no default, no backfill, no existing row is touched, and nothing reads
-- the column until the code that writes it ships.
--
-- ORDERING: this migration must be APPLIED BEFORE the API code that
-- writes these columns is deployed. `routes/admin.ts` references
-- legal_hold_at on all seven tables; against a database without them the
-- UPDATE raises 42703 and the whole legal-hold transaction rolls back.
-- Apply, then merge. (docs/OPS/POLICY.md expand-then-extend.)

ALTER TABLE checkpoint_scans    ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;
ALTER TABLE location_pings      ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;
ALTER TABLE off_post_events     ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;
ALTER TABLE shift_sessions      ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;
ALTER TABLE shifts              ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;
ALTER TABLE task_completions    ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;
ALTER TABLE vehicle_inspections ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;

-- Backfill for the rows already held. Three rows exist platform-wide at
-- authoring time (1 report, 1 shift_session, 1 shift, all on session
-- e9d49c9e-7c96-495a-ab52-d4b08bb9ffa3). Their hold was placed by the
-- cascade from report 53fc82ec-5320-45d8-af22-185f0788853f, whose own
-- legal_hold_at is 2026-07-13T20:27:58.744Z — so that is the honest
-- timestamp for them, not NOW(). Rows held but unattributable to any
-- origin are left NULL rather than stamped with a value nobody can
-- defend; NULL here reads as "held, origin time unknown", which is true.
UPDATE shift_sessions ss
   SET legal_hold_at = (
         SELECT MIN(r.legal_hold_at) FROM reports r
          WHERE r.shift_session_id = ss.id AND r.legal_hold AND r.legal_hold_at IS NOT NULL)
 WHERE ss.legal_hold AND ss.legal_hold_at IS NULL;

UPDATE shifts sh
   SET legal_hold_at = (
         SELECT MIN(ss.legal_hold_at) FROM shift_sessions ss
          WHERE ss.shift_id = sh.id AND ss.legal_hold AND ss.legal_hold_at IS NOT NULL)
 WHERE sh.legal_hold AND sh.legal_hold_at IS NULL;
