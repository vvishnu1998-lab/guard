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
