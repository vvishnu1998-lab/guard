/**
 * Site-timezone-aware helpers for rendering shift times.
 *
 * A shift's calendar day is a property of the SITE's timezone, not the
 * device's. A shift starting 23:30 PT is today in Pacific and tomorrow in UTC;
 * deciding "today vs tomorrow" against the device clock is right only while
 * the guard's phone shares the site's zone. That holds for every current site
 * and goes silently wrong the moment it does not — a guard travelling, or a
 * site added in another zone.
 */

/**
 * Short timezone label for display, e.g. "PDT".
 *
 * Extracted verbatim from app/shifts/[id]/index.tsx so the home card and the
 * shift-detail screen cannot drift apart. Behaviour is unchanged.
 *
 * The API sends the raw IANA zone (site_tz) and that is correct — it is what
 * Intl needs as input. It is only unfit for display: `site_tz.split('/').pop()`
 * renders "Los_Angeles", underscore and all.
 *
 * For zones with no common abbreviation Intl returns an offset instead
 * ("GMT+5:30" for Asia/Kolkata). That is correct, useful output and is
 * deliberately not special-cased.
 *
 * Returns null when the zone is absent or rejected by Intl, so the caller
 * renders nothing rather than a broken fragment. Uses 'en-US' because en-GB
 * yields offsets where en-US yields the familiar North American
 * abbreviations, and every current site is US-based.
 */
export function tzAbbreviation(iso: string, tz: string | null): string | null {
  if (!tz) return null;
  try {
    const part = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, timeZoneName: 'short',
    })
      .formatToParts(new Date(iso))
      .find((p) => p.type === 'timeZoneName');
    return part?.value ?? null;
  } catch {
    // Invalid/unknown IANA zone — Intl throws a RangeError. Show nothing
    // rather than crashing the screen over a cosmetic label.
    return null;
  }
}

/**
 * The calendar day an instant falls on, in a given zone, as 'YYYY-MM-DD'.
 *
 * 'en-CA' is used because it formats as ISO-ordered YYYY-MM-DD, which makes
 * the resulting strings directly comparable for equality without parsing.
 * Returns null when the zone is rejected by Intl so callers can fall back.
 */
function dayKeyInTz(date: Date, tz: string | undefined): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(date);
  } catch {
    return null;
  }
}

/**
 * "Today" / "Tomorrow" / a short date, computed in the site's zone.
 *
 * Deliberately compares DAY KEYS rather than subtracting milliseconds: the gap
 * between now and a shift start says nothing about which calendar day it lands
 * on. 23:50 tonight and 00:10 tomorrow are 20 minutes apart and on different
 * days; 00:10 and 23:50 on the same day are nearly 24 hours apart and on the
 * same one. Only the rendered day can answer the question.
 *
 * Falls back to the device zone when siteTz is missing or unusable — degraded
 * is better than blank, and it matches what the card rendered before.
 *
 * @param startIso shift scheduled_start
 * @param siteTz   IANA zone from the API's site_tz, or undefined
 * @param nowMs    injected so this is testable and the caller owns "now"
 */
export function shiftDayLabel(
  startIso: string | null | undefined,
  siteTz: string | undefined,
  nowMs: number,
): string {
  if (!startIso) return '';
  const start = new Date(startIso);
  if (isNaN(start.getTime())) return '';

  // undefined tz makes Intl use the device zone — the intended fallback.
  const tz = siteTz && dayKeyInTz(start, siteTz) ? siteTz : undefined;

  const startKey = dayKeyInTz(start, tz);
  const todayKey = dayKeyInTz(new Date(nowMs), tz);
  if (!startKey || !todayKey) return '';

  if (startKey === todayKey) return 'Today';

  // Tomorrow = the day after today's key, resolved in the same zone rather
  // than by adding 24h to the instant, so DST transitions cannot shift it.
  const tomorrowKey = dayKeyInTz(new Date(nowMs + 24 * 60 * 60 * 1000), tz);
  if (startKey === tomorrowKey) return 'Tomorrow';

  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, weekday: 'short', day: 'numeric', month: 'short',
    }).format(start);
  } catch {
    return '';
  }
}

/**
 * Clock time for a shift instant, rendered in the site's zone.
 *
 * Same 'en-GB' 24-hour shape the home card already used; the only change is
 * that the zone is now explicit rather than implicitly the device's.
 */
export function fmtTimeInTz(
  iso: string | null | undefined,
  siteTz: string | undefined,
): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: siteTz, hour: '2-digit', minute: '2-digit',
    }).format(d);
  } catch {
    // Unknown zone — fall back to the device clock rather than showing nothing.
    return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }
}
