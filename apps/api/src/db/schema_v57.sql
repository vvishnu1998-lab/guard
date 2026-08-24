-- schema_v57 — once-per-window claim for the ping reminder.
--
-- jobs/pingReminder.ts had no catch-up: it fired only within ±60s of a
-- window close and never retried. A single skipped cron minute cost the
-- reminder outright, and because guards react to the push rather than to a
-- clock, it also cost the ping and then FLAGGED them for missing it.
-- Observed 2026-08-24 04:00Z: the tick gap 03:59:10 -> 04:01:05 cost Naveen
-- his 21:00 ping and produced the missed_pings row for it. He pings 10-56s
-- after every reminder he receives.
--
-- Widening the eligibility to a RANGE means a later tick can still fire, so
-- the job now needs to know which window it has already spoken for.
-- alreadyRemindedRecently() was a read-then-decide SELECT EXISTS over a
-- 5-minute notifications lookback: two ticks could both read "no" before
-- either wrote, and a wider range gives that race far more room.
--
-- One column, claimed atomically: the newest window START this session has
-- been reminded for. The claim is
--     UPDATE ... SET last_ping_reminder_window = $new
--      WHERE id = $id
--        AND (last_ping_reminder_window IS NULL OR last_ping_reminder_window < $new)
--   RETURNING id
-- which both tests and sets in one statement, so a racing tick matches zero
-- rows. Windows only ever advance, so "strictly greater than the last one"
-- is exactly the once-per-window guarantee, and it needs no second table.
--
-- Not indexed: the claim is keyed on shift_sessions.id, which is the PK.
--
-- NULL means no ping reminder has been sent for this session yet. Existing
-- rows backfill to NULL, which is correct — they predate the claim and
-- their windows are long closed.
ALTER TABLE shift_sessions
  ADD COLUMN IF NOT EXISTS last_ping_reminder_window TIMESTAMPTZ;

COMMENT ON COLUMN shift_sessions.last_ping_reminder_window IS
  'Start of the newest ping window this session has been reminded for. Claimed atomically by jobs/pingReminder.ts (UPDATE ... WHERE col IS NULL OR col < $new) to guarantee one reminder per window across a widened, catch-up-capable eligibility range. NULL = none sent yet.';
