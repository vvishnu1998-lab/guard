/**
 * Missed-report detection cron — Commit A2.
 *
 * Mirror of missedPingCron.ts but with HOURLY (60 min) window slots
 * instead of pings' 30 min, and matched against the reports table
 * (any report_type — activity, incident, maintenance — satisfies).
 *
 * Runs every 5 minutes. Walks every currently-open shift_session
 * (and sessions that clocked out within the last 15 min, to catch
 * the final window of a shift that autoCompleteShifts just closed),
 * computes the completed hourly windows anchored to the shift's
 * scheduled_start, and INSERTs a missed_reports row for any window
 * that has no report.
 *
 * Window rules (matches missedPingCron):
 *   * Windows are 60 min slots starting at scheduled_start.
 *   * A window [ws, we] is TRACKED only if we <= scheduled_end
 *     (no partial window at the end of the shift).
 *   * Windows whose ws < clocked_in_at are SKIPPED (the guard was
 *     never late for a window that started before their clock-in).
 *     Windows whose ws >= clocked_in_at count with NO first-report
 *     grace.
 *
 * De-dup: UNIQUE(shift_session_id, window_start). INSERT ... ON
 * CONFLICT DO NOTHING RETURNING id ensures each 5-min tick either
 * lands a fresh row or returns nothing — we only fire the guard
 * push on a fresh row so the every-5-min cron never spams.
 *
 * When a fresh row lands:
 *   1. insertNotification(type='missed_report') with deep-link
 *      payload { missedReportId, windowLabel, windowStart,
 *      windowEnd, siteName }.
 *   2. sendPushNotification to the guard's fcm_token if present.
 *
 * The Alerts feed's auto-erase in routes/notifications.ts hides the
 * row once resolved_at is set on the missed_reports row (which
 * happens when the guard submits a late report via POST /api/reports
 * carrying the matching window_label body param).
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { insertNotification } from '../services/notifications';
import { expiresAtFor } from '../services/retention';
import { Sentry } from '../services/sentry';

interface SessionRow {
  session_id: string;
  shift_id: string;
  site_id: string;
  site_name: string;
  guard_id: string;
  fcm_token: string | null;
  clocked_in_at: Date;
  scheduled_start: Date;
  scheduled_end: Date;
  site_tz: string | null;
}

const WINDOW_MS = 60 * 60 * 1000;

function siteLocalLabel(when: Date, siteTz: string | null): string {
  const tz = siteTz ?? 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: tz,
  }).format(when);
}

/**
 * Enumerate the [window_start, window_end] pairs for a session that
 * have COMPLETED as of `now` and that pass the window fit + clock-in
 * rules. Returns oldest → newest. Loop bound protects against a
 * bogus scheduled_start way in the past.
 */
function completedTrackableWindows(
  scheduledStart: Date,
  scheduledEnd:   Date,
  clockedInAt:    Date,
  now:            Date,
): Array<{ windowStart: Date; windowEnd: Date }> {
  const ssMs = scheduledStart.getTime();
  const seMs = scheduledEnd.getTime();
  const ciMs = clockedInAt.getTime();
  const nowMs = now.getTime();

  const out: Array<{ windowStart: Date; windowEnd: Date }> = [];
  for (let n = 0; n < 200; n += 1) {
    const wsMs = ssMs + n * WINDOW_MS;
    const weMs = wsMs + WINDOW_MS;
    if (weMs > seMs) break;             // window_end must fit within shift
    if (weMs > nowMs) break;            // window hasn't closed yet
    if (wsMs < ciMs) continue;          // skip pre-clock-in windows
    out.push({ windowStart: new Date(wsMs), windowEnd: new Date(weMs) });
  }
  return out;
}

async function anyReportInWindow(
  sessionId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const { rows } = await pool.query<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM reports
       WHERE shift_session_id = $1
         AND reported_at >= $2 AND reported_at < $3
     ) AS hit`,
    [sessionId, windowStart, windowEnd],
  );
  return rows[0]?.hit === true;
}

cron.schedule('*/5 * * * *', async () => {
  const now = new Date();
  let created = 0;
  let considered = 0;

  Sentry.addBreadcrumb({
    category: 'cron',
    message: 'missedReportCron tick',
    level: 'info',
    data: { at: now.toISOString() },
  });

  try {
    const { rows: sessions } = await pool.query<SessionRow>(
      `SELECT ss.id AS session_id,
              ss.shift_id,
              ss.site_id,
              si.name AS site_name,
              ss.guard_id,
              g.fcm_token,
              ss.clocked_in_at,
              s.scheduled_start,
              s.scheduled_end,
              si.timezone AS site_tz
       FROM shift_sessions ss
       JOIN shifts s  ON s.id  = ss.shift_id
       JOIN sites  si ON si.id = ss.site_id
       JOIN guards g  ON g.id  = ss.guard_id
       WHERE (ss.clocked_out_at IS NULL
              AND s.scheduled_start <= NOW())
          OR ss.clocked_out_at > NOW() - INTERVAL '15 minutes'`,
    );

    for (const s of sessions) {
      const windows = completedTrackableWindows(
        new Date(s.scheduled_start),
        new Date(s.scheduled_end),
        new Date(s.clocked_in_at),
        now,
      );

      for (const w of windows) {
        considered += 1;

        // Fast-path skip: SELECT is cheaper than a would-be
        // conflicting INSERT.
        if (await anyReportInWindow(s.session_id, w.windowStart, w.windowEnd)) continue;

        const label = siteLocalLabel(w.windowStart, s.site_tz);

        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO missed_reports
             (shift_session_id, site_id, guard_id,
              window_start, window_end, window_label, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (shift_session_id, window_start) DO NOTHING
           RETURNING id`,
          [
            s.session_id, s.site_id, s.guard_id,
            w.windowStart, w.windowEnd, label,
            expiresAtFor('missed_report'),
          ],
        );
        const mrId = inserted.rows[0]?.id;
        if (!mrId) continue;
        created += 1;

        Sentry.addBreadcrumb({
          category: 'cron',
          message: 'missedReportCron created row',
          level: 'info',
          data: {
            missed_report_id: mrId,
            session_id: s.session_id,
            window_label: label,
          },
        });

        const title = 'Missed report';
        const body  = `You missed the ${label} report window. Submit now.`;
        const data = {
          missedReportId: mrId,
          windowLabel:    label,
          windowStart:    w.windowStart.toISOString(),
          windowEnd:      w.windowEnd.toISOString(),
          siteName:       s.site_name,
        };

        await insertNotification({
          guardId:        s.guard_id,
          type:           'missed_report',
          title,
          body,
          data,
          shiftSessionId: s.session_id,
        });

        if (s.fcm_token) {
          try {
            await sendPushNotification({
              token: s.fcm_token,
              title,
              body,
              data: {
                type:           'missed_report',
                missedReportId: mrId,
                windowLabel:    label,
                windowStart:    w.windowStart.toISOString(),
                windowEnd:      w.windowEnd.toISOString(),
                siteName:       s.site_name,
              },
            });
          } catch (err) {
            console.error(`[missedReportCron] FCM push failed for session ${s.session_id}:`, err);
            Sentry.addBreadcrumb({
              category: 'cron',
              message: 'missedReportCron push failed',
              level: 'error',
              data: { session_id: s.session_id, missed_report_id: mrId },
            });
            Sentry.captureException(err, {
              tags: { service: 'firebase', flow: 'missed_report_push' },
              extra: { session_id: s.session_id, missed_report_id: mrId },
            });
          }
        }
      }
    }
  } catch (err) {
    console.error('[missedReportCron] Cron error:', err);
    Sentry.captureException(err, { tags: { service: 'cron', flow: 'missed_report' } });
  } finally {
    if (created > 0 || considered > 20) {
      console.log(`[missedReportCron] considered=${considered} created=${created}`);
    }
  }
});
