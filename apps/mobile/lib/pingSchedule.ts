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
 *   5m  The reminder cron skips sessions clocked in less than 5 minutes ago
 *       (pingReminder.ts:168), so a boundary landing inside that grace
 *       period never fires and the countdown must skip to the next one.
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
const DEFAULT_SITE_TZ = 'America/Los_Angeles';

/** 30-minute cadence. Server: `const stepMs = 30 * 60 * 1000` (pingReminder.ts:115)
 *  and `const WINDOW_MS = 30 * 60 * 1000` (missedPingCron.ts:52). */
export const PING_WINDOW_MS = 30 * 60 * 1000;

/** Server: `ss.clocked_in_at <= NOW() - INTERVAL '5 minutes'`. */
const CLOCK_IN_GRACE_MS = 5 * 60 * 1000;

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
 * The next instant a ping_reminder can fire: scheduled_start + N*30min for
 * N >= 1, capped at scheduled_end, skipping any boundary inside the 5-minute
 * post-clock-in grace. Returns null once no further boundary can fire.
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

  // Server: `n <= 0` returns null, so the earliest boundary is N = 1.
  let n = nowMs < startMs ? 1 : Math.floor((nowMs - startMs) / PING_WINDOW_MS) + 1;

  // Bounded: a shift cannot contain more steps than its own length.
  for (let guard = 0; guard < 512; guard += 1) {
    const boundaryMs = startMs + n * PING_WINDOW_MS;
    if (boundaryMs > scheduledEnd.getTime()) return null;
    if (boundaryMs - clockedInAt.getTime() >= CLOCK_IN_GRACE_MS) return new Date(boundaryMs);
    n += 1;
  }
  return null;
}

/** Milliseconds until the next firing boundary, or null when none remains. */
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
