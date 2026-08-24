-- schema_v56 — clock-out reminder sentinel (2026-08-24)
--
-- NUMBERING NOTE: v55 (the clock-out photo columns) is the highest entry in
-- migrate.ts and was applied earlier today. v56 is free. Read off migrate.ts
-- at HEAD, never from a brief — this chain has three recorded collisions
-- (v46 -> v50, v51 -> v52, and v54 taken overnight).
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through
-- piped psql is a silent no-op in autocommit (learned applying v54).
SET LOCAL lock_timeout = '3s';

-- ── Once-per-session guarantee for the pre-end clock-out reminder ────────
--
-- jobs/clockOutReminder.ts fires one push per session, five minutes before
-- scheduled_end. "Once" needs a durable claim, not a query.
--
-- WHY NOT THE EXISTING QUERY GUARD. pingReminder.ts:137
-- alreadyRemindedRecently() does SELECT EXISTS over the notifications table
-- and then sends. That is read-then-decide: two overlapping cron ticks both
-- read false and both send. It also only ever answers "not in the last five
-- minutes", which is the right question for a RECURRING nag and the wrong
-- one for a fire-once event. Correct for its job, insufficient for this one.
--
-- This column is claimed with an atomic UPDATE ... WHERE
-- clock_out_reminder_sent_at IS NULL ... RETURNING, so the row is won before
-- the push is attempted and a losing tick returns zero rows. Same idiom as
-- jobs/handoffNudge.ts, whose comment records the same reasoning ("so two
-- cron ticks racing don't double-nudge").
--
-- ── WHY shift_sessions AND NOT shifts ───────────────────────────────────
--
-- Every other *_sent_at sentinel lives on `shifts`: pre_shift_reminder_sent_at
-- and start_reminder_sent_at (v17), late_10/late_15/late_admin_email (v37),
-- missed_alert_sent_at (v4). All six concern the shift lifecycle BEFORE
-- clock-in — a shift that may have no session at all.
--
-- This one is the first reminder about an IN-PROGRESS session. It can only
-- ever be sent to a guard who has an open shift_sessions row, so the sentinel
-- belongs where the thing it guards lives: a no-show shift should not carry a
-- clock-out-reminder column forever, and the requirement is explicitly
-- once per SESSION. Co-locating it with the other clock_out_* columns also
-- means the claim UPDATE targets the same table the eligibility predicate
-- reads.
--
-- NULL = not yet reminded. Set to NOW() when the claim is won. Never reset.
ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS clock_out_reminder_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN shift_sessions.clock_out_reminder_sent_at IS
  'Claim marker for the pre-end clock-out reminder (jobs/clockOutReminder.ts). '
  'NULL = not yet sent. Written by an atomic UPDATE ... WHERE '
  'clock_out_reminder_sent_at IS NULL ... RETURNING so two racing cron ticks '
  'cannot both send; the loser gets zero rows. Never reset it — the reminder '
  'is once per session by design.';

-- Partial index on the claim predicate. Unlike v55's inert
-- clock_out_photo_delete_at, this column IS scanned — every five minutes, by
-- the reminder cron, and the partial WHERE keeps the index to just the open
-- unreminded sessions rather than the whole table's history.
CREATE INDEX IF NOT EXISTS idx_shift_sessions_clockout_reminder_pending
  ON shift_sessions (shift_id)
  WHERE clock_out_reminder_sent_at IS NULL AND clocked_out_at IS NULL;
