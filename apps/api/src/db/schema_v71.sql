-- schema_v71 — creation attribution and provenance for shifts (2026-09-09)
--
-- NUMBERING: v70 is the highest entry in migrate.ts and the highest file on
-- disk; both were re-read at HEAD (7de9e0c) immediately before writing this,
-- and prod confirms v70 applied. v71 is free. Read the chain off migrate.ts,
-- never from a brief — it has three recorded collisions (v46 -> v50,
-- v51 -> v52, and v54 taken overnight).
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through piped
-- psql is a silent no-op in autocommit (learned applying v54).
SET LOCAL lock_timeout = '3s';

-- ── Why these columns exist ──────────────────────────────────────────────
--
-- `shifts` records WHAT was scheduled and nothing about WHO scheduled it or
-- HOW. Verified against prod at 7de9e0c: the table has exactly 18 columns,
-- attnum 1..18 contiguous, and there is no created_by, no created_by_role,
-- no source, and no updated_at. 511 rows created between 2026-07-13 and
-- 2026-09-08 carry no creator and no provenance.
--
-- That is not merely untidy. All three INSERT sites live in one route,
-- routes/shifts.ts POST / (:288 specific_dates, :397 repeat_days, :432
-- single), and that handler never reads req.user.sub at all — its only four
-- req.user references are company_id for tenant scoping. Meanwhile seven
-- scripts in apps/api/scripts/ can INSERT INTO shifts directly against prod
-- (each builds its own pool from DATABASE_URL; four document `railway run`
-- in their own docblocks). A script-created row and an admin-created row are
-- today INDISTINGUISHABLE in the schema.
--
-- `source` is the forward-looking half. A later phase generates shifts from
-- site_scheduling_profiles; verified at 7de9e0c that NOTHING does so today
-- (site_profile_shifts is named by exactly one executable file,
-- routes/scheduling.ts, which contains no INSERT INTO shifts). Once a
-- generator exists there is no way to tell a generated row from a typed one
-- without this column — `shifts` has no profile_id and no slot_id either.
--
-- ── Why created_by has NO foreign key ────────────────────────────────────
--
-- Deliberate, and it matches all four existing audit tables
-- (shift_schedule_audit v58, site_config_audit v70, guard_assignment_audit
-- v20, shift_reassignments v15) — none of which FKs its actor column.
--
-- Actors live in FOUR different places: guards, company_admins, clients, and
-- the super-admin, which has NO DB ROW AT ALL. `vishnu` authenticates off
-- VISHNU_JWT_SECRET against a vishnu_state singleton keyed `id integer = 1`
-- with no uuid column, and mints the sentinel sub
-- 00000000-0000-0000-0000-000000000000 (routes/auth.ts:595). A uuid FK to any
-- one table would reject that sentinel outright.
--
-- The codebase already paid for this lesson: geofence_violations.override_by
-- FKs to company_admins, so the vishnu branch deliberately stores NULL
-- (routes/admin.ts:492) and the actor survives only in a Sentry breadcrumb.
-- In prod override_by is populated on 0 of 40 rows. Do not add an FK here.
--
-- created_by_role is what makes the bare uuid resolvable, exactly as v58 and
-- v70 do. It is the discriminator, not decoration: without it, a uuid alone
-- cannot be looked up because you do not know which table to look in.
-- guard_assignment_audit (v20) omits it and is the one audit table in this
-- schema where a super-admin action would write the all-zeros sentinel with
-- nothing beside it to say what the uuid means.
--
-- ── Existing rows ────────────────────────────────────────────────────────
--
-- source picks up 'manual' from the DEFAULT. On PG 11+ an ADD COLUMN with a
-- non-volatile DEFAULT is a catalog-only rewrite, so this does not rewrite
-- 511 rows and does not hold ACCESS EXCLUSIVE for meaningful time.
--
-- created_by and created_by_role stay NULL on historical rows and that is
-- CORRECT: we genuinely do not know who created them, and there is no
-- surviving record anywhere to reconstruct it from (shift_reassignments and
-- shift_schedule_audit hold 23 + 19 rows against 511 shifts, and neither
-- records creation). A backfill would be an invention. Both columns are
-- therefore NULLable forever, not NULLable-pending-backfill.
--
-- ── Domain of created_by_role ────────────────────────────────────────────
--
-- 'company_admin' and 'vishnu' are the two roles the API's UserRole union
-- admits on an admin path (middleware/auth.ts:6). 'guard' is included because
-- two shift write paths are ALREADY requireAuth('guard') and rewrite
-- guard_id — POST /:id/swap-response (:1766) and POST /:id/handoff-clock-in
-- (:2314) — and a later phase may want to attribute a guard-initiated
-- creation. 'system' is for a future generator job, which has no req.user at
-- all; the codebase's existing machine-attribution precedent is a
-- CHECK-enumerated string, break_sessions.ended_by ('break_expiry' from
-- breakExpiryCron.ts:64, 'auto_complete' from autoCompleteShifts.ts:123),
-- not a uuid. Nothing writes 'guard' or 'system' in this phase.
--
-- 'client' is deliberately EXCLUDED. Clients are read-only on this surface
-- and no write path admits them; including it would advertise a capability
-- that does not exist.
--
-- ── Scope: this migration is additive and inert ──────────────────────────
--
-- Nothing reads these columns. No API response exposes them, no UI renders
-- them, no index covers them, and no code writes them until the next commit.
-- shift_schedule_audit is deliberately NOT touched: its CHECK pins action to
-- the single value 'shift_schedule_edited' and its changed_by_role CHECK
-- admits only company_admin|vishnu (so a guard-initiated change cannot be
-- recorded there at all). Widening either is a separate decision with its own
-- migration.

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS created_by uuid;

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS created_by_role varchar(16);

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS source varchar(16) NOT NULL DEFAULT 'manual';

-- Idempotent: ADD CONSTRAINT has no IF NOT EXISTS in Postgres, and this file
-- is expected to be re-run (whether by migrate.ts's array replay or by hand),
-- so the DO-block guard is load-bearing rather than decorative.
--
-- The guard is qualified with conrelid, following schema_v8.sql:31-34 rather
-- than the unqualified form in schema_v69.sql:52, schema_v46.sql:60 and
-- schema_v26.sql:34. pg_constraint is unique on (conrelid, contypid, conname),
-- NOT on conname alone: an unqualified guard would be satisfied by a
-- same-named constraint on ANY other table and would then skip creating this
-- one while still reporting success. No collision exists today (prod: zero
-- constraints named chk_shifts_source or chk_shifts_created_by_role on any
-- table, and zero duplicate connames anywhere in public), so this costs
-- nothing now and removes the failure mode permanently.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_shifts_source'
       AND conrelid = 'shifts'::regclass
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT chk_shifts_source
      CHECK (source IN ('manual', 'profile'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_shifts_created_by_role'
       AND conrelid = 'shifts'::regclass
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT chk_shifts_created_by_role
      CHECK (created_by_role IS NULL
             OR created_by_role IN ('company_admin', 'vishnu', 'guard', 'system'));
  END IF;
END $$;
