/**
 * The long-shift confirm (U5, D20), in one place.
 *
 * A shift whose ELAPSED duration (scheduled_end − scheduled_start, as
 * instants) is over 12 hours is written only when the request carries
 * `confirm_long_shift: true`; otherwise the route answers 409
 * LONG_SHIFT_CONFIRM_REQUIRED with the real end and the duration, and the web
 * shows a confirm step and resends with the flag. The web asks before it
 * sends, so the 409 is the backstop that makes the rule hold for any caller.
 *
 * Why: the create modal rolls an end earlier than the start into the next day
 * silently, so an AM/PM slip ("8:00 → 2:00" meant as 2 PM) becomes an 18-hour
 * shift nobody saw — the 2026-09-26 Bethel incident. Real overnights over 12 h
 * exist too (STARNET: 13 h and 12.5 h in the 60 days to 2026-09-28), so this
 * asks rather than refuses.
 *
 * STRICTLY over 12 h: exactly 12:00 does not ask. STARNET scheduled 90
 * twelve-hour shifts in the same 60 days; a dialog on every one would be
 * clicked through by habit, which defeats it.
 *
 * Elapsed, not wall-clock: a 19:00 → 07:00 overnight on the autumn DST night
 * is 13 h of work and asks; on the spring night it is 11 h and does not.
 *
 * Readers: routes/shifts.ts POST / (single, repeat_days, specific_dates) and
 * PATCH /:id (scheduled edits and the active-shift end edit). The web keeps
 * its own copy of the threshold for the pre-send check
 * (apps/web/lib/longShift.ts); this file is the authority — a web that
 * disagreed would only change WHEN the dialog appears, never whether the
 * rule holds.
 */

export const LONG_SHIFT_CONFIRM_HOURS = 12;
const LONG_SHIFT_CONFIRM_MS = LONG_SHIFT_CONFIRM_HOURS * 3_600_000;

/** Body flag a caller sends after the admin confirmed a long shift. */
export const LONG_SHIFT_CONFIRM_FLAG = 'confirm_long_shift';

export function isLongShift(start: Date, end: Date): boolean {
  return end.getTime() - start.getTime() > LONG_SHIFT_CONFIRM_MS;
}

/** '18h', '12h 30m' — whole minutes, as the web prints it. */
export function fmtShiftDuration(start: Date, end: Date): string {
  const totalMin = Math.round((end.getTime() - start.getTime()) / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/** 'Fri Sep 26, 06:00' at the site — the D20 wording. */
export function fmtShiftEnd(end: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    timeZone: tz,
  }).formatToParts(end);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('month')} ${get('day')}, ${get('hour')}:${get('minute')}`;
}

/** Body of the 409. `error` is the sentence the web renders; `code` is what it branches on. */
export function longShiftConfirmBody(start: Date, end: Date, tz: string) {
  const duration = fmtShiftDuration(start, end);
  const endsAt   = fmtShiftEnd(end, tz);
  const message  =
    `This shift is ${duration} long — it ends ${endsAt}. ` +
    `Shifts over ${LONG_SHIFT_CONFIRM_HOURS} hours need a confirmation.`;
  return {
    code:             'LONG_SHIFT_CONFIRM_REQUIRED' as const,
    error:            message,
    message,
    duration_minutes: Math.round((end.getTime() - start.getTime()) / 60_000),
    scheduled_start:  start.toISOString(),
    scheduled_end:    end.toISOString(),
    ends_at_label:    `Ends ${endsAt} — ${duration}`,
    confirm_with:     { [LONG_SHIFT_CONFIRM_FLAG]: true },
  };
}

/**
 * Reads the flag. `undefined` = not sent; anything but a boolean is a 400 at
 * the caller (guards.ts deactivation precedent), so a stringly "true" never
 * counts as consent.
 */
export function readLongShiftConfirm(body: unknown): boolean | 'invalid' {
  const v = (body as Record<string, unknown> | null | undefined)?.[LONG_SHIFT_CONFIRM_FLAG];
  if (v === undefined) return false;
  if (typeof v !== 'boolean') return 'invalid';
  return v;
}
