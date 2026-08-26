/**
 * Expire pending guard-to-guard swap and handoff requests.
 *
 * Runs every minute. Uses the partial index
 * idx_shift_swap_requests_pending_requested (requested_at) WHERE
 * status = 'pending' to narrow the scan to the pending pool.
 *
 * For each expired row: mark status='expired' and push the requester
 * (A) so they know nobody accepted and can contact admin instead.
 * Push is best-effort; a delivery failure never leaves the row
 * un-expired.
 *
 * ── DEADLINES ARE KIND-AWARE ────────────────────────────────────────────
 *
 * Both kinds used to share one flat 15-minute window. They no longer do,
 * because they are answering different questions:
 *
 *   guard_handoff    A is ON POST right now and cannot leave until someone
 *                    takes over. The clock is A standing there, so the
 *                    window is short and absolute: 30 minutes.
 *
 *   guard_pre_shift  Nobody is stuck. The only hard fact is that the shift
 *                    starts eventually, so the window is bounded by the
 *                    shift itself, not by a stopwatch: at most 24h, and
 *                    normally closing an hour before start so an unanswered
 *                    request still leaves someone time to re-cover it.
 *
 * The pre-shift deadline is
 *   LEAST(requested_at + 24h, scheduled_start - 1h)
 * with one correction for late requests: when `scheduled_start - 1h` has
 * ALREADY passed at request time, that expression collapses to a deadline
 * at or before requested_at and the invite would expire the instant it was
 * created. A request made 30 minutes before the shift instead runs to
 * scheduled_start, giving the recipient the time that actually remains.
 *
 * NOTE ON THE SPEC. The policy was handed down as
 * "LEAST(requested_at + 24h, scheduled_start - 1h), clamped to
 * [requested_at, scheduled_start]". Read literally, a 09:30 request for a
 * 10:00 shift expires at 09:30 — immediately — because the clamp pins it to
 * the lower bound. The stated intent for that same case was 10:00. This
 * implements the intent. It also makes the upper clamp meaningful: under
 * the literal reading LEAST(...) is always < scheduled_start, so clamping
 * to scheduled_start could never bind.
 *
 * Verified against Postgres for the three reference cases:
 *   request 48h out          → requested_at + 24h
 *   request 22:00 for 10:00  → 09:00  (scheduled_start - 1h)
 *   request 09:30 for 10:00  → 10:00  (scheduled_start)
 *
 * ── ACCESS PATTERN ──────────────────────────────────────────────────────
 *
 * The deadline is computed per row rather than persisted, because this
 * statement already joins `shifts` to reach si.name for the push copy — so
 * scheduled_start is in scope for free and an expires_at column would be a
 * denormalised copy that has to be maintained on every shift reschedule.
 * The cost is that the partial index now narrows to the pending pool and
 * the deadline is evaluated as a filter over it, instead of a range scan on
 * requested_at. That pool is bounded by this very cron and is a handful of
 * rows at any moment; revisit if pending volume ever grows.
 *
 * Exports `runExpireSwapRequestsOnce()` for smoke-test / manual
 * invocation — the cron just calls it on the schedule.
 */
import cron from 'node-cron';
import { pool } from '../db/pool';
import { pushSwapExpiredToRequester, pushHandoffExpiredToRequester } from '../services/swapPush';

/** A is stuck on post while this runs. Deliberately short. */
export const HANDOFF_EXPIRY_MINUTES = 30;
/** Hard ceiling on how long a pre-shift invite may sit unanswered. */
export const SWAP_MAX_AGE_HOURS = 24;
/** Normal pre-shift close-off ahead of the shift, so there is still time to re-cover. */
export const SWAP_LEAD_HOURS = 1;

/**
 * The expiry instant for a row, as a SQL expression over `ssr` and `sh`.
 *
 * Exported so anything else keying off the same deadline — notably the
 * halfway reminder — derives it from this one definition instead of
 * restating the policy. Two copies of this expression would drift, and the
 * failure would be silent: reminders firing at the wrong fraction of a
 * window nobody re-checked.
 *
 * Contains no user input; every value is a literal from the constants
 * above.
 */
export const SWAP_DEADLINE_SQL = `
  CASE WHEN ssr.initiated_by = 'guard_handoff'
       THEN ssr.requested_at + INTERVAL '${HANDOFF_EXPIRY_MINUTES} minutes'
       ELSE LEAST(
              ssr.requested_at + INTERVAL '${SWAP_MAX_AGE_HOURS} hours',
              CASE WHEN sh.scheduled_start - INTERVAL '${SWAP_LEAD_HOURS} hours' <= ssr.requested_at
                   THEN sh.scheduled_start
                   ELSE sh.scheduled_start - INTERVAL '${SWAP_LEAD_HOURS} hours'
              END
            )
  END`;

export async function runExpireSwapRequestsOnce(): Promise<number> {
  // RETURNING carries initiated_by so we can route to the correct push
  // helper and log the two kinds separately — before this they were
  // indistinguishable in Railway logs, which made "did the handoff window
  // change take effect?" unanswerable from the logs alone.
  const result = await pool.query<{
    id:            string;
    shift_id:      string;
    from_guard_id: string;
    site_name:     string;
    initiated_by:  string;
  }>(
    `UPDATE shift_swap_requests ssr
        SET status = 'expired'
      FROM shifts sh
      JOIN sites  si ON si.id = sh.site_id
      WHERE ssr.status = 'pending'
        AND sh.id = ssr.shift_id
        AND NOW() >= (${SWAP_DEADLINE_SQL})
      RETURNING ssr.id, ssr.shift_id, ssr.from_guard_id, si.name AS site_name, ssr.initiated_by`,
  );
  if (!result.rowCount) return 0;

  // Fire-and-forget pushes; loop awaits so we don't return before the
  // batch dispatches, but individual failures don't block the batch.
  // Copy is unchanged from the flat-15-minute era — the guard-facing
  // message ("nobody accepted, contact admin") is the same regardless of
  // how long the window was.
  let handoffs = 0;
  let swaps    = 0;
  for (const row of result.rows) {
    const isHandoff = row.initiated_by === 'guard_handoff';
    if (isHandoff) handoffs += 1;
    else           swaps    += 1;

    const p = isHandoff
      ? pushHandoffExpiredToRequester({
          fromGuardId: row.from_guard_id,
          siteName:    row.site_name,
          shiftId:     row.shift_id,
          historyId:   row.id,
        })
      : pushSwapExpiredToRequester({
          fromGuardId: row.from_guard_id,
          siteName:    row.site_name,
          shiftId:     row.shift_id,
          historyId:   row.id,
        });
    p.catch((err) => console.error('[expire-swap] push failed for history', row.id, err));
  }

  // One line per kind, and only for kinds that actually expired, so a tick
  // that expires two handoffs does not also print "0 swaps" and invite the
  // reader to wonder which window applied.
  if (handoffs) {
    console.log(`[expire-swap] handoff: ${handoffs} row(s) expired (window ${HANDOFF_EXPIRY_MINUTES}m)`);
  }
  if (swaps) {
    console.log(`[expire-swap] swap: ${swaps} row(s) expired (window ${SWAP_MAX_AGE_HOURS}h / start-${SWAP_LEAD_HOURS}h)`);
  }
  return result.rowCount;
}

cron.schedule('* * * * *', async () => {
  try {
    await runExpireSwapRequestsOnce();
  } catch (err) {
    console.error('[expire-swap] tick failed:', err);
  }
});
