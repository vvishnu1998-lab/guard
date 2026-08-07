/**
 * Mobile-side hours formatters for the 4-field shift-hours breakdown.
 *
 * Kept in sync with:
 *   apps/web/lib/formatHours.ts        (client-side helper for web)
 *   apps/api/src/services/shiftHours.ts (server-side helper for emails/PDF)
 *
 * D2 contract, per field type:
 *   scheduled_hours   null → "—"  |  0 → "—"      |  n → "Nh MMm"
 *   actual_hours      null → "—"  |  0 → "0h 00m" |  n → "Nh MMm"
 *   break_hours       null → "—"  |  0 → "0h 00m" |  n → "Nh MMm"
 *   violation_hours   null → "—"  |  0 → "None"   |  n → "Nh MMm"
 *
 * Zero scheduled is treated as a data-error signal (a shift can't have
 * equal start and end). Zero break is legitimate. Zero violation is the
 * clean-shift case — surfaced as "None" so it doesn't read as a defect.
 *
 * All three helpers accept string OR number since node-postgres NUMERIC
 * types come across the wire as strings.
 */

export function formatHoursHHMM(hours: number | string | null | undefined): string {
  if (hours == null) return '—';
  const n = typeof hours === 'string' ? parseFloat(hours) : hours;
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0h 00m';
  const abs   = Math.abs(n);
  const whole = Math.floor(abs);
  const mins  = Math.round((abs - whole) * 60);
  // Rounding can bump minutes to 60 (e.g. 1.999h → 1h 60m). Roll over.
  if (mins === 60) return `${whole + 1}h 00m`;
  const sign = n < 0 ? '-' : '';
  return `${sign}${whole}h ${String(mins).padStart(2, '0')}m`;
}

export function formatOffPostHours(hours: number | string | null | undefined): string {
  if (hours == null) return '—';
  const n = typeof hours === 'string' ? parseFloat(hours) : hours;
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return 'None';
  return formatHoursHHMM(n);
}

/**
 * scheduled_hours defensive: zero should never occur legitimately, so
 * render "—" as a "data error / not applicable" signal.
 */
export function formatScheduledHours(hours: number | string | null | undefined): string {
  if (hours == null) return '—';
  const n = typeof hours === 'string' ? parseFloat(hours) : hours;
  if (!Number.isFinite(n) || n === 0) return '—';
  return formatHoursHHMM(n);
}

/**
 * Millisecond variant for the home-screen live tickers. Same D2 contract
 * as formatHoursHHMM but takes ms elapsed since a start timestamp. Zero
 * ms renders "0h 00m" — a legitimate "just started" state, not an error.
 */
export function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—';
  const clamped = Math.max(0, ms);
  return formatHoursHHMM(clamped / 3_600_000);
}

/** Shared shape for the 4-field object returned by Phase 1 API endpoints. */
export interface ShiftHours {
  scheduled_hours: number;
  actual_hours:    number;
  break_hours:     number;
  violation_hours: number;
}
