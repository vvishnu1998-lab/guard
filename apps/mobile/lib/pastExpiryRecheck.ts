/**
 * T6a (U3): the background geofence task is about to suppress an event
 * because the stored shift end + grace has passed. Ask the server once
 * whether that end is still true.
 *
 * WHY THIS EXISTS. U3 rewrites 'active_shift_end' when the app re-reads the
 * shift — on the edit's push, on foreground, on home focus. A suspended or
 * killed app runs none of that: the push shows a banner and no JS runs. So
 * after an admin EXTENDS a shift, a guard who never reopens the app would
 * have every breach from old end + grace onward suppressed by the local gate,
 * on a session the server still has open. The region is still armed and the
 * task still runs on every Enter/Exit, so the task itself can ask.
 *
 * Deliberately narrow:
 *   - Only on the suppress path. The normal breach path is untouched and still
 *     alerts before any network call.
 *   - Only "extended" un-suppresses: the same session, a well-formed window,
 *     and a new end that is not itself past expiry — in an answer handled
 *     promptly. Everything else — offline, a timeout, an answer handled late
 *     (see RECHECK_LATE_AFTER_MS), a 401 (the stored access token lives 8 h
 *     and the task never refreshes it), a 5xx, null, another session, a
 *     malformed body — suppresses exactly as before.
 *   - A null answer does NOT disarm the region here: that answer also covers
 *     an open session more than 2 h past its end, and suppressing already
 *     costs nothing. The 409 teardown and the app's next foreground disarm it.
 *
 * Pure, importing only ./shiftExpiry, so scripts/check-past-expiry-recheck.ts
 * can run it.
 */
import { isPastShiftExpiry, isUsableShiftEnd } from './shiftExpiry';

/** Long enough for one small GET on a poor connection, short enough to leave
 *  the violation POST room inside iOS's background window for a region event
 *  (general knowledge: about 10 s). Enforced natively by the request itself. */
export const RECHECK_TIMEOUT_MS = 5_000;

/**
 * An answer handled later than this after the request went out counts as NO
 * answer. The request's own timeout cannot guarantee that: on Android, JS
 * timers and timer-scheduled callbacks do not run while the app is
 * backgrounded or running headless, so a response can sit unprocessed until
 * the guard next opens the app — minutes or hours later. Judging it then
 * would replay an old event as a fresh breach. The 2 s over the timeout is
 * slack for handling a response that arrived just inside it.
 */
export const RECHECK_LATE_AFTER_MS = RECHECK_TIMEOUT_MS + 2_000;

export type RecheckResponse =
  | { ok: false }                                   // request failed, timed out, aborted, or no API URL
  | { ok: true; status: number; body: unknown };    // body: parsed JSON, or undefined

export type RecheckVerdict =
  | { kind: 'extended'; scheduledEnd: string }
  | {
      kind: 'suppress';
      reason: 'late' | 'fetch_failed' | 'http_status' | 'no_session' | 'different_session' | 'unparseable' | 'still_past';
    };

/**
 * @param askedAtMs  when the request went out.
 * @param nowMs      when the answer is being handled.
 */
export function decidePastExpiryRecheck(
  res: RecheckResponse,
  storedSessionId: string,
  askedAtMs: number,
  nowMs: number,
): RecheckVerdict {
  if (!(nowMs - askedAtMs <= RECHECK_LATE_AFTER_MS)) return { kind: 'suppress', reason: 'late' };
  if (!res.ok) return { kind: 'suppress', reason: 'fetch_failed' };
  if (res.status !== 200) return { kind: 'suppress', reason: 'http_status' };
  if (res.body === null) return { kind: 'suppress', reason: 'no_session' };
  if (typeof res.body !== 'object') return { kind: 'suppress', reason: 'unparseable' };
  const body = res.body as { session?: { id?: unknown }; shift?: { scheduled_start?: unknown; scheduled_end?: unknown } };
  if (body.session?.id !== storedSessionId) return { kind: 'suppress', reason: 'different_session' };
  const start = body.shift?.scheduled_start;
  const end   = body.shift?.scheduled_end;
  if (typeof start !== 'string' || typeof end !== 'string' || !isUsableShiftEnd(start, end)) {
    return { kind: 'suppress', reason: 'unparseable' };
  }
  if (isPastShiftExpiry(end, nowMs)) return { kind: 'suppress', reason: 'still_past' };
  return { kind: 'extended', scheduledEnd: end };
}
