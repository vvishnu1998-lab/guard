/**
 * What a failed POST /shifts/:id/clock-out means, and what to tell the guard
 * when the session is already gone.
 *
 * WHY THIS EXISTS. The route answers every "no open session for this shift
 * and guard" with one 404 carrying prose only — { error: 'Active session not
 * found' } — whether the sweep auto-closed it at end + grace, an admin closed
 * it in the past (D20), a handoff moved it to another guard, or the guard's
 * own earlier clock-out committed and its response was lost. The screen
 * showed "Clock-Out Failed / Active session not found", left the cached
 * session in place, and every retry failed the same way.
 *
 * The 404 has no code, and the project rule is never to branch on error prose.
 * So a 404 here decides only that the app should ASK: the screen calls
 * refreshFromServer, and GET /shifts/active-session — null, or still a
 * session — decides what happened. The 404's wording is never read.
 *
 * A 409 SESSION_CLOSED — what the other guard routes send for a closed
 * session, and what this route is planned to send (the follow-up API PR) — is
 * proof on its own. Accepting both lets the API and the app ship in either
 * order, and the 404 path stays for a rolled-back or older API.
 *
 * Pure, importing only ./errors, so scripts/check-clockout-copy.ts can run it.
 */
import { ApiError } from './errors';

export type ClockOutFailure =
  /** 400 PHOTO_REJECTED: the photo failed validation; the shift is still open. */
  | 'photo_rejected'
  /** 409 SESSION_CLOSED: the server says this session is closed. */
  | 'session_closed'
  /** 404 from this route: no open session for (shift, guard). Ask the server
   *  before telling the guard anything. */
  | 'maybe_closed'
  /** Anything else: today's generic "Clock-Out Failed". */
  | 'other';

export function classifyClockOutError(err: unknown): ClockOutFailure {
  if (!(err instanceof ApiError)) return 'other';
  if (err.status === 400 && err.code === 'PHOTO_REJECTED') return 'photo_rejected';
  if (err.status === 409 && err.code === 'SESSION_CLOSED') return 'session_closed';
  if (err.status === 404) return 'maybe_closed';
  return 'other';
}

/**
 * After the screen's refreshFromServer, is the session known to be closed?
 * A 409 SESSION_CLOSED is proof on its own. A 404 is confirmed only when the
 * refresh left the store with no session — i.e. the server answered null.
 * A session still in the store (the refresh failed, or the server still
 * reports one) means the 404 was not this session going away.
 */
export function isConfirmedClosed(failure: ClockOutFailure, hasSessionAfterRefresh: boolean): boolean {
  if (failure === 'session_closed') return true;
  if (failure === 'maybe_closed') return !hasSessionAfterRefresh;
  return false;
}

export const ALREADY_CLOCKED_OUT_TITLE = 'Shift Ended';

/**
 * True in every case that reaches it: an auto-close, an admin close, a handoff
 * (the shift carries on under another guard, so "this shift has ended" would
 * be false), and the guard's own earlier clock-out whose response was lost.
 *
 * The route answers before it writes anything, so whatever the guard sent
 * with this attempt — handover notes, the post photo — is recorded nowhere,
 * except in that lost-response case, where the earlier attempt saved it.
 * Hence "may not have been".
 */
export function alreadyClockedOutBody(sent: { notes: boolean; photo: boolean }): string {
  const base = 'You are already clocked out of this shift.';
  if (sent.notes && sent.photo) {
    return `${base}\n\nYour handover notes and post photo may not have been saved. Tell your supervisor.`;
  }
  if (sent.notes) return `${base}\n\nYour handover notes may not have been saved. Give them to your supervisor.`;
  if (sent.photo) return `${base}\n\nYour post photo may not have been saved. Tell your supervisor.`;
  return base;
}
