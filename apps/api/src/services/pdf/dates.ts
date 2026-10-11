/**
 * Dates and times as the two client-facing PDFs print them: the activity log
 * (services/pdf/activityLog.ts) and the site security report
 * (routes/clientPortal.ts).
 *
 * "Sep 8, 2026": the month spelled out, in US order. A US client reads a
 * numeric date month-first, so en-GB's "11/10/2026" (11 October) read as
 * November 10. One style per document, so a cover never says "Sep 1, 2026"
 * two lines above "08 Sept 2026". Times stay 24-hour, as both have always
 * printed them.
 *
 * The zone is a required argument, never a default. Without one, Intl
 * formats in the PROCESS's zone, and Railway sets no TZ, so the API runs in
 * UTC: that is how the site security report printed a 09:00 PT report as
 * 16:00 and filed every report from 17:00 PT on under the next day (N105).
 *
 * A module of its own, not theme.ts: scripts/test-letterhead-pdf.ts swaps
 * theme.ts for its 5def3a5 blob to hold the no-letterhead chrome
 * byte-identical, and that blob cannot export anything added since.
 */

/** "Sep 8, 2026", in `timeZone`. */
export function monthDayYear(d: Date | string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone })
    .format(new Date(d));
}

/** "09:00", 24-hour, in `timeZone`. */
export function hourMinute(d: Date | string | number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone })
    .format(new Date(d));
}
