/**
 * test-n171-formula-guard.ts — N171: no CSV or XLSX cell built from user-typed data
 * can be read by a spreadsheet as a formula.
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n171-formula-guard.ts     (from apps/api)
 *
 * LOCAL DATABASES ONLY; fake data on Star Guard's id and on an invented company.
 * Sentry, email and S3 are stubbed. Needs git: the "before" side of every identity
 * check is the file as it was at BASE (main before N171), read from git and compiled
 * beside the current one.
 *
 *   U  neutralizeFormula / readsAsFormula / neutralizeRow, value by value
 */
import Module from 'node:module';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';
import { pngImage } from './image-fixtures';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** main before N171: PR #97's merge. */
const BASE = '1632dd6166a19859d5c903930b3655191827cfd0';
const T0 = '2026-10-08T19:00:00Z';
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const JWT_SECRET = 'test-only-n171';
const S3_HOST = 'test-bucket.s3.us-east-1.amazonaws.com';

process.env.JWT_SECRET = JWT_SECRET;
process.env.S3_BUCKET = 'test-bucket';
process.env.AWS_REGION = 'us-east-1';

/** Text a spreadsheet would run, one per trigger character. */
const HOSTILE = {
  guard:  '=HYPERLINK("http://x.example","open")',
  badge:  '-1+1',
  site:   '@SUM(A1) Gate',
  report: "+cmd|' /C calc'!A0",
  cr:     '\rcarriage-return description',
  tab:    '\ttab description',
} as const;

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  const url = process.env.DATABASE_URL;
  if (url) {
    let h = '';
    try { h = new URL(url).hostname; } catch { h = '(unparseable)'; }
    if (!LOCAL_HOSTS.has(h)) { console.error(`REFUSING: DATABASE_URL points at ${h}.`); process.exit(2); }
  }
}
function stubModule(name: string, overrides: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...overrides }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the N171 test`); }),
  });
}
/** Run `fn` while `request` resolves to `exports`, then put back whatever was cached. */
function withModule<T>(request: string, exports: unknown, fn: () => T): T {
  const resolved = require.resolve(request);
  const prior = require.cache[resolved];
  inject(request, exports);
  try { return fn(); } finally { if (prior) require.cache[resolved] = prior; else delete require.cache[resolved]; }
}
function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}

let failures = 0;
let passes = 0;
// A harness that stops before its last check must not pass.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)');
    process.exitCode = 1;
  }
});
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);
const show = (s: unknown) => JSON.stringify(s);

const RealDate = Date;
async function frozen<T>(fn: () => Promise<T>): Promise<T> {
  const t = RealDate.parse(T0);
  function FrozenDate(...args: unknown[]): Date {
    return args.length === 0 ? new RealDate(t) : (Reflect.construct(RealDate, args) as Date);
  }
  FrozenDate.now = () => t;
  FrozenDate.parse = RealDate.parse;
  FrozenDate.UTC = RealDate.UTC;
  FrozenDate.prototype = RealDate.prototype;
  (globalThis as { Date: unknown }).Date = FrozenDate;
  try { return await fn(); } finally { (globalThis as { Date: unknown }).Date = RealDate; }
}

/** `apps/api/<rel>` as it was at BASE, compiled as a fresh module under the current file's path. */
function loadBase(rel: string): any {
  const file = path.join(__dirname, '..', rel);
  const src = execFileSync('git', ['show', `${BASE}:apps/api/${rel}`], { encoding: 'utf8' });
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}

/** RFC 4180, enough for these files: quoted cells, doubled quotes, LF row ends. */
function parseCsv(t: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let quoted = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else quoted = false; } else f += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(f); f = ''; }
    else if (ch === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else f += ch;
  }
  row.push(f);
  rows.push(row);
  return rows;
}

/** A small deterministic HoursExportDataset; `name` overrides the guard and site names. */
function hoursFixture(names: { guards: string[]; sites: string[]; company: string }): any {
  const pad = (n: number) => String(n).padStart(2, '0');
  const label = (ms: number) => { const d = new RealDate(ms - 7 * 3600e3); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`; };
  const rows: any[] = [];
  const t0 = RealDate.parse('2026-09-14T15:00:00Z');
  for (let day = 0; day < 3; day++) names.guards.forEach((gname, gi) => {
    const sname = names.sites[gi % names.sites.length];
    const ss = t0 + day * 86400e3 + gi * 3600e3;
    const se = ss + 8 * 3600e3;
    const ci = ss + (gi === 1 ? 50 : 0) * 60e3;
    const co = se;
    const hours = (co - ci) / 3600e3;
    const cov = Math.round(hours / 8 * 1000) / 10;
    rows.push({ guard_id: `g${gi}`, guard_name: gname, badge_number: `B${gi}`, site_id: `s${gi % names.sites.length}`, site_name: sname,
      site_timezone: 'America/Los_Angeles', shift_id: `sh-${day}-${gi}`, session_id: `ss-${day}-${gi}`,
      shift_date: new RealDate(ci - 7 * 3600e3).toISOString().slice(0, 10), shift_date_label: label(ci).split(', ')[0], day_of_week: 'Mon',
      sched_start_iso: new RealDate(ss).toISOString(), sched_start_label: label(ss), sched_end_iso: new RealDate(se).toISOString(), sched_end_label: label(se),
      clock_in_iso: new RealDate(ci).toISOString(), clock_in_label: label(ci), clock_out_iso: new RealDate(co).toISOString(), clock_out_label: label(co),
      scheduled_hours: 8, actual_hours: +hours.toFixed(2), payable_hours: +hours.toFixed(2), break_hours: 0.5, offpost_hours: 0,
      variance_hours: +(hours - 8).toFixed(2), coverage_pct: cov, flags: cov < 80 ? ['SHORT'] : [] });
  });
  const agg = (sel: any[], g?: string, st?: string) => {
    const sum = (k: string) => +sel.reduce((a, r) => a + r[k], 0).toFixed(2);
    const sch = sum('scheduled_hours'); const pay = sum('payable_hours');
    return { guard_id: g ? 'g' : null, guard_name: g ?? null, badge_number: null, site_id: st ? 's' : null, site_name: st ?? null, label: 'x',
      sessions: sel.length, shifts: sel.length, scheduled_hours: sch, actual_hours: sum('actual_hours'), payable_hours: pay, break_hours: sum('break_hours'),
      offpost_hours: 0, variance_hours: +(pay - sch).toFixed(2), coverage_pct: sch ? Math.round(pay / sch * 1000) / 10 : null,
      auto_closed_sessions: 0, flagged_count: sel.filter((r) => r.flags.length).length };
  };
  return { company_id: STAR_GUARD, company_name: names.company, company_slug: 'fixture', start_date: '2026-09-14', end_date: '2026-09-16', rows,
    by_guard: names.guards.map((g) => agg(rows.filter((r) => r.guard_name === g), g)),
    by_site: names.sites.map((st) => agg(rows.filter((r) => r.site_name === st), undefined, st)),
    by_guard_site: names.guards.map((g, gi) => agg(rows.filter((r) => r.guard_name === g), g, names.sites[gi % names.sites.length])),
    overall: agg(rows) };
}

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  class S3ObjectTooLargeError extends Error {}
  const s3Objects = new Map<string, Buffer>();
  inject('../src/services/s3', stubModule('s3', {
    S3ObjectTooLargeError,
    s3KeyFromPublicUrl: (url: string): string | null => {
      try { const u = new URL(url); return u.hostname === S3_HOST ? u.pathname.replace(/^\//, '') || null : null; } catch { return null; }
    },
    getS3ObjectBuffer: async (key: string) => {
      const b = s3Objects.get(key);
      if (!b) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey', statusCode: 404 });
      return b;
    },
  }));
  const ExcelJS = (await import('exceljs')).default;
  const XLSX = require('xlsx');
  const loadXlsx = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as never); return wb; };
  /** Every plain-string cell of every sheet, as [sheet, address, value]. */
  const stringCells = (wb: any) => {
    const out: Array<[string, string, string]> = [];
    wb.eachSheet((ws: any) => ws.eachRow((row: any) => row.eachCell((c: any) => { if (typeof c.value === 'string') out.push([ws.name, c.address, c.value]); })));
    return out;
  };
  const S = await import('../src/services/spreadsheetSafe');

  // ══════════════════════════════════════════════════════════════════════════
  section('U  the guard, value by value');
  {
    const trig = [['=', '=1+1'], ['+', '+cmd'], ['-', '-2+3'], ['@', '@SUM(A1)'], ['tab', '\tx'], ['CR', '\rx']];
    for (const [label, v] of trig) check(S.neutralizeFormula(v) === `'${v}` && S.readsAsFormula(v), `U1 a value starting with ${label}: ${show(v)} → ${show(S.neutralizeFormula(v))}`);
    for (const v of ['-2.5', '+3', '-0', '1e3', '-.5', '-12', '+0.25', '6.02E23']) check(S.neutralizeFormula(v) === v, `U2 a plain number is not a formula and stays as it is: ${show(v)}`);
    for (const v of ['Fixture Guard A', '1200 Example Avenue', "'=already escaped", '', ' =leading space', 'a=b', '(408) 555-0142', '–en dash', '—em dash'])
      check(S.neutralizeFormula(v) === v, `U3 ordinary text stays as it is: ${show(v)}`);
    const d = new RealDate('2026-09-15T00:00:00Z');
    check(S.neutralizeFormula(-2.5) === -2.5 && S.neutralizeFormula(null) === null && S.neutralizeFormula(undefined) === undefined
      && S.neutralizeFormula(d) === d && S.neutralizeFormula(true) === true, 'U4 a number, null, undefined, a Date or a boolean comes back untouched');
    const row = { a: '=x', b: -1, c: 'ok', d: null, e: '-1.5' };
    const out = S.neutralizeRow(row);
    check(show(Object.keys(out)) === show(Object.keys(row)) && out.a === "'=x" && out.b === -1 && out.c === 'ok' && out.d === null && out.e === '-1.5' && row.a === '=x',
      `U5 neutralizeRow: keys and order kept, only the formula text escaped, the input not mutated (${show(out)})`);
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
