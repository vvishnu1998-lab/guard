/**
 * Missed-ping detection cron — Phase 1A (Q5).
 *
 * Runs every 5 minutes. Walks every currently-open shift_session (and
 * sessions that clocked out within the last 15 min, to catch the final
 * window of a shift that autoCompleteShifts just closed), computes the
 * completed 30-min windows anchored to the shift's scheduled_start,
 * and INSERTs a missed_pings row for any window that has no ping.
 *
 * Window rules (SD-D + R3 + R4):
 *   * Windows are 30 min slots starting at scheduled_start.
 *   * A window [ws, we] is TRACKED only if we <= scheduled_end
 *     (R3 — no partial window at the end of the shift).
 *   * Windows whose ws < clocked_in_at are SKIPPED (R4 — the guard
 *     was never late for a window that started before their clock-in).
 *     Windows whose ws >= clocked_in_at count with NO first-ping grace.
 *
 * De-dup (R6): the DB has UNIQUE(shift_session_id, window_start).
 * INSERT ... ON CONFLICT DO NOTHING RETURNING id ensures each 5-min
 * tick either lands a fresh row or returns nothing — we only fire the
 * guard push on a fresh row so the every-5-min cron doesn't spam.
 *
 * When a fresh row lands:
 *   1. insertNotification(type='missed_ping') with deep-link payload
 *      { missedPingId, windowLabel, windowStart, windowEnd }.
 *   2. sendPushNotification to the guard's fcm_token if present.
 *
 * The Alerts feed's auto-erase in routes/notifications.ts hides the
 * row once resolved_at is set on the missed_pings row (which happens
 * when the guard submits a late ping via POST /api/locations/ping
 * carrying the matching window_label body param).
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendPushNotification } from '../services/firebase';
import { insertNotification } from '../services/notifications';
import { expiresAtFor } from '../services/retention';

interface SessionRow {
  session_id: string;
  shift_id: string;
  site_id: string;
  guard_id: string;
  fcm_token: string | null;
  clocked_in_at: Date;
  scheduled_start: Date;
  scheduled_end: Date;
  site_tz: string | null;
}

const WINDOW_MS = 30 * 60 * 1000;

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
 * rules (R3 + R4). Returns oldest → newest.
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
  // We only inspect windows whose window_end has already passed.
  // Cap the loop with a safety bound so a bad row (say, a
  // scheduled_start way in the past) can't spin forever.
  for (let n = 0; n < 250; n += 1) {
    const wsMs = ssMs + n * WINDOW_MS;
    const weMs = wsMs + WINDOW_MS;
    if (weMs > seMs) break;             // R3 — end must fit within shift
    if (weMs > nowMs) break;            // window hasn't closed yet
    if (wsMs < ciMs) continue;          // R4/SD-D — skip pre-clock-in windows
    out.push({ windowStart: new Date(wsMs), windowEnd: new Date(weMs) });
  }
  return out;
}

async function anyPingInWindow(
  sessionId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const { rows } = await pool.query<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM location_pings
       WHERE shift_session_id = $1
         AND pinged_at >= $2 AND pinged_at < $3
     ) AS hit`,
    [sessionId, windowStart, windowEnd],
  );
  return rows[0]?.hit === true;
}

cron.schedule('*/5 * * * *', async () => {
  const now = new Date();
  let created = 0;
  let considered = 0;

  try {
    const { rows: sessions } = await pool.query<SessionRow>(
      `SELECT ss.id AS session_id,
              ss.shift_id,
              ss.site_id,
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

        // Fast-path skip: if any ping lands in the window, don't
        // even attempt the INSERT — the ON CONFLICT would still
        // be a no-op but the SELECT here is cheaper than the
        // insert + conflict path.
        if (await anyPingInWindow(s.session_id, w.windowStart, w.windowEnd)) continue;

        const label = siteLocalLabel(w.windowStart, s.site_tz);

        // R6 dedup — ON CONFLICT DO NOTHING RETURNING id. If the
        // row already existed (this window was flagged on a prior
        // tick), the RETURNING yields nothing and we skip the push.
        const inserted = await pool.query<{ id: string }>(
          `INSERT INTO missed_pings
             (shift_session_id, site_id, guard_id,
              window_start, window_end, window_label, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (shift_session_id, window_start) DO NOTHING
           RETURNING id`,
          [
            s.session_id, s.site_id, s.guard_id,
            w.windowStart, w.windowEnd, label,
            expiresAtFor('missed_ping'),
          ],
        );
        const mpId = inserted.rows[0]?.id;
        if (!mpId) continue;
        created += 1;

        const title = 'Missed ping';
        const body  = `You missed the ${label} ping. Submit now.`;
        const data = {
          missedPingId: mpId,
          windowLabel:  label,
          windowStart:  w.windowStart.toISOString(),
          windowEnd:    w.windowEnd.toISOString(),
        };

        await insertNotification({
          guardId:        s.guard_id,
          type:           'missed_ping',
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
                type:         'missed_ping',
                missedPingId: mpId,
                windowLabel:  label,
                windowStart:  w.windowStart.toISOString(),
                windowEnd:    w.windowEnd.toISOString(),
              },
            });
          } catch (err) {
            console.error(`[missedPingCron] FCM push failed for session ${s.session_id}:`, err);
          }
        }
      }
    }
  } catch (err) {
    console.error('[missedPingCron] Cron error:', err);
  } finally {
    if (created > 0 || considered > 20) {
      console.log(`[missedPingCron] considered=${considered} created=${created}`);
    }
  }
});
