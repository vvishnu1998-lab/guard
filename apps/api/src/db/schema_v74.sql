-- schema_v74 — shift_reassignments can record an UNASSIGN (2026-09-09)
--
-- NUMBERING: v73 is the highest entry in migrate.ts and the highest file on
-- disk; both were re-read at HEAD (408a5cf) immediately before writing this,
-- and prod confirms v71/v72/v73 applied. v74 is free. Read the chain off
-- migrate.ts, never from a brief — it has three recorded collisions
-- (v46 -> v50, v51 -> v52, and v54 taken overnight).
--
-- STATEMENT COUNT: four, and that is fine. The one-statement-per-file rule
-- (schema_v72.sql, schema_v73.sql) exists ONLY for CREATE INDEX CONCURRENTLY,
-- which refuses to run inside the implicit transaction that db/migrate.ts:14's
-- simple-protocol `client.query(sql)` creates around a multi-statement file.
-- This migration creates no index. A DDL ALTER inside a transaction is not
-- merely allowed, it is what we want — the widening and the constraint that
-- replaces it must land together or not at all.
--
-- APPLYING BY HAND: this file MUST run inside an explicit transaction —
-- `psql -1`, or a hand-typed BEGIN/COMMIT. `SET LOCAL` through piped psql in
-- autocommit is a SILENT no-op, which is how v54 was applied without its
-- lock_timeout and nobody noticed. With -1 the SET LOCAL below is real, and
-- the two ALTERs cannot half-apply.
SET LOCAL lock_timeout = '3s';

-- ── What changes, and why ────────────────────────────────────────────────
--
-- Verified against prod at 408a5cf: shift_reassignments (v15) holds 23 rows
-- in 48 kB, and its two guard columns are asymmetric —
--
--   old_guard_id  UUID     REFERENCES guards(id)   -- NULLABLE
--   new_guard_id  UUID NOT NULL REFERENCES guards(id)
--
-- The nullability of old_guard_id is not theoretical: 9 of the 23 rows carry
-- NULL there, meaning "this shift had nobody on it and now has someone." The
-- table can therefore already record an ASSIGN-from-nothing. It cannot record
-- the reverse.
--
-- Phase E gives an admin an override on guard deactivation that sets the
-- guard's future shifts to status='unassigned', guard_id=NULL. That is
-- precisely an unassign-to-nothing, and with new_guard_id NOT NULL there is
-- nowhere in the schema to write it. The alternatives were a second audit
-- table for one direction of an existing relation, or writing nothing at all.
-- Both are worse: the first splits one question across two tables, and the
-- second means the single most destructive scheduling action in the product
-- is the only one with no audit row. schema_v58.sql:30 already states the
-- house rule — "Every sibling mutation already audits: reassign ->
-- shift_reassignments".
--
-- After this migration the column pair reads as a transition, and the CHECK
-- below is what makes that reading enforceable rather than conventional:
--
--   old NULL, new SET    — assigned to somebody      (9 rows today)  ALLOWED
--   old SET,  new SET    — reassigned between guards (14 rows today) ALLOWED
--   old SET,  new NULL   — UNASSIGNED                (0 rows; new)   ALLOWED
--   old NULL, new NULL   — nobody to nobody                          FORBIDDEN
--
-- ── Why the CHECK ships in THIS file and not a later one ─────────────────
--
-- Widening new_guard_id makes (NULL, NULL) representable — a row asserting a
-- shift went from nobody to nobody. No writer produces one: the Phase 3
-- override always carries an old_guard_id, because a guard with no shifts
-- assigned to them generates no rows at all. The temptation is therefore to
-- rely on that and add nothing.
--
-- That temptation is exactly how the adjacent gap opened. `shifts` today has
-- no constraint tying status='unassigned' to guard_id IS NULL; the pairing
-- holds across all 8 unassigned rows in prod purely because every writer
-- happens to set both. Widening a column without stating what the new value
-- means is the mechanism, and it produces an invariant that lives only in the
-- heads of the people who wrote the writers. This file does not repeat it.
--
-- The constraint is also cheapest right now. It validates against all 23
-- existing rows (every one has new_guard_id NOT NULL, so every one passes
-- trivially) and costs one ACCESS EXCLUSIVE moment on a 48 kB table. Once a
-- NULL-new row exists, adding it means reasoning about live data first.
--
-- Note what the CHECK is NOT: it is weaker than the NOT NULL it partly
-- replaces, deliberately. It permits exactly one new state and forbids the
-- one that has no meaning. It is validated, not NOT VALID — at 23 rows there
-- is no reason to defer validation.
--
-- ── Cost ─────────────────────────────────────────────────────────────────
--
-- DROP NOT NULL is a catalog-only change. It does not rewrite the table, does
-- not revalidate rows, and does not touch the index or the FK. On PG 18 (prod
-- runs 18.6) a NOT NULL lives in pg_constraint as contype='n' — here named
-- shift_reassignments_new_guard_id_not_null — and this statement deletes that
-- catalog row. It takes ACCESS EXCLUSIVE for the duration, which at 23 rows is
-- microseconds; the lock_timeout above is the guard against waiting behind
-- someone else's long transaction, not against this statement's own work.
--
-- IDEMPOTENT BY CONSTRUCTION: DROP NOT NULL on an already-nullable column is a
-- no-op and does NOT raise. ADD CONSTRAINT has no IF NOT EXISTS form and DOES
-- raise 42710 on a re-run, so it is wrapped in the pg_constraint guard that
-- schema_v71.sql:124-149 established for exactly this — two CHECKs, same
-- shape. The whole file is therefore safe to re-run, including under
-- migrate.ts's full array replay, which as of 2026-09-09 cannot in fact reach
-- it (schema_v5.sql:10-12 aborts the replay with SQLSTATE 23514 at file 6 —
-- see N43).
--
-- The FOREIGN KEY shift_reassignments_new_guard_id_fkey is deliberately left
-- alone. A NULL satisfies a foreign key trivially, so the reference still
-- means "if there is a new guard, it is a real guard."

ALTER TABLE shift_reassignments
  ALTER COLUMN new_guard_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_shift_reassignments_direction'
       AND conrelid = 'shift_reassignments'::regclass
  ) THEN
    ALTER TABLE shift_reassignments
      ADD CONSTRAINT chk_shift_reassignments_direction
      CHECK (old_guard_id IS NOT NULL OR new_guard_id IS NOT NULL);
  END IF;
END $$;

COMMENT ON COLUMN shift_reassignments.new_guard_id IS
  'Guard the shift moved TO. NULL means the shift was UNASSIGNED — guard_id set to NULL and status set to ''unassigned'', which is what the Phase E deactivation override writes. Mirrors old_guard_id, where NULL has always meant the shift came from nobody. Both NULL is forbidden by chk_shift_reassignments_direction.';
