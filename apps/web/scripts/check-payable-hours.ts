#!/usr/bin/env ts-node
/**
 * Enforce, by running it, the one rule the admin web has for Payable hours
 * (D19): when the API does not send payable_hours, the page shows '—' —
 * never 0, never NaN, and never another figure under the Payable label.
 *
 * WHY THIS EXISTS (U6). Vercel and Railway deploy separately, so the new web
 * can run against an API that has not shipped payable_hours yet. The page
 * before U6 had three ways to get that wrong, all in plain sight:
 *   * `?? parseFloat(total_hours)` / `: parseHours(hours_legacy)` — the stored
 *     legacy scalar (start-clamped, neither Actual nor Payable) shown as if
 *     it were the headline figure;
 *   * parseHours() turning null into 0, which renders '0h 00m';
 *   * summing undefined into NaN, which silently dropped the month and made
 *     the card claim "No completed shifts yet".
 * lib/payableHours.ts owns the rule; this runs it, and scans the two pages
 * so none of those three patterns can come back on a Payable path.
 *
 * Run: npm run check:payable-hours   (from apps/web).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { formatHoursHHMM } from '../lib/formatHours';
import { monthlyPayable, payableOf } from '../lib/payableHours';

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ok   ${msg}`); }
  else      { failures += 1; console.log(`  FAIL ${msg}`); }
}

console.log('[check-payable-hours] payableOf: missing -> null -> "—"');
const missing: Array<[string, unknown]> = [
  ['undefined object', undefined],
  ['null object', null],
  ['no payable_hours key (API before D19)', { actual_hours: 8.25, scheduled_hours: 8 }],
  ['payable_hours: undefined', { payable_hours: undefined }],
  ['payable_hours: null', { payable_hours: null }],
  ['payable_hours: NaN', { payable_hours: NaN }],
  ['payable_hours: Infinity', { payable_hours: Infinity }],
  ['payable_hours: "abc"', { payable_hours: 'abc' }],
];
for (const [label, h] of missing) {
  const p = payableOf(h as { payable_hours?: unknown } | null | undefined);
  check(p === null, `${label}: payableOf = ${String(p)}`);
  check(formatHoursHHMM(p) === '—', `${label}: renders ${formatHoursHHMM(p)}`);
}
check(payableOf({ payable_hours: 0 }) === 0 && formatHoursHHMM(payableOf({ payable_hours: 0 })) === '0h 00m',
  'a KNOWN zero stays 0 and renders 0h 00m');
check(payableOf({ payable_hours: 7.25 }) === 7.25 && formatHoursHHMM(7.25) === '7h 15m', '7.25 -> 7h 15m');
check(payableOf({ payable_hours: '5.5' }) === 5.5, 'a numeric string is read as a number');

console.log('[check-payable-hours] monthlyPayable: an old API keeps its months, each "—"');
{
  const oldApi = monthlyPayable([
    { month: 'Aug 2026', hours: { actual_hours: 100 } as { payable_hours?: unknown } },
    { month: 'Aug 2026', hours: { actual_hours: 40 } as { payable_hours?: unknown } },
    { month: 'Sep 2026', hours: { actual_hours: 90 } as { payable_hours?: unknown } },
  ]);
  check(oldApi.months.length === 2, `2 months kept (${oldApi.months.length})`);
  check(oldApi.months.every(([, v]) => v === null), 'every month is null, not 0 and not the Actual sum');
  check(oldApi.months.every(([, v]) => formatHoursHHMM(v) === '—'), 'every month renders —');
  check(oldApi.max === 1, 'bar scale stays finite (1)');
}
{
  const newApi = monthlyPayable([
    { month: 'Aug 2026', hours: { payable_hours: 100 } },
    { month: 'Aug 2026', hours: { payable_hours: 40.5 } },
    { month: 'Sep 2026', hours: { payable_hours: 90 } },
  ]);
  check(JSON.stringify(newApi.months) === JSON.stringify([['Aug 2026', 140.5], ['Sep 2026', 90]]),
    `sums per month in API order: ${JSON.stringify(newApi.months)}`);
  check(newApi.max === 140.5, `bar scale is the largest month (${newApi.max})`);
}
{
  const mixed = monthlyPayable([
    { month: 'Aug 2026', hours: { payable_hours: 100 } },
    { month: 'Aug 2026', hours: {} },
    { month: 'Sep 2026', hours: { payable_hours: 90 } },
  ]);
  check(mixed.months[0][1] === null && mixed.months[1][1] === 90,
    'a month with any row missing payable is unknown as a whole — no partial sum');
}
check(monthlyPayable([]).months.length === 0, 'no rows -> no months (the page shows its empty state)');

console.log('[check-payable-hours] source scan: no fallback on the Payable pages');
const pages = ['app/admin/analytics/page.tsx', 'components/admin/ActiveSitesTable.tsx'];
// READS only — property access or destructuring. The legacy fields may still
// be DECLARED in an interface (the API sends them) and named in comments.
const forbidden: Array<[RegExp, string]> = [
  [/parseHours\s*\(/, 'parseHours( — turns a missing value into 0'],
  [/\?\?\s*parseFloat\s*\(/, '?? parseFloat( — falls back to a legacy scalar'],
  [/\.total_hours_this_month\b/, 'read of total_hours_this_month (the stored scalar)'],
  [/\.total_hours\b/, 'read of top_guards[].total_hours (the stored scalar)'],
  [/\.hours_legacy\b|[{,]\s*hours_legacy\s*[,}]/, 'read of hours_legacy (the stored scalar)'],
  [/\.hours_this_week\b/, 'read of hours_this_week (the stored scalar)'],
  [/payable_hours\s*\?\?\s*0/, 'payable_hours ?? 0 — unknown rendered as 0h 00m'],
];
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
for (const rel of pages) {
  const src = stripComments(readFileSync(join(__dirname, '..', rel), 'utf8'));
  for (const [re, why] of forbidden) check(!re.test(src), `${rel}: no ${why}`);
}

console.log(`\n[check-payable-hours] ${failures === 0 ? 'PASS' : 'FAIL'} - ${passes} passed, ${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
