/**
 * The PING tile — ONE definition, read by every screen that offers a ping.
 *
 * This gate lived inline in app/active-shift/index.tsx. Home now offers a
 * ping too (N173: guards who file reports all shift but never open the
 * active-shift screen never saw the tile), and a second copy of the rule on
 * Home would be the defect class this codebase keeps removing — two
 * definitions of the same window that drift until they disagree. Both
 * screens call pingTileFor(), so they cannot.
 *
 * Pure: no React, no Expo. scripts/check-ping-home.ts proves it against the
 * inline version it replaced.
 */
import type { PingWindow, PingWindowState } from './pingSchedule';

/** The window this device last answered, scoped to a session. */
export interface AnsweredWindow {
  sessionId: string;
  label: string;
}

export interface PingTile {
  enabled: boolean;
  label: 'PING' | 'PING NOW' | 'PINGED';
  /** Why the tile is in this state, or which window a tap answers. */
  note: string | null;
  /** The window currently open, whether or not it is answered. */
  openWindow: PingWindow | null;
}

/**
 * One rule per disabled state, each with copy that names the reason. The
 * tile is never hidden: a guard who cannot ping right now still needs to see
 * that pinging is a thing this shift expects of them.
 *
 * "Already answered" is this device's memory (store/shiftStore.ts
 * lastPingedWindow), not the server's. When the memory is missing the tile
 * fails OPEN — a redundant ping comes back "Already Recorded", while a
 * wrongly-disabled tile leaves a window unanswered.
 *
 * An open break dims the tile: the server waives any window a break overlaps
 * (services/pingWindows.ts breakOverlapsWindow), so nothing is owed, and the
 * tile and Home's ping line must not disagree about that. A window answered
 * before the break still reads PINGED.
 */
export function pingTileFor(
  pingWindow: PingWindowState | null,
  answered: AnsweredWindow | null,
  sessionId: string,
  onBreak: boolean,
): PingTile {
  const openWindow = pingWindow?.status === 'open' ? pingWindow.window : null;
  const alreadyPinged =
    openWindow !== null &&
    answered?.sessionId === sessionId &&
    answered?.label === openWindow.label;

  if (!pingWindow)                              return { enabled: false, label: 'PING',   note: null,                   openWindow };
  if (pingWindow.status === 'before_shift')     return { enabled: false, label: 'PING',   note: 'Starts at shift time', openWindow };
  if (pingWindow.status === 'shift_ending')     return { enabled: false, label: 'PING',   note: 'Shift ending',         openWindow };
  if (pingWindow.status === 'before_clock_in')  return { enabled: false, label: 'PING',   note: 'Next window',          openWindow };
  if (alreadyPinged)                            return { enabled: false, label: 'PINGED', note: `${openWindow!.label} done`,   openWindow };
  if (onBreak)                                  return { enabled: false, label: 'PING',   note: 'On break',             openWindow };
  return { enabled: true, label: 'PING NOW', note: `${openWindow!.label} window`, openWindow };
}

/** What Home's ping line says. */
export type PingStatus =
  /** The window is open and unanswered: the guard owes a ping now. */
  | { kind: 'due';  window: PingWindow; closesInMs: number }
  /** The open window is answered; nextInMs is null when none remains. */
  | { kind: 'done'; window: PingWindow; nextInMs: number | null }
  /** Nothing is owed right now; the next window opens in nextInMs. */
  | { kind: 'next'; nextInMs: number }
  | { kind: 'none' };

/**
 * Home's countdown used to read "Next ping in mm:ss" at every moment of a
 * shift — including while the CURRENT window was open and unanswered, when
 * the number was the time until the window AFTER it. The only line on Home
 * about pings therefore told a guard who owed one that the next was 20
 * minutes off (N173). This states the obligation instead, from the same
 * gate as the tile.
 *
 * "Due" is exactly "the tile is live", so the two cannot disagree. During an
 * open break the tile is dimmed (the window is waived; see pingTileFor), so
 * the line falls back to the countdown.
 */
export function pingStatusFor(args: {
  pingWindow: PingWindowState | null;
  nextPingMs: number | null;
  answered:   AnsweredWindow | null;
  sessionId:  string;
  onBreak:    boolean;
  now:        Date;
}): PingStatus {
  const tile = pingTileFor(args.pingWindow, args.answered, args.sessionId, args.onBreak);
  const w = tile.openWindow;
  if (w && tile.label === 'PINGED') return { kind: 'done', window: w, nextInMs: args.nextPingMs };
  if (w && tile.enabled) {
    return { kind: 'due', window: w, closesInMs: Math.max(0, w.end.getTime() - args.now.getTime()) };
  }
  if (args.nextPingMs !== null) return { kind: 'next', nextInMs: args.nextPingMs };
  return { kind: 'none' };
}

/** "m:ss", minutes unbounded — the format Home's countdown has always used. */
export function formatMinSec(ms: number): string {
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

/** The words for a PingStatus. null renders nothing, as the old countdown
 *  did once no further window remained. */
export function pingStatusCopy(s: PingStatus): { title: string | null; text: string } | null {
  switch (s.kind) {
    case 'due':
      return { title: 'PING DUE NOW', text: `${s.window.label} window closes in ${formatMinSec(s.closesInMs)}` };
    case 'done':
      return {
        title: null,
        text: `✓ ${s.window.label} done` +
          (s.nextInMs !== null ? ` · next window opens in ${formatMinSec(s.nextInMs)}` : ''),
      };
    case 'next':
      return { title: null, text: `Next ping in ${formatMinSec(s.nextInMs)}` };
    case 'none':
      return null;
  }
}

/**
 * Same route and same query param the notification deep-link uses
 * (lib/navigateForNotification.ts ping_reminder / missed_ping), so every
 * entry point converges on one flow and writes one shape of row.
 */
export function pingRouteFor(window: PingWindow): string {
  return `/ping?window_label=${encodeURIComponent(window.label)}`;
}
