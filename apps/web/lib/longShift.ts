/**
 * The long-shift confirm (U5, D20) — the web's side.
 *
 * The API is the authority (apps/api/src/constants/longShift.ts): every shift
 * create and edit over 12 hours is refused with 409
 * LONG_SHIFT_CONFIRM_REQUIRED unless it carries `confirm_long_shift: true`.
 * This copy of the threshold only decides when the web asks FIRST, so the
 * admin sees the confirm before anything is sent; if the two ever disagreed
 * (a DST night the web computed differently), the 409 carries the server's
 * own label and the same confirm step appears then.
 *
 * Strictly over 12 h, measured as elapsed time between the two instants —
 * the API's rule. Exactly 12:00 does not ask.
 */

export const LONG_SHIFT_CONFIRM_HOURS = 12;

export function isLongShift(startIso: string, endIso: string): boolean {
  return new Date(endIso).getTime() - new Date(startIso).getTime() > LONG_SHIFT_CONFIRM_HOURS * 3_600_000;
}

/** '18h', '12h 30m' — whole minutes. */
export function fmtShiftDuration(startIso: string, endIso: string): string {
  const totalMin = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** 'Fri Sep 26, 06:00' at the site. */
export function fmtShiftEnd(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: tz,
  }).formatToParts(new Date(iso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('weekday')} ${get('month')} ${get('day')}, ${get('hour')}:${get('minute')}`;
}

/** 'Ends Fri Sep 26, 06:00 — 18h' — the D20 wording, the same as the API's ends_at_label. */
export function longShiftLabel(startIso: string, endIso: string, tz: string): string {
  return `Ends ${fmtShiftEnd(endIso, tz)} — ${fmtShiftDuration(startIso, endIso)}`;
}

/** '18:00' at the site — the 24-hour clock the edit form's time input uses. */
export function fmtClockInZone(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz,
  }).formatToParts(new Date(iso));
  const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('hour')}:${get('minute')}`;
}
