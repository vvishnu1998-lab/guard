/**
 * Late clock-in escalation cron — Phase 1A (Q4).
 *
 * Runs every 5 minutes. For each shift in status='scheduled' whose
 * scheduled_start has passed and where the guard has still not
 * clocked in, fire the appropriate escalation rung:
 *
 *   T+10 min  → guard push  "You're 10 min late — please clock in"
 *   T+15 min  → guard push  "You're 15 min late — please clock in"
 *   T+30 min  → admin email "James has not clocked in for [site]"
 *
 * Dedup lives on three schema_v37 columns on shifts:
 *   late_10_reminder_sent_at
 *   late_15_reminder_sent_at
 *   late_admin_email_sent_at
 *
 * These are stamped NOW() after each successful send, and the WHERE
 * clauses gate the next fire. The 3-column approach matches the
 * existing pattern (pre_shift_reminder_sent_at / start_reminder_sent_at
 * / missed_alert_sent_at all live on shifts) and gives us cleaner
 * observability when triaging "which rung fired" incidents.
 *
 * Once the guard clocks in, the shift status flips to 'active' and
 * every WHERE below stops matching automatically — no explicit "stop"
 * needed. If the guard never clocks in, autoCompleteShifts eventually
 * flips the shift to 'missed' at scheduled_end and this cron stops
 * too. missedShiftAlert.ts stays in place for the pre-existing
 * admin-only T+10 email flow; the T+30 admin email here is a separate
 * ladder rung with different framing (it fires 30 min into the
 * escalation as the "no-response" fallback).
 *
 * Also mirrors each guard push into the notifications table with
 * type='late_clock_in' so the mobile Alerts tab renders it.
 * insertNotification is best-effort; a swallowed failure won't roll
 * back the shifts.late_*_reminder_sent_at column update.
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { insertNotification } from '../services/notifications';
import { sendMissedShiftAlert } from '../services/email';

interface LateCandidateRow {
  shift_id: string;
  scheduled_start: Date;
  site_name: string;
  guard_id: string | null;
  guard_name: string | null;
  fcm_token: string | null;
  minutes_late: number;
  late_10_reminder_sent_at: Date | null;
  late_15_reminder_sent_at: Date | null;
  late_admin_email_sent_at: Date | null;
}

async function fireGuardPush(row: LateCandidateRow, rung: 10 | 15): Promise<boolean> {
  const title = `You're ${rung} min late`;
  const body  = `Clock in at ${row.site_name} to start your shift.`;

  try {
    if (row.fcm_token) {
      await sendPushNotification({
        token: row.fcm_token,
        title,
        body,
        data: {
          type:         'late_clock_in',
          shiftId:      row.shift_id,
          rung:         String(rung),
          minutesLate:  String(row.minutes_late),
        },
      });
    } else {
      console.warn(`[lateClockIn] shift=${row.shift_id} rung=T+${rung} — no fcm_token; notification row still written`);
    }
    // Mirror to notifications table — always, even when fcm_token is
    // missing (so the Alerts tab renders the row once the guard opens
    // the app). shift_session_id is NULL because no session exists
    // yet; routes/notifications.ts special-cases late_clock_in in the
    // outer scope filter to let it through the "active session" gate.
    if (row.guard_id) {
      await insertNotification({
        guardId:        row.guard_id,
        type:           'late_clock_in',
        title,
        body,
        data:           { shiftId: row.shift_id, rung, minutesLate: row.minutes_late, siteName: row.site_name },
        shiftSessionId: null,
      });
    }
    return true;
  } catch (err) {
    console.error(`[lateClockIn] guard push T+${rung} failed for shift ${row.shift_id}:`, err);
    return false;
  }
}

cron.schedule('*/5 * * * *', async () => {
  const startedAt = Date.now();
  let t10 = 0, t15 = 0, t30 = 0, skipped = 0;

  try {
    // Pull every scheduled shift whose start has passed by at least
    // 10 min (the earliest rung we might fire). The three column
    // fields drive the per-rung branch below. Guard fields via
    // LEFT JOIN so unassigned shifts still row up (they'll be
    // skipped, but logged).
    const { rows } = await pool.query<LateCandidateRow>(
      `SELECT s.id AS shift_id,
              s.scheduled_start,
              st.name AS site_name,
              g.id AS guard_id, g.name AS guard_name, g.fcm_token,
              GREATEST(0, EXTRACT(EPOCH FROM (NOW() - s.scheduled_start)) / 60)::INT AS minutes_late,
              s.late_10_reminder_sent_at,
              s.late_15_reminder_sent_at,
              s.late_admin_email_sent_at
       FROM shifts s
       JOIN sites  st ON st.id = s.site_id
       LEFT JOIN guards g ON g.id = s.guard_id
       WHERE s.status = 'scheduled'
         AND s.scheduled_start <= NOW() - INTERVAL '10 minutes'
         AND (s.late_10_reminder_sent_at IS NULL
              OR s.late_15_reminder_sent_at IS NULL
              OR s.late_admin_email_sent_at IS NULL)`,
    );

    for (const row of rows) {
      if (!row.guard_id) {
        skipped += 1;
        console.warn(`[lateClockIn] shift=${row.shift_id} — unassigned, skipping`);
        continue;
      }

      // T+10 rung
      if (row.late_10_reminder_sent_at === null && row.minutes_late >= 10) {
        const ok = await fireGuardPush(row, 10);
        if (ok) {
          await pool.query(
            'UPDATE shifts SET late_10_reminder_sent_at = NOW() WHERE id = $1',
            [row.shift_id],
          );
          t10 += 1;
        }
      }

      // T+15 rung
      if (row.late_15_reminder_sent_at === null && row.minutes_late >= 15) {
        const ok = await fireGuardPush(row, 15);
        if (ok) {
          await pool.query(
            'UPDATE shifts SET late_15_reminder_sent_at = NOW() WHERE id = $1',
            [row.shift_id],
          );
          t15 += 1;
        }
      }

      // T+30 rung — admin email. Uses the existing sendMissedShiftAlert
      // renderer (same "James is X min late" tone). Dedup independent
      // from missedShiftAlert.ts's own missed_alert_sent_at column so
      // a shift can fire BOTH the T+10 admin email (that cron) AND the
      // T+30 rung email (this cron) — they're framed as "detected
      // missed" vs "no response after 30 min" and admins should see
      // both if the situation persists.
      if (row.late_admin_email_sent_at === null && row.minutes_late >= 30) {
        try {
          await sendMissedShiftAlert(row.shift_id);
          await pool.query(
            'UPDATE shifts SET late_admin_email_sent_at = NOW() WHERE id = $1',
            [row.shift_id],
          );
          t30 += 1;
        } catch (err) {
          console.error(`[lateClockIn] admin email T+30 failed for shift ${row.shift_id}:`, err);
        }
      }
    }
  } catch (err) {
    console.error('[lateClockIn] Cron error:', err);
  } finally {
    if (t10 + t15 + t30 + skipped > 0) {
      console.log(
        `[lateClockIn] fired t+10=${t10} t+15=${t15} t+30=${t30} skipped=${skipped} ` +
        `(${Date.now() - startedAt}ms)`,
      );
    }
  }
});
