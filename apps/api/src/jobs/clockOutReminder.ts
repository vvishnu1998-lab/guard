/**
 * Pre-end clock-out reminder — every 5 minutes.
 *
 * Pushes one notification per session shortly before scheduled_end so the
 * guard closes their own shift, with a photo and coordinates, instead of
 * being swept by jobs/autoCompleteShifts.ts thirty minutes later. 23 of the
 * last 25 clock-outs were auto-closed; the fallback is the norm today, and
 * this job exists to make it the exception.
 *
 * ── FIRST END-SIDE NOTIFICATION IN THE SYSTEM ───────────────────────────
 *
 * Every other cron anchors to scheduled_start (preShiftReminder at -55..-65
 * min, shiftStartReminder at +0..+5, lateClockInReminder at +10/+15,
 * missedShiftAlert at +10) or to a relative event (taskDueCron on due_at,
 * breakExpiryCron on break_start). Nothing has ever fired off scheduled_end,
 * so there was no throttle or dedupe key to reuse — both had to be chosen
 * rather than inherited.
 *
 * ── ONCE PER SESSION: WHY A COLUMN, NOT A QUERY ─────────────────────────
 *
 * pingReminder.ts:137 alreadyRemindedRecently() is the closest existing
 * dedupe, and it is deliberately NOT what this job uses. It runs
 * SELECT EXISTS over the notifications table and then sends — read-then-
 * decide, so two overlapping ticks both read false and both send. It also
 * only answers "not within the last five minutes", which is exactly right
 * for a recurring nag and wrong for a fire-once event.
 *
 * lateClockInReminder is the right precedent, and for a reason its own
 * docblock gets wrong: that file says the shift status flip at scheduled_end
 * is what stops it. It is not — the three late_*_sent_at sentinel columns
 * are. Read the code, not the comment.
 *
 * So: a sentinel column (schema_v56 shift_sessions.clock_out_reminder_sent_at)
 * claimed by an ATOMIC update-then-select — the same single-statement claim
 * jobs/handoffNudge.ts uses so two racing ticks cannot both nudge. The row is
 * won BEFORE the push is attempted; a losing tick gets zero rows and does
 * nothing. A query-based guard on a five-minute cron could not offer that.
 *
 * Cost of the claim-first ordering: if the push fails after the claim, the
 * reminder is lost rather than retried. That is the correct trade. A missed
 * reminder costs one auto-close, which is the status quo; a double claim
 * costs a duplicate push to a guard on post. The failure is logged and the
 * guard still has the full grace window.
 *
 * ── THE WINDOW, AND WHY IT IS NOT A TOLERANCE ───────────────────────────
 *
 * Eligible from scheduled_end - 5min until scheduled_end + 30min (the moment
 * autoCompleteShifts takes over). It is deliberately a RANGE, not a
 * boundary-with-tolerance.
 *
 * pingReminder fires only within ±1 min of a window boundary and never
 * retries, so a single skipped cron minute costs that ping outright — this
 * was observed on 2026-08-24 when the 04:00 tick was skipped and the 21:00
 * ping reminder never fired at all. Repeating that pattern here would mean a
 * dropped tick silently costs a guard their chance to clock out properly.
 * A range plus a durable sentinel is catch-up-safe: a late tick still fires,
 * and the sentinel still guarantees once.
 *
 * The copy is time-aware for the same reason — inside the window it says how
 * long is left; past scheduled_end it says the shift has ended and names the
 * auto-close. A fixed "5 minutes left" string would be a lie on a catch-up
 * tick.
 *
 * ── EXCLUSIONS ──────────────────────────────────────────────────────────
 *
 * Handoff sessions are excluded on BOTH sides of the relationship — a
 * session that handed off (from_session_id) and a session that was handed to
 * (to_session_id). Guard A's session is closed by the handoff path itself
 * with clock_out_reason='handed_off_to_<guard_uuid>' and must never be asked
 * to clock out; guard B arrived mid-shift and the handoff flow owns their
 * end-of-shift too.
 *
 * Breaks are deliberately NOT suppressed — explicit product call. A guard on
 * a break five minutes before their shift ends is exactly who needs telling.
 * This diverges from pingReminder's break-quiet policy on purpose.
 */
import { runJob } from './_run';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { ACTIVE_PUSH_TOKEN_SQL } from '../services/deviceRegistry';
import { insertNotification } from '../services/notifications';
import { Sentry } from '../services/sentry';

/** How long before scheduled_end the reminder becomes eligible. */
const LEAD_MINUTES = 5;

/**
 * Upper bound of the eligibility window. Matches the auto-close grace in
 * jobs/autoCompleteShifts.ts — once that sweep owns the session there is
 * nothing left to remind about. Keep the two in step.
 */
const GRACE_MINUTES = 30;

interface Candidate {
  session_id:      string;
  guard_id:        string;
  guard_name:      string;
  fcm_token:       string | null;
  site_name:       string;
  shift_id:        string;
  scheduled_end:   Date;
  minutes_left:    number;
}

/**
 * One pass. Exported so a local harness can drive it against a throwaway DB;
 * the cron registration below is the only production caller.
 */
export async function runClockOutReminder(): Promise<number> {
  const started = Date.now();
  try {
    // ATOMIC CLAIM. The UPDATE both selects and marks in one statement, so a
    // second tick racing this one matches zero rows. Everything the push
    // needs is returned here — there is no second read that could see a
    // different world.
    const { rows } = await pool.query<Candidate>(
      `UPDATE shift_sessions ss
          SET clock_out_reminder_sent_at = NOW()
         FROM shifts sh
         JOIN sites si  ON si.id = sh.site_id
         JOIN guards g  ON g.id  = sh.guard_id
        WHERE ss.shift_id = sh.id
          AND ss.clocked_out_at IS NULL
          AND ss.clock_out_reminder_sent_at IS NULL
          AND sh.status IN ('active', 'scheduled')
          AND NOW() >= sh.scheduled_end - ($1 || ' minutes')::interval
          AND NOW() <  sh.scheduled_end + ($2 || ' minutes')::interval
          -- Handoff exclusion, BOTH sides of the relationship.
          AND NOT EXISTS (
                SELECT 1 FROM shift_swap_requests ssr
                 WHERE ssr.initiated_by = 'guard_handoff'
                   AND (ssr.from_session_id = ss.id OR ssr.to_session_id = ss.id)
              )
        RETURNING ss.id                AS session_id,
                  ss.guard_id          AS guard_id,
                  g.name               AS guard_name,
                  ${ACTIVE_PUSH_TOKEN_SQL('g')},
                  si.name              AS site_name,
                  sh.id                AS shift_id,
                  sh.scheduled_end     AS scheduled_end,
                  CEIL(EXTRACT(EPOCH FROM (sh.scheduled_end - NOW())) / 60.0)::int AS minutes_left`,
      [String(LEAD_MINUTES), String(GRACE_MINUTES)],
    );

    let pushed = 0;
    let failed = 0;

    for (const row of rows) {
      // Copy is time-aware: a catch-up tick past scheduled_end must not claim
      // minutes that have already gone.
      const body =
        row.minutes_left > 0
          ? `Your shift at ${row.site_name} ends in ${row.minutes_left} min. Clock out when you're done.`
          : `Your shift at ${row.site_name} has ended. Clock out now — it closes automatically soon.`;

      // Log the notification first so the in-app tray is right even when the
      // device has no usable token. Best-effort by contract; it never throws.
      await insertNotification({
        guardId:        row.guard_id,
        type:           'clock_out_reminder',
        title:          'Time to clock out',
        body,
        data:           { type: 'clock_out_reminder', shift_id: row.shift_id },
        shiftSessionId: row.session_id,
      });

      if (!row.fcm_token) continue;
      try {
        await sendPushNotification({
          token: row.fcm_token,
          title: 'Time to clock out',
          body,
          data:  { type: 'clock_out_reminder', shift_id: row.shift_id },
        });
        pushed++;
      } catch (err) {
        // The claim is already spent — see the docblock. Log and move on.
        failed++;
        console.error(`[clock_out_reminder] push failed session=${row.session_id}:`, err);
      }
    }

    // Heartbeat on EVERY tick including the empty one, matching
    // jobs/orphanedSessionCheck.ts and autoCompleteShifts: without it a
    // silently wedged cron is indistinguishable from "nobody was due".
    console.info('[clock_out_reminder.tick]', {
      claimed:     rows.length,
      pushed,
      failed,
      duration_ms: Date.now() - started,
    });

    if (failed > 0) {
      // Stable message + explicit fingerprint, low-cardinality tags, counts
      // in extra — the nightlyPurge haltStep shape that orphanedSessionCheck
      // also follows. Interpolating a count into the message would mint a
      // fresh Sentry issue on every run.
      Sentry.captureMessage('clock_out_reminder_push_failed', {
        level:       'warning',
        fingerprint: ['clock_out_reminder_push_failed'],
        tags:        { flow: 'clock_out_reminder' },
        extra:       { claimed: rows.length, pushed, failed },
      } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
    }

    return rows.length;
  } catch (err) {
    console.error('[clock_out_reminder] FAILED:', err);
    Sentry.captureException(err, {
      tags:        { flow: 'clock_out_reminder' },
      fingerprint: ['clock_out_reminder', 'tick_error'],
    } as unknown as Parameters<typeof Sentry.captureException>[1]);
    return -1;
  }
}

// Every 5 minutes. The eligibility window is 35 minutes wide, so any single
// skipped tick is absorbed rather than costing the reminder — deliberately
// unlike pingReminder's ±1-minute boundary tolerance.
runJob('clockOutReminder', '*/5 * * * *', runClockOutReminder, { sentryMonitor: false });
