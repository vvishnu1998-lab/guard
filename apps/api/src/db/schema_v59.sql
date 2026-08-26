-- schema_v59 — once-per-request claim for the swap halfway reminder.
--
-- NUMBERING NOTE: v58 (shift_schedule_audit) is the highest entry in
-- migrate.ts and the highest file on disk; both were re-read immediately
-- before writing this. v59 is free. Read off migrate.ts at HEAD, never from
-- a brief — this chain has recorded collisions (v46 -> v50, v51 -> v52, and
-- v54 taken overnight).
--
-- APPLYING BY HAND: wrap in an explicit BEGIN/COMMIT. SET LOCAL through
-- piped psql is a silent no-op in autocommit (learned applying v54).
SET LOCAL lock_timeout = '3s';

-- ── Why this column exists ───────────────────────────────────────────────
--
-- jobs/expireSwapRequests.ts now fires a reminder to the RECIPIENT when a
-- pending pre-shift swap passes the halfway point of its window. The window
-- is no longer a flat 15 minutes (v-none, code only): it is
-- LEAST(requested_at + 24h, scheduled_start - 1h), so halfway can be many
-- hours out and the cron will evaluate the same row on hundreds of
-- consecutive minute ticks while it sits past halfway and before expiry.
--
-- Without a claim the recipient gets one push PER TICK for the rest of the
-- window. That is not a nuisance, it is a pager: a swap requested 24h ahead
-- would send roughly 720 pushes.
--
-- Read-then-decide is not sufficient either. A SELECT EXISTS over recent
-- notifications is what jobs/pingReminder.ts used before v57, and two ticks
-- could both read "not yet sent" before either wrote. The correction there
-- was a claim column updated atomically, and this is the same shape:
--
--     UPDATE shift_swap_requests ssr
--        SET reminder_sent_at = NOW()
--      WHERE ... AND ssr.reminder_sent_at IS NULL
--     RETURNING ...
--
-- The UPDATE itself is the claim. Only the tick whose write lands gets rows
-- back, and only those rows are pushed. A second tick racing it sees the
-- stamped value and matches nothing.
--
-- ── Deliberately NOT backfilled ──────────────────────────────────────────
--
-- Every existing row keeps NULL. Stamping historical rows would assert a
-- reminder was sent that never was, and the column is read only under
-- status = 'pending' — every non-pending row is out of scope for the query
-- regardless of its value here. Prod had 0 pending rows when this was
-- written, so there is nothing to protect against an immediate first
-- reminder on deploy; a pending row already past halfway SHOULD be
-- reminded once, promptly, which is exactly what NULL produces.
--
-- ── No index ─────────────────────────────────────────────────────────────
--
-- The reminder query is gated on status = 'pending' first, which is served
-- by the existing partial index
-- idx_shift_swap_requests_pending_requested (requested_at) WHERE
-- status = 'pending'. The pending pool is bounded by this same cron and is
-- a handful of rows at any moment, so `reminder_sent_at IS NULL` is a cheap
-- filter over an already-tiny set. An index here would be write cost for no
-- read benefit.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Safe to re-run, which migrate.ts
-- does on every single boot.

ALTER TABLE shift_swap_requests
  ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;

COMMENT ON COLUMN shift_swap_requests.reminder_sent_at IS
  'When the halfway reminder push was sent to to_guard_id, or NULL if it has not been. Written ONLY as an atomic claim inside jobs/expireSwapRequests.ts (UPDATE ... WHERE reminder_sent_at IS NULL RETURNING), never read-then-written — the cron re-evaluates every pending row every minute, so without the claim a 24h window would send ~720 pushes. Pre-shift swaps only; guard_handoff rows are excluded by the query and stay NULL, because a handoff already has jobs/handoffNudge.ts for its own follow-up and its 30-minute window has no useful halfway point.';
