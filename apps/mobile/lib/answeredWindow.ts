/**
 * The answered ping window, persisted so it survives an app restart.
 *
 * store/shiftStore.ts keeps lastPingedWindow in memory, and iOS kills a
 * backgrounded app freely — STARNET GRD0012's phone cold-started on nearly
 * every open across one night (N173). Each restart forgot the answer, and
 * the PING tile fails OPEN by design, so Home would go back to "PING DUE
 * NOW" for a window the guard had just answered. Persisting the one value
 * (scoped to its session) keeps the line truthful after a restart.
 *
 * Still fails open: anything unreadable, malformed or belonging to another
 * session reads as "not answered", never as answered. There is no server
 * endpoint that reports pings for the current window; adding one is the
 * real fix and is an API change.
 *
 * Pure: storage I/O is the caller's (shiftStore). scripts/check-ping-home.ts
 * exercises these.
 */
import type { AnsweredWindow } from './pingTile';

export const ANSWERED_WINDOW_KEY = 'answered_ping_window';

/** Window labels are the server's HH:MM, site-local (lib/pingSchedule.ts). */
const LABEL_RE = /^\d{2}:\d{2}$/;

export function serializeAnsweredWindow(w: AnsweredWindow): string {
  return JSON.stringify({ sessionId: w.sessionId, label: w.label });
}

/** The stored answer if it belongs to `sessionId`; null for anything else. */
export function parseAnsweredWindow(raw: string | null, sessionId: string): AnsweredWindow | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { sessionId?: unknown; label?: unknown } | null;
    if (
      v !== null && typeof v === 'object' &&
      typeof v.sessionId === 'string' && v.sessionId === sessionId &&
      typeof v.label === 'string' && LABEL_RE.test(v.label)
    ) {
      return { sessionId: v.sessionId, label: v.label };
    }
  } catch {
    // corrupt value: not answered
  }
  return null;
}

/**
 * A value read back from storage may be applied only to the session it was
 * read for, and never over an answer made in memory while the read was in
 * flight (a ping can land between setActiveSession and the Keychain reply).
 */
export function shouldApplyStored(args: {
  stored:          AnsweredWindow | null;
  current:         AnsweredWindow | null;
  activeSessionId: string | null;
}): boolean {
  return args.stored !== null &&
    args.current === null &&
    args.activeSessionId === args.stored.sessionId;
}

/**
 * The window a confirmed ping lets the PING tile count as answered: only the
 * window open now, the one the tile and Home's ping line ask about
 * (lib/pingTile.ts). A backfill answers a closed window, so there is nothing
 * to record — and with one slot, recording it overwrote the open window's
 * answer: ping 07:30, backfill 07:00, and Home read PING DUE NOW for the
 * 07:30 already pinged.
 *
 * `openNow` is the open window's label when the ping is confirmed, or null
 * when none is open; then nothing is recorded.
 */
export function windowToRemember(answered: string | null, openNow: string | null): string | null {
  return answered !== null && answered === openNow ? answered : null;
}
