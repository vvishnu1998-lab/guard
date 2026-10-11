/**
 * How late a missed ping window was answered, in the words of the activity
 * feed's "Missed — answered … late" (routes/activityLog.ts). The web table
 * and both activity PDFs print that string as the server sends it.
 *
 * Under a minute it counts SECONDS. Rounded to whole minutes, the answers
 * that land just after a window closes read "answered 0 minutes late", which
 * says the window was both missed and not late: 43 of the 224 answered misses
 * in production arrived 9-29 s after the close (read 2026-10-11).
 *
 * Its own module so the test imports it rather than a copy: the route opens a
 * database pool at import.
 */

/**
 * `lateMs` > 0, measured from the window's END. Rounded to whole seconds,
 * never below 1; anything that rounds to 60 s or more is in whole minutes,
 * rounded, as the figure always was (so never "60 seconds").
 */
export function lateBy(lateMs: number): string {
  const s = Math.max(1, Math.round(lateMs / 1000));
  if (s < 60) return `${s} ${s === 1 ? 'second' : 'seconds'}`;
  const m = Math.round(lateMs / 60_000);
  return `${m} ${m === 1 ? 'minute' : 'minutes'}`;
}
