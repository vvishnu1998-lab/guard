-- schema_v58 — audit trail for admin edits to a shift's scheduled hours (2026-08-25)
--
-- NUMBERING NOTE: v57 (the ping-reminder window claim) is the highest entry
-- in migrate.ts and the highest file on disk; both were re-read immediately
-- before writing this. v58 is free. Read off migrate.ts at HEAD, never from
-- a brief — this chain has three recorded collisions (v46 -> v50, v51 -> v52,
-- and v54 taken overnight).
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through
-- piped psql is a silent no-op in autocommit (learned applying v54).
SET LOCAL lock_timeout = '3s';

-- ── Why this table exists ────────────────────────────────────────────────
--
-- PATCH /api/shifts/:id (the schedule edit) mutates scheduled_start and
-- scheduled_end. `shifts` has NO updated_at column and no history anywhere,
-- so without this table an edit leaves LITERALLY NO TRACE: two columns
-- change value and nothing else in the database differs. The previous
-- schedule is not merely hard to reconstruct, it is gone.
--
-- That matters because these two columns are billing inputs.
-- services/shiftHours.ts:107 recomputes scheduled_hours from them LIVE, in
-- SQL, on every read — so it FOLLOWS an edit, silently changing a figure
-- that has already gone to a paying customer in the daily client email and
-- the hours export. Meanwhile shift_sessions.total_hours was frozen at
-- clock-out from the OLD scheduled_start (routes/shifts.ts:2990,
-- jobs/autoCompleteShifts.ts:142) and does NOT follow. After an edit the
-- two disagree permanently and neither row records why.
--
-- Every sibling mutation already audits: reassign -> shift_reassignments,
-- guard-site assignment changes -> guard_assignment_audit, cancel ->
-- shifts.cancellation_reason. An unaudited edit would be the only admin
-- shift mutation leaving no trace.
--
-- ── Modelled on guard_assignment_audit (v20), with one deliberate change ─
--
-- FORM is copied: before/after jsonb rather than shift_reassignments' fixed
-- columns. Two mutable columns today; a third (site_id, say) becomes a code
-- change rather than a migration.
--
-- SCOPE is NOT copied. guard_assignment_audit snapshots the WHOLE parent
-- row because guard_site_assignments rows are DELETED in normal operation
-- and the audit has to stand in for a parent that no longer exists — its
-- own docblock says exactly that. A schedule edit deletes nothing; the
-- shift row survives and only two columns move. So `before`/`after` here
-- carry ONLY the mutable schedule columns:
--
--     {"scheduled_start": "2026-09-01T02:00:00.000Z",
--      "scheduled_end":   "2026-09-01T14:00:00.000Z"}
--
-- A whole-row snapshot was rejected for two reasons. First, retention:
-- jobs/nightlyPurge.ts:355 deletes shifts at expires_at < NOW() AND
-- legal_hold = false (RETENTION.SHIFT_DAYS = 1460). A full row copy living
-- in a second table is a shadow of `shifts` with a different lifetime —
-- either it escapes that purge, or it is destroyed by it. Second, "absorbs
-- future columns without a migration" and "archives future columns without
-- anyone deciding to" are THE SAME PROPERTY. If someone later adds a notes
-- or contact column to shifts, a whole-row snapshot starts copying it into
-- this table silently. Narrow keeps the audit about the thing being
-- audited. The jsonb still absorbs a new SCHEDULE column for free.
--
-- ── Retention: deliberately none of its own ──────────────────────────────
--
-- FK is ON DELETE CASCADE, matching shift_reassignments (v15) rather than
-- guard_assignment_audit (which deliberately has no FK, because its parent
-- is deleted operationally). A shift is deleted only by the 1460-day
-- retention purge — genuine end-of-life, not an operational event — and an
-- audit of a schedule change to a shift that no longer exists has no
-- reader. So this table has NO expires_at and needs NO nightlyPurge step:
-- it lives exactly as long as the shift it describes. Adding an expires_at
-- that nothing purges would be a retention column that enforces nothing,
-- which this codebase has been bitten by before.
--
-- Idempotent: IF NOT EXISTS on the table and both indexes. Safe to re-run,
-- which migrate.ts does on every single boot.

CREATE TABLE IF NOT EXISTS shift_schedule_audit (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_id        uuid        NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  action          text        NOT NULL CHECK (action IN ('shift_schedule_edited')),

  -- WHO. A5: the shifts row carries no actor and no updated_at, so this is
  -- the only place an actor can exist for a schedule change. Mirrors
  -- shift_reassignments.reassigned_by_admin_id / _by_role — both roles put
  -- their JWT `sub` in changed_by.
  changed_by      uuid        NOT NULL,
  changed_by_role varchar(20) NOT NULL
    CHECK (changed_by_role IN ('company_admin','vishnu')),
  changed_at      timestamptz NOT NULL DEFAULT now(),

  -- WHY. Optional free-text note from the admin, same shape and intent as
  -- shift_reassignments.reason.
  reason          text,

  -- WHAT. NOT NULL on both: an edit always has a before and an after.
  -- (guard_assignment_audit leaves these nullable only because its
  -- 'created' action has no before and 'removed' has no after.)
  before          jsonb       NOT NULL,
  after           jsonb       NOT NULL
);

-- Detail-page panel reads by shift, newest first.
CREATE INDEX IF NOT EXISTS shift_schedule_audit_shift_id_idx
  ON shift_schedule_audit (shift_id, changed_at DESC);

-- Cross-shift feed / "what did this admin change last week".
CREATE INDEX IF NOT EXISTS shift_schedule_audit_changed_at_idx
  ON shift_schedule_audit (changed_at DESC);

COMMENT ON TABLE shift_schedule_audit IS
  'Per-row history of admin edits to a shift''s scheduled_start/scheduled_end. The ONLY record that such an edit occurred: shifts has no updated_at and the columns are overwritten in place. Written atomically with the UPDATE by PATCH /api/shifts/:id.';

COMMENT ON COLUMN shift_schedule_audit.before IS
  'Mutable schedule columns as they were immediately before the edit, e.g. {"scheduled_start":"...","scheduled_end":"..."}. DELIBERATELY NOT a whole-row snapshot — see this migration''s header for the retention and scope-creep reasoning. Add a key here only for a column the edit endpoint can actually mutate.';

COMMENT ON COLUMN shift_schedule_audit.after IS
  'Same keys as `before`, holding the values written by the edit. Comparing the two is the whole record of what changed.';

COMMENT ON COLUMN shift_schedule_audit.changed_by IS
  'JWT sub of the acting admin (company_admin) or super-admin (vishnu). NOT a FK: company_admins and the vishnu identity live in different tables, exactly as shift_reassignments.reassigned_by_admin_id does it.';
