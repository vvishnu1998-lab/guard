-- Schema v80 — clock_in_verifications becomes hold-aware, and selfie_url
-- becomes nullable so its photo can be purged without losing the row
--
-- Tier 1 (docs/OPS/POLICY.md:18-24): expand-only DDL plus a one-row backfill
-- INSIDE the migration. Nothing here narrows a type, drops a column, or
-- touches STARNET data — the single row it updates belongs to Star Guard
-- (a different tenant with a confusingly similar name; check the id, not the
-- prefix: STARNET is 27c4d404-8769-49ca-bfd6-93cb9b890067).
--
-- ORDERING: apply BEFORE the API code that reads these columns is deployed.
-- routes/admin.ts gains a cascade line on clock_in_verifications.legal_hold
-- and routes/locations.ts inherits it at INSERT; against a database without
-- the columns both raise 42703. Apply, then merge. (expand-then-extend.)
--
-- ── WHY clock_in_verifications NEEDS A HOLD AT ALL ──────────────────────
--
-- The retention rebuild's next PR adds a step that deletes the clock-in
-- SELFIE at 30 days while keeping the row to 365. That step destroys an S3
-- object, and this table has no legal_hold column, so the step would have no
-- predicate that could spare held evidence.
--
-- That is not hypothetical. Measured 2026-09-19: the platform's only legal
-- hold sits on session e9d49c9e-7c96-495a-ab52-d4b08bb9ffa3, and its
-- clock-in verification 89c861f3-1d5c-43c1-bac3-2880ac26d49a carries a real
-- clock_in/ selfie, verified_at 2026-07-13T20:21:39.515Z — 68 days old, so
-- already past 30. A hold-blind 30d step would delete the clock-in selfie of
-- the one held session on the platform, on its first live night.
--
-- The standing rule that follows: no step that destroys an S3 object ships
-- without a hold predicate.
--
-- ── WHY THE BACKFILL IS NOT THE de9aa0b0 SHAPE ──────────────────────────
--
-- Ping de9aa0b0 needed a hand-run one-row script (scripts/ops/) because it
-- was a TIMING miss: the row was written 29m58s AFTER the hold was stamped,
-- so the one-shot cascade could not have matched it, and the repair keyed on
-- a specific id that would match nothing on a fresh database.
--
-- 89c861f3 is a STRUCTURAL miss instead. It was verified at 20:21:39.515Z,
-- SIX MINUTES NINETEEN SECONDS BEFORE the hold at 20:27:58.744Z — the row
-- already existed when the hold was placed. The cascade did not miss it by
-- timing; there was no column to set and no line to set it with.
--
-- That difference is why this backfill belongs in the migration rather than
-- in an ops script. It is expressed as a predicate over STATE, not as an id:
-- "a verification whose session is held is held". It is idempotent, it
-- matches zero rows on a fresh database, and it will stay correct if another
-- hold is placed before this is applied.
--
-- Neither insert-time inheritance nor the new cascade line would reach this
-- row on their own. Inheritance only affects new INSERTs; the cascade line
-- only fires when a hold is placed or released from now on, and this hold
-- was placed in July and is not going to be re-placed. Without this
-- statement the row stays unheld.
--
-- ── VALIDATION (every statement run as a SELECT against production first) ──
--   selfie_url          is_nullable=NO, 0 existing NULLs, 0 CHECK constraints,
--                       0 partial indexes referencing it -> DROP NOT NULL is
--                       safe and strictly widening
--   legal_hold/_at      0 of 2 present -> both ADDs are genuine
--   backfill            matches exactly 1 row; 346 rows left untouched;
--                       0 orphans; would set legal_hold_at =
--                       2026-07-13T20:27:58.744Z, the parent's own value
--   COMMENT ON          current text still says "NOW() + 365 days"
--   clock-out rows      45 of 45 already equal clocked_out_at + 90 days, so
--                       the writer fix in this PR needs NO backfill

BEGIN;

-- ── 1. The photo can now be removed without losing the evidence row ──────
--
-- selfie_url is varchar(1000) NOT NULL. The 30d photo step must write NULL
-- into it — the same shape nightlyPurge step 1 uses on
-- location_pings.photo_url — while the row itself lives to 365 days carrying
-- its GPS, accuracy and geofence verdict. NOT NULL makes that impossible:
-- the step would have to delete the row and take the evidence with it.
--
-- Strictly widening. No existing row has a NULL, nothing CHECKs it, and no
-- index is predicated on it. One reader changes behaviour: routes/
-- locations.ts:966 passes `selfie_url ?? null`, which raises 23502 today and
-- becomes a legitimate NULL after this. That is the more honest outcome — it
-- is also why 11 rows hold the literal string 'pending'.
ALTER TABLE clock_in_verifications ALTER COLUMN selfie_url DROP NOT NULL;

-- ── 2. The hold columns, same shape as the other nine tables ─────────────
--
-- legal_hold NOT NULL DEFAULT false matches every other hold-bearing table,
-- so the purge predicate `AND legal_hold = false` reads identically here.
-- legal_hold_at stays nullable, as v78 made it everywhere else: NULL means
-- "not held", and on a cascade row it carries the PARENT's hold time rather
-- than NOW(), because "held since" is the question it answers.
ALTER TABLE clock_in_verifications
  ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE clock_in_verifications
  ADD COLUMN IF NOT EXISTS legal_hold_at TIMESTAMPTZ;

-- ── 3. Backfill: a verification whose session is held is held ────────────
--
-- Expect: UPDATE 1.
--
-- legal_hold_at is inherited from the parent session, not stamped NOW() —
-- same rule as v78's backfill and as services/legalHold.ts. The row was
-- frozen when the session was frozen; NOW() would assert it was frozen on
-- the day this migration ran, which is false.
--
-- The predicate is deliberately over-specified: `ss.legal_hold` alone would
-- be enough, and `c.legal_hold = false` alone would be enough. Together they
-- make a second run report UPDATE 0, and make a session whose hold has since
-- been RELEASED correctly do nothing rather than re-freeze evidence an admin
-- deliberately let go.
UPDATE clock_in_verifications c
   SET legal_hold    = true,
       legal_hold_at = (SELECT ss.legal_hold_at FROM shift_sessions ss
                         WHERE ss.id = c.shift_session_id)
 WHERE c.legal_hold = false
   AND EXISTS (SELECT 1 FROM shift_sessions ss
                WHERE ss.id = c.shift_session_id AND ss.legal_hold);

-- ── 4. The clock-out photo comment has said 365 since schema_v55 ─────────
--
-- The tier is 90 days: v79:237 moved every row to clocked_out_at + 90 days
-- and the writer at routes/shifts.ts now stamps the same expression. This
-- comment was the last place still asserting 365.
--
-- Its three prerequisites are re-stated because two have moved: (2) the
-- dry-run gate is being replaced by a per-step allowlist in this same PR,
-- and (1) a purge step is being written. (3) was stated here as unmoved:
-- versioning on with no NoncurrentVersionExpiration rule. Corrected
-- 2026-09-26 (N123): the bucket has lifecycle rule "noncurrent-30d",
-- NoncurrentVersionExpiration NoncurrentDays 60 (the id says 30), so a delete
-- here writes a delete marker and the bytes expire 60 days later.
--
-- The COMMENT ON text below was corrected the same day. migrate.ts replays
-- every file on every run, so the next db:migrate against a database rewrites
-- that column comment; until then a database keeps the earlier text.
COMMENT ON COLUMN shift_sessions.clock_out_photo_delete_at IS
  'When the clock-out photo becomes eligible for deletion: clocked_out_at + 90 days, '
  'the tier locked 2026-09-19 (schema_v79.sql:237). NULL when no photo was taken. '
  'Was NOW() + 365 days from schema_v55 until 2026-09-19; the writer at '
  'routes/shifts.ts and schema_v79 now use the same expression. '
  'BEFORE RELYING ON A PURGE THAT SCANS THIS COLUMN: (1) the step is being added in the '
  'retention part-2 PR and is dry-run until named in RETENTION_LIVE_STEPS. '
  '(2) enforcement is per-step via that allowlist; an absent or malformed variable leaves '
  'every step in dry-run. (3) S3 bucket guard-media-prod has versioning ENABLED, so a live '
  'purge writes a delete marker and the bytes become a noncurrent version: billed and '
  'retrievable via GetObjectVersion until lifecycle rule noncurrent-30d expires them '
  '(NoncurrentVersionExpiration, NoncurrentDays 60; read 2026-09-26). '
  'Add an index on this column at the same time as the purge that scans it.';

-- ── 5. The two indexes the new steps will scan ──────────────────────────
--
-- The COMMENT ON below carries a standing instruction from its own author:
-- "Add an index on this column at the same time as the purge that scans it."
-- These are that, plus the same for the table this migration just made
-- hold-aware. They belong with the columns they serve, not in a follow-up
-- migration nobody remembers to write.
--
-- NEITHER WILL BE USED TODAY, AND THAT IS NOT AN ARGUMENT AGAINST THEM.
-- clock_in_verifications holds 347 rows and shift_sessions 345, so the
-- planner will Seq Scan both whatever exists — an index is only cheaper once
-- the heap outgrows a few pages. The platform is ten weeks old; these are for
-- the first year when it is not, and nightlyPurge step 1 is the warning
-- (it Seq Scans 861 candidate rows today against an index that DOES exist,
-- because the row count has not yet crossed over).
--
-- Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run inside a
-- transaction block, and this migration is one. At three hundred rows the
-- ACCESS EXCLUSIVE lock is held for microseconds. If either table is in the
-- millions when this is finally applied, split these two statements out and
-- run them CONCURRENTLY outside the transaction instead.

-- Serves BOTH new clock_in_verifications steps — the 30d photo sweep and the
-- 365d row delete — because both lead on verified_at and both filter
-- legal_hold = false. Same shape as the EIGHT existing partial tier indexes
-- (checkpoint_scans, geofence_violations, location_pings, reports,
-- shift_sessions, shifts, task_completions, vehicle_inspections — counted
-- 2026-09-19, not recalled). The photo step additionally filters
-- `selfie_url IS NOT NULL`; that stays a heap filter rather than a second
-- index, because verified_at is the selective half and one index that serves
-- two steps beats two that each serve one.
CREATE INDEX IF NOT EXISTS idx_clock_in_verifications_verified_at
  ON clock_in_verifications (verified_at) WHERE legal_hold = false;

-- Mirrors idx_location_pings_photo_delete, which is the direct analogue: a
-- photo-nulling step on a table whose ROWS survive it. The partial predicate
-- is the photo column rather than legal_hold because it is far more
-- selective here — 45 of 345 sessions have a clock-out photo at all, and
-- shift_sessions already has idx_shift_sessions_expires_at WHERE
-- legal_hold = false for the row-level step 6.
CREATE INDEX IF NOT EXISTS idx_shift_sessions_clock_out_photo_delete
  ON shift_sessions (clock_out_photo_delete_at) WHERE clock_out_photo_url IS NOT NULL;

COMMIT;
