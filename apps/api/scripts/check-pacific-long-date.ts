/**
 * pacificLongDateTime: the time a password-changed email names (Phase D, D2).
 *
 * A standalone script (in scripts/, so the build never compiles it or its
 * compiler import). Run:
 *   cd apps/api && npx ts-node -P tsconfig.scripts.json scripts/check-pacific-long-date.ts
 *
 * Vishnu, 2026-10-14: the proposed copy said "Tuesday, October 14, 2026", and
 * that date is a Wednesday. "Weekday must be computed in the site's zone (PT),
 * with a test that pins a known date's weekday." This is that test:
 *
 *   1. Pinned: Wednesday 14 October 2026, at 2:06 PM, at 9:30 PM (already
 *      Thursday in UTC), at noon; both midnights around it; both 2026 DST
 *      changes; a leap day; a year end.
 *   2. Swept: every six hours of 2025-2028, the weekday against Intl's own
 *      weekday for Los Angeles, the date and clock against Intl's.
 *   3. All of it in six process zones, UTC-11 to UTC+14, each a child process
 *      with its own TZ: the API runs in UTC, and nothing may depend on that.
 *   4. Mutation controls: the weekday of the UTC instant, the weekday in the
 *      process's zone, and a 24-hour clock each fail.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import ts from 'typescript';

const FILE = path.join(__dirname, '..', 'src', 'services', 'pacificDate.ts');
const ZONES = ['Pacific/Midway', 'America/Los_Angeles', 'America/New_York', 'Etc/UTC', 'Asia/Kolkata', 'Pacific/Kiritimati'];
const PINNED: Array<[string, string]> = [
  ['2026-10-14T21:06:00.000Z', 'Wednesday, October 14, 2026 at 2:06 PM PT'],
  ['2026-10-15T04:30:00.000Z', 'Wednesday, October 14, 2026 at 9:30 PM PT'],
  ['2026-10-14T19:00:00.000Z', 'Wednesday, October 14, 2026 at 12:00 PM PT'],
  ['2026-10-14T07:00:00.000Z', 'Wednesday, October 14, 2026 at 12:00 AM PT'],
  ['2026-10-15T06:59:00.000Z', 'Wednesday, October 14, 2026 at 11:59 PM PT'],
  ['2026-10-15T07:00:00.000Z', 'Thursday, October 15, 2026 at 12:00 AM PT'],
  ['2026-03-08T09:59:00.000Z', 'Sunday, March 8, 2026 at 1:59 AM PT'],
  ['2026-03-08T10:00:00.000Z', 'Sunday, March 8, 2026 at 3:00 AM PT'],
  ['2026-11-01T08:30:00.000Z', 'Sunday, November 1, 2026 at 1:30 AM PT'],
  ['2026-11-01T09:30:00.000Z', 'Sunday, November 1, 2026 at 1:30 AM PT'],
  ['2028-02-29T20:00:00.000Z', 'Tuesday, February 29, 2028 at 12:00 PM PT'],
  ['2027-01-01T07:59:00.000Z', 'Thursday, December 31, 2026 at 11:59 PM PT'],
  ['2027-01-01T08:00:00.000Z', 'Friday, January 1, 2027 at 12:00 AM PT'],
];

/** pacificDate.ts from `src` (the file, or a mutant of it), compiled under its own path. */
function load(src: string): { pacificLongDateTime: (d: Date | string) => string } {
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(FILE, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = FILE;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(FILE));
  m._compile(js, FILE);
  return m.exports as any;
}

const intl = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
/** What Intl itself says, assembled in the email's shape, as the independent reference for the sweep. */
function reference(t: number): string {
  const p = intl.formatToParts(new Date(t));
  const g = (k: string) => p.find((x) => x.type === k)?.value ?? '';
  return `${g('weekday')}, ${g('month')} ${g('day')}, ${g('year')} at ${g('hour')}:${g('minute')} ${g('dayPeriod').toUpperCase()} PT`;
}
function problems(fmt: (d: Date | string) => string): string[] {
  const out: string[] = [];
  for (const [iso, want] of PINNED) if (fmt(iso) !== want) out.push(`${iso} -> ${fmt(iso)}, want ${want}`);
  for (let t = Date.UTC(2025, 0, 1); t < Date.UTC(2029, 0, 1) && out.length < 5; t += 6 * 3_600_000) {
    const got = fmt(new Date(t));
    if (got !== reference(t)) out.push(`${new Date(t).toISOString()} -> ${got}, Intl ${reference(t)}`);
  }
  return out;
}

// ── 3: the child: run in this process's zone, print the problems ──
if (process.env.D2_ZONE) {
  const src = process.env.D2_SRC ? Buffer.from(process.env.D2_SRC, 'base64').toString('utf8') : fs.readFileSync(FILE, 'utf8');
  process.stdout.write(JSON.stringify(problems(load(src).pacificLongDateTime)));
  process.exit(0);
}
function inZones(src?: string): string[] {
  const out: string[] = [];
  for (const zone of ZONES) {
    const r = spawnSync(process.execPath, ['-r', 'ts-node/register', __filename], {
      env: { ...process.env, TZ: zone, D2_ZONE: zone, D2_SRC: src ? Buffer.from(src).toString('base64') : '', TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_PROJECT: path.join(__dirname, '..', 'tsconfig.scripts.json') },
      encoding: 'utf8',
    });
    if (r.status !== 0) { out.push(`${zone}: child failed ${r.stderr.slice(0, 200)}`); continue; }
    for (const p of JSON.parse(r.stdout) as string[]) out.push(`${zone}: ${p}`);
  }
  return out;
}

let passed = 0;
let failed = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passed += 1; console.log(`  ok  ${msg}`); } else { failed += 1; console.log(`  FAIL  ${msg}`); }
}

const src = fs.readFileSync(FILE, 'utf8');
console.log('\npacificLongDateTime — the time a password-changed email names');
const p = inZones();
check(p.length === 0, `${PINNED.length} pinned times (Wednesday, October 14, 2026 among them) and every six hours of 2025-2028 against Intl, in ${ZONES.length} zones (${p.slice(0, 2).join('; ') || 'all right'})`);

const WEEKDAY = '  const weekday = WEEKDAYS_LONG[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];';
const once = (s: string, a: string, b: string) => { if (s.split(a).length !== 2) throw new Error(`mutant target: ${a.slice(0, 40)}`); return s.replace(a, b); };
const mutants: Array<[string, string]> = [
  ['the weekday of the instant in UTC (9:30 PM Wednesday reads Thursday)', once(src, WEEKDAY, "  const weekday = WEEKDAYS_LONG[(typeof input === 'string' ? new Date(input) : input).getUTCDay()];")],
  ["the weekday in the process's zone", once(src, WEEKDAY, "  const weekday = WEEKDAYS_LONG[(typeof input === 'string' ? new Date(input) : input).getDay()];")],
  ['a 24-hour clock', once(src, "  hourCycle: 'h12',\n});\nconst WEEKDAYS_LONG", "  hourCycle: 'h23',\n});\nconst WEEKDAYS_LONG")],
];
let caught = 0;
for (const [what, m] of mutants) {
  const mp = inZones(m);
  if (mp.length) caught += 1;
  check(mp.length > 0, `control — ${what}: ${mp.length} problems (${(mp[0] || 'NOT caught').slice(0, 110)})`);
}
check(caught === mutants.length, `${caught} of ${mutants.length} mutants caught`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
