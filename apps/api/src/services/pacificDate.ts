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
