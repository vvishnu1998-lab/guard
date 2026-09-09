-- schema_v70 — audit trail for admin edits to a site's configuration (2026-09-09)
--
-- NUMBERING: v69 is the highest entry in migrate.ts and the highest file on
-- disk; both were re-read at HEAD immediately before writing this, and prod
-- confirms v69 applied. v70 is free. Read the chain off migrate.ts, never
-- from a brief — it has three recorded collisions (v46 -> v50, v51 -> v52,
-- and v54 taken overnight).
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through
-- piped psql is a silent no-op in autocommit (learned applying v54).
SET LOCAL lock_timeout = '3s';

-- ── Why this table exists ────────────────────────────────────────────────
--
-- Phase H adds PATCH /api/sites/:id/ping-interval, which mutates
-- sites.ping_interval_minutes. `sites` has NO updated_at column and no
-- history anywhere, so without this table the edit leaves LITERALLY NO
-- TRACE: one column changes value and nothing else in the database differs.
--
-- That is not hypothetical. docs/OPS/STATE.md records exactly this failure
-- for the sibling flags: three sites were found with checkpoints_enabled =
-- false where the table said true, and the question "were they created that
-- way on 09-06, or toggled since" is UNANSWERABLE — no updated_at, no audit,
-- nothing. That is a boolean. ping_interval_minutes is the SOURCE the
-- clock-in snapshot copies into shift_sessions.ping_interval_minutes
-- (schema_v68), and that snapshot decides how many ping windows a guard is
-- accountable for and how many off-post hours reach the daily client email
-- and the XLSX export. An unaudited change to it moves a billed number with
-- no record of who moved it.
--
-- Every sibling admin mutation of consequence already audits: a schedule
-- edit -> shift_schedule_audit (v58), a guard-site assignment change ->
-- guard_assignment_audit (v20), a reassign -> shift_reassignments (v15).
-- Site configuration is the gap.
--
-- ── Modelled on shift_schedule_audit (v58), not guard_assignment_audit ───
--
-- v58 is the better model for four reasons, each of which v20 fails:
--
--   1. changed_by_role. v20 records a bare uuid, and company_admins and the
--      vishnu identity live in DIFFERENT TABLES — so a uuid alone is not
--      resolvable without knowing the role. sites.ts already admits vishnu
--      on GET / , GET /:id and PATCH /:id/client-access, so this is real.
--   2. before/after NOT NULL. v20 leaves them nullable only because its
--      'created' action has no before and 'removed' has no after. A config
--      edit always has both; nullable would permit a meaningless row.
--   3. reason. A cadence change is a business decision ("client asked for
--      tighter patrol"), and v58 already established the column.
--   4. Narrow before/after rather than a whole-row snapshot — see below.
--
-- SCOPE, copied from v58's reasoning verbatim in spirit: before/after carry
-- ONLY the mutable configuration columns, e.g.
--
--     {"ping_interval_minutes": 30}  ->  {"ping_interval_minutes": 45}
--
-- A whole-row snapshot was rejected because "absorbs future columns without
-- a migration" and "archives future columns without anyone deciding to" are
-- THE SAME PROPERTY. `sites` has seventeen columns including address and
-- geocode; a full copy would start shadowing them the moment anyone adds an
-- eighteenth. The jsonb still absorbs a new CONFIG key for free.
--
-- ── Retention: none of its own, and the cascade is DEFENSIVE ─────────────
--
-- The FK is ON DELETE CASCADE for consistency with v58 — but unlike v58 it
-- is never expected to fire, and that difference is worth stating rather
-- than inheriting by copy-paste.
--
-- v58's cascade is operational: jobs/nightlyPurge.ts deletes shifts at
-- RETENTION.SHIFT_DAYS = 1460. Sites are different. There is NO
-- `DELETE FROM sites` anywhere in the codebase — a site is only ever
-- soft-deactivated via PATCH /api/sites/:id/active — `sites` has no
-- expires_at, and nightlyPurge does not touch it. So this table is
-- PERMANENT by construction, which is the correct lifetime for a
-- configuration history: the question it answers ("what was this site set
-- to in August, and who changed it") outlives any single shift.
--
-- The cascade therefore exists so that IF a hard delete is ever added, the
-- audit does not become an orphan pointing at a site that no longer exists.
-- It is not doing work today. No expires_at, and no nightlyPurge step: a
-- retention column that nothing purges is a promise that enforces nothing,
-- which this codebase has been bitten by before (see the S3 versioning
-- note in docs/OPS).
--
-- ── action: a single-value CHECK, deliberately ───────────────────────────
--
-- Only 'site_ping_interval_changed' is admitted, matching v58's single-value
-- form. A constraint should describe what exists, not what might.
--
-- KNOWN COST, so it is not a surprise later: Postgres has no ALTER for a
-- CHECK body, so auditing the schema_v47 toggles (checkpoints_enabled,
-- vehicle_inspection_required) later means DROP CONSTRAINT + ADD CONSTRAINT
-- in a new migration. The table NAME is deliberately generic —
-- site_config_audit, not site_ping_interval_audit — so that migration is a
-- constraint change and not a second table.
--
-- ── Idempotent, and why no DO-block ─────────────────────────────────────
--
-- migrate.ts replays every file in its array on EVERY invocation, so
-- re-runnability is load-bearing, not decorative.
--
-- CREATE TABLE IF NOT EXISTS covers the table and every constraint declared
-- inside it — the FK and both CHECKs are part of the CREATE, so they are
-- skipped with it. CREATE INDEX IF NOT EXISTS covers the indexes. COMMENT ON
-- is unconditionally idempotent. Nothing here is a bare ADD CONSTRAINT
-- against a pre-existing table, which is the one shape with no IF NOT EXISTS
-- — that is why schema_v69 needed a DO-block guard on pg_constraint and this
-- file does not.
--
-- Verified against production before writing: to_regclass('public.
-- site_config_audit') IS NULL, both index names unused, no constraint name
-- beginning site_config_audit, uuid-ossp installed, and sites.id is uuid.

CREATE TABLE IF NOT EXISTS site_config_audit (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  site_id         uuid        NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  action          text        NOT NULL CHECK (action IN ('site_ping_interval_changed')),

  -- WHO. The sites row carries no actor and no updated_at, so this is the
  -- only place an actor can exist for a configuration change. Both roles put
  -- their JWT `sub` in changed_by; the role disambiguates which table that
  -- uuid lives in.
  changed_by      uuid        NOT NULL,
  changed_by_role varchar(20) NOT NULL
    CHECK (changed_by_role IN ('company_admin','vishnu')),
  changed_at      timestamptz NOT NULL DEFAULT now(),

  -- WHY. Optional free-text note from the admin, same shape and intent as
  -- shift_schedule_audit.reason and shift_reassignments.reason.
  reason          text,

  -- WHAT. NOT NULL on both: a configuration edit always has a before and an
  -- after. (guard_assignment_audit leaves these nullable only because its
  -- 'created' action has no before and 'removed' has no after.)
  before          jsonb       NOT NULL,
  after           jsonb       NOT NULL
);

-- Site-detail panel reads by site, newest first.
CREATE INDEX IF NOT EXISTS site_config_audit_site_id_idx
  ON site_config_audit (site_id, changed_at DESC);

-- Cross-site feed / "what did this admin change last week".
CREATE INDEX IF NOT EXISTS site_config_audit_changed_at_idx
  ON site_config_audit (changed_at DESC);

COMMENT ON TABLE site_config_audit IS
  'Per-row history of admin edits to a site''s configuration. The ONLY record that such an edit occurred: sites has no updated_at and the columns are overwritten in place. Written atomically with the UPDATE by the owning route.';

COMMENT ON COLUMN site_config_audit.before IS
  'Mutable configuration columns as they were immediately before the edit, e.g. {"ping_interval_minutes":30}. DELIBERATELY NOT a whole-row snapshot — see this migration''s header for the scope-creep reasoning. Add a key here only for a column an audited endpoint can actually mutate.';

COMMENT ON COLUMN site_config_audit.after IS
  'Same keys as `before`, holding the values written by the edit. Comparing the two is the whole record of what changed.';

COMMENT ON COLUMN site_config_audit.changed_by IS
  'JWT sub of the acting admin (company_admin) or super-admin (vishnu). NOT a FK: company_admins and the vishnu identity live in different tables, exactly as shift_schedule_audit.changed_by and shift_reassignments.reassigned_by_admin_id do it.';

COMMENT ON COLUMN site_config_audit.site_id IS
  'FK is ON DELETE CASCADE for consistency with shift_schedule_audit, but is never expected to fire: no DELETE FROM sites exists in the codebase and sites are only soft-deactivated. This table is permanent by construction.';
