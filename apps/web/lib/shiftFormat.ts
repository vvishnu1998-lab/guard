/**
 * Shared date/time formatters used by the shifts pages. Kept small +
 * dependency-free (no date-fns) so they can be pulled into any admin
 * surface without expanding the bundle.
 */

export function fmtDT(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtDateShort(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(start: string, end: string): string {
  const h = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return `${h.toFixed(1)}h`;
}

export function fmtDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

// ── Site-zone wall-clock conversion ─────────────────────────────────────
//
// The shift-edit form must round-trip an instant through a site-local wall
// clock: show "26 Aug, 10:00 AM" for an ISO instant, and turn the admin's
// edited "10:30" back into the right instant.
//
// Doing that with `new Date(...); d.setHours(h, m)` — the idiom in
// ScheduleShiftModal.buildISO — silently interprets the typed time in the
// BROWSER's zone. That is correct only while every admin sits in the same
// zone as the site. It is wrong the moment one does not, and the failure is
// invisible: the shift saves, and the hours are off by the zone difference.
// These columns are billing inputs (services/shiftHours.ts recomputes
// scheduled_hours from them live), so an off-by-a-zone edit is a wrong
// invoice, not a cosmetic bug.
//
// All 12 production sites are America/Los_Angeles today, so nothing here
// changes any current behaviour. It removes an assumption rather than
// fixing a live defect.

/**
 * How far `tz` is behind UTC at `instant`, in ms. Pacific in August → +7h.
 * Add this to a wall-clock-parsed-as-UTC value to get the true instant.
 */
function tzOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(instant);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)?.value ?? '0');
  // Intl renders midnight as hour 24 in some engines; normalise to 0.
  const hour = get('hour') % 24;
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), hour, get('minute'), get('second'));
  return instant.getTime() - asUTC;
}

/**
 * ISO instant → the `YYYY-MM-DD` and `HH:MM` an <input type="date"> and
 * <input type="time"> should show for that instant AT THE SITE.
 */
export function isoToZonedInputs(iso: string, tz: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(iso));
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  const hh = String(Number(pick('hour')) % 24).padStart(2, '0');
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${hh}:${pick('minute')}`,
  };
}

/**
 * `YYYY-MM-DD` + `HH:MM` read as a wall clock AT THE SITE → ISO instant.
 *
 * Two passes: the first offset is computed from the wall clock parsed as
 * UTC, which is right except inside a DST transition; re-deriving the
 * offset at the resulting instant corrects that. Returns null on
 * unparseable input so callers can validate rather than send `Invalid Date`.
 */
export function zonedInputsToISO(date: string, time: string, tz: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const naive = new Date(`${date}T${time}:00Z`);
  if (Number.isNaN(naive.getTime())) return null;
  const firstPass  = new Date(naive.getTime() + tzOffsetMs(naive, tz));
  const secondPass = new Date(naive.getTime() + tzOffsetMs(firstPass, tz));
  return secondPass.toISOString();
}
