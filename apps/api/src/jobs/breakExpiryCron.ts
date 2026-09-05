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

import { runJob } from './_run';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { Sentry } from '../services/sentry';
import { insertNotification } from '../services/notifications';
import { sendPushNotification } from '../services/firebase';
import { getActivePushToken } from '../services/deviceRegistry';
import { validateAtSite } from '../services/geofence';

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

/**
 * Shared push helper — Alerts row FIRST (the DB feed is the source of
 * truth; the swap/handoff audit found FCM-only pushes that could never
 * render in-app — not repeated here), then FCM, then stale-token cleanup.
 * Mirrors services/shiftPush.ts.
 */
async function pushWithAlertRow(params: {
  guardId: string;
  shiftSessionId: string;
  type: 'break_ended' | 'break_return_overdue';
  title: string;
  body: string;
  data: Record<string, unknown>;
}): Promise<void> {
  await insertNotification({
    guardId: params.guardId,
    type: params.type,
    title: params.title,
    body: params.body,
    data: params.data,
    shiftSessionId: params.shiftSessionId,
  });

  const token = await getActivePushToken(params.guardId);
  if (!token) return; // Alerts row already written — feed stays truthful

  await sendPushNotification({
    token,
    title: params.title,
    body: params.body,
    data: Object.fromEntries(
      Object.entries(params.data).map(([k, v]) => [k, String(v)]),
    ) as Record<string, string>,
  });
}

/**
 * Push 1 of 2 — at expiry, for every break Step 1 just closed. Driven off
 * the close UPDATE's RETURNING rows, and that UPDATE matches a row exactly
 * once (break_end IS NULL), so this cannot double-fire per break.
 */
export async function notifyBreakEnded(closed: ExpiredBreak[]): Promise<void> {
  for (const b of closed) {
    try {
      await pushWithAlertRow({
        guardId: b.guard_id,
        shiftSessionId: b.shift_session_id,
        type: 'break_ended',
        title: 'Break ended',
        body: 'Your break time is up — return to post.',
        data: {
          break_id: b.id,
          break_type: b.break_type,
          planned_duration_minutes: b.planned_duration_minutes,
        },
      });
    } catch (err) {
      console.error('[breakExpiry] break_ended push failed for break', b.id, err);
    }
  }
}

/**
 * Push 2 of 2 — at expiry+10, ONLY if the guard is off post. Position is
 * the most recent signal since break start: onsite ping, off-post ping
 * rejection (off_post_events), violation occurred/resolved, falling back
 * to the break-start coordinates re-evaluated against the site fence. No
 * signal at all → no push, and the decision is logged explicitly — we
 * don't guess.
 *
 * Dedup: each auto-closed break is evaluated exactly once; return_check_at
 * is stamped in the same pass regardless of outcome.
 */
export async function sendReturnOverduePushes(client: PoolClient): Promise<{
  checked: number;
  pushed: number;
}> {
  const due = await client.query<{
    id: string;
    guard_id: string;
    shift_session_id: string;
    site_id: string;
    break_type: string;
    break_start: Date;
    break_end: Date;
    start_lat: number | null;
    start_lng: number | null;
    start_accuracy_m: number | null;
    clocked_out_at: Date | null;
  }>(
    `SELECT bs.id, bs.guard_id, bs.shift_session_id, bs.site_id, bs.break_type,
            bs.break_start, bs.break_end, bs.start_lat, bs.start_lng,
            bs.start_accuracy_m, ss.clocked_out_at
       FROM break_sessions bs
       JOIN shift_sessions ss ON ss.id = bs.shift_session_id
      WHERE bs.ended_by = 'break_expiry'
        AND bs.return_check_at IS NULL
        AND bs.break_end + INTERVAL '10 minutes' <= NOW()`
  );

  let pushed = 0;
  for (const b of due.rows) {
    let outcome: 'off_post_pushed' | 'onsite' | 'unknown' | 'session_closed';

    if (b.clocked_out_at) {
      outcome = 'session_closed';
    } else {
      const signal = await client.query<{ verdict: 'onsite' | 'offpost'; t: Date }>(
        `SELECT verdict, t FROM (
           SELECT 'onsite'::text AS verdict, MAX(lp.pinged_at) AS t
             FROM location_pings lp
            WHERE lp.shift_session_id = $1 AND lp.pinged_at > $2
           UNION ALL
           SELECT 'offpost', MAX(ope.occurred_at)
             FROM off_post_events ope
            WHERE ope.shift_session_id = $1 AND ope.occurred_at > $2
           UNION ALL
           SELECT 'offpost', MAX(gv.occurred_at)
             FROM geofence_violations gv
            WHERE gv.shift_session_id = $1 AND gv.occurred_at > $2
           UNION ALL
           SELECT 'onsite', MAX(gv.resolved_at)
             FROM geofence_violations gv
            WHERE gv.shift_session_id = $1 AND gv.resolved_at > $2
         ) signals
         WHERE t IS NOT NULL
         ORDER BY t DESC
         LIMIT 1`,
        [b.shift_session_id, b.break_start]
      );

      if (signal.rows[0]) {
        outcome = signal.rows[0].verdict === 'offpost' ? 'off_post_pushed' : 'onsite';
      } else if (b.start_lat !== null && b.start_lng !== null) {
        // Fallback: only position we ever got is where the break started.
        const fence = await validateAtSite(
          { lat: b.start_lat, lng: b.start_lng, accuracy_m: b.start_accuracy_m ?? 0 },
          b.site_id,
          client,
        );
        outcome = fence.allowed ? 'onsite' : 'off_post_pushed';
      } else {
        outcome = 'unknown';
        console.log(
          `[breakExpiry.return_check] break=${b.id} outcome=unknown — ` +
          `no position signal since break start and no break-start coords; not pushing`,
        );
      }

      if (outcome === 'off_post_pushed') {
        try {
          await pushWithAlertRow({
            guardId: b.guard_id,
            shiftSessionId: b.shift_session_id,
            type: 'break_return_overdue',
            title: 'Return to post',
            body: 'Your break ended 10 minutes ago and you appear to be off post.',
            data: { break_id: b.id, break_type: b.break_type },
          });
          pushed++;
        } catch (err) {
          console.error('[breakExpiry] return_overdue push failed for break', b.id, err);
        }
      }
    }

    await client.query(
      `UPDATE break_sessions
          SET return_check_at = NOW(), return_check_outcome = $1
        WHERE id = $2 AND return_check_at IS NULL`,
      [outcome, b.id]
    );
  }
  return { checked: due.rows.length, pushed };
}

runJob('breakExpiryCron', '* * * * *', async () => {
  const tickStart = Date.now();
  const client = await pool.connect();
  try {
    const closed = await closeExpiredBreaks(client);
    await notifyBreakEnded(closed);
    const overruns = await finalizeOverruns(client);
    const returnCheck = await sendReturnOverduePushes(client);

    if (closed.length > 0 || overruns.finalized > 0 || returnCheck.checked > 0) {
      console.log(
        `[breakExpiry] auto-closed ${closed.length} break(s), ` +
        `finalized ${overruns.finalized} overrun verdict(s) (${overruns.flagged} flagged), ` +
        `return-checked ${returnCheck.checked} (${returnCheck.pushed} pushed)`
      );
    }
    console.info('[break_expiry.tick]', {
      breaks_closed:        closed.length,
      overruns_finalized:   overruns.finalized,
      overruns_flagged:     overruns.flagged,
      return_checks:        returnCheck.checked,
      return_pushes:        returnCheck.pushed,
      duration_ms:          Date.now() - tickStart,
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
}, { sentryMonitor: false });
