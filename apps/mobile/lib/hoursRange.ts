/**
 * Guard Hours PDF — the pure half: range presets, the courtesy day-count
 * gate, and server-error copy.
 *
 * Split out of lib/hoursReport.ts so it can be exercised in plain node. That
 * file imports react-native-blob-util, expo-sharing and expo-secure-store at
 * module top, so importing ANY of it outside a device pulls in three native
 * modules and throws — which meant the range arithmetic and the guard-facing
 * error strings, the two things most worth testing, could not be.
 *
 * Nothing here imports from react-native. Keep it that way.
 *
 * SERVER IS THE GATE. Everything that looks like validation here is a
 * courtesy: it saves the guard a round trip and gives them a readable reason
 * sooner. GET /shifts/my-hours.pdf enforces the 45-day cap, the ordering and
 * the date shape itself. If the two ever disagree the server wins and the
 * guard sees the server's message.
 */

/** Mirror of MAX_RANGE_DAYS in apps/api/src/services/pdf/guardHours.ts.
 *  A courtesy bound only — see the header. */
export const MAX_RANGE_DAYS = 45;

// ── Range presets ─────────────────────────────────────────────────────────
//
// Presets rather than a calendar widget, deliberately. Every date-picker
// option (@react-native-community/datetimepicker, react-native-date-picker)
// is a NATIVE module, and this release already adds one — expo-sharing —
// which is what forces a new binary at all. A second native dep doubles the
// surface of that build for a control the guard barely needs: the useful
// ranges here are "recent" and "a named month", both of which are two taps
// and no keyboard. If a free-form calendar is wanted later it is an additive
// change, not a rework.

export interface RangePreset {
  key: string;
  label: string;
  /** Inclusive YYYY-MM-DD bounds, computed against `today`. */
  range: (today: Date) => { from: string; to: string };
}

/** YYYY-MM-DD for a Date, read in UTC. Callers pass dates already anchored
 *  to the day they mean, so no zone conversion happens here. */
export function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysAgo(today: Date, n: number): Date {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - n));
}

export const RANGE_PRESETS: RangePreset[] = [
  { key: '7',  label: 'Last 7 days',  range: (t) => ({ from: ymd(daysAgo(t, 6)),  to: ymd(t) }) },
  { key: '14', label: 'Last 14 days', range: (t) => ({ from: ymd(daysAgo(t, 13)), to: ymd(t) }) },
  { key: '30', label: 'Last 30 days', range: (t) => ({ from: ymd(daysAgo(t, 29)), to: ymd(t) }) },
  { key: '45', label: 'Last 45 days', range: (t) => ({ from: ymd(daysAgo(t, 44)), to: ymd(t) }) },
  {
    key: 'this-month',
    label: 'This month',
    range: (t) => ({
      from: ymd(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1))),
      to:   ymd(t),
    }),
  },
  {
    key: 'last-month',
    label: 'Last month',
    // A 31-day month is inside the cap; nothing here can exceed it.
    range: (t) => ({
      from: ymd(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1))),
      to:   ymd(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0))),
    }),
  },
];

/** Inclusive day count, matching the server's arithmetic exactly. */
export function rangeDays(from: string, to: string): number {
  const f = Date.parse(`${from}T00:00:00Z`);
  const t = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(f) || Number.isNaN(t)) return NaN;
  return Math.floor((t - f) / 86_400_000) + 1;
}

/** Courtesy pre-check. Returns null when the range looks sendable. */
export function localRangeProblem(from: string, to: string): string | null {
  const days = rangeDays(from, to);
  if (Number.isNaN(days)) return 'Pick a start and end date.';
  if (days <= 0)          return 'The end date must be on or after the start date.';
  if (days > MAX_RANGE_DAYS) {
    return `Pick a shorter range — up to ${MAX_RANGE_DAYS} days at a time (this one is ${days}).`;
  }
  return null;
}

// ── Server error copy ─────────────────────────────────────────────────────

/**
 * Turn a server response into something a guard can act on.
 *
 * Every code GET /shifts/my-hours.pdf can return is handled by name; the
 * status fallbacks cover everything else. A guard must never be shown
 * "RANGE_TOO_WIDE" or a bare HTTP number.
 *
 * 404 is called out specifically. This screen ships in a binary that can
 * install BEFORE the API carrying the route deploys, so 404 is not an
 * anomaly here — it is the expected answer for a period of days, and it must
 * read as "not available yet", never as "something broke".
 */
export function hoursErrorCopy(status: number, body: { code?: string; days?: number } | null): string {
  switch (body?.code) {
    case 'RANGE_TOO_WIDE':
      return `That range is too long. Choose up to ${MAX_RANGE_DAYS} days at a time` +
             (body.days ? ` — you asked for ${body.days}.` : '.');
    case 'RANGE_INVERTED':
      return 'The end date must be on or after the start date.';
    case 'RANGE_INVALID':
      return 'Those dates aren\'t valid. Choose a start and end date and try again.';
  }
  if (status === 401) return 'Your session expired. Sign in again to download your hours.';
  if (status === 403) return 'You can only download your own hours.';
  if (status === 404) return 'Hours summaries aren\'t available yet. Update the app, or try again later.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500)  return 'We couldn\'t build your summary just now. Please try again.';
  return `We couldn't download your hours (HTTP ${status}).`;
}
