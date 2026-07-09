/**
 * Expire pending guard-to-guard swap requests older than 15 minutes.
 *
 * Runs every minute. Uses the partial index on
 * shift_swap_requests(requested_at) WHERE status = 'pending' so the
 * scan stays cheap regardless of historical row volume.
 *
 * For each expired row: mark status='expired' and push the requester
 * (A) so they know nobody accepted and can contact admin instead.
 * Push is best-effort; a delivery failure never leaves the row
 * un-expired.
 *
 * Exports `runExpireSwapRequestsOnce()` for smoke-test / manual
 * invocation — the cron just calls it on the schedule.
 */
import cron from 'node-cron';
import { pool } from '../db/pool';
import { pushSwapExpiredToRequester, pushHandoffExpiredToRequester } from '../services/swapPush';

export async function runExpireSwapRequestsOnce(): Promise<number> {
  // Phase 2 additive: RETURNING now includes initiated_by so we can route
  // to the correct push helper. Handoff invites and pre-shift swaps share
  // the 15-min window and this cron; only the outbound push copy differs.
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
        AND ssr.requested_at < NOW() - INTERVAL '15 minutes'
        AND sh.id = ssr.shift_id
      RETURNING ssr.id, ssr.shift_id, ssr.from_guard_id, si.name AS site_name, ssr.initiated_by`,
  );
  if (!result.rowCount) return 0;

  // Fire-and-forget pushes; loop awaits so we don't return before the
  // batch dispatches, but individual failures don't block the batch.
  for (const row of result.rows) {
    const p = row.initiated_by === 'guard_handoff'
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
  console.log(`[expire-swap] marked ${result.rowCount} row(s) expired`);
  return result.rowCount;
}

cron.schedule('* * * * *', async () => {
  try {
    await runExpireSwapRequestsOnce();
  } catch (err) {
    console.error('[expire-swap] tick failed:', err);
  }
});
