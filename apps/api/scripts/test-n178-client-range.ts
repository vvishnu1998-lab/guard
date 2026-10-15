/**
 * test-n178-client-range.ts — N178: the client report's date range is whole days in site time.
 * "Oct 11" covers exactly Oct 11 00:00 to 23:59:59 PT, whichever shape the portal sends it in.
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test TZ=UTC \
 *   PGOPTIONS='-c TimeZone=UTC' npx ts-node -P tsconfig.scripts.json scripts/test-n178-client-range.ts
 *                                                                           (from apps/api)
 *
 * BOTH zones must be UTC, as in production: the process (TZ) and the database session
 * (PGOPTIONS). The local test Postgres gives its sessions the machine's zone, Pacific, and in
 * Pacific the defect does not show: the portal's zone-less "2026-10-11T00:00:00" casts to the
 * right instant by accident. That hid N178 on the first sample run. The harness refuses to run
 * otherwise. It also switches the process to Pacific at runtime (Node re-reads TZ) to prove the
 * output depends on neither.
 *
 * Needs poppler (pdftotext, pdfinfo) and git: BASE is main before this PR, read from git and
 * compiled under the current path. LOCAL DATABASES ONLY; fake data on Star Guard's id. Sentry,
 * email, S3 and Firebase are stubbed. N178_SAMPLES_DIR, when set, keeps the before/after PDFs.
 *
 *   P  calendarDay(): a bare date or a zone-less date-time names its date; an instant names its
 *      day in site time; anything else, '2026-02-30' included, is not a day. The same from a UTC
 *      and a Pacific process. dayLabel() prints a day without moving it.
 *   C  the site security report over HTTP, the portal's two steps, for the inputs the portal
 *      sends (daily, weekly, custom) and the other shapes (bare dates, instants), with reports
 *      and sessions at every edge of Oct 11 PT and on both DST days:
 *      C1 the PDF holds exactly the reports of the days asked for
 *      C2 it prints those days as its period
 *      C3 its hours total is the sessions clocked in on those days
 *      C4 the download panel's preview lists exactly the same reports
 *      C5 every shape of Oct 11 gives the same bytes; C6 so does a Pacific process
 *      C7 the file is dated in Pacific
 *      C8 nothing else changed: the bytes are BASE's for the one input BASE got right
 *         (instants at the day's bounds)
 *      C9 a bound that is not a date, or a start after the end, is refused in words
 *      C10 control: BASE, on the portal's own daily input, prints "Oct 10 – Oct 11", lists
 *          Oct 10's evening and misses Oct 11's, previews the same wrong set, and dates the
 *          file Oct 12
 */
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** main before this PR: PR #102's merge. */
const BASE = '147430bad8ceed64b80c091a5abfb9cbcb051048';
/** 21:30 PT on Oct 11, 04:30 UTC on Oct 12. */
const T0 = '2026-10-12T04:30:00Z';
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const JWT_SECRET = 'test-only-n178';
const LA = 'America/Los_Angeles';

process.env.JWT_SECRET = JWT_SECRET;
process.env.S3_BUCKET = 'test-bucket';
process.env.AWS_REGION = 'us-east-1';

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
      : () => { throw new Error(`${name}.${String(prop)} called in the N178 test`); }),
  });
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
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

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
/** `fn` with the process's zone set to `tz` (Node re-reads TZ when it is assigned); UTC again after. */
async function inZone<T>(tz: string, fn: () => Promise<T>): Promise<T> {
  process.env.TZ = tz;
  try {
    const offset = new RealDate(RealDate.UTC(2026, 8, 1)).getTimezoneOffset();
    if ((tz === 'UTC') !== (offset === 0)) throw new Error(`process.env.TZ = ${tz} did not take (offset ${offset})`);
    return await fn();
  } finally {
    process.env.TZ = 'UTC';
  }
}
/**
 * `apps/api/<rel>` at BASE, compiled as a fresh module under the current file's path. `edit` layers a later change
 * onto it: N180 (after this test's PR) moved the report's timeline day count 10 pt in, so BASE's report gets the same
 * edit, exactly once, and C8 still proves the bytes equal.
 */
function loadBase(rel: string, edit: (src: string) => string = (s) => s): any {
  const file = path.join(__dirname, '..', rel);
  const src = edit(execFileSync('git', ['show', `${BASE}:apps/api/${rel}`], { encoding: 'utf8' }));
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

/**
 * Reports, each tagged so the PDF's text and the preview can be checked for exactly which are in.
 * Times are UTC; the comment gives Pacific.
 */
const REPORTS: Array<[tag: string, type: string, at: string]> = [
  ['W1', 'activity', '2026-10-05T03:00:00Z'],    // Sun Oct 4 20:00 PDT, before the week
  ['W2', 'activity', '2026-10-05T07:00:00Z'],    // Mon Oct 5 00:00 PDT
  ['W3', 'activity', '2026-10-05T13:00:00Z'],    // Mon Oct 5 06:00 PDT
  ['E1', 'activity', '2026-10-11T01:30:00Z'],    // Oct 10 18:30 PDT
  ['E2', 'activity', '2026-10-11T06:59:00Z'],    // Oct 10 23:59 PDT
  ['E3', 'activity', '2026-10-11T07:00:00Z'],    // Oct 11 00:00 PDT
  ['E4', 'activity', '2026-10-11T16:00:00Z'],    // Oct 11 09:00 PDT
  ['E5', 'activity', '2026-10-11T23:59:00Z'],    // Oct 11 16:59 PDT
  ['E6', 'activity', '2026-10-12T00:00:00Z'],    // Oct 11 17:00 PDT
  ['E7', 'incident', '2026-10-12T03:30:00Z'],    // Oct 11 20:30 PDT
  ['E8', 'maintenance', '2026-10-12T06:59:00Z'], // Oct 11 23:59 PDT
  ['E9', 'activity', '2026-10-12T07:00:00Z'],    // Oct 12 00:00 PDT
  ['D1', 'activity', '2026-11-01T06:59:00Z'],    // Oct 31 23:59 PDT
  ['D2', 'activity', '2026-11-01T07:00:00Z'],    // Nov 1 00:00 PDT (a 25-hour day)
  ['D3', 'activity', '2026-11-01T08:30:00Z'],    // Nov 1 01:30 PDT, the first
  ['D4', 'activity', '2026-11-01T09:30:00Z'],    // Nov 1 01:30 PST, the second
  ['D5', 'activity', '2026-11-02T07:59:00Z'],    // Nov 1 23:59 PST
  ['D6', 'activity', '2026-11-02T08:00:00Z'],    // Nov 2 00:00 PST
  ['M1', 'activity', '2026-03-08T07:59:00Z'],    // Mar 7 23:59 PST
  ['M2', 'activity', '2026-03-08T08:00:00Z'],    // Mar 8 00:00 PST (a 23-hour day)
  ['M3', 'activity', '2026-03-08T10:00:00Z'],    // Mar 8 03:00 PDT
  ['M4', 'activity', '2026-03-09T06:59:00Z'],    // Mar 8 23:59 PDT
  ['M5', 'activity', '2026-03-09T07:00:00Z'],    // Mar 9 00:00 PDT
];
/** Sessions by clock-in, each 7 h 53 min: either side of Oct 11 PT, and on its last minute. */
const SESSIONS = ['2026-10-11T05:02:00Z', '2026-10-11T14:02:00Z', '2026-10-12T01:02:00Z', '2026-10-12T06:59:00Z', '2026-10-12T07:00:00Z'];

/** Each request: its label, the strings the portal (or another caller) sends, the days, the tags in them. */
const OCT11 = ['E3', 'E4', 'E5', 'E6', 'E7', 'E8'];
const REQUESTS: Array<[label: string, from: string, to: string, days: [string, string], tags: string[]]> = [
  ['daily, as the portal sends it', '2026-10-11T00:00:00', '2026-10-11T23:59:59', ['2026-10-11', '2026-10-11'], OCT11],
  ['custom, as the portal sends it', '2026-10-11', '2026-10-11T23:59:59', ['2026-10-11', '2026-10-11'], OCT11],
  ['bare dates', '2026-10-11', '2026-10-11', ['2026-10-11', '2026-10-11'], OCT11],
  ['instants at the day\'s bounds', '2026-10-11T07:00:00.000Z', '2026-10-12T06:59:59.999Z', ['2026-10-11', '2026-10-11'], OCT11],
  ['weekly, as the portal sends it', '2026-10-05T00:00:00', '2026-10-11T23:59:59', ['2026-10-05', '2026-10-11'], ['W2', 'W3', 'E1', 'E2', ...OCT11]],
  ['Nov 1, the 25-hour day', '2026-11-01T00:00:00', '2026-11-01T23:59:59', ['2026-11-01', '2026-11-01'], ['D2', 'D3', 'D4', 'D5']],
  ['Mar 8, the 23-hour day', '2026-03-08T00:00:00', '2026-03-08T23:59:59', ['2026-03-08', '2026-03-08'], ['M2', 'M3', 'M4']],
];

async function main(): Promise<void> {
  refuseUnlessLocal();
  if (process.env.TZ !== 'UTC') { console.error('REFUSING: run with TZ=UTC, as production runs.'); process.exit(2); }
  for (const tool of ['pdftotext', 'pdfinfo']) {
    if (spawnSync(tool, ['-v']).status !== 0) { console.error(`poppler (${tool}) is required.`); process.exit(2); }
  }
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  inject('../src/services/firebase', stubModule('firebase'));
  class S3ObjectTooLargeError extends Error {}
  inject('../src/services/s3', stubModule('s3', {
    S3ObjectTooLargeError,
    s3KeyFromPublicUrl: () => null,
    getS3ObjectBuffer: async () => { throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey', statusCode: 404 }); },
    urlOrPresign: async (u: unknown) => u,
    presignAll: async (u: unknown) => u,
  }));

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'n178-'));
  const keep = process.env.N178_SAMPLES_DIR;
  const file = (buf: Buffer, name: string) => {
    const f = path.join(TMP, name);
    fs.writeFileSync(f, buf);
    if (keep) fs.writeFileSync(path.join(keep, name), buf);
    return f;
  };
  const textOf = (f: string) => execFileSync('pdftotext', [f, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
  const tagsIn = (t: string) => REPORTS.map(([tag]) => tag).filter((tag) => new RegExp(`\\b${tag}\\b`).test(t));

  // ══════════════════════════════════════════════════════════════════════════
  section('P  calendarDay() and dayLabel()');
  const { calendarDay } = await import('../src/services/dateRange');
  const { dayLabel } = await import('../src/services/pdf/dates');
  {
    const cases: Array<[string, string | null]> = [
      ['2026-10-11', '2026-10-11'],
      [' 2026-10-11 ', '2026-10-11'],
      ['2026-10-11T00:00:00', '2026-10-11'],
      ['2026-10-11T23:59:59', '2026-10-11'],
      ['2026-10-11T23:59:59.999', '2026-10-11'],
      ['2026-10-11T07:00', '2026-10-11'],
      ['2026-10-11T07:00:00.000Z', '2026-10-11'],     // 00:00 PDT
      ['2026-10-12T06:59:59.999Z', '2026-10-11'],     // 23:59:59.999 PDT
      ['2026-10-12T07:00:00Z', '2026-10-12'],
      ['2026-10-11T23:30:00-07:00', '2026-10-11'],
      ['2026-10-12T02:00:00+05:30', '2026-10-11'],    // 20:30Z Oct 11
      ['2026-11-01T09:30:00Z', '2026-11-01'],         // 01:30 PST, the second one
      ['2026-11-02T07:59:00Z', '2026-11-01'],         // 23:59 PST
      ['2026-03-09T06:59:00Z', '2026-03-08'],         // 23:59 PDT
      ['2026-02-30', null],
      ['2026-13-01', null],
      ['2026-10-11T24:00:00', null],
      ['2026-10-11T23:60', null],
      ['2026/10/11', null],
      ['yesterday', null],
      ['2026-10-11T00:00:00Zjunk', null],
      ['', null],
    ];
    const run = () => cases.map(([v]) => calendarDay(v, LA));
    const inUtc = await inZone('UTC', async () => run());
    const inLa = await inZone(LA, async () => run());
    const bad = cases.filter((c, i) => inUtc[i] !== c[1] || inLa[i] !== c[1]).map((c, i) => `${JSON.stringify(c[0])} -> ${inUtc[i]}/${inLa[i]}`);
    check(bad.length === 0, `P1 calendarDay: ${cases.length} cases — a bare date or a zone-less date-time names its date; an instant its day in Pacific, across both DST changes; anything else is not a day; the same from a UTC and a Pacific process (${bad.join('; ') || 'all as expected'})`);
    const labels = await inZone(LA, async () => ['2026-10-11', '2026-03-08', '2026-11-01'].map((d) => dayLabel(d)));
    const labelsUtc = ['2026-10-11', '2026-03-08', '2026-11-01'].map((d) => dayLabel(d));
    check(JSON.stringify(labels) === JSON.stringify(['Oct 11, 2026', 'Mar 8, 2026', 'Nov 1, 2026']) && JSON.stringify(labels) === JSON.stringify(labelsUtc),
      `P2 dayLabel prints a day without moving it: ${labels.join(', ')}, from either process zone`);
  }

  // ══ the database: Star Guard, fake data, local only, in UTC as production ══
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  const sessionTz = (await pool.query('SHOW TimeZone')).rows[0].TimeZone as string;
  if (sessionTz !== 'UTC' && sessionTz !== 'Etc/UTC') {
    console.error(`REFUSING: the database session runs in ${sessionTz}; production's runs in UTC. Run with PGOPTIONS='-c TimeZone=UTC'.`);
    await pool.end();
    process.exit(2);
  }
  await import('express-async-errors');
  const express = (await import('express')).default;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `n178-${RealDate.now().toString(36)}`;
  const seeded: Record<string, string[]> = { reports: [], clients: [], shift_sessions: [], shifts: [], guards: [], sites: [] };
  const ins = async (table: string, sql: string, params: unknown[]) => {
    const id = (await q(sql, params)).rows[0].id as string;
    seeded[table].push(id);
    return id;
  };
  // Rows an earlier run left behind, swept by this harness's own markers before anything is written.
  for (const sql of [
    "DELETE FROM reports WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'n178-%')",
    "DELETE FROM clients WHERE email LIKE 'n178-%'",
    "DELETE FROM shift_sessions WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'n178-%')",
    "DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'n178-%')",
    "DELETE FROM guards WHERE email LIKE 'n178-%'",
    "DELETE FROM sites WHERE name LIKE 'n178-%'",
  ]) await q(sql);
  const hadStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rowCount > 0;
  let server: Server | null = null;
  try {
    if (!hadStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const site = await ins('sites', `INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1200 Example Avenue, San Jose, CA', '2026-01-01') RETURNING id`,
      [STAR_GUARD, `${marker} N Gate`]);
    const sessions: string[] = [];
    for (const [i, at] of SESSIONS.entries()) {
      const guard = await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
        [STAR_GUARD, `Fixture Guard 0${i + 1}`, `${marker}-${i}@test.invalid`, `GRD977${i}`]);
      const start = new RealDate(at);
      const shift = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
        [site, guard, start, new RealDate(start.getTime() + 8 * 3600e3)]);
      sessions.push(await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords)
        VALUES ($1, $2, $3, $4, $5, '37.33,-121.89') RETURNING id`, [shift, guard, site, start, new RealDate(start.getTime() + (7 * 60 + 53) * 60e3)]));
    }
    for (const [i, [tag, type, at]] of REPORTS.entries()) {
      await ins('reports', `INSERT INTO reports (shift_session_id, site_id, report_type, description, severity, reported_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [sessions[i % sessions.length], site, type, `${tag}: round at the north gate.`, type === 'incident' ? 'medium' : null, new RealDate(at)]);
    }
    const client = await ins('clients', `INSERT INTO clients (site_id, name, email, password_hash, company_id, is_active) VALUES ($1, 'Fixture Client', $2, 'x', $3, true) RETURNING id`,
      [site, `${marker}-client@test.invalid`, STAR_GUARD]);

    /** The oracle: the hours a day range holds, by an explicit Pacific-day predicate written here. */
    const oracleHours = async (fromDay: string, toDay: string) => Number((await q(
      `SELECT COALESCE(SUM(ROUND(CAST(EXTRACT(EPOCH FROM (clocked_out_at - clocked_in_at)) / 3600.0 AS NUMERIC), 2)), 0) AS h
         FROM shift_sessions WHERE site_id = $1
          AND clocked_in_at >= ($2::date)::timestamp AT TIME ZONE 'America/Los_Angeles'
          AND clocked_in_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles'`, [site, fromDay, toDay])).rows[0].h);
    const oracleTags = async (fromDay: string, toDay: string) => (await q(
      `SELECT split_part(description, ':', 1) AS tag FROM reports WHERE site_id = $1
          AND reported_at >= ($2::date)::timestamp AT TIME ZONE 'America/Los_Angeles'
          AND reported_at <  ($3::date + 1)::timestamp AT TIME ZONE 'America/Los_Angeles'
        ORDER BY reported_at`, [site, fromDay, toDay])).rows.map((r: { tag: string }) => r.tag);

    const app = express();
    app.use(express.json());
    app.use('/api/client', (await import('../src/routes/clientPortal')).default);
    app.use('/api/client-base', loadBase('src/routes/clientPortal.ts', (src) => {
      const from = "{ align: 'right', width: PAGE_W - ML });";
      if (src.split(from).length !== 2) throw new Error('N180: expected the day count line once at BASE');
      return src.replace(from, "{ align: 'right', width: PAGE_W - ML - 10 });");
    }).default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    listening.keepAliveTimeout = 600_000;
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    const bearer = () => `Bearer ${jwt.sign({ sub: client, role: 'client', site_id: site }, JWT_SECRET, { expiresIn: '1h' })}`;
    /** A response's JSON, or a note of what came instead: a PDF where a refusal was due must fail its check, not the run. */
    const jsonOf = async (r: Response): Promise<any> => {
      const raw = Buffer.from(await r.arrayBuffer());
      try { return JSON.parse(raw.toString('utf8')); } catch { return { error: `(not JSON: ${r.headers.get('content-type') ?? 'no type'}, ${raw.length} bytes)` }; }
    };
    /** The portal's two steps, in the frozen clock and the given process zone. */
    const pdf = (prefix: string, from: string, to: string, tz = 'UTC') => inZone(tz, () => frozen(async () => {
      const link = await fetch(`${origin}${prefix}/reports/pdf-link`, {
        method: 'POST', headers: { authorization: bearer(), 'content-type': 'application/json' }, body: JSON.stringify({ from, to }),
      });
      const lj = (await jsonOf(link)) as { url?: string; error?: string };
      if (link.status !== 200 || !lj.url) return { status: link.status, error: lj.error ?? '', body: Buffer.alloc(0), filename: '' };
      const r = await fetch(`${origin}${prefix}${lj.url.slice('/api/client'.length)}`);
      return {
        status: r.status, error: '', body: Buffer.from(await r.arrayBuffer()),
        filename: (r.headers.get('content-disposition') ?? '').replace(/^.*filename="/, '').replace(/"$/, ''),
      };
    }));
    /** The download panel's preview: GET /api/client/reports with the same strings. */
    const preview = (prefix: string, from: string, to: string) => frozen(async () => {
      const r = await fetch(`${origin}${prefix}/reports?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`, { headers: { authorization: bearer() } });
      const body = (await jsonOf(r)) as Array<{ description: string }> | { error: string };
      return { status: r.status, tags: Array.isArray(body) ? body.map((x) => x.description.split(':')[0]).reverse() : [], error: Array.isArray(body) ? '' : body.error };
    });

    // ══════════════════════════════════════════════════════════════════════════
    section('C  the site security report, over HTTP, for each shape of range');
    const got: Record<string, { body: Buffer; text: string; filename: string }> = {};
    const bad1: string[] = [];
    const bad2: string[] = [];
    const bad3: string[] = [];
    const bad4: string[] = [];
    for (const [label, from, to, days, tags] of REQUESTS) {
      const r = await pdf('/api/client', from, to);
      if (r.status !== 200) { bad1.push(`${label}: ${r.status} ${r.error}`); continue; }
      const f = file(r.body, `client-report-${label.split(',')[0].replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-after.pdf`);
      const text = textOf(f);
      got[label] = { body: r.body, text, filename: r.filename };
      const oracle = await oracleTags(days[0], days[1]);
      const inPdf = tagsIn(text);
      if (JSON.stringify(inPdf) !== JSON.stringify(tags) || JSON.stringify(oracle) !== JSON.stringify(tags)) bad1.push(`${label}: PDF ${inPdf.join(' ')} | want ${tags.join(' ')} | oracle ${oracle.join(' ')}`);
      const want = `Report Period: ${dayLabel(days[0])} – ${dayLabel(days[1])} |`;
      if (!text.includes(want)) bad2.push(`${label}: no "${want}" in "${text.match(/Report Period: [^|]*\|/)?.[0]}"`);
      const hours = Number(text.match(/([\d.]+) hours on duty/)?.[1]);
      const wantHours = await oracleHours(days[0], days[1]);
      if (hours.toFixed(1) !== wantHours.toFixed(1)) bad3.push(`${label}: ${hours} h, want ${wantHours.toFixed(1)}`);
      const pv = await preview('/api/client', from, to);
      if (pv.status !== 200 || JSON.stringify(pv.tags) !== JSON.stringify(tags)) bad4.push(`${label}: preview ${pv.status} ${pv.tags.join(' ')}`);
    }
    check(bad1.length === 0, `C1 each of the ${REQUESTS.length} ranges holds exactly the reports of its days in Pacific, edges and both DST days included, as an explicit Pacific-day query finds them (${bad1.join('; ') || 'all exact'})`);
    check(bad2.length === 0, `C2 each prints those days as its period, e.g. "Report Period: Oct 11, 2026 – Oct 11, 2026" (${bad2.join('; ') || 'all'})`);
    check(bad3.length === 0, `C3 each hours total is the sessions clocked in on its days, 00:00 to 23:59 PT (${bad3.join('; ') || 'all'})`);
    check(bad4.length === 0, `C4 the download panel's preview lists exactly the same reports (${bad4.join('; ') || 'all'})`);
    {
      const oct11 = REQUESTS.slice(0, 4).map(([label]) => got[label]?.body);
      check(oct11.every((b) => b && b.equals(oct11[0])),
        `C5 the portal's daily and custom inputs, bare dates and instants all give the same bytes for Oct 11 (${oct11.map((b) => (b ? sha(b) : '-')).join(' ')})`);
      const la = await pdf('/api/client', REQUESTS[0][1], REQUESTS[0][2], LA);
      check(la.body.equals(got[REQUESTS[0][0]].body), `C6 the same bytes from a Pacific process (${sha(la.body)})`);
      check(got[REQUESTS[0][0]].filename.endsWith('-2026-10-11.pdf'),
        `C7 the file is dated in Pacific: ${got[REQUESTS[0][0]].filename} (generated 21:30 PT on Oct 11, already Oct 12 in UTC)`);
    }
    {
      // BASE handled one input right: instants at the day's bounds. Its PDF for those is the
      // current one for the portal's own input, byte for byte; and for the DST days too.
      const pairs: Array<[string, string, string]> = [
        [REQUESTS[0][0], '2026-10-11T07:00:00.000Z', '2026-10-12T06:59:59.999Z'],
        [REQUESTS[4][0], '2026-10-05T07:00:00.000Z', '2026-10-12T06:59:59.999Z'],
        [REQUESTS[5][0], '2026-11-01T07:00:00.000Z', '2026-11-02T07:59:59.999Z'],
        [REQUESTS[6][0], '2026-03-08T08:00:00.000Z', '2026-03-09T06:59:59.999Z'],
      ];
      const res: string[] = [];
      let all = true;
      for (const [label, from, to] of pairs) {
        const b = await pdf('/api/client-base', from, to);
        const same = b.status === 200 && b.body.equals(got[label].body);
        all &&= same;
        res.push(`${label.split(',')[0]} ${same ? '=' : '≠'}`);
      }
      check(all, `C8 nothing else changed: for the input BASE got right (instants at the days' bounds), its PDF is the current one's for the portal's input, byte for byte (${res.join('; ')})`);
    }
    {
      const r1 = await pdf('/api/client', 'yesterday', '2026-10-11');
      const r2 = await pdf('/api/client', '2026-02-30', '2026-10-11');
      const r3 = await pdf('/api/client', '2026-10-12', '2026-10-11T23:59:59');
      const r4 = await preview('/api/client', 'garbage', '2026-10-11');
      const r5 = await frozen(async () => {
        const r = await fetch(`${origin}/api/client/reports/pdf?from=garbage&to=2026-10-11`, { headers: { authorization: bearer() } });
        return { status: r.status, error: ((await jsonOf(r)) as { error: string }).error };
      });
      check(r1.status === 400 && r2.status === 400 && /must be dates/.test(r1.error) && r3.status === 400 && /start date is after the end date/.test(r3.error)
        && r4.status === 400 && r4.error === 'invalid date_from' && r5.status === 400 && r5.error === 'invalid from',
        `C9 refused in words: "yesterday" and "2026-02-30" (${r1.status}/${r2.status} "${r1.error}"), a start after the end (${r3.status} "${r3.error}"), a preview date that is not one (${r4.status} "${r4.error}"), and the Bearer fallback's (${r5.status} "${r5.error}")`);
    }
    {
      const [label, from, to] = REQUESTS[0];
      const b = await pdf('/api/client-base', from, to);
      const fb = file(b.body, 'client-report-daily-before.pdf');
      const t = textOf(fb);
      const pv = await preview('/api/client-base', from, to);
      check(t.includes('Report Period: Oct 10, 2026 – Oct 11, 2026 |') && JSON.stringify(tagsIn(t)) === JSON.stringify(['E1', 'E2', 'E3', 'E4', 'E5'])
        && JSON.stringify(pv.tags) === JSON.stringify(['E1', 'E2', 'E3', 'E4', 'E5']) && b.filename.endsWith('-2026-10-12.pdf'),
        `C10 control: BASE, on the portal's ${label.split(',')[0]} input, prints "Oct 10 – Oct 11", holds ${tagsIn(t).join(' ')} (Oct 10's evening in, Oct 11's out), previews ${pv.tags.join(' ')}, and dates the file ${b.filename.slice(-14, -4)}`);
      if (keep) {
        const w = await pdf('/api/client-base', REQUESTS[4][1], REQUESTS[4][2]);
        file(w.body, 'client-report-weekly-before.pdf');
      }
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    for (const table of ['reports', 'clients', 'shift_sessions', 'shifts', 'guards', 'sites']) {
      if (seeded[table].length) await q(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [seeded[table]]);
    }
    if (!hadStarGuard) await q('DELETE FROM companies WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM sites WHERE company_id = $1)', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM sites WHERE name LIKE $1)::int + (SELECT count(*) FROM guards WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM clients WHERE email LIKE $1)::int AS n`, [`${marker}%`])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
    await pool.end();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
