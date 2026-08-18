/**
 * Break Expiry — runs every minute (schema_v46 package, 2026-08-18).
 *
 * Until this job existed, planned_duration_minutes was display-only: the
 * reddy session of 2026-08-17 ran a 30-minute meal break for 112 minutes
 * with no cap, no flag, and no notification. Now:
 *
 *   Step 1 — AUTO-CLOSE: any open break past its plan is closed server-side
 *     with break_end = break_start + plan (not NOW(), so cron lag never
 *     inflates the deduction), duration_minutes = plan exactly, and
 *     ended_by = 'break_expiry'. Obligations resume immediately — nothing
 *     here (or anywhere) suppresses pings, reports, or geofence enforcement
 *     during a break, by design.
 *
 *   Step 2 — OVERRUN FINALIZATION: for auto-closed breaks, determine
 *     whether the guard was off post after expiry and for how long. Overrun
 *     is NEVER deducted from total_hours — it is recorded on the break row
 *     (overrun_minutes + overrun_flagged_at) for a human to review via the
 *     admin sessions endpoints. Evidence rules:
 *       off-post evidence  = off_post_events row or geofence_violations
 *                            occurred_at after break_end
 *       back-on-post proof = onsite ping (location_pings rows are onsite by
 *                            construction), violation resolved_at, or a
 *                            geofence-validated clock-out
 *     No off-post evidence → overrun_minutes = 0, no flag. We record what
 *     we can prove, we do not guess from silence.
 *
 * Idempotency: Step 1's predicate (break_end IS NULL) can match a row only
 * once; Step 2's (overrun_minutes IS NULL) likewise. Re-runs are no-ops.
 *
 * The guard-facing pushes at expiry and expiry+10 live in this tick too —
 * see notifyExpiredBreaks (Phase 4 of the package).
 *
 * Worker functions are exported for testability, mirroring
 * autoCompleteShifts.ts.
 */

import cron from 'node-cron';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { Sentry } from '../services/sentry';

export interface ExpiredBreak {
  id: string;
  shift_session_id: string;
  guard_id: string;
  site_id: string;
  break_type: string;
  planned_duration_minutes: number;
  break_start: Date;
  break_end: Date;
}

/** Step 1 — close every open break that has outlived its plan. */
export async function closeExpiredBreaks(client: PoolClient): Promise<ExpiredBreak[]> {
  const result = await client.query<ExpiredBreak>(
    `UPDATE break_sessions
        SET break_end = break_start + make_interval(mins => planned_duration_minutes),
            duration_minutes = planned_duration_minutes,
            ended_by = 'break_expiry'
      WHERE break_end IS NULL
        AND break_start + make_interval(mins => planned_duration_minutes) <= NOW()
      RETURNING id, shift_session_id, guard_id, site_id, break_type,
                planned_duration_minutes, break_start, break_end`
  );
  return result.rows;
}

/**
 * Step 2 — finalize overrun for auto-closed breaks whose verdict is still
 * open. Set-size is tiny (auto-closed AND unfinalized), so per-row UPDATEs
 * are fine.
 */
export async function finalizeOverruns(client: PoolClient): Promise<{
  finalized: number;
  flagged: number;
}> {
  const pending = await client.query<{
    id: string;
    break_end: Date;
    shift_session_id: string;
    clocked_out_at: Date | null;
    clock_out_within_geofence: boolean | null;
    first_onsite: Date | null;
    first_offpost: Date | null;
  }>(
    `SELECT bs.id, bs.break_end, bs.shift_session_id,
            ss.clocked_out_at, ss.clock_out_within_geofence,
            LEAST(
              (SELECT MIN(lp.pinged_at) FROM location_pings lp
                WHERE lp.shift_session_id = bs.shift_session_id
                  AND lp.pinged_at > bs.break_end),
              (SELECT MIN(gv.resolved_at) FROM geofence_violations gv
                WHERE gv.shift_session_id = bs.shift_session_id
                  AND gv.resolved_at > bs.break_end)
            ) AS first_onsite,
            LEAST(
              (SELECT MIN(ope.occurred_at) FROM off_post_events ope
                WHERE ope.shift_session_id = bs.shift_session_id
                  AND ope.occurred_at > bs.break_end),
              (SELECT MIN(gv.occurred_at) FROM geofence_violations gv
                WHERE gv.shift_session_id = bs.shift_session_id
                  AND gv.occurred_at > bs.break_end)
            ) AS first_offpost
       FROM break_sessions bs
       JOIN shift_sessions ss ON ss.id = bs.shift_session_id
      WHERE bs.ended_by = 'break_expiry'
        AND bs.overrun_minutes IS NULL`
  );

  let finalized = 0;
  let flagged = 0;
  for (const row of pending.rows) {
    // A validated clock-out is back-on-post proof too.
    const onsiteAt: Date | null =
      row.first_onsite ??
      (row.clocked_out_at && row.clock_out_within_geofence === true
        ? row.clocked_out_at
        : null);
    const sessionClosed = row.clocked_out_at !== null;

    const offpostSeen =
      row.first_offpost !== null &&
      (onsiteAt === null || row.first_offpost < onsiteAt);

    let overrunMinutes: number | null = null;
    let flag = false;

    if (offpostSeen && onsiteAt) {
      overrunMinutes = minutesBetween(row.break_end, onsiteAt);
      flag = true;
    } else if (offpostSeen && sessionClosed) {
      overrunMinutes = minutesBetween(row.break_end, row.clocked_out_at!);
      flag = true;
    } else if (!offpostSeen && (onsiteAt || sessionClosed)) {
      // Proven back, or session over with zero off-post evidence: clean.
      overrunMinutes = 0;
    } else {
      continue; // verdict still open — retry next tick
    }

    await client.query(
      `UPDATE break_sessions
          SET overrun_minutes = $1,
              overrun_flagged_at = CASE WHEN $2 THEN NOW() ELSE NULL END
        WHERE id = $3 AND overrun_minutes IS NULL`,
      [overrunMinutes, flag, row.id]
    );
    finalized++;
    if (flag) flagged++;
  }
  return { finalized, flagged };
}

function minutesBetween(a: Date, b: Date): number {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
}

cron.schedule('* * * * *', async () => {
  const tickStart = Date.now();
  const client = await pool.connect();
  try {
    const closed = await closeExpiredBreaks(client);
    const overruns = await finalizeOverruns(client);

    if (closed.length > 0 || overruns.finalized > 0) {
      console.log(
        `[breakExpiry] auto-closed ${closed.length} break(s), ` +
        `finalized ${overruns.finalized} overrun verdict(s) (${overruns.flagged} flagged)`
      );
    }
    console.info('[break_expiry.tick]', {
      breaks_closed:      closed.length,
      overruns_finalized: overruns.finalized,
      overruns_flagged:   overruns.flagged,
      duration_ms:        Date.now() - tickStart,
    });
  } catch (err) {
    console.error('[breakExpiry] Error:', err);
    Sentry.captureException(err, {
      tags: { flow: 'break_expiry' },
      fingerprint: ['break_expiry', 'tick_error'],
      extra: { tick_start: new Date(tickStart).toISOString() },
    });
  } finally {
    client.release();
  }
});
