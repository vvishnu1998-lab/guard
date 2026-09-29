/**
 * The create modal's single and repeat-days instants (components/admin/
 * ScheduleShiftModal.tsx): the typed HH:MM start and end on a picked
 * calendar day, as wall-clock times in the BROWSER's zone. (That zone choice
 * is the modal's existing design — lib/shiftFormat.ts explains its limits;
 * the specific-dates mode resolves at the site instead.)
 *
 * An end earlier than the start is an overnight and ends on the NEXT CALENDAR
 * DAY. It is rolled with setDate(+1), never by adding 86_400_000 ms: a local
 * day is not always 24 hours. On the autumn DST day it is 25, so local
 * midnight + 24 h is 23:00 the SAME day, and a 19:00 -> 07:00 shift starting
 * 2026-11-01 came out ending at 07:00 on Nov 1 — before it started. The
 * server now refuses that (422, schema_v81); before U5 it was written.
 * scripts/check-date-format.ts pins 2026-10-31 -> 11-01 and 2026-11-01 ->
 * 11-02 in America/Los_Angeles.
 */
export function localShiftWindow(
  day: Date,
  startTime: string,
  endTime: string,
): { start: string; end: string; overnight: boolean } {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const overnight = eh * 60 + em < sh * 60 + sm;

  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), sh, sm, 0, 0);
  // The Date constructor normalises day + 1 past a month's end, and builds
  // the local wall clock on that calendar date whatever its length.
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + (overnight ? 1 : 0), eh, em, 0, 0);
  return { start: start.toISOString(), end: end.toISOString(), overnight };
}
