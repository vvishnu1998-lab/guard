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
 */
export function pingTileFor(
  pingWindow: PingWindowState | null,
  answered: AnsweredWindow | null,
  sessionId: string,
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
  return { enabled: true, label: 'PING NOW', note: `${openWindow!.label} window`, openWindow };
}

/**
 * Same route and same query param the notification deep-link uses
 * (lib/navigateForNotification.ts ping_reminder / missed_ping), so every
 * entry point converges on one flow and writes one shape of row.
 */
export function pingRouteFor(window: PingWindow): string {
  return `/ping?window_label=${encodeURIComponent(window.label)}`;
}
