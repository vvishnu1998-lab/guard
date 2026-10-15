/**
 * N179. The 30-second grace after a ping window closes.
 *
 * Vishnu, 2026-10-15: "add a 30-second grace after the ping window closes; a ping inside it counts as on time.
 * Forward-only, no backfill of past records." And decision (a): a ping that counts through the grace answers only
 * the window it names; the next window still needs its own ping.
 *
 * Before N179 a window was answered only by a ping that ARRIVED inside it, and missedPingCron judged it about one
 * second after the close. A ping the guard sent in time but that uploaded a few seconds late was "missed, answered
 * N seconds late" on the client's documents: 36 such answers in the 30 days to 2026-10-15, median 16.6 s.
 *
 * The rule, for a window W = [ws, we) that closes at or after PING_GRACE_FROM:
 *   - a ping labelled W (its window_label) that arrives in [we, we + PING_GRACE_MS) answers W on time;
 *   - that ping does NOT also answer the window it arrived in, the way every other ping answers the window it
 *     arrives in: so a ping arriving in [ws, ws + grace) labelled with the PREVIOUS window belongs to the previous
 *     window, not to W (decision (a): one ping, one window);
 *   - missedPingCron judges W only once its grace has passed.
 *
 * Windows that closed before PING_GRACE_FROM keep the old rule (no grace, no exclusion), so nothing judged before
 * the cutover changes: forward-only. The cutover must fall after the deploy that ships this, so that no window is
 * judged by the old process's rule and then again by this one.
 *
 * Ping-aware on purpose, and a module of its own: services/pingWindows.ts must stay ping-blind for the daily
 * client report. missedPingCron (the flag) and pingReminder (the prompt) both judge "answered" here, so they cannot
 * disagree about a window.
 */
import { pool } from '../db/pool';
import { siteLocalLabel } from './pingWindows';

/** How long after a window closes a ping labelled with it still counts as on time. */
export const PING_GRACE_MS = 30_000;

/** Windows that close at or after this instant get the grace (00:00 PDT, 2026-10-16). After the deploy. */
export const PING_GRACE_FROM = new Date('2026-10-16T07:00:00Z');

/** The grace of a window that ends at `windowEnd`: PING_GRACE_MS from the cutover on, 0 before it. */
export function graceMsFor(windowEnd: Date): number {
  return windowEnd.getTime() >= PING_GRACE_FROM.getTime() ? PING_GRACE_MS : 0;
}

/** True once a window can be judged: it has closed and its grace, if it has one, has passed. */
export function windowJudgeable(windowEnd: Date, now: Date): boolean {
  return now.getTime() >= windowEnd.getTime() + graceMsFor(windowEnd);
}

/**
 * Was this window answered on time? Either:
 *   - a ping arrived inside it, unless that ping arrived in the previous window's grace labelled with the previous
 *     window (then it answered the previous window: decision (a)); or
 *   - a ping labelled with this window arrived in its own grace.
 *
 * A ping with no label is matched on its arrival time alone, as before. A label is compared null-safely, so an
 * unlabelled ping in the first seconds of a window still answers it.
 */
export async function windowAnsweredOnTime(
  shiftSessionId: string,
  windowStart: Date,
  windowEnd: Date,
  siteTz: string | null,
  intervalMs: number,
): Promise<boolean> {
  // The previous window ends where this one starts.
  const prevGraceMs = graceMsFor(windowStart);
  const graceMs = graceMsFor(windowEnd);
  const prevLabel = siteLocalLabel(new Date(windowStart.getTime() - intervalMs), siteTz);
  const label = siteLocalLabel(windowStart, siteTz);
  const { rows } = await pool.query<{ hit: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM location_pings
        WHERE shift_session_id = $1
          AND (   (pinged_at >= $2::timestamptz AND pinged_at < $3::timestamptz
                   AND NOT ($4::int > 0
                            AND pinged_at < $2::timestamptz + $4::int * INTERVAL '1 millisecond'
                            AND window_label IS NOT DISTINCT FROM $5::text))
               OR ($6::int > 0
                   AND pinged_at >= $3::timestamptz
                   AND pinged_at < $3::timestamptz + $6::int * INTERVAL '1 millisecond'
                   AND window_label IS NOT DISTINCT FROM $7::text))
     ) AS hit`,
    [shiftSessionId, windowStart, windowEnd, prevGraceMs, prevLabel, graceMs, label],
  );
  return rows[0]?.hit === true;
}

/**
 * The answer to a window that arrived after its grace but before missedPingCron flagged it: a ping labelled with
 * the window, at or after its close. missedPingCron writes such a window's row already resolved by it, and marks
 * the ping late, so it reads exactly like an answer that came after the flag. Without this, a ping landing in the
 * second between the grace's end and the tick would be stored on time beside an open miss for its own window.
 */
export async function lateAnswerFor(
  shiftSessionId: string,
  windowLabel: string,
  windowEnd: Date,
): Promise<{ id: string; pinged_at: Date } | null> {
  const { rows } = await pool.query<{ id: string; pinged_at: Date }>(
    `SELECT id, pinged_at FROM location_pings
      WHERE shift_session_id = $1 AND window_label = $2 AND pinged_at >= $3::timestamptz
      ORDER BY pinged_at ASC
      LIMIT 1`,
    [shiftSessionId, windowLabel, windowEnd],
  );
  return rows[0] ?? null;
}

/** Resolve a fresh missed_pings row with the late answer that beat its flag, and mark that ping late. One transaction. */
export async function resolveAtFlag(missedPingId: string, ping: { id: string; pinged_at: Date }): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE missed_pings SET resolved_at = $2, resolved_by_ping_id = $3
        WHERE id = $1 AND resolved_at IS NULL`,
      [missedPingId, ping.pinged_at, ping.id],
    );
    await client.query('UPDATE location_pings SET submitted_late = true WHERE id = $1', [ping.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
