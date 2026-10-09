import { useEffect, useState } from 'react';
import {
  currentPingWindow,
  remainingMsUntilNextPing,
  type PingWindowState,
} from '../lib/pingSchedule';

/**
 * The ping window in force and the time until the next one opens, recomputed
 * every second from the SAME helpers, so a countdown and a PING tile on one
 * screen can never disagree with each other — or with the server, which
 * anchors on scheduled_start too.
 *
 * site_tz is not on the /shifts/active-session payload; pingSchedule falls
 * back to the same zone the server does. See its header.
 *
 * `now` is the instant both values were computed for. A caller deriving
 * anything else from the window (time until it closes) uses it rather than a
 * fresh clock read, so the derived number and the window agree.
 */
export function usePingWindow(args: {
  clockedInAt?:    string;
  scheduledStart?: string;
  scheduledEnd?:   string;
}): { pingWindow: PingWindowState | null; nextPingMs: number | null; now: Date } {
  const { clockedInAt, scheduledStart, scheduledEnd } = args;
  const [state, setState] = useState<{
    pingWindow: PingWindowState | null;
    nextPingMs: number | null;
    now: Date;
  }>({ pingWindow: null, nextPingMs: null, now: new Date() });

  useEffect(() => {
    if (!clockedInAt || !scheduledStart || !scheduledEnd) return;
    const a = { scheduledStart, scheduledEnd, clockedInAt };

    const tick = () => {
      const now = new Date();
      setState({
        pingWindow: currentPingWindow({ ...a, now }),
        nextPingMs: remainingMsUntilNextPing({ ...a, now }),
        now,
      });
    };

    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [clockedInAt, scheduledStart, scheduledEnd]);

  return state;
}
