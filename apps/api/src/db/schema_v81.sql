-- Schema v81 — a shift must end after it starts (U5, D20; decision 5b, 2026-09-28)
--
-- Tier 1 (docs/OPS/POLICY.md:18-24): expand-only DDL. One CHECK on shifts, no
-- data change.
--
-- ── WHY ──────────────────────────────────────────────────────────────────
--
-- Until U5 no POST /api/shifts mode checked end > start (single and
-- repeat_days bind the client's instants as sent; specific_dates accepts
-- start_time = end_time as a zero-length shift), and only PATCH /:id did.
-- The routes now return 422 on every path, and this constraint makes the
-- database hold the invariant too, so a path added later, a script, or a
-- hand-written INSERT cannot write an inverted or zero-length shift.
--
-- It also replaces an accident. shifts_no_guard_overlap (v77) builds
-- tstzrange(scheduled_start, scheduled_end), which raises 22000 for an
-- inverted pair — but only for rows its WHERE admits (scheduled/active), and
-- the route answered that with a 500. A zero-length range is empty and passes
-- it. This CHECK covers every status and both shapes.
--
-- ── VALIDATION ───────────────────────────────────────────────────────────
--
-- Read-only against production 2026-09-28 15:43 PT: 0 of 837 shifts have
-- scheduled_end <= scheduled_start. NOT VALID then VALIDATE keeps the
-- ACCESS EXCLUSIVE part to a catalog change; VALIDATE scans under SHARE
-- UPDATE EXCLUSIVE. Applied by hand before the merge with
-- scripts/ops/v81_shifts_end_after_start*.sql, which asserts zero violators
-- first. RE-RUN THAT COUNT IMMEDIATELY BEFORE APPLYING — it is a snapshot.
--
-- ── IDEMPOTENT ───────────────────────────────────────────────────────────
--
-- db/migrate.ts re-runs every file on every invocation. ADD CONSTRAINT has no
-- IF NOT EXISTS form, so it carries the pg_constraint guard (schema_v71.sql,
-- schema_v77.sql). VALIDATE on an already-valid constraint is a no-op.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────
--
--   ALTER TABLE shifts DROP CONSTRAINT shifts_end_after_start;
--
-- and remove this file from migrate.ts, or the next db:migrate re-adds it.

SET LOCAL lock_timeout = '3s';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'shifts_end_after_start'
       AND conrelid = 'shifts'::regclass
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT shifts_end_after_start
      CHECK (scheduled_end > scheduled_start) NOT VALID;
  END IF;
END $$;

ALTER TABLE shifts VALIDATE CONSTRAINT shifts_end_after_start;
