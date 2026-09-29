-- backfill-legal-hold-de9aa0b0.sql
--
-- NOT A MIGRATION. Deliberately absent from the migrate.ts chain: this is a
-- one-row repair to PRODUCTION data, and replaying it against a fresh
-- database would match nothing. Vishnu runs it by hand, once.
--
-- PREREQUISITE: schema_v78 must already be applied. This statement writes
-- location_pings.legal_hold_at, which v78 creates. Against an unmigrated
-- database it raises 42703 and changes nothing.
--
-- WHAT IT REPAIRS
-- ---------------
-- Ping de9aa0b0-680a-42f0-8b1f-9e5f44659a28 sits on shift_session
-- e9d49c9e-7c96-495a-ab52-d4b08bb9ffa3, which IS on legal hold, yet the ping
-- itself carries legal_hold = false.
--
-- This is not a cascade that failed. It is a cascade that could not have
-- succeeded. The hold was stamped on report 53fc82ec at 20:27:58.744Z; the
-- session stayed open another 57 minutes; the ping was written at
-- 20:57:56.376Z — 29m58s LATER. The one-shot UPDATE at admin.ts:372 matched
-- zero rows because the row did not exist yet, and nothing has re-applied a
-- hold in the 68 days since.
--
-- CONSEQUENCE IF LEFT ALONE: the ping is in nightlyPurge step 1's candidate
-- set (60+ days past photo_delete_at) and step 1 filters retain_as_evidence,
-- not legal_hold. A live run would NULL its photo_url — erasing the last
-- application-reachable pointer to the evidence photo for a held incident
-- report. The S3 object is already delete-markered but the noncurrent
-- version survives (271,643 bytes, VersionId
-- GV3sNMWf5C6Xhl2zJ9JoVhG1ztxFJxnK), so the bytes are recoverable only by
-- someone who already knows the key — which is the pointer this row is.
--
-- SCOPE: exactly one row. See the report for why the sibling report
-- 09ec2da1 (which PREDATES the hold by 5m17s) is deliberately NOT included.
--
-- ============================================================================
-- RUN INSIDE A TRANSACTION. Read step 1, run step 2, read step 3, then
-- COMMIT only if step 2 reported UPDATE 1 and step 3 shows held = true.
-- ============================================================================

BEGIN;

-- ── STEP 1 — BEFORE. Expect exactly one row, held = false, parent held = true.
SELECT lp.id,
       lp.pinged_at,
       lp.legal_hold                AS ping_held,
       lp.photo_delete_at,
       (lp.photo_delete_at < NOW()) AS past_photo_delete_at,
       ss.id                        AS session_id,
       ss.legal_hold                AS session_held,
       ss.legal_hold_at             AS session_held_since
  FROM location_pings lp
  JOIN shift_sessions ss ON ss.id = lp.shift_session_id
 WHERE lp.id = 'de9aa0b0-680a-42f0-8b1f-9e5f44659a28';

-- ── STEP 2 — THE REPAIR. Expect: UPDATE 1.
--
-- The predicate is deliberately over-specified. Three independent clauses,
-- each of which alone would prevent collateral damage:
--   * lp.id = ...            — one row, by primary key. Cannot widen.
--   * lp.legal_hold = false  — idempotent. A second run reports UPDATE 0.
--   * EXISTS (... ss.legal_hold) — self-validating. If the hold has since
--     been RELEASED, this correctly does nothing rather than re-freezing
--     evidence that an admin deliberately let go.
--
-- legal_hold_at is inherited from the parent session rather than stamped
-- NOW(), which is what the new code does at INSERT
-- (services/legalHold.ts) and what schema_v78's own backfill does. The row
-- was frozen when the report was frozen; NOW() would assert it was frozen
-- today, which is false.
UPDATE location_pings lp
   SET legal_hold    = true,
       legal_hold_at = (SELECT ss.legal_hold_at
                          FROM shift_sessions ss
                         WHERE ss.id = lp.shift_session_id)
 WHERE lp.id = 'de9aa0b0-680a-42f0-8b1f-9e5f44659a28'
   AND lp.legal_hold = false
   AND EXISTS (SELECT 1
                 FROM shift_sessions ss
                WHERE ss.id = lp.shift_session_id
                  AND ss.legal_hold);

-- ── STEP 3 — AFTER. Expect ping_held = true, held_since = 2026-07-13
--    20:27:58.744+00, and step1_candidate = false.
SELECT lp.id,
       lp.legal_hold    AS ping_held,
       lp.legal_hold_at AS held_since,
       (lp.photo_url IS NOT NULL
        AND lp.photo_delete_at < NOW()
        AND lp.retain_as_evidence = false) AS step1_candidate_predicate_today
  FROM location_pings lp
 WHERE lp.id = 'de9aa0b0-680a-42f0-8b1f-9e5f44659a28';

-- ============================================================================
-- READ THIS BEFORE ASSUMING THE ROW IS SAFE
-- ============================================================================
-- Step 3's last column will still read TRUE after this runs, and that is not
-- a bug in this script.
--
-- nightlyPurge step 1 (apps/api/src/jobs/nightlyPurge.ts:116-119) filters
-- `retain_as_evidence = false` and does NOT filter legal_hold. It is the one
-- step of nine that ignores the flag. `retain_as_evidence` is written by
-- nothing in the codebase, so it is false on all 1,190 ping rows.
--
-- That predicate is NOT changed on this branch. Verified: `git diff
-- origin/main HEAD -- apps/api/src/jobs/nightlyPurge.ts` is empty.
--
-- So setting legal_hold here does NOT by itself protect this row from a live
-- step 1. It is necessary and not sufficient. The row is only safe once the
-- step-1 predicate also reads legal_hold — Phase 0 sized that as a one-line
-- change (add `AND legal_hold = false`, drop the dead retain_as_evidence
-- clause) and it has not been briefed into a phase yet.
--
-- Until then the row's actual protection is that RETENTION_DRY_RUN is unset,
-- so step 1 deletes nothing at all. That is a circumstance, not a safeguard.

COMMIT;
