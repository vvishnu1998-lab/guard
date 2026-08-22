-- schema_v52 — Wave 2 provenance coverage: the five remaining GPS writes
--
-- NUMBERING NOTE: this was dispatched as "v51". v51 is TAKEN — it is the
-- location_integrity_flags review queue, created and applied to production
-- earlier on 2026-08-22, and migrate.ts already runs through it. This is
-- v52. (Second numbering collision caught this way; the first was v46.)
--
-- ── PURPOSE ─────────────────────────────────────────────────────────────
--
-- Wave 1 (schema_v50) instrumented three write paths: location_pings,
-- clock_in_verifications, and shift_sessions clock-IN. Five client-
-- submitted GPS writes were left with no provenance at all. Each can record
-- a simulated position and the row cannot say so.
--
-- That is not hypothetical. On 2026-08-22, session 047534ca, a controlled
-- reproduction submitted TWO reports from a simulated position: both were
-- stored with the full coordinate and accuracy fingerprint, both scored
-- is_within_geofence = true, and neither carried any verdict — because the
-- columns did not exist. mock.reject could not fire on that route at all.
--
-- Enforcing on clock-in while reports stay uninstrumented does not protect
-- anything; it relocates the write.
--
-- ── THREE-STATE SEMANTICS — IDENTICAL TO v50, READ BEFORE QUERYING ──────
--
--   TRUE   the OS explicitly reported the fix came from a mock provider
--   FALSE  the OS explicitly reported it did NOT
--   NULL   UNKNOWN — iOS (expo-location exposes `mocked` on Android only),
--          a pre-OTA client, or an absent/malformed field.
--
--   NULL IS NEVER A REJECT CONDITION. Not here, not in the API, not ever.
--   iOS is permanently NULL by design, not by defect. A query written as
--   `WHERE location_mocked IS NOT TRUE` reads as an all-clear across the
--   entire iOS fleet — branch on all three states explicitly.
--
-- fix_age_ms is STORED RAW, INCLUDING NEGATIVES (a negative age means the
-- OS fix timestamp is ahead of the device clock — a skew signature, which
-- is signal). Only unstorable values degrade to NULL. Any query over these
-- columns MUST handle negatives; do not assume >= 0.
--
-- ── NAMING ──────────────────────────────────────────────────────────────
--
-- Each table keeps ITS OWN existing prefix convention. Verified against
-- information_schema before writing:
--
--   reports            latitude, accuracy_meters              → bare
--   checkpoint_scans   scan_lat, accuracy_m                   → bare
--   task_completions   completion_lat, completion_accuracy_meters
--                                                             → completion_
--   break_sessions     start_lat, start_accuracy_m            → start_
--   shift_sessions     clock_out_lat, clock_out_accuracy_meters
--                                                             → clock_out_
--
-- NOTE the deviation from the dispatch: task_completions is given
-- `completion_location_mocked` / `completion_fix_age_ms`, NOT the bare
-- names. Every other GPS column on that table carries the `completion_`
-- prefix, and "match each table's existing prefix convention" is the
-- governing rule. Bare names there would be the only unprefixed GPS columns
-- on the table. Flagged for approval rather than assumed.
--
-- No column is renamed. The pre-existing accuracy-naming inconsistency
-- (accuracy_meters / accuracy_m / *_accuracy_meters) is a separate ticket
-- and is deliberately NOT touched here.

-- ── 1. reports — HIGHEST PRIORITY ───────────────────────────────────────
-- Demonstrated the gap three times: 2026-08-21 (Nikith), 2026-08-22 02:13
-- (deepak), 2026-08-22 08:16 + 09:00 (controlled reproduction).

ALTER TABLE reports ADD COLUMN IF NOT EXISTS location_mocked BOOLEAN;
ALTER TABLE reports ADD COLUMN IF NOT EXISTS fix_age_ms       INTEGER;

COMMENT ON COLUMN reports.location_mocked IS
  'OS mock-provider flag. TRUE=mocked, FALSE=clean, NULL=unknown (iOS, pre-OTA, or absent). NULL IS NEVER A REJECT.';
COMMENT ON COLUMN reports.fix_age_ms IS
  'ms between the OS fix timestamp and request build. STORED RAW incl. negatives (negative = skewed device clock). NULL = unknown/unstorable.';

-- ── 2. shift_sessions — clock-OUT ───────────────────────────────────────
-- The other half of every shift's evidentiary record; it sets billable
-- hours. Wave 1 covered clock-IN only, so a shift could open with a
-- provenance-checked position and close with an unchecked one.
--
-- NOTE for the API layer: clock-out is PERSIST-AND-FLAG, never reject —
-- rejecting a clock-out strands a guard in an open session with no way to
-- close it, and autoCompleteShifts would close it later with NULL coords
-- anyway, destroying the very evidence this column exists to capture.

ALTER TABLE shift_sessions ADD COLUMN IF NOT EXISTS clock_out_location_mocked BOOLEAN;
ALTER TABLE shift_sessions ADD COLUMN IF NOT EXISTS clock_out_fix_age_ms      INTEGER;

COMMENT ON COLUMN shift_sessions.clock_out_location_mocked IS
  'OS mock-provider flag at clock-OUT. TRUE=mocked, FALSE=clean, NULL=unknown. Clock-out PERSISTS AND FLAGS, it NEVER rejects. Two reasons, the second decisive: (1) a rejected clock-out strands the guard in an open session with no way to close it; (2) autoCompleteShifts would close that session later with clock_out_lat, clock_out_lng, clock_out_accuracy_meters and clock_out_within_geofence ALL NULL - so rejecting does not prevent a mocked clock-out, it trades a flagged row that records the simulated position for a blank row that records nothing. Rejecting makes the evidence strictly worse.';
COMMENT ON COLUMN shift_sessions.clock_out_fix_age_ms IS
  'ms between the OS fix timestamp and request build at clock-OUT. STORED RAW incl. negatives. NULL = unknown/unstorable.';

-- ── 3. checkpoint_scans ─────────────────────────────────────────────────
-- Bare prefix, matching scan_lat / accuracy_m.
-- Do NOT touch validateAtCheckpoint: its budget deliberately omits
-- SAFETY_MARGIN_M and that asymmetry is intentional.

ALTER TABLE checkpoint_scans ADD COLUMN IF NOT EXISTS location_mocked BOOLEAN;
ALTER TABLE checkpoint_scans ADD COLUMN IF NOT EXISTS fix_age_ms       INTEGER;

COMMENT ON COLUMN checkpoint_scans.location_mocked IS
  'OS mock-provider flag. TRUE=mocked, FALSE=clean, NULL=unknown (iOS, pre-OTA, or absent). NULL IS NEVER A REJECT.';
COMMENT ON COLUMN checkpoint_scans.fix_age_ms IS
  'ms between the OS fix timestamp and request build. STORED RAW incl. negatives. NULL = unknown/unstorable.';

-- ── 4. task_completions ─────────────────────────────────────────────────
-- completion_ prefix, matching completion_lat / completion_accuracy_meters.
-- See the NAMING note above — this deviates from the dispatch's bare names
-- deliberately, and is flagged for approval.

ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS completion_location_mocked BOOLEAN;
ALTER TABLE task_completions ADD COLUMN IF NOT EXISTS completion_fix_age_ms      INTEGER;

COMMENT ON COLUMN task_completions.completion_location_mocked IS
  'OS mock-provider flag at task completion. TRUE=mocked, FALSE=clean, NULL=unknown. NULL IS NEVER A REJECT.';
COMMENT ON COLUMN task_completions.completion_fix_age_ms IS
  'ms between the OS fix timestamp and request build. STORED RAW incl. negatives. NULL = unknown/unstorable.';

-- ── 5. break_sessions ───────────────────────────────────────────────────
-- start_ prefix, matching start_lat / start_accuracy_m.
-- breakExpiryCron feeds start_lat/lng into validateAtSite to decide
-- off_post_pushed, so provenance here has downstream weight.

ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS start_location_mocked BOOLEAN;
ALTER TABLE break_sessions ADD COLUMN IF NOT EXISTS start_fix_age_ms      INTEGER;

COMMENT ON COLUMN break_sessions.start_location_mocked IS
  'OS mock-provider flag at break start. TRUE=mocked, FALSE=clean, NULL=unknown. NULL IS NEVER A REJECT.';
COMMENT ON COLUMN break_sessions.start_fix_age_ms IS
  'ms between the OS fix timestamp and request build. STORED RAW incl. negatives. NULL = unknown/unstorable.';

-- ── NOT DONE HERE, DELIBERATELY ─────────────────────────────────────────
--
--   * No NOT NULL, no DEFAULT — both would rewrite live tables belonging to
--     a paying customer for zero benefit. Adding nullable columns with no
--     default is metadata-only on modern Postgres.
--   * No index. Nothing queries these on a hot path yet, and an index on an
--     all-NULL column earns nothing.
--   * No backfill. Existing rows have no provenance and never will.
--   * No accuracy ceiling. Still uncalibrated; the honest observed range is
--     0.01 m to 660.41 m and the 660.41 m reading was a real guard on a
--     real overnight shift.
--   * No change to validateAtSite, to validateAtCheckpoint, or to any
--     accept/reject branch. This migration is columns only.
--   * geofence_violations and off_post_events stay out: the former stores
--     the SITE CENTRE rather than a measured position (fix that first or
--     skip the table), the latter is server-derived and should inherit
--     provenance from its source row rather than re-collect it.
