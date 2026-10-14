/**
 * Contract dates (N201).
 *
 * sites.contract_start and contract_end are DATE columns: a day, with no time
 * and no zone. The API sends them as UTC midnight ("2026-01-01T00:00:00.000Z"):
 * node-postgres turns a DATE into a Date at the API process's midnight, and the
 * API runs in UTC. A Date built from that string is the evening before anywhere
 * west of UTC, so the admin Sites list showed a contract starting 1 Jan 2026 as
 * starting "31 Dec 2025", and the Vishnu companies page counted the days left
 * to the evening before the end date.
 *
 * These read the YYYY-MM-DD part and never build a Date from it.
 */
import { calDaysBetween, fmtCalDate } from './shiftFormat';

/** Every site's zone today; used only when the API did not send the site's own. */
export const SITE_ZONE_FALLBACK = 'America/Los_Angeles';

/** "01 Jan 2026", the format the pages already used, on the right day; "—" when there is none. */
export function fmtContractDate(value: string | null | undefined): string {
  if (!value) return '—';
  return fmtCalDate(value);
}

/**
 * The Vishnu companies page's contract cell: the end date, and the days left
 * counted in calendar days from `todayAtSite` (a bare date in the site's zone).
 * A contract is live through its end date (0 days left on it) and expired from
 * the day after.
 */
export function contractCell(end: string | null, todayAtSite: string): { date: string; sub: string; subColor: string } {
  if (!end) return { date: 'No contract end', sub: '', subColor: 'text-gray-600' };
  const date = fmtContractDate(end);
  const days = calDaysBetween(todayAtSite, end);
  if (days === null) return { date, sub: '', subColor: 'text-gray-600' };
  if (days < 0)  return { date, sub: 'EXPIRED',   subColor: 'text-red-400' };
  if (days < 30) return { date, sub: `${days}d remaining`, subColor: 'text-orange-400' };
  if (days < 90) return { date, sub: `${days}d remaining`, subColor: 'text-yellow-400' };
  return                 { date, sub: `${days}d remaining`, subColor: 'text-green-400' };
}
