-- Schema v19 — Tier 2 Wave A: coord capture + flagging for clock-out, tasks, reports
--
-- Closes T2-A, T2-C, T2-D from the 2026-05-17 location-services audit. The
-- handler-side validation lands in a follow-up commit; this migration just
-- shapes the table so the code can write to it without 23502s.
--
-- All new columns nullable. Build 24 + older mobile clients don't send
-- coords for these endpoints; the handlers (Phase B) skip validation
-- entirely when all of {lat, lng, accuracy} aren't present. Tightening to
-- required coords gates on Build 25 shipping (per batch/mobile-1).
--
-- Expand-then-extend: applied to prod via railway run npm run db:migrate
-- BEFORE the matching handler code ships. See memory feedback_expand_then_extend.

-- (1) T2-A — clock-out: typed coords on shift_sessions.
--     (clock_in_coords stays as the legacy "lat,lng" VARCHAR. Migrating
--     it to typed columns is a separate v1.1 follow-up.)
ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS clock_out_lat              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS clock_out_lng              DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS clock_out_accuracy_meters  DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS clock_out_within_geofence  BOOLEAN;

-- (2) T2-C — task completion: accuracy + within-geofence flag.
ALTER TABLE task_completions
  ADD COLUMN IF NOT EXISTS completion_accuracy_meters DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS completion_within_geofence BOOLEAN;

-- (2a) Latent-bug fix on task_completions.completion_lat/lng.
--      Mobile (apps/mobile/app/tasks/complete/[id].tsx) silently sends
--      NULL on GPS failure (`catch { /* GPS optional */ }`); the current
--      NOT NULL constraint means those submits 23502 and 500 to the
--      client. Probe confirmed zero rows with NULL coords (constraint
--      blocks them), so DROP NOT NULL is a no-op for historical data
--      and a regression fix for the GPS-failure code path.
ALTER TABLE task_completions ALTER COLUMN completion_lat DROP NOT NULL;
ALTER TABLE task_completions ALTER COLUMN completion_lng DROP NOT NULL;

-- (3) T2-D — reports: persist coords + flag.
--     Today the wire payload already includes latitude/longitude (mobile
--     sends them) but the INSERT in routes/reports.ts drops them on the
--     floor — the columns don't exist. This migration creates them so
--     the Phase B handler can persist + validate.
ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS latitude            DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS longitude           DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS accuracy_meters     DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS is_within_geofence  BOOLEAN;
