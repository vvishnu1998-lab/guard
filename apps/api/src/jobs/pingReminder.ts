/**
 * Ping / activity-report / task reminder cron job.
 *
 * Phase 1A rewrite (2026-07-12): the PING half of this job is now
 * schedule-anchored per session (scheduled_start + N * 30 min in the
 * site's local timezone). The old wall-clock UTC :00/:30 gate is gone
 * for pings — a 6:22 PT clock-in for a 6:00 PT shift now gets its next
 * ping reminder at 6:30 PT (T+8min), not at the next arbitrary UTC :30
 * boundary. Per R5, activity-report and task reminders stay on the
 * wall-clock hourly schedule for now.
 *
 * Cron ticks every minute. On each tick we:
 *   1. Fetch every active shift_session with its shift's scheduled_start
 *      and site tz. Skip guards who clocked in less than 5 min ago
 *      (parity with the old rule so a 5:59 clock-in doesn't get the
 *      6:00 ping at 6:00:30).
 *   2. For each session, ask services/pingWindows.ts which window has
 *      just CLOSED (windowJustClosed → R3 + R4 + closure). If one has,
 *      and it closed within TOLERANCE_MS, fire the ping reminder naming
 *      THAT window; the mobile UI treats this as "your 6:30 ping window
 *      is closing — submit now".
 *
 *      This job used to compute the answer itself, from a private
 *      currentBoundary() plus a private copy of siteLocalLabel. Both are
 *      gone. The boundary form named the window OPENING rather than the
 *      one closing, and had no R3 check, so it nagged for windows that
 *      cannot exist — 6.9% of production reminders, ending in a 422
 *      after the guard had already captured and uploaded the photo. The
 *      arithmetic lives in ONE place now, the same place missedPingCron
 *      reads, which is the entire reason that module exists.
 *   3. Send at most one ping reminder per session per window, via an
 *      ATOMIC CLAIM on shift_sessions.last_ping_reminder_window
 *      (schema_v57). The window stays eligible for RECOVERY_MS after it
 *      closes, so a dropped cron minute is recovered by a later tick
 *      instead of losing the reminder outright; the claim is what makes
 *      that widening safe. Copy is time-aware — a recovered push says the
 *      window has closed rather than claiming a freshness it lacks.
 *
 * Activity-report + task reminders still run on the old UTC :00/:30
 * gate below the ping block. Those don't have the same "keyed to
 * scheduled_start" requirement — a wall-clock hourly cadence is fine
 * for the "hey, submit your hourly activity report" nudge.
 */
import { runJob } from './_run';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { ACTIVE_PUSH_TOKEN_SQL } from '../services/deviceRegistry';
import { insertNotification, NotificationType } from '../services/notifications';
import { breakOverlapsWindow, siteLocalLabel, windowJustClosed } from '../services/pingWindows';
import { Sentry } from '../services/sentry';

// The hourly slot the activity-report + task legs nudge for. Matches
// jobs/missedReportCron.ts's WINDOW_MS (60 min) so the reminder and the
// missed_reports flag reason about the same span of time. Deliberately a
// local constant: services/pingWindows.ts owns PING_WINDOW_MS (30 min)
// and exports no hourly equivalent.
const REPORT_WINDOW_MS = 60 * 60 * 1000;

interface ActiveGuardRow {
  guard_id: string;
  guard_name: string;
  fcm_token: string | null;
  shift_session_id: string;
  scheduled_start: Date;
  scheduled_end: Date;
  clocked_in_at: Date;
  site_tz: string | null;
  last_ping_reminder_window: Date | null;
}

async function sendReminder(
  row: Pick<ActiveGuardRow, 'guard_id' | 'fcm_token' | 'shift_session_id'>,
  type: NotificationType,
  title: string,
  body: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  const payload = { type, ...data };
  if (!row.fcm_token) {
    Sentry.captureMessage('push_skip_null_token', {
      level: 'warning',
      tags: { flow: 'ping_reminder' },
      extra: {
        guard_id:         row.guard_id,
        shift_session_id: row.shift_session_id,
        type,
      },
    });
  }
  await Promise.allSettled([
    row.fcm_token
      ? sendPushNotification({ token: row.fcm_token, title, body, data: payload as Record<string, string> }).catch(
          (err) => console.error(`[pingReminder] FCM ${type} failed for guard ${row.guard_id}:`, err),
        )
      : Promise.resolve(),
    insertNotification({
      guardId: row.guard_id,
      type,
      title,
      body,
      data,
      shiftSessionId: row.shift_session_id,
    }),
  ]);
}

/**
 * ATOMIC CLAIM — the once-per-window guarantee (schema_v57).
 *
 * Tests and sets in ONE statement, so a second tick racing this one matches
 * zero rows and returns false. Windows only ever advance, so "strictly
 * greater than the last one claimed" is exactly once-per-window.
 *
 * This replaced alreadyRemindedRecently(), a read-then-decide SELECT EXISTS
 * over a 5-minute notifications lookback. Two ticks could both read "no"
 * before either wrote; widening the eligibility range below gives that race
 * far more room to land, so the check had to stop being advisory.
 *
 * Only the CLAIM is SQL. The window arithmetic stays in pingWindows.ts —
 * expressing R3/R4 in this statement would recreate exactly the second
 * implementation the previous commit deleted.
 */
/**
 * Did the guard already answer this window?
 *
 * A deliberate, line-for-line copy of missedPingCron's anyPingInWindow.
 * Without it this job nagged for windows that HAD been answered: reddy
 * (Star Guard, session fd3ee9ac) pinged the 15:00 window at 15:01:03 with
 * submitted_late=false, missed_pings correctly held no row for it, and at
 * 15:30 the reminder still fired "Submit your 15:00 ping now." Nothing
 * between windowJustClosed and claimWindow had ever looked at
 * location_pings — claimWindow only dedupes repeat reminders for the SAME
 * window, it says nothing about whether the window was satisfied.
 *
 * THE MATCH IS A HALF-OPEN TIME RANGE ON pinged_at, NOT window_label, and
 * that is not interchangeable:
 *   * window_label is an optional client-supplied body param on
 *     POST /locations/ping — a ping without one is still a real ping and
 *     would be invisible to a label match;
 *   * a late ping deliberately backfills a PAST window's label while its
 *     pinged_at sits in a later window, so the two rules disagree exactly
 *     when it matters (submitted_late);
 *   * the label is derived through the site's IANA zone and is ambiguous
 *     on its own — which is why window_start was added beside it in this
 *     job's own push payload.
 *
 * Copied rather than shared on purpose. Hoisting it into
 * services/pingWindows.ts would make completedTrackableWindows's module
 * aware of pings, and that function is consumed by the daily client report
 * where it must stay break-blind AND ping-blind — it counts windows that
 * WERE trackable, not windows that were answered.
 */
async function anyPingInWindow(
  shiftSessionId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const { rows } = await pool.query<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM location_pings
       WHERE shift_session_id = $1
         AND pinged_at >= $2 AND pinged_at < $3
     ) AS hit`,
    [shiftSessionId, windowStart, windowEnd],
  );
  return rows[0]?.hit === true;
}

async function claimWindow(shiftSessionId: string, windowStart: Date): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE shift_sessions
        SET last_ping_reminder_window = $2
      WHERE id = $1
        AND (last_ping_reminder_window IS NULL OR last_ping_reminder_window < $2)
      RETURNING id`,
    [shiftSessionId, windowStart],
  );
  return (rowCount ?? 0) > 0;
}

runJob('pingReminder', '* * * * *', async () => {
  const now = new Date();
  // ELIGIBILITY RANGE, not a firing instant. The old ±60s tolerance meant a
  // single skipped cron minute lost the reminder outright and never retried
  // — see schema_v57's header for the 2026-08-24 04:00Z case, where the gap
  // cost Naveen his ping AND flagged him for missing it.
  //
  // A window stays eligible for RECOVERY_MS after it closes, so a later tick
  // still fires. The once-per-window claim below is what makes widening this
  // safe. Bounded well inside the 30-min window length so a recovered push
  // can never arrive after the NEXT window has already closed.
  const RECOVERY_MS = 10 * 60 * 1000;
  // A close within this age is "just now"; older is a catch-up, and the copy
  // must say so rather than claim a freshness it does not have.
  const FRESH_MS = 90 * 1000;

  try {
    // Every active session with the fields we need to compute per-session
    // window boundaries. The 5-min just-clocked-in guard mirrors the old
    // job so a 6:29:30 clock-in doesn't get the 6:30 ping 30 sec later.
    const { rows } = await pool.query<ActiveGuardRow>(
      `SELECT ss.id AS shift_session_id,
              g.id  AS guard_id,
              g.name AS guard_name,
              ${ACTIVE_PUSH_TOKEN_SQL('g')},
              s.scheduled_start,
              s.scheduled_end,
              ss.clocked_in_at,
              ss.last_ping_reminder_window,
              si.timezone AS site_tz
       FROM shift_sessions ss
       JOIN shifts s  ON s.id  = ss.shift_id
       JOIN sites  si ON si.id = ss.site_id
       JOIN guards g  ON g.id  = ss.guard_id
       WHERE ss.clocked_out_at IS NULL
         AND ss.clocked_in_at <= NOW() - INTERVAL '5 minutes'`,
    );

    // ── Ping reminder — schedule-anchored per session ─────────────────
    let pingsFired = 0;
    for (const row of rows) {
      // The window that just CLOSED — R3 + R4 + closure, from the same
      // module missedPingCron flags from. Never a boundary: see the
      // windowJustClosed docblock for the two faults a boundary produced.
      const closed = windowJustClosed(
        new Date(row.scheduled_start),
        new Date(row.scheduled_end),
        new Date(row.clocked_in_at),
        now,
        RECOVERY_MS,
      );
      if (!closed) continue;

      // Cheap short-circuit for the repeat ticks the widened range creates:
      // a window stays eligible for RECOVERY_MS, so without this the break
      // query AND the claim would re-run every minute for ten minutes
      // instead of once. Purely an optimisation — claimWindow below is
      // still the authority, so a stale read here costs at most one extra
      // no-op UPDATE and can never double-send.
      if (
        row.last_ping_reminder_window !== null &&
        new Date(row.last_ping_reminder_window).getTime() >= closed.windowStart.getTime()
      ) {
        continue;
      }

      // Break-time quiet policy (locked 2026-08-20): no reminder for a
      // window a break overlaps.
      //
      // This waives on the window being NAGGED FOR — the closed one,
      // [windowStart, windowEnd] — which is the identical span
      // missedPingCron passes when it decides whether to waive the flag.
      // It previously passed [boundary, boundary + 30min), i.e. the
      // window OPENING rather than the one closing, so a break covering
      // the nagged window failed to suppress the push while a break
      // covering the NEXT one suppressed it wrongly. The comment here
      // asserted the reminder and the flag "can never disagree"; they
      // were off by exactly one window, always.
      if (await breakOverlapsWindow(row.shift_session_id, closed.windowStart, closed.windowEnd)) {
        console.log(
          `[pingReminder.skipped.break] session=${row.shift_session_id} ` +
          `window=${closed.windowStart.toISOString()}`,
        );
        continue;
      }

      // Already answered? Then there is nothing to nag for. Ordered here
      // for the same reason the break waiver is: BEFORE the claim, so a
      // satisfied window never burns one and stays eligible if the ping is
      // somehow rolled back. Same two Dates the break check just used, so
      // the reminder and missedPingCron can never disagree about which
      // window is in question.
      if (await anyPingInWindow(row.shift_session_id, closed.windowStart, closed.windowEnd)) {
        console.log(
          `[pingReminder.skipped.answered] session=${row.shift_session_id} ` +
          `window=${closed.windowStart.toISOString()}`,
        );
        continue;
      }

      // Claimed AFTER the break check so a waived window never burns a
      // claim, and immediately BEFORE the send so the gap in which a crash
      // could lose the push is as small as it can be.
      if (!(await claimWindow(row.shift_session_id, closed.windowStart))) continue;

      const label = siteLocalLabel(closed.windowStart, row.site_tz);
      const lateMs = now.getTime() - closed.windowEnd.getTime();
      // Time-aware copy. On a catch-up tick the window closed minutes ago,
      // and "now" would be claiming a freshness this push does not have —
      // the same reasoning as clockOutReminder's minutes_left branch.
      const body =
        lateMs <= FRESH_MS
          ? `Submit your ${label} ping now.`
          : `You still owe the ${label} ping. Submit it now — the window has closed.`;
      await sendReminder(
        row,
        'ping_reminder',
        'Location ping',
        body,
        {
          window_label: label,
          // Unchanged in both meaning and value: the instant we fired,
          // which is the close of the nagged window. Kept so forensic
          // queries stay comparable across this fix. window_start is the
          // new field — the label is timezone-derived and therefore
          // ambiguous on its own.
          window_boundary: closed.windowEnd.toISOString(),
          window_start:    closed.windowStart.toISOString(),
        },
      );
      pingsFired += 1;
    }
    if (pingsFired > 0) {
      console.log(`[pingReminder] schedule-anchored: fired ${pingsFired} ping reminder(s)`);
    }

    // ── Activity-report + task reminders — wall-clock hourly (R5) ─────
    const minute = now.getUTCMinutes();
    if (minute !== 0) return;
    if (!rows.length) return;

    // The hourly slot these two legs are FOR: [topOfHour, topOfHour+1h).
    // Execution only reaches here at UTC minute 0, so this is the hour
    // that is opening — the one the guard is being asked to file in.
    const hourStart = new Date(now);
    hourStart.setUTCMinutes(0, 0, 0);
    const hourEnd = new Date(hourStart.getTime() + REPORT_WINDOW_MS);

    let reportsFired = 0;
    await Promise.allSettled(
      rows.map(async (row) => {
        // Break-time quiet policy (locked 2026-08-20): during a break a
        // guard owes nothing, so no report nudge for an hour a break
        // overlaps. Same shared predicate the ping leg above and
        // missedReportCron use — one definition, so the nudge and the
        // flag can never disagree.
        //
        // 155c9a8 gated the ping leg only. This leg fired at 20:00:01 PT
        // on 2026-08-20 into a break running 19:54:42-20:13:58.
        if (await breakOverlapsWindow(row.shift_session_id, hourStart, hourEnd)) {
          console.log(
            `[activityReportReminder.skipped.break] session=${row.shift_session_id} ` +
            `window=${hourStart.toISOString()}`,
          );
          return;
        }
        reportsFired += 1;
        await sendReminder(
          row,
          'activity_report_reminder',
          'Activity report',
          'Time to submit your hourly activity report.',
        );
      }),
    );
    // Count is now what actually went out, not rows.length — a log line
    // that overstates delivery is how a suppressed leg stays invisible.
    console.log(
      `[pingReminder] Sent activity-report reminder to ${reportsFired} of ${rows.length} active guards`,
    );

    for (const row of rows) {
      // Break-time quiet policy (locked 2026-08-20) — leg 3. Same hourly
      // slot and same shared predicate as the report leg above. Checked
      // BEFORE the count query: a waived session needs no COUNT(*).
      //
      // This is the pre-due hourly NUDGE only. The at-due push lives in
      // jobs/taskDueCron.ts and is suppressed by an open-break check
      // there, because a due_at is an instant and the task is still due
      // when the guard returns.
      if (await breakOverlapsWindow(row.shift_session_id, hourStart, hourEnd)) {
        console.log(
          `[taskReminder.skipped.break] session=${row.shift_session_id} ` +
          `window=${hourStart.toISOString()}`,
        );
        continue;
      }

      const taskCount = await pool.query<{ count: number }>(
        // due_at horizon: only nag about tasks due within the next hour
        // (or overdue). Without it this hourly leg counted EVERY pending
        // instance regardless of due time — a guard on a morning shift got
        // "You have 1 pending task" for a 9 PM task ~10 hours early
        // (Mosser Towers, 2026-08-20). taskDueCron owns the at-due push;
        // this leg is only the pre-due hourly nudge.
        `SELECT COUNT(*)::int AS count
         FROM task_instances ti
         JOIN shifts s ON s.id = ti.shift_id
         JOIN shift_sessions ss ON ss.shift_id = s.id
         WHERE ss.id = $1
           AND ti.status = 'pending'
           AND ti.due_at <= NOW() + interval '1 hour'`,
        [row.shift_session_id],
      );
      const n = taskCount.rows[0]?.count ?? 0;
      if (n <= 0) continue;

      const plural = n === 1 ? 'task' : 'tasks';
      await sendReminder(
        row,
        'task_reminder',
        'Task reminder',
        `You have ${n} pending ${plural}.`,
        { count: n },
      );
    }
  } catch (err) {
    console.error('[pingReminder] Cron error:', err);
  }
}, { sentryMonitor: false });
