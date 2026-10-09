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
 *   W  the hours workbook: clean data gives the same bytes as at BASE (with and
 *      without a letterhead); hostile names leave no cell that reads as a formula,
 *      numbers stay numbers, and a "+1" phone in the letterhead is labelled "Tel"
 *   R  the routes over HTTP on a local database seeded with hostile names, badges,
 *      report descriptions and a violation: the analytics CSV, the analytics XLSX
 *      and the billing hours XLSX. Clean data: the same output as the BASE routes.
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

  // ══════════════════════════════════════════════════════════════════════════
  section(`W  the hours workbook: clean data unchanged since ${BASE.slice(0, 7)}; hostile text escaped everywhere`);
  // The current workbook first, then the base one compiled while ./letterhead/xlsx resolves to ITS base
  // too, so W1 compares main with now and not a hybrid of the two.
  const curWB = require('../src/services/hoursWorkbook');
  const baseWB = withModule('../src/services/letterhead/xlsx', loadBase('src/services/letterhead/xlsx.ts'),
    () => loadBase('src/services/hoursWorkbook.ts'));
  const xlsxOf = (mod: any, data: unknown, lh?: unknown) => frozen<Buffer>(() => mod.workbookToBuffer(mod.buildHoursWorkbook(data, lh)));
  const LOGO = pngImage(400, 160);
  const FULL = { companyName: 'Star Guard', contactEmail: 'dispatch@starguard.example', phone: '(408) 555-0142',
    address: '1200 Example Avenue, Suite 300\nSan Jose, CA 95110', licenceNumber: 'PPO 120456', website: 'https://www.starguard.example/', logo: LOGO };
  const clean = hoursFixture({ guards: ['Fixture Guard A', 'Fixture Guard B'], sites: ['North Gate', 'South Lot'], company: 'Star Guard' });
  check(!String(baseWB.buildHoursWorkbook).includes('neutralizeWorkbook') && String(curWB.buildHoursWorkbook).includes('neutralizeWorkbook'),
    'W0 the base workbook predates the guard; the current one runs it');
  for (const [label, lh] of [['no letterhead', null], ['the full letterhead, "(408)" phone', FULL]] as const) {
    const before = await xlsxOf(baseWB, clean, lh);
    const after = await xlsxOf(curWB, clean, lh);
    check(before.equals(after), `W1 clean data, ${label}: ${sha(before)} = ${sha(after)} (${after.length} bytes)`);
  }
  {
    const hostile = hoursFixture({ guards: [HOSTILE.guard, HOSTILE.badge], sites: [HOSTILE.site, HOSTILE.tab], company: HOSTILE.report });
    const LH = { ...FULL, phone: '+1 (408) 555-0142', address: '=EVIL()\nSan Jose', licenceNumber: '@x' };
    const wb = await loadXlsx(await xlsxOf(curWB, hostile, LH));
    const cells = stringCells(wb);
    const live = cells.filter(([, , v]) => S.readsAsFormula(v));
    check(cells.length > 100 && live.length === 0, `W2 no text cell in any of the 4 sheets reads as a formula (${cells.length} text cells; live: ${show(live.slice(0, 3))})`);
    const has = (v: string) => cells.some(([, , c]) => c === v);
    const where = (v: string) => [...new Set(cells.filter(([, , c]) => c === `'${v}`).map(([s]) => s))].sort().join(',');
    for (const v of [HOSTILE.guard, HOSTILE.badge, HOSTILE.site, HOSTILE.tab]) {
      check(has(`'${v}`) && !has(v), `W3 ${show(v)} is written escaped, and never bare (sheets: ${where(v)})`);
    }
    check(cells.some(([s, , c]) => s === 'NOTES' && c.startsWith(`'${HOSTILE.report}  (`)), 'W4 the company name on the NOTES Tenant row is escaped too');
    const sum = wb.getWorksheet('SUMMARY')!;
    check(sum.getCell('B3').value === 'Tel +1 (408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example'
      && sum.getCell('B2').value === "'=EVIL(), San Jose" && sum.getCell('B4').value === 'License No. @x' && sum.getCell('B1').value === 'Star Guard',
      `W5 letterhead block: a "+1" phone line is labelled "Tel" (no apostrophe), an address that reads as a formula is escaped (B2 ${show(sum.getCell('B2').value)}, B3 ${show(sum.getCell('B3').value)})`);
    const detail = wb.getWorksheet('HOURS DETAIL')!;
    const variances: unknown[] = [];
    detail.eachRow((row: any, n: number) => { if (n > 1 && row.getCell(1).value !== 'TOTAL') variances.push(row.getCell(14).value); });
    check(variances.length > 0 && variances.every((v) => typeof v === 'number') && variances.some((v) => (v as number) < 0),
      `W6 negative figures stay numbers (HOURS DETAIL variance: ${show(variances)})`);
    const amp = await loadXlsx(await xlsxOf(curWB, clean, { ...FULL, phone: '(408) 555-0142' }));
    check(amp.getWorksheet('SUMMARY')!.getCell('B3').value === '(408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example',
      'W7 a "(408)" phone line is written exactly as B1 wrote it: no label');
    // The block on its own, in a bare workbook with no whole-workbook pass after it: it must be safe by itself.
    const { writeLetterheadBlock } = require('../src/services/letterhead/xlsx');
    const bare = new ExcelJS.Workbook();
    const ws = bare.addWorksheet('ANY');
    writeLetterheadBlock(bare, ws, { ...FULL, logo: null, companyName: '=EVIL()', address: '@SUM(1)', phone: '-5 hostile' });
    check(ws.getCell('A1').value === "'=EVIL()" && ws.getCell('A2').value === "'@SUM(1)" && String(ws.getCell('A3').value).startsWith('Tel -5 hostile'),
      `W8 the letterhead block by itself, in a bare workbook: the name and lines are escaped, the phone line labelled (A1 ${show(ws.getCell('A1').value)}, A2 ${show(ws.getCell('A2').value)}, A3 ${show(ws.getCell('A3').value)})`);
  }

  // ══ the database and the routes ══
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  await import('express-async-errors');
  const express = (await import('express')).default;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `n171-${RealDate.now().toString(36)}`;
  const seeded: Record<string, string[]> = {
    geofence_violations: [], reports: [], shift_sessions: [], shifts: [], guards: [], sites: [], company_admins: [], companies: [],
  };
  const ins = async (table: string, sql: string, params: unknown[]) => {
    const id = (await q(sql, params)).rows[0].id as string;
    seeded[table].push(id);
    return id;
  };
  // Rows an earlier run left behind, swept by this harness's own markers before anything is written.
  for (const sql of [
    "DELETE FROM geofence_violations WHERE site_id IN (SELECT id FROM sites WHERE address LIKE 'n171-%')",
    "DELETE FROM reports WHERE site_id IN (SELECT id FROM sites WHERE address LIKE 'n171-%')",
    "DELETE FROM shift_sessions WHERE site_id IN (SELECT id FROM sites WHERE address LIKE 'n171-%')",
    "DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE address LIKE 'n171-%')",
    "DELETE FROM guards WHERE email LIKE 'n171-%'",
    "DELETE FROM sites WHERE address LIKE 'n171-%'",
    "DELETE FROM company_admins WHERE email LIKE 'n171-%'",
    "DELETE FROM companies WHERE name LIKE 'N171 Fixture n171-%'",
  ]) await q(sql);
  let server: Server | null = null;
  try {
    // A hostile company and a clean one, each with one completed shift on 2026-09-15.
    async function seedCompany(tag: 'hostile' | 'clean') {
      const hostile = tag === 'hostile';
      const company = await ins('companies', 'INSERT INTO companies (name) VALUES ($1) RETURNING id', [`N171 Fixture ${marker} ${tag}`]);
      const admin = await ins('company_admins', `INSERT INTO company_admins (company_id, name, email, password_hash, is_primary)
        VALUES ($1, $2, $3, 'x', true) RETURNING id`, [company, `${marker} ${tag} admin`, `${marker}-${tag}-admin@test.invalid`]);
      const site = await ins('sites', `INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, $3, '2026-01-01') RETURNING id`,
        [company, hostile ? HOSTILE.site : 'North Gate', `${marker} ${tag} address`]);
      const guards = [
        await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
          [company, hostile ? HOSTILE.guard : 'Fixture Guard A', `${marker}-${tag}-g1@test.invalid`, hostile ? HOSTILE.badge : 'GRD9901']),
        await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, 'Plain Guard', $2, 'x', 'GRD9902') RETURNING id`,
          [company, `${marker}-${tag}-g2@test.invalid`]),
      ];
      const start = new RealDate('2026-09-15T15:00:00Z');
      const at = (min: number) => new RealDate(start.getTime() + min * 60e3);
      for (const [i, g] of guards.entries()) {
        const shift = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
          VALUES ($1, $2, $3, $4, 'completed') RETURNING id`, [site, g, at(i * 30), at(480 + i * 30)]);
        const sess = await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords)
          VALUES ($1, $2, $3, $4, $5, '37.33,-121.89') RETURNING id`, [shift, g, site, at(i * 30 + 2), at(i * 30 + 470)]);
        const descs = hostile ? (i === 0 ? [HOSTILE.report, HOSTILE.cr] : [HOSTILE.tab]) : ['Perimeter checked, gate secured.'];
        for (const [k, desc] of descs.entries()) {
          await ins('reports', `INSERT INTO reports (shift_session_id, site_id, report_type, description, reported_at)
            VALUES ($1, $2, 'activity', $3, $4) RETURNING id`, [sess, site, desc, at(i * 30 + 60 + k * 10)]);
        }
        if (i === 0) {
          await ins('geofence_violations', `INSERT INTO geofence_violations (shift_session_id, guard_id, site_id, violation_lat, violation_lng,
              position_source, occurred_at, resolved_at, duration_minutes)
            VALUES ($1, $2, $3, 37.34, -121.88, 'background', $4, $5, 12) RETURNING id`, [sess, g, site, at(200), at(212)]);
        }
      }
      return { company, admin };
    }
    const H = await seedCompany('hostile');
    const C = await seedCompany('clean');

    const app = express();
    app.use(express.json());
    app.use('/api/exports', (await import('../src/routes/exports')).default);
    app.use('/api/exports-base', loadBase('src/routes/exports.ts').default);
    app.use('/api/billing', (await import('../src/routes/billing')).default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    const tokenFor = (x: { company: string; admin: string }) =>
      jwt.sign({ sub: x.admin, role: 'company_admin', company_id: x.company, is_primary: true }, JWT_SECRET, { expiresIn: '1h' });
    const get = (p: string, token: string) => frozen(async () => {
      const r = await fetch(`${origin}${p}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
    });
    const range = 'date_from=2026-09-15&date_to=2026-09-15';

    // ══════════════════════════════════════════════════════════════════════════
    section('R  the routes over HTTP: the analytics CSV and XLSX, and the billing hours XLSX');
    {
      const r = await get(`/api/exports/analytics/csv?${range}`, tokenFor(H));
      const rows = parseCsv(r.body.toString('utf8').replace(/^﻿/, ''));
      const cells = rows.flat();
      const live = cells.filter((c) => S.readsAsFormula(c));
      check(r.status === 200 && live.length === 0, `R1 analytics CSV: no cell reads as a formula (${cells.length} cells; live: ${show(live.slice(0, 3))})`);
      for (const v of Object.values(HOSTILE)) {
        check(cells.includes(`'${v}`) && !cells.includes(v), `R2 analytics CSV: ${show(v)} is there, escaped, and never bare`);
      }
      const hoursHeader = rows.findIndex((row) => row[0] === 'Site' && row[1] === 'Guard');
      const hoursRows = rows.slice(hoursHeader + 1).filter((row) => row.length === 12);
      // Columns 5-7: Scheduled, Actual and Payable Hours. (Total Hours, column 4, is the legacy figure only
      // the clock-out path writes, so it is empty for these seeded sessions.)
      check(hoursHeader > 0 && hoursRows.length === 2 && hoursRows.every((row) => [5, 6, 7].every((i) => /^\d+(\.\d+)?$/.test(row[i]))),
        `R3 the figures beside them are untouched: Scheduled, Actual and Payable Hours stay plain numbers (${show(hoursRows.map((row) => row.slice(5, 8)))})`);
    }
    {
      const r = await get(`/api/exports/analytics/xlsx?${range}`, tokenFor(H));
      const wb = XLSX.read(r.body, { type: 'buffer' });
      const all: unknown[] = [];
      for (const name of wb.SheetNames) for (const row of XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true }) as unknown[][]) all.push(...row);
      const strs = all.filter((v): v is string => typeof v === 'string');
      const live = strs.filter((v) => S.readsAsFormula(v));
      check(r.status === 200 && wb.SheetNames.length === 3 && live.length === 0, `R4 analytics XLSX: no text cell in its 3 sheets reads as a formula (${strs.length} text cells; live: ${show(live.slice(0, 3))})`);
      for (const v of Object.values(HOSTILE)) {
        check(strs.includes(`'${v}`) && !strs.includes(v), `R5 analytics XLSX: ${show(v)} is there, escaped, and never bare`);
      }
      const nums = all.filter((v) => typeof v === 'number');
      check(nums.includes(12), `R6 analytics XLSX: numbers stay numbers (the violation's duration_minutes is still the number 12; ${nums.length} numeric cells)`);
    }
    {
      const r = await get('/api/billing/hours-export?start_date=2026-09-15&end_date=2026-09-15', tokenFor(H));
      const wb = r.status === 200 ? await loadXlsx(r.body) : null;
      const cells = wb ? stringCells(wb) : [];
      const live = cells.filter(([, , v]) => S.readsAsFormula(v));
      check(r.status === 200 && live.length === 0 && cells.some(([, , v]) => v === `'${HOSTILE.guard}`) && cells.some(([, , v]) => v === `'${HOSTILE.site}`),
        `R7 billing hours XLSX: the guard and site come out escaped, and no text cell reads as a formula (${cells.length} text cells; live: ${show(live.slice(0, 3))})`);
    }
    // Clean data: the same output as the BASE routes.
    {
      const b = await get(`/api/exports-base/analytics/csv?${range}`, tokenFor(C));
      const c = await get(`/api/exports/analytics/csv?${range}`, tokenFor(C));
      check(b.status === 200 && b.body.equals(c.body) && c.body.toString('utf8').includes('Fixture Guard A'),
        `R8 clean data, analytics CSV: the base route ${sha(b.body)} = current ${sha(c.body)} (${c.body.length} bytes)`);
      const bx = await get(`/api/exports-base/analytics/xlsx?${range}`, tokenFor(C));
      const cx = await get(`/api/exports/analytics/xlsx?${range}`, tokenFor(C));
      const cellsOf = (buf: Buffer) => { const wb = XLSX.read(buf, { type: 'buffer' }); return show(wb.SheetNames.map((n: string) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true }))); };
      check(bx.status === 200 && cellsOf(bx.body) === cellsOf(cx.body), 'R9 clean data, analytics XLSX: every cell of every sheet the same as the base route\'s');
      const hostileVsBase = await get(`/api/exports-base/analytics/csv?${range}`, tokenFor(H));
      check(parseCsv(hostileVsBase.body.toString('utf8')).flat().includes(HOSTILE.guard),
        'R10 control: the base route, given the hostile data, writes it bare; the comparisons above can see the difference');
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    for (const table of ['geofence_violations', 'reports', 'shift_sessions', 'shifts', 'guards', 'sites', 'company_admins', 'companies']) {
      if (seeded[table].length) await q(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [seeded[table]]);
    }
    const left = (await q(`SELECT (SELECT count(*) FROM sites WHERE address LIKE $1)::int + (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM companies WHERE name LIKE $2)::int AS n`, [`${marker}%`, `N171 Fixture ${marker}%`])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
    await pool.end();
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
