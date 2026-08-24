/**
 * Site-timezone day-of-week resolution.
 *
 * The API runs UTC on Railway, so any `Date.getDay()` on a stored instant
 * returns the UTC day — not the day the guard was actually working. Every
 * NetraOps post that straddles UTC midnight is affected: Bethel AME Church
 * (17:00–23:00 PT) and 23000 Cristo Rey Los Altos (19:00–06:00 PT) both roll
 * into the next UTC date mid-shift, so a Saturday-evening clock-in resolves
 * to Sunday in UTC.
 *
 * `sites.timezone` (schema_v21, NOT NULL with a shape CHECK) is the source of
 * truth for interpreting anything scheduled at a site — the same principle
 * schema_v40 established when it moved `task_instances.due_at` off
 * `setUTCHours()` and onto Postgres timezone math.
 *
 * This helper exists so there is exactly ONE way to answer "what day of the
 * week was it, at this site?". It was lifted verbatim out of
 * routes/shifts.ts (the repeat_days expansion) when services/tasks.ts needed
 * the same answer; both call sites now share it rather than carrying a copy
 * each.
 *
 * Semantics are deliberately unchanged from that original: a formatter that
 * yields an unrecognised weekday name falls back to the UTC `getDay()`. A
 * timezone string that is syntactically valid but not a real IANA zone makes
 * `Intl.DateTimeFormat` throw, and that throw is left to propagate — a loud
 * failure is better than silently gating tasks on the wrong day, and each
 * caller already handles it (routes/shifts.ts surfaces it on shift create;
 * services/tasks.ts is invoked fire-and-forget behind a Sentry catch).
 */

const DOW_BY_NAME: Record<string, number> = {
  Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
  Thursday: 4, Friday: 5, Saturday: 6,
};

/** Day of week (0 = Sunday) for `d` as observed in IANA zone `timeZone`. */
export function dowInTimeZone(d: Date, timeZone: string): number {
  return DOW_BY_NAME[
    new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(d)
  ] ?? d.getDay();
}
