/**
 * Formats a timestamp as "HH:MM (+Nm late)" in Pacific time, where
 * lateness = actual time − most recent scheduled boundary at or before
 * actual. Boundaries are `scheduleMinutes` past the hour (e.g. `[0, 30]`
 * for the every-30-min ping schedule, `[0]` for the top-of-hour report
 * schedule). Whole-minute floor. On-boundary reads "(on time)". Null
 * actual → "—".
 *
 * Timezone: because our schedules are :00 / :30 past the hour (both
 * timezone-invariant on whole-hour offsets like Pacific), boundary math
 * runs on UTC ms and the display formatter converts the same instant
 * into Pacific. DST is handled by Intl.DateTimeFormat — the underlying
 * instant doesn't change.
 *
 * Lives in its own module (rather than inline in
 * apps/web/app/admin/live-status/page.tsx) so it's importable from
 * tests and other pages. Next.js page files reject custom named
 * exports.
 */
export function computeLateness(
  actualISO: string | null,
  scheduleMinutes: number[],
): { display: string } {
  if (!actualISO) return { display: '—' };
  const actual        = new Date(actualISO);
  const actualMs      = actual.getTime();
  const hourStartMs   = Math.floor(actualMs / 3_600_000) * 3_600_000;
  const candidates: number[] = [];
  for (const m of scheduleMinutes) {
    candidates.push(hourStartMs + m * 60_000);
    candidates.push(hourStartMs - 3_600_000 + m * 60_000);
  }
  const boundaryMs = Math.max(...candidates.filter((b) => b <= actualMs));
  const lateMins   = Math.floor((actualMs - boundaryMs) / 60_000);
  const time = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  }).format(actual);
  return { display: lateMins === 0 ? `${time} (on time)` : `${time} (+${lateMins}m late)` };
}

/**
 * Minutes after which a guard's last ping reads as stale. Wall-clock, and
 * deliberately independent of computeLateness above: that one measures the
 * ping against its SCHEDULE boundary for display, this one measures it
 * against NOW for urgency. A guard who pinged perfectly on time an hour ago
 * is "(on time)" and stale at once, and both statements are correct.
 */
export const PING_STALE_MINUTES = 35;

/**
 * The stale-ping urgency rule, lifted verbatim out of
 * app/admin/live-status/page.tsx so the table cell and the map pin cannot
 * drift apart. Behaviour is unchanged from the inline form it replaces —
 * the added Number.isFinite guard only makes explicit what an unparseable
 * date already did (NaN >= 35 is false).
 */
export function isPingStale(
  lastPingISO: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!lastPingISO) return false;
  const t = Date.parse(lastPingISO);
  if (!Number.isFinite(t)) return false;
  return (nowMs - t) / 60_000 >= PING_STALE_MINUTES;
}
