/**
 * Payable hours on the admin web (D19) — the read side.
 *
 * Payable is the clocked-in time INSIDE the scheduled window. It drives the
 * admin totals (analytics, ACTIVE SITES); Actual stays raw clock-out −
 * clock-in and is shown beside it, never instead of it.
 *
 * Vercel and Railway deploy separately, so this page can run against an API
 * that does not send payable_hours yet. Every helper here returns null for a
 * missing or non-finite value, and formatHoursHHMM(null) renders '—'.
 *
 * Never fall back to actual_hours, and never to the legacy total_hours /
 * hours_legacy / total_hours_this_month scalars: those are different figures
 * (the legacy ones are the stored, start-clamped column), and one of them
 * shown under a Payable label is the single wrong answer here. Never coerce
 * a missing value to 0 either — '0h 00m' reads as a real figure.
 *
 * Pure module (no React), so scripts/check-payable-hours.ts can run it.
 */

/** Payable hours from an API hours object, or null when the API did not send it. */
export function payableOf(hours: { payable_hours?: unknown } | null | undefined): number | null {
  const v = hours?.payable_hours;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

export interface MonthlyPayable {
  /** Months in API order; null where any row of that month lacked payable_hours. */
  months: Array<[month: string, payable: number | null]>;
  /** Largest known monthly value, at least 1 — the bar scale. */
  max: number;
}

/**
 * Per-month Payable totals across sites. A month with any row missing
 * payable_hours is null as a whole — a partial sum would print as a real
 * total. Months stay in the list either way, so an old API shows each month
 * with '—' rather than an empty chart.
 */
export function monthlyPayable(
  rows: ReadonlyArray<{ month: string; hours?: { payable_hours?: unknown } | null }>,
): MonthlyPayable {
  const sum = new Map<string, number | null>();
  for (const r of rows) {
    const p = payableOf(r.hours);
    const prev = sum.has(r.month) ? sum.get(r.month)! : 0;
    sum.set(r.month, prev === null || p === null ? null : prev + p);
  }
  // Array.from, not a spread: apps/web's tsconfig targets below ES2015, where
  // spreading a Map iterator does not compile (next build is the check).
  const months = Array.from(sum.entries());
  const known = months.map(([, v]) => v).filter((v): v is number => v !== null);
  return { months, max: Math.max(...known, 1) };
}
