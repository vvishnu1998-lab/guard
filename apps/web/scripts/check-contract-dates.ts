#!/usr/bin/env ts-node
/**
 * Prove N201: a contract date shows as the day it is in every browser zone, and
 * the Vishnu companies page counts a contract's days left in calendar days at
 * the site.
 *
 * sites.contract_start / contract_end are DATE columns, and the API sends them
 * as UTC midnight ("2026-01-01T00:00:00.000Z"). The admin Sites list built a Date
 * from that and printed it in the browser's zone: west of UTC, the evening
 * before ("31 Dec 2025" for a contract starting 1 Jan 2026).
 *
 * 1. Every day of 2025 to 2028, as the API sends it and as a bare date, renders
 *    exactly as the old formatter rendered the RIGHT day: the format is the
 *    same, only the day is fixed.
 * 2. In six zones from UTC-11 to UTC+14, each a child process with its own TZ,
 *    the API's values render their own day; the old formatter is shown wrong in
 *    every zone west of UTC (the bug, reproduced, so the check can see it).
 * 3. calDaysBetween agrees with a day-by-day walk over four years, both ways,
 *    across both US DST changes and a leap day; malformed input is null.
 * 4. contractCell: live through the end date (0d remaining), EXPIRED from the
 *    day after, the 30- and 90-day bands; the old cell said EXPIRED at 6 PM
 *    Pacific on the end date.
 * 5. The sources: every contract date on both pages goes through these helpers
 *    and none through a Date; the Vishnu page counts from today in the site's
 *    zone (Pacific when an older API sends none); the all-sites query selects
 *    the zone. Each page is BASE's source with exactly the N201 edits applied.
 * 6. Mutation controls: each check above can fail.
 *
 * Run: npm run check:contract-dates (from apps/web). Needs git.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import Module from 'module';
import * as path from 'path';
import ts from 'typescript';
import { contractCell, fmtContractDate } from '../lib/contractDates';
import { calDaysBetween } from '../lib/shiftFormat';
import { undoN203Stage2 } from './n203Stage2Edits';

/** main before N201 (PR #120's merge). */
const BASE = '7245a0a95a3cfc175e4a775cbbf58471821fa2ee';
const WEB = path.join(__dirname, '..');
const SITES = 'app/admin/sites/page.tsx';
const VISHNU = 'app/vishnu/companies/page.tsx';
const ADMIN_API = '../api/src/routes/admin.ts';
const ZONES = ['Pacific/Midway', 'America/Los_Angeles', 'America/New_York', 'Etc/UTC', 'Asia/Kolkata', 'Pacific/Kiritimati'];
const WEST = ['Pacific/Midway', 'America/Los_Angeles', 'America/New_York'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];
/** What the pages printed before N201, as a function so a child process can run it in its own zone. */
const oldFmt = (iso: string | null): string => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const DAY = 86_400_000;
const ymdOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const START = Date.UTC(2025, 0, 1);
const DAYS = Math.round((Date.UTC(2029, 0, 1) - START) / DAY);
const SAMPLE = ['2026-01-01', '2026-03-08', '2026-09-10', '2026-11-01', '2026-12-31', '2028-02-29', '2025-01-01'];

// ── 2: the child: render in this process's zone and print JSON ─────────────────
if (process.env.N201_ZONE) {
  const out = SAMPLE.map((d) => ({ d, api: fmtContractDate(`${d}T00:00:00.000Z`), bare: fmtContractDate(d), old: oldFmt(`${d}T00:00:00.000Z`) }));
  process.stdout.write(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, out }));
  process.exit(0);
}

let passes = 0;
let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function once(s: string, find: string, replace: string, what: string): string {
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`${what}: found ${n} times`);
  return s.replace(find, () => replace);
}
/** The page as it was before N203 stage 2 (scripts/n203Stage2Edits.ts, proven exact by check-session-cookie), so this check still compares only its own change. */
const now = (rel: string) => undoN203Stage2(rel, fs.readFileSync(path.join(WEB, rel), 'utf8'));
const base = (rel: string) => execFileSync('git', ['show', `${BASE}:apps/web/${rel}`], { encoding: 'utf8' });
const baseApi = () => execFileSync('git', ['show', `${BASE}:apps/api/src/routes/admin.ts`], { encoding: 'utf8' });
/** A lib module from `src`, compiled under its own path so its imports resolve as in the app: a mutant. */
function lib(rel: string, src: string): any {
  const file = path.join(WEB, rel);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  return m.exports;
}

// ── the checks, each a function of what it checks, so a mutant runs through the same one ──
type Fmt = (v: string | null) => string;
/** 1: every day, both input shapes, equals the old formatter on the right day (rendered in UTC). */
function formatProblems(fmt: Fmt): string[] {
  const problems: string[] = [];
  for (let i = 0; i < DAYS; i += 1) {
    const d = ymdOf(START + i * DAY);
    const want = new Date(`${d}T00:00:00.000Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
    for (const v of [`${d}T00:00:00.000Z`, d]) if (fmt(v) !== want) problems.push(`${v} -> ${fmt(v)}, want ${want}`);
  }
  if (fmt(null) !== '—') problems.push(`null -> ${fmt(null)}`);
  return problems;
}
type ZoneRun = { zone: string; out: Array<{ d: string; api: string; bare: string; old: string }> };
function zoneRuns(): ZoneRun[] {
  return ZONES.map((zone) => {
    const r = spawnSync(process.execPath, ['-r', 'ts-node/register', __filename], {
      env: { ...process.env, TZ: zone, N201_ZONE: zone, TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_PROJECT: `${__dirname}/tsconfig.check.json` },
      encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`child ${zone}: ${r.stderr.slice(0, 300)}`);
    return JSON.parse(r.stdout) as ZoneRun;
  });
}
const named = (d: string) => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
/** 2: the rendered day is the value's own, in every zone; `pick` chooses which renderer to judge. */
function zoneProblems(runs: ZoneRun[], pick: (o: ZoneRun['out'][number]) => string[]): string[] {
  const problems: string[] = [];
  for (const run of runs) for (const o of run.out) for (const got of pick(o)) if (got !== named(o.d)) problems.push(`${run.zone} ${o.d} -> ${got}`);
  return problems;
}
type Days = (a: string, b: string) => number | null;
/** 3: day arithmetic against a walk, both directions, and malformed input. */
function daysProblems(days: Days): string[] {
  const problems: string[] = [];
  for (let i = 0; i < DAYS; i += 1) {
    const d = ymdOf(START + i * DAY);
    if (days('2025-01-01', d) !== i) problems.push(`2025-01-01 → ${d}: ${days('2025-01-01', d)}, want ${i}`);
    if (days(d, '2025-01-01') !== -i) problems.push(`${d} → 2025-01-01: ${days(d, '2025-01-01')}, want ${-i}`);
    if (problems.length > 5) break;
  }
  const named: Array<[string, string, number]> = [
    ['2026-03-07', '2026-03-09', 2], ['2026-10-31', '2026-11-02', 2], ['2026-12-31', '2027-01-01', 1],
    ['2028-02-28', '2028-03-01', 2], ['2026-10-14T00:00:00.000Z', '2026-10-14', 0],
  ];
  for (const [a, b, n] of named) if (days(a, b) !== n) problems.push(`${a} → ${b}: ${days(a, b)}, want ${n}`);
  for (const bad of ['', 'soon', '2026-13-01', '20261014']) if (days(bad, '2026-10-14') !== null) problems.push(`'${bad}' is not null`);
  return problems;
}
type Cell = (end: string | null, today: string) => { date: string; sub: string; subColor: string };
/** 4: the cell for each band, from a fixed today. */
function cellProblems(cell: Cell): string[] {
  const today = '2026-10-14';
  const want: Array<[string | null, string, string, string]> = [
    [null, 'No contract end', '', 'text-gray-600'],
    ['2026-10-14T00:00:00.000Z', '14 Oct 2026', '0d remaining', 'text-orange-400'],
    ['2026-10-13T00:00:00.000Z', '13 Oct 2026', 'EXPIRED', 'text-red-400'],
    ['2026-11-12', '12 Nov 2026', '29d remaining', 'text-orange-400'],
    ['2026-11-13', '13 Nov 2026', '30d remaining', 'text-yellow-400'],
    ['2027-01-11', '11 Jan 2027', '89d remaining', 'text-yellow-400'],
    ['2027-01-12', '12 Jan 2027', '90d remaining', 'text-green-400'],
  ];
  const problems: string[] = [];
  for (const [end, date, sub, subColor] of want) {
    const got = cell(end, today);
    if (got.date !== date || got.sub !== sub || got.subColor !== subColor) problems.push(`${end}: ${JSON.stringify(got)}`);
  }
  return problems;
}

// ── 5: the sources ──────────────────────────────────────────────────────────────
const SITES_EDITS: Array<[string, string, number]> = [
  ["import { adminGet, adminPatch, adminPost } from '../../../lib/adminApi';\n",
    "import { adminGet, adminPatch, adminPost } from '../../../lib/adminApi';\nimport { fmtContractDate } from '../../../lib/contractDates';\n", 1],
  ["  function fmtDate(iso: string | null) {\n    if (!iso) return '—';\n    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });\n  }\n\n", '', 1],
  ['fmtDate(site.contract_start)', 'fmtContractDate(site.contract_start)', 2],
  ['fmtDate(site.contract_end)', 'fmtContractDate(site.contract_end)', 2],
];
const VISHNU_EDITS: Array<[string, string, number]> = [
  ["import { vishnuGet, vishnuPost, vishnuPatch } from '../../../lib/vishnuApi';\n",
    "import { vishnuGet, vishnuPost, vishnuPatch } from '../../../lib/vishnuApi';\nimport { contractCell, SITE_ZONE_FALLBACK } from '../../../lib/contractDates';\nimport { dayOffsetInZone } from '../../../lib/shiftFormat';\n", 1],
  ['  contract_end:          string | null;\n  photo_limit_override:  number | null;\n',
    "  contract_end:          string | null;\n  /** N201: the site's zone, for the days left; absent from an API older than it. */\n  timezone?:             string;\n  photo_limit_override:  number | null;\n", 1],
  ['const cc = contractCell(s.contract_end);', 'const cc = contractCell(s.contract_end, dayOffsetInZone(0, s.timezone ?? SITE_ZONE_FALLBACK));', 1],
];
const applyEdits = (src: string, edits: Array<[string, string, number]>) => edits.reduce((s, [a, b, n]) => {
  const count = s.split(a).length - 1;
  if (count !== n) throw new Error(`edit applies ${count} times, not ${n}: ${a.slice(0, 50)}`);
  return s.split(a).join(b);
}, src);
/** The Vishnu page's old date and cell functions, removed whole. */
function withoutOldVishnuHelpers(src: string): string {
  const a = src.indexOf('function fmtDate(iso: string | null): string {');
  const b = src.indexOf('export default function CompaniesPage()');
  if (a < 0 || b < 0) throw new Error('the old helpers');
  return src.slice(0, a) + src.slice(b);
}
function sourceProblems(sites: string, vishnu: string, api: string): string[] {
  const problems: string[] = [];
  if (/new Date\([^)]*contract_/.test(sites) || /\bfmtDate\(/.test(sites)) problems.push('Sites: a contract date still goes through a Date or the old fmtDate');
  if ((sites.match(/fmtContractDate\(site\.contract_(start|end)\)/g) || []).length !== 4) problems.push('Sites: not all four contract dates use fmtContractDate');
  if (/new Date\(end/.test(vishnu) || /\bfmtDate\(/.test(vishnu)) problems.push('Vishnu: the old Date-based helpers remain');
  if (vishnu.split('contractCell(s.contract_end, dayOffsetInZone(0, s.timezone ?? SITE_ZONE_FALLBACK))').length !== 2) problems.push("Vishnu: the cell is not counted from today in the site's zone");
  const route = api.slice(api.indexOf("router.get('/all-sites'"), api.indexOf('\nrouter.', api.indexOf("router.get('/all-sites'") + 1));
  if (!/\n\s+s\.timezone,\n/.test(route)) problems.push('API: all-sites does not select s.timezone');
  return problems;
}
function backToBaseProblems(sites: string, vishnu: string, api: string): string[] {
  const problems: string[] = [];
  try { if (applyEdits(base(SITES), SITES_EDITS) !== sites) problems.push('Sites: not BASE plus the N201 edits'); } catch (e) { problems.push(`Sites: ${(e as Error).message}`); }
  try { if (withoutOldVishnuHelpers(applyEdits(base(VISHNU), VISHNU_EDITS)) !== vishnu) problems.push('Vishnu: not BASE plus the N201 edits'); } catch (e) { problems.push(`Vishnu: ${(e as Error).message}`); }
  // The API file gains other routes later; the all-sites route itself must be BASE's plus the zone.
  const span = (s: string) => s.slice(s.indexOf("router.get('/all-sites'"), s.indexOf('\nrouter.', s.indexOf("router.get('/all-sites'") + 1));
  const want = once(span(baseApi()), '  const result = await pool.query(\n    `SELECT\n       s.id, s.name, s.address, s.is_active, s.contract_start, s.contract_end,\n',
    "  // N201: timezone lets the Vishnu companies page count a contract's days left\n  // at the site, not in the browser.\n  const result = await pool.query(\n    `SELECT\n       s.id, s.name, s.address, s.is_active, s.contract_start, s.contract_end,\n       s.timezone,\n", 'the all-sites SELECT');
  if (span(api) !== want) problems.push('API: the all-sites route is not BASE plus the zone');
  return problems;
}

function main(): void {
  const sites = now(SITES);
  const vishnu = now(VISHNU);
  const api = fs.readFileSync(path.join(WEB, ADMIN_API), 'utf8');

  console.log('\n── 1  the format is the old one, on the right day');
  const f = formatProblems(fmtContractDate);
  check(f.length === 0, `fmtContractDate on all ${DAYS} days of 2025-2028, as the API sends them and as bare dates, equals the old formatter rendering the right day (${f.slice(0, 3).join('; ') || 'all equal'})`);

  console.log('\n── 2  every zone renders the day itself');
  const runs = zoneRuns();
  const z = zoneProblems(runs, (o) => [o.api, o.bare]);
  check(z.length === 0, `${ZONES.length} zones, UTC-11 to UTC+14 (${runs.map((r) => r.zone).join(', ')}): ${SAMPLE.length} dates each render their own day (${z.slice(0, 3).join('; ') || 'all right'})`);
  const westWrong = runs.filter((r) => WEST.indexOf(r.zone) >= 0).every((r) => r.out.every((o) => o.old !== named(o.d)));
  const eastRight = runs.filter((r) => WEST.indexOf(r.zone) < 0).every((r) => r.out.every((o) => o.old === named(o.d)));
  check(westWrong && eastRight, `the bug, reproduced: the old formatter shows the day before in all ${WEST.length} zones west of UTC and the right day elsewhere (Los Angeles: ${runs[1].out[0].old} for ${runs[1].out[0].d})`);

  console.log('\n── 3  day arithmetic');
  const d = daysProblems(calDaysBetween);
  check(d.length === 0, `calDaysBetween over ${DAYS} days both ways, across DST changes, a year end and a leap day; malformed input is null (${d.slice(0, 3).join('; ') || 'all right'})`);

  console.log('\n── 4  the contract cell');
  const c = cellProblems(contractCell);
  check(c.length === 0, `from today 14 Oct 2026: no end, 0d on the end date, EXPIRED the day after, 29/30 and 89/90 at the band edges (${c.join('; ') || 'all right'})`);
  const oldDays = Math.ceil((new Date('2026-10-14T00:00:00.000Z').getTime() - Date.UTC(2026, 9, 15, 1)) / DAY);
  check(oldDays < 0, `the old cell, at 6 PM Pacific on 14 Oct 2026 for a contract ending that day: ${oldDays} days, so EXPIRED; the new one says 0d remaining`);

  console.log('\n── 5  the sources');
  const s = sourceProblems(sites, vishnu, api);
  check(s.length === 0, `both pages put every contract date through these helpers and none through a Date; the Vishnu page counts from today in the site's zone; all-sites selects it (${s.join('; ') || 'all right'})`);
  const b = backToBaseProblems(sites, vishnu, api);
  check(b.length === 0, `each page is BASE's source (${BASE.slice(0, 7)}) with exactly the N201 edits; the all-sites route is BASE's plus the zone (${b.join('; ') || 'all equal'})`);

  console.log('\n── 6  mutation controls');
  const contractSrc = now('lib/contractDates.ts');
  const formatSrc = now('lib/shiftFormat.ts');
  const mutants: Array<[string, () => string[]]> = [
    ['fmtContractDate through a Date: the zone check fails west of UTC', () => zoneProblems(runs, (o) => [o.old])],
    ['fmtContractDate with a numeric month: the format check fails', () => formatProblems(lib('lib/contractDates.ts',
      once(contractSrc, '  return fmtCalDate(value);', "  return value.slice(8, 10) + '/' + value.slice(5, 7) + '/' + value.slice(0, 4);", 'fmt')).fmtContractDate)],
    ['calDaysBetween as a difference of day-of-month: the walk fails at the first month end', () => daysProblems(lib('lib/shiftFormat.ts',
      once(formatSrc, 'return Math.round((Date.UTC(Number(b.y), b.m - 1, Number(b.d)) - Date.UTC(Number(a.y), a.m - 1, Number(a.d))) / 86_400_000);',
        'return Number(b.d) - Number(a.d);', 'days')).calDaysBetween)],
    ['a contract expired on its end date: the cell check fails', () => cellProblems(lib('lib/contractDates.ts',
      once(contractSrc, "  if (days < 0)  return { date, sub: 'EXPIRED',", "  if (days <= 0) return { date, sub: 'EXPIRED',", 'cell')).contractCell)],
    ['the Sites list on the old fmtDate: the source check fails', () => sourceProblems(base(SITES), vishnu, api)],
    ["the Vishnu cell counted from the browser's today: the source check fails", () => sourceProblems(sites,
      once(vishnu, 'dayOffsetInZone(0, s.timezone ?? SITE_ZONE_FALLBACK)', 'dayOffsetInZone(0)', 'today'), api)],
    ['all-sites without the zone: the source check fails', () => sourceProblems(sites, vishnu, once(api, '       s.timezone,\n', '', 'zone'))],
    ['one more edit on the Sites page: the back-to-base check fails', () => backToBaseProblems(once(sites, 'FIX 2: no "no end date" filler.', 'FIX 2: no "no end date" filler!', 'comment'), vishnu, api)],
  ];
  let caught = 0;
  for (const [what, run] of mutants) {
    const p = run();
    if (p.length) caught += 1;
    check(p.length > 0, `control — ${what} (${p.length} problem${p.length === 1 ? '' : 's'}: ${(p[0] || 'none').slice(0, 90)})`);
  }
  check(caught === mutants.length, `${caught} of ${mutants.length} mutants caught`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
