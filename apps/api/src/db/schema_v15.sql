-- Schema v15 — Shift reassignment audit trail
--
-- New table backing the admin "Reassign Guard" feature. Each row records
-- one reassignment of a shift from one guard to another, including who
-- performed it (company admin or vishnu sentinel) and an optional reason.
--
-- Background: until v15 there was no way for an admin to record that a
-- shift had been moved off the originally-assigned guard. The only
-- workaround was a manual UPDATE to shifts.guard_id, which left no audit
-- trail. The Reassign Guard flow writes here in the same transaction as
-- the shifts.guard_id update so the two never desynchronize.
--
-- reassigned_by_admin_id is intentionally NOT a foreign key — the vishnu
-- super-admin uses the sentinel UUID '00000000-0000-0000-0000-000000000000'
-- which doesn't exist in the company_admins table. reassigned_by_role
-- distinguishes the two principal types ('company_admin' vs 'vishnu').

CREATE TABLE IF NOT EXISTS shift_reassignments (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id               UUID         NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  old_guard_id           UUID         REFERENCES guards(id),
  new_guard_id           UUID         NOT NULL REFERENCES guards(id),
  reassigned_by_admin_id UUID         NOT NULL,
  reassigned_by_role     VARCHAR(20)  NOT NULL
    CHECK (reassigned_by_role IN ('company_admin','vishnu')),
  reason                 TEXT,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shift_reassignments_shift
  ON shift_reassignments (shift_id);
