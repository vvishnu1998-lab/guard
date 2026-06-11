-- schema_v20.sql — Phase B
--
-- guard_assignment_audit: per-row history of every write to
-- guard_site_assignments. Mirrors the per-domain audit pattern set by
-- shift_reassignments rather than the auth-only auth_events table.
--
-- Why no FK on assignment_id: the DELETE path writes an audit row IN THE
-- SAME TRANSACTION as the parent delete. A real FK with ON DELETE CASCADE
-- would wipe the audit immediately; ON DELETE SET NULL would lose the
-- back-link the moment the row is gone. We want the original UUID
-- preserved as a soft reference so audit rows for the same assignment can
-- be grouped across its full lifetime, even after removal. The `before`
-- jsonb captures the row snapshot so nothing depends on the parent row
-- still existing.
--
-- Idempotent: IF NOT EXISTS on the table + the indexes. Safe to re-run.

CREATE TABLE IF NOT EXISTS guard_assignment_audit (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  assignment_id uuid NOT NULL,
  action        text NOT NULL CHECK (action IN (
                  'guard_assignment_created',
                  'guard_assignment_ended',
                  'guard_assignment_removed'
                )),
  changed_by    uuid NOT NULL,
  changed_at    timestamptz NOT NULL DEFAULT now(),
  before        jsonb,
  after         jsonb
);

CREATE INDEX IF NOT EXISTS guard_assignment_audit_assignment_id_idx
  ON guard_assignment_audit(assignment_id);

CREATE INDEX IF NOT EXISTS guard_assignment_audit_changed_at_idx
  ON guard_assignment_audit(changed_at DESC);
