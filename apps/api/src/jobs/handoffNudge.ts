/**
 * Nudge stuck mid-shift handoffs.
 *
 * A handoff row goes 'accepted' (B agreed) → to_session_id set (B has
 * clocked in on-site). Between those two moments B is travelling. If
 * travel takes too long — B forgot, missed the push, or bailed silently
 * — A is still stuck on-post and someone needs to know.
 *
 * Every 5 minutes, this job scans the eligible pool via the partial
 * index idx_shift_swap_requests_handoff_pending_arrival (accepted +
 * guard_handoff + to_session_id IS NULL) and, for each row that's:
 *   - been accepted for ≥ 30 minutes
 *   - hasn't been nudged in the last 15 minutes
 *   - has fewer than NUDGE_CAP nudges so far
 * fires three pushes (A, B, primary admin FYI email) and stamps
 * handoff_last_nudge_at + handoff_nudge_count.
 *
 * Push copy is intentionally different for A vs B ("they haven't clocked
 * in yet" vs "you haven't clocked in yet"). Admin email is a single FYI
 * per nudge tick (no double-count if both mobile pushes fail).
 *
 * Exports `runHandoffNudgeOnce()` for tests / manual invocation.
 */
import cron from 'node-cron';
import { pool } from '../db/pool';
import { pushHandoffNudge } from '../services/swapPush';
import { sendHandoffNudgeFyi } from '../services/email';
import { Sentry } from '../services/sentry';

const NUDGE_CAP = 4;

export async function runHandoffNudgeOnce(): Promise<number> {
  const result = await pool.query<{
    id:               string;
    shift_id:         string;
    from_guard_id:    string;
    to_guard_id:      string;
    site_name:        string;
    from_guard_name:  string;
    to_guard_name:    string;
    minutes_late:     number;
  }>(
    // Update-then-select in a single statement so two cron ticks racing
    // don't double-nudge — the WHERE guards on both time thresholds and
    // count cap.
    `UPDATE shift_swap_requests ssr
        SET handoff_last_nudge_at = NOW(),
            handoff_nudge_count   = handoff_nudge_count + 1
      FROM shifts sh
      JOIN sites  si ON si.id = sh.site_id
      JOIN guards fg ON fg.id = ssr.from_guard_id
      JOIN guards tg ON tg.id = ssr.to_guard_id
      WHERE sh.id = ssr.shift_id
        AND ssr.initiated_by  = 'guard_handoff'
        AND ssr.status        = 'accepted'
        AND ssr.to_session_id IS NULL
        AND ssr.accepted_at   < NOW() - INTERVAL '30 minutes'
        AND (ssr.handoff_last_nudge_at IS NULL
             OR ssr.handoff_last_nudge_at < NOW() - INTERVAL '15 minutes')
        AND ssr.handoff_nudge_count < $1
      RETURNING ssr.id,
                ssr.shift_id,
                ssr.from_guard_id,
                ssr.to_guard_id,
                si.name AS site_name,
                fg.name AS from_guard_name,
                tg.name AS to_guard_name,
                EXTRACT(EPOCH FROM (NOW() - ssr.accepted_at))::INT / 60 AS minutes_late`,
    [NUDGE_CAP],
  );
  if (!result.rowCount) return 0;

  for (const row of result.rows) {
    // Two pushes + one email per nudge. All fire-and-forget; one channel
    // failing doesn't block the others.
    pushHandoffNudge({
      guardId:     row.from_guard_id,
      role:        'from',
      otherName:   row.to_guard_name,
      siteName:    row.site_name,
      shiftId:     row.shift_id,
      historyId:   row.id,
      minutesLate: row.minutes_late,
    }).catch((err) => console.error('[handoff-nudge] push A failed:', row.id, err));

    pushHandoffNudge({
      guardId:     row.to_guard_id,
      role:        'to',
      otherName:   row.from_guard_name,
      siteName:    row.site_name,
      shiftId:     row.shift_id,
      historyId:   row.id,
      minutesLate: row.minutes_late,
    }).catch((err) => console.error('[handoff-nudge] push B failed:', row.id, err));

    sendHandoffNudgeFyi(row.id, row.minutes_late).catch((err) => {
      console.error('[handoff-nudge] admin FYI email failed:', row.id, err);
      Sentry.captureException(err, {
        tags: { service: 'sendgrid', flow: 'handoff_nudge' },
        extra: { history_id: row.id, minutes_late: row.minutes_late },
      });
    });
  }
  console.log(`[handoff-nudge] nudged ${result.rowCount} stuck handoff(s)`);
  return result.rowCount;
}

cron.schedule('*/5 * * * *', async () => {
  try {
    await runHandoffNudgeOnce();
  } catch (err) {
    console.error('[handoff-nudge] tick failed:', err);
  }
});
