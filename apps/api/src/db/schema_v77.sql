-- schema_v77 — guard double-booking exclusion constraint (N45, 2026-09-14)
--
-- NUMBERING: v76 is the highest file on disk AND the highest entry in
-- db/migrate.ts. Both re-read at HEAD (243e4b3) immediately before writing
-- this. Read the chain off migrate.ts, never off a brief — v76's header
-- records four prior collisions (v46->v50, v51->v52, v54 taken overnight,
-- and v15 reserved in docs/06-IMPLEMENTATION-PLAN.md then taken by the
-- shift-reassignment audit table).
--
-- STATEMENT COUNT: three (SET LOCAL, CREATE EXTENSION, DO block), and that
-- is fine. The one-statement-per-file rule (schema_v72, schema_v73) exists
-- ONLY for CREATE INDEX CONCURRENTLY, which refuses the implicit transaction
-- that migrate.ts:14's simple-protocol client.query(sql) wraps around a
-- multi-statement file (SQLSTATE 25001). NOTHING HERE IS CONCURRENTLY.
-- CREATE EXTENSION and ALTER TABLE ... ADD CONSTRAINT are both transactional
-- DDL, and within one transaction the ALTER sees the operator class the
-- CREATE EXTENSION just registered — verified on local PG 18.6, below.
--
-- APPLYING BY HAND: `psql -1`. SET LOCAL through piped psql in autocommit is
-- a silent no-op (learned applying v54, and observed again while proving
-- this file locally: psql -f without -1 emits
-- "WARNING: SET LOCAL can only be used in transaction blocks").
--
-- ── WHAT THIS CLOSES ─────────────────────────────────────────────────────
--
-- N45. Every guard-overlap check in routes/shifts.ts is check-then-act under
-- READ COMMITTED. Where a lock exists it is FOR UPDATE OF sh on the row
-- being MUTATED, which is a different row from the one that would collide.
-- Two concurrent requests can both pass and both write.
--
-- PROVEN LOCALLY, not argued: PG 18.6, two concurrent psql sessions running
-- the predicate from services/shiftOverlap.ts:101-103 verbatim. Both checks
-- returned 0. Without the constraint both INSERTs land. With it, A committed
-- and B raised 23P01; one row exists instead of two.
--
-- ── WHY btree_gist IS MANDATORY ──────────────────────────────────────────
--
-- `guard_id WITH =` needs a GiST operator class for uuid. Verified against
-- PRODUCTION at this ref: pg_opclass carries uuid opclasses for brin, btree
-- and hash only — there is NO gist entry. btree_gist supplies
-- gist_uuid_ops, declared DEFAULT FOR TYPE uuid (btree_gist--1.2--1.3.sql
-- :45-46), which is why the EXCLUDE clause below names no opclass.
-- CONFIRMED EMPIRICALLY on local 18.6: before the extension, zero gist/uuid
-- opclasses; after, gist/gist_uuid_ops with opcdefault = t, and the
-- constraint builds unqualified.
--
-- The range half needs nothing: gist/range_ops (anyrange) is built in.
--
-- Prod has btree_gist 1.8 AVAILABLE but not installed (pg_extension holds
-- only plpgsql and uuid-ossp), and the app role is `postgres`, rolsuper.
--
-- ── [) NOT [] ────────────────────────────────────────────────────────────
--
-- tstzrange defaults to lower-inclusive / upper-exclusive, which is exactly
-- services/shiftOverlap.ts:101-103's strict `<` and `>`. With [] a shift
-- ending 16:00 and one starting 16:00 would share that instant, && would
-- return true, and the constraint would reject a back-to-back pair the
-- product deliberately permits. shiftOverlap.ts:13-16: "a guard is free the
-- instant the prior shift ends, and there is deliberately NO rest-gap rule."
-- Locally verified both ways: back-to-back ACCEPTED, one-minute overlap
-- REJECTED with 23P01.
--
-- ── THE PARTIAL PREDICATE MUST TRACK services/shiftOverlap.ts:101 ────────
--
-- All six overlap predicates in routes/shifts.ts read IN ('scheduled',
-- 'active') at this ref (:673 :834 :1487 :1806 :1885 :2248 as of 243e4b3),
-- and so does the shared builder. Drift is NOT symmetric:
--   app widens, this does not  -> app refuses writes this would allow.
--                                 Conservative; a false 409, never a
--                                 double-book.
--   this widens, app does not  -> writes 23P01 at commit. Loud.
--   app narrows                -> this still catches the double-book. Which
--                                 is the entire point of having it.
-- Postgres cannot enforce the agreement. This comment and the one in
-- services/shiftOverlap.ts are the only binding.
--
-- ── guard_id IS NULLABLE, AND THAT IS HANDLED TWICE ──────────────────────
--
-- An exclusion constraint conflicts only when EVERY operator returns TRUE.
-- NULL = NULL is NULL, never TRUE, so an unassigned row can never conflict —
-- including with another unassigned row. Verified locally: two exactly
-- overlapping rows with guard_id NULL and status 'scheduled' both inserted.
--
-- Today the WHERE clause does all the work anyway: all 5 unassigned rows in
-- prod carry status='unassigned', so zero NULL-guard rows enter the index.
-- Both mechanisms are wanted. Nothing enforces
-- guard_id IS NULL <-> status='unassigned' — routes/shifts.ts:602 checks
-- both precisely because "the two agree on all 189 production rows, but
-- nothing enforces that agreement."
--
-- ── ADDS VALIDATED. NO `NOT VALID`, NO BACKFILL ─────────────────────────
--
-- Re-derived against production 2026-09-14 02:51 UTC with the operators
-- below, not with hand-rolled comparisons: ZERO violating pairs. All 37
-- historical overlapping pairs are terminal-status (cancelled / completed /
-- missed) and fall outside the filter, so there is no decision to make about
-- existing rows. Also checked, because they abort an ALTER even at zero
-- violations: zero rows with scheduled_start > scheduled_end (which would
-- raise 22000 building the range), zero empty ranges, zero pre-existing
-- exclusion constraints on shifts.
--
-- RE-RUN THAT CHECK IMMEDIATELY BEFORE APPLYING. It is a snapshot, and an
-- admin can create a genuinely overlapping scheduled pair in between:
--
--   SELECT count(*) FROM shifts a JOIN shifts b
--       ON b.id > a.id AND a.guard_id = b.guard_id
--      AND tstzrange(a.scheduled_start, a.scheduled_end)
--          && tstzrange(b.scheduled_start, b.scheduled_end)
--    WHERE a.status IN ('scheduled','active')
--      AND b.status IN ('scheduled','active');
--
-- ── LOCK ─────────────────────────────────────────────────────────────────
--
-- The ALTER builds its index NON-concurrently and holds ACCESS EXCLUSIVE on
-- shifts for the build: every reader and writer blocks. 586 rows / 328 kB —
-- sub-second. The lock_timeout guards against queuing behind someone else's
-- long transaction, not against this statement's own work. Prefer the
-- CONDITION deploy window (zero active STARNET shifts, zero open sessions).
--
-- ── IDEMPOTENT, AND THAT IS STRUCTURAL ───────────────────────────────────
--
-- There is no migration tracking table — db/migrate.ts re-runs EVERY file on
-- EVERY invocation — so a non-idempotent file breaks the chain for good.
-- CREATE EXTENSION IF NOT EXISTS is a no-op where installed. ADD CONSTRAINT
-- has NO IF NOT EXISTS form and raises 42710 on a re-run, so it carries the
-- pg_constraint guard that schema_v71.sql:124-149 established and
-- schema_v74.sql:107-118 reused. Replay verified locally: no 42710.
--
-- ── ROLLBACK ─────────────────────────────────────────────────────────────
--
--   ALTER TABLE shifts DROP CONSTRAINT shifts_no_guard_overlap;
--
-- drops the constraint and its index together — ACCESS EXCLUSIVE, but a
-- catalog delete and an index unlink, no data work. LEAVE THE EXTENSION: it
-- installs operator classes only, changes no data, and costs nothing. Never
-- DROP EXTENSION ... CASCADE — that drops this constraint as a side effect.
--
-- AND REMOVE THIS FILE FROM migrate.ts, or the next `npm run db:migrate`
-- re-creates the constraint. Reverting the PR does both.

SET LOCAL lock_timeout = '3s';

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'shifts_no_guard_overlap'
       AND conrelid = 'shifts'::regclass
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT shifts_no_guard_overlap
      EXCLUDE USING gist (
        guard_id                                  WITH =,
        tstzrange(scheduled_start, scheduled_end) WITH &&
      ) WHERE (status IN ('scheduled', 'active'));
  END IF;
END $$;
