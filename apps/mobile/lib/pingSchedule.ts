/**
 * Ping window schedule — the client's mirror of the SERVER's window math.
 *
 * The server anchors every ping window to the SHIFT's scheduled_start:
 *
 *     window N = [ scheduled_start + N*30min , scheduled_start + (N+1)*30min )
 *
 * and labels it by its START, formatted in the site's timezone. See
 * apps/api/src/jobs/pingReminder.ts (currentBoundary + siteLocalLabel) and
 * apps/api/src/jobs/missedPingCron.ts (completedTrackableWindows).
 *
 * This file previously floored the WALL CLOCK to :00/:30 and anchored on
 * clocked_in_at. That agrees with the server only when scheduled_start
 * happens to land on :00 or :30. Every STARNET shift so far has, which is
 * why the divergence never surfaced — but a 20:15 shift put the countdown
 * 15 minutes out of phase with the reminders the guard actually receives
 * and with the windows they are marked down against in missed_pings.
 *
 * Rules mirrored from the server, and why each exists:
 *   R3  A window counts only if its END fits inside scheduled_end — no
 *       partial window at the tail of a shift (missedPingCron.ts:85).
 *   R4  A window whose START precedes clocked_in_at is not the guard's to
 *       answer for; they were not on shift yet (missedPingCron.ts:87).
 *
 * R3 and R4 are the WHOLE test. The reminder cron's 5-minute post-clock-in
 * grace (pingReminder.ts:168) is deliberately NOT mirrored here: it decides
 * whether a PUSH goes out, not whether a window counts. missedPingCron
 * applies no such grace, so a window inside it is still fully trackable and
 * the guard is still marked down for it. Honouring the grace would have
 * meant staying quiet about exactly the windows that carry an obligation
 * but no notification — the worst case, and the one a manual button exists
 * to cover.
 *
 * The same reasoning fixes what the countdown MEANS. It is not "time until
 * the next push"; it is "time until your next window opens". Those differ
 * whenever the cron suppresses a boundary, and the window opening is the
 * one the guard can act on.
 *
 * TIMEZONE: the window BOUNDARIES are pure epoch arithmetic and carry no
 * timezone. Only the LABEL is formatted, and it must match the server's
 * rendering byte for byte because the server matches on the string
 * (routes/locations.ts looks up missed_pings by window_label). We therefore
 * reproduce the server's exact Intl option bag INCLUDING its
 * 'America/Los_Angeles' fallback. GET /shifts/active-session does not
 * currently return site_tz — plumbing it through is a one-line API change
 * and would let siteTz be passed here instead of falling back. Every site
 * on the platform today is America/Los_Angeles, so the fallback and the
 * real value are the same string.
 */

/** Mirrors the `siteTz ?? 'America/Los_Angeles'` fallback in
 *  pingReminder.ts:91 and missedPingCron.ts:55. */
export const DEFAULT_SITE_TZ = 'America/Los_Angeles';

/** 30-minute cadence. Server: `const stepMs = 30 * 60 * 1000` (pingReminder.ts:115)
 *  and `const WINDOW_MS = 30 * 60 * 1000` (missedPingCron.ts:52). */
export const PING_WINDOW_MS = 30 * 60 * 1000;

export interface PingWindow {
  /** N in scheduled_start + N*30min. */
  index: number;
  start: Date;
  end: Date;
  /** HH:MM of `start`, site-local — the exact string the server expects. */
  label: string;
}

export type PingWindowState =
  | { status: 'open'; window: PingWindow }
  /** now < scheduled_start — the server's currentBoundary() returns null here. */
  | { status: 'before_shift'; startsAt: Date }
  /** R4 — this window opened before the guard clocked in. */
  | { status: 'before_clock_in'; window: PingWindow }
  /** R3 — no whole window left inside scheduled_end. */
  | { status: 'shift_ending' };

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * HH:MM in the site's zone. Byte-identical to the server's siteLocalLabel:
 * same locale, same option bag, same fallback zone.
 */
export function pingWindowLabel(when: Date, siteTz?: string | null): string {
  const opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit', minute: '2-digit', hour12: false,
    timeZone: siteTz ?? DEFAULT_SITE_TZ,
  };
  try {
    return new Intl.DateTimeFormat('en-GB', opts).format(when);
  } catch {
    // Unknown IANA zone — Intl throws RangeError. Fall back to the same
    // zone the server would have used rather than to the device's, so the
    // label still matches what the server stored.
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: DEFAULT_SITE_TZ }).format(when);
  }
}

/** The window containing `now`, regardless of whether it is answerable. */
function windowAt(scheduledStart: Date, now: Date, siteTz?: string | null): PingWindow {
  const index = Math.floor((now.getTime() - scheduledStart.getTime()) / PING_WINDOW_MS);
  const start = new Date(scheduledStart.getTime() + index * PING_WINDOW_MS);
  const end   = new Date(start.getTime() + PING_WINDOW_MS);
  return { index, start, end, label: pingWindowLabel(start, siteTz) };
}

/**
 * The ping window in force right now, or why there isn't one.
 *
 * `status: 'open'` is the ONLY state in which the guard both owes a ping and
 * can submit one that the server will attribute to the window they are in.
 */
export function currentPingWindow(args: {
  scheduledStart: string | Date;
  scheduledEnd:   string | Date;
  clockedInAt:    string | Date;
  siteTz?:        string | null;
  now?:           Date;
}): PingWindowState {
  const scheduledStart = toDate(args.scheduledStart);
  const scheduledEnd   = toDate(args.scheduledEnd);
  const clockedInAt    = toDate(args.clockedInAt);
  const now            = args.now ?? new Date();

  if (now.getTime() < scheduledStart.getTime()) {
    return { status: 'before_shift', startsAt: scheduledStart };
  }

  const w = windowAt(scheduledStart, now, args.siteTz);

  // R3 — the window must close on or before scheduled_end.
  if (w.end.getTime() > scheduledEnd.getTime()) return { status: 'shift_ending' };
  // R4 — the guard was not on shift when this window opened.
  if (w.start.getTime() < clockedInAt.getTime()) return { status: 'before_clock_in', window: w };

  return { status: 'open', window: w };
}

/**
 * When the guard's next ping window OPENS: scheduled_start + N*30min for the
 * smallest N whose window is still trackable and whose start is in the future.
 *
 * Returns null when no trackable window remains — the tail of a shift has no
 * next window to count down to, and freezing at 0:00 was the old code's way
 * of saying so.
 *
 * N starts at 0, not 1. Window 0 = [scheduled_start, +30min) is trackable
 * whenever the guard clocked in before their shift, and it is the one window
 * that NEVER gets a ping_reminder (pingReminder.ts returns null for n <= 0) —
 * it only ever surfaces as a missed_ping after it has closed. On STARNET
 * b8d23d66 that is precisely the 20:00 window: no reminder, missed row at
 * 20:30. Counting down to it is the point.
 */
export function nextPingAt(args: {
  scheduledStart: string | Date;
  scheduledEnd:   string | Date;
  clockedInAt:    string | Date;
  now?:           Date;
}): Date | null {
  const scheduledStart = toDate(args.scheduledStart);
  const scheduledEnd   = toDate(args.scheduledEnd);
  const clockedInAt    = toDate(args.clockedInAt);
  const nowMs          = (args.now ?? new Date()).getTime();
  const startMs        = scheduledStart.getTime();

  let n = nowMs < startMs ? 0 : Math.floor((nowMs - startMs) / PING_WINDOW_MS) + 1;

  // Bounded: a shift cannot contain more steps than its own length.
  for (let guard = 0; guard < 512; guard += 1) {
    const openMs  = startMs + n * PING_WINDOW_MS;
    const closeMs = openMs + PING_WINDOW_MS;
    if (closeMs > scheduledEnd.getTime()) return null;          // R3
    if (openMs >= clockedInAt.getTime()) return new Date(openMs); // R4
    n += 1;
  }
  return null;
}

/** Milliseconds until the next window opens, or null when none remains. */
export function remainingMsUntilNextPing(args: {
  scheduledStart: string | Date;
  scheduledEnd:   string | Date;
  clockedInAt:    string | Date;
  now?:           Date;
}): number | null {
  const now  = args.now ?? new Date();
  const next = nextPingAt({ ...args, now });
  return next ? Math.max(0, next.getTime() - now.getTime()) : null;
}
