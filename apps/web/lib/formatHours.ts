/**
 * Client-side hours formatters for the 4-field shift-hours breakdown.
 *
 * Contract (Phase 2 lock-in, D2):
 *   null / undefined  → "—"    (unknown; row has no session yet)
 *   0                 → "0h 00m"   (known-zero)
 *   n                 → "Nh MMm"
 *
 * formatOffPostHours() differs on the known-zero case: violations of zero
 * mean "no off-post time" — surfaced as "None" rather than "0h 00m" so a
 * clean shift reads at a glance and doesn't look like a defect.
 *
 * The server has an equivalent formatHoursHHMM() in shiftHours.ts. Both
 * kept in sync intentionally — the web helper renders live-updating
 * numbers from the client, the server helper renders into emails/PDFs.
 * Change both together or the same shift row will read differently in
 * two places.
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
 * scheduled_hours defensive: a zero value should never occur legitimately
 * (a shift can't have equal start and end), so render "—" as a
 * "data error / not applicable" signal instead of "0h 00m". D2 update.
 */
export function formatScheduledHours(hours: number | string | null | undefined): string {
  if (hours == null) return '—';
  const n = typeof hours === 'string' ? parseFloat(hours) : hours;
  if (!Number.isFinite(n) || n === 0) return '—';
  return formatHoursHHMM(n);
}
