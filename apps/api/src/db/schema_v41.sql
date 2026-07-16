-- Schema v41 — break_sessions.planned_duration_minutes
--
-- Server-driven break timer (Phase D Bug A fix). Prior break flow stored
-- the countdown duration only on the client via BREAK_OPTIONS constants
-- (meal=30, rest=15, other=10). Countdown was a pure setInterval on a
-- decrementing local counter — JS-thread suspension during backgrounding
-- froze the timer; walk-test 2026-07-15 surfaced 13-sec decrement across
-- 6 real minutes of background. Server had zero notion of the intended
-- duration and no way to reconcile on foreground.
--
-- This migration adds the source-of-truth column server-side. New writes
-- (post-Phase-1 code) populate it explicitly from a hardcoded map that
-- must stay in sync with the mobile BREAK_OPTIONS constant (see
-- apps/api/src/constants/breakDurations.ts). Legacy rows get backfilled
-- deterministically from break_type via the same map.
--
-- Ordering (all inside one migration file for atomicity per migrate.ts):
--   1. ADD COLUMN IF NOT EXISTS — nullable initially.
--   2. UPDATE backfill for existing rows (only touches NULL rows, so
--      idempotent across re-runs of this migration).
--   3. Temporary DEFAULT 30 — bridges the deploy window between
--      migrate-complete and container-reboot: OLD code (still running
--      on Railway during rollout) INSERTs break_sessions rows without
--      setting this column; the DEFAULT keeps those writes from
--      violating the NOT NULL constraint added in step 4. Value chosen
--      as `meal` duration since it's the largest and least likely to
--      cut a break short if the wrong path hits it. New code always
--      sets planned_duration_minutes explicitly. A follow-up migration
--      can drop the DEFAULT once we're confident no OLD-code writes
--      are in flight.
--   4. SET NOT NULL — enforced only AFTER backfill has filled every row
--      and the DEFAULT covers any concurrent write from OLD code.
--
-- All operations idempotent; safe to re-run.

ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS planned_duration_minutes INTEGER;

UPDATE break_sessions
   SET planned_duration_minutes = CASE break_type
     WHEN 'meal'  THEN 30
     WHEN 'rest'  THEN 15
     WHEN 'other' THEN 10
   END
 WHERE planned_duration_minutes IS NULL;

ALTER TABLE break_sessions ALTER COLUMN planned_duration_minutes SET DEFAULT 30;

ALTER TABLE break_sessions ALTER COLUMN planned_duration_minutes SET NOT NULL;
