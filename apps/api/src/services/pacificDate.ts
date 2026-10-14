/**
 * Pacific calendar-date helpers.
 *
 * All date semantics in this app are anchored to America/Los_Angeles (see
 * email.ts fmtDTPacific). Comparing instants in UTC is wrong for "is this
 * shift dated before today" — a shift scheduled for 11pm PT today is 7am
 * UTC tomorrow, and a naive UTC compare would call it "tomorrow's date."
 *
 * Pacific calendar dates are formatted as YYYY-MM-DD strings so they
 * compare lexicographically without timezone gymnastics.
 */

const FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function pacificDateStr(input: Date | string, now?: Date): string {
  const d = typeof input === 'string' ? new Date(input) : input;
  return FORMATTER.format(d);
}

export function isPastPacificDate(input: Date | string, now: Date = new Date()): boolean {
  return pacificDateStr(input) < pacificDateStr(now);
}

export function pacificTodayStr(now: Date = new Date()): string {
  return FORMATTER.format(now);
}

/**
 * Compare a raw YYYY-MM-DD calendar string against today's Pacific date.
 *
 * `isPastPacificDate("2026-06-15")` would parse the string as 2026-06-15
 * UTC midnight and then format it back into Pacific — which lands on
 * 2026-06-14 PT (because midnight UTC is 5pm PT the prior day). That
 * off-by-one is wrong for calendar-string inputs. This helper sidesteps
 * the round-trip and just compares the two YYYY-MM-DD strings directly.
 */
export function isPastPacificDateString(yyyymmdd: string, now: Date = new Date()): boolean {
  return yyyymmdd < pacificTodayStr(now);
}

/**
 * The Pacific zone as a ready-to-interpolate SQL literal, quotes included.
 *
 * Postgres has no notion of "the app's timezone": a bare CURRENT_DATE or
 * DATE_TRUNC(..., NOW()) resolves against the SESSION TimeZone, which on
 * Railway is Etc/UTC. Every calendar boundary therefore has to name the zone
 * explicitly, and the string was being retyped at each call site.
 *
 * Two shapes use it, both of which keep the compared column BARE so an index
 * on it stays usable -- the bound is computed from NOW(), not by wrapping the
 * column:
 *
 *   period start:  col >= (DATE_TRUNC('week', NOW() AT TIME ZONE ${PACIFIC_TZ_SQL})
 *                            AT TIME ZONE ${PACIFIC_TZ_SQL})
 *   bucketing:     DATE_TRUNC('month', col AT TIME ZONE ${PACIFIC_TZ_SQL})
 *
 * Use this ONLY where the query is company- or app-scoped. Where the query
 * already joins sites, prefer that site's own s.timezone -- see
 * routes/admin.ts dashboard-sites, which anchors per-site.
 */
export const PACIFIC_TZ_SQL = "'America/Los_Angeles'";

const LONG_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hourCycle: 'h12',
});
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * An instant as a sentence names it, in Pacific time: "Wednesday, October 14,
 * 2026 at 2:06 PM PT" (Phase D, D2: the password-changed email).
 *
 * The weekday is computed from the Pacific calendar date, on that date's UTC
 * midnight, so no process zone can move it. Vishnu's correction, 2026-10-14:
 * the copy first proposed for this email named 14 October 2026 a Tuesday; it
 * is a Wednesday, and scripts/test-d2-password-changed-email.ts pins it.
 */
export function pacificLongDateTime(input: Date | string): string {
  const parts = LONG_PARTS.formatToParts(typeof input === 'string' ? new Date(input) : input);
  const part = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const y = Number(part('year'));
  const m = Number(part('month'));
  const d = Number(part('day'));
  const weekday = WEEKDAYS_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS_LONG[m - 1]} ${d}, ${y} at ${part('hour')}:${part('minute')} ${part('dayPeriod').toUpperCase()} PT`;
}
