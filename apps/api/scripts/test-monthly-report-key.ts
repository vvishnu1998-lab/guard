/**
 * test-monthly-report-key.ts — N123: the monthly cron and the regenerate
 * route write the SAME S3 key for the same company and month.
 *
 * LOCAL ONLY; NOTHING LEAVES THE MACHINE. The database pool, S3, Sentry, the
 * auth middleware, logEvent and the cron scheduler are replaced in
 * require.cache before any module under test loads (the
 * routes/_aiEnhance.test.ts pattern). The S3 stub records the key and returns
 * the URL uploadBufferToS3 would; every other S3 export throws. The pool is an
 * in-memory fake that answers only the statements the writers issue — with
 * the refusals Postgres would make (uuid and integer input, the month CHECK,
 * the company FK) — and throws on anything else. No .env is read and no JWT is
 * needed. The last section asserts that no AWS, pg, Sentry, SendGrid or
 * ExcelJS module was loaded at all.
 *
 * What runs for real: the route handler (driven through router.stack — no
 * express app, no listen), the cron closure (captured from runJob and called
 * directly), services/monthlyReport.ts, and slugify() from
 * services/hoursExport.ts. buildHoursExport is replaced by a fake returning
 * slugify(the company's name) — the only field the key reads — and the
 * workbook renderer by a stub. The workbook is not under test here;
 * scripts/hours-export-snapshot.ts pins it.
 *
 * EXPECTED KEYS ARE WRITTEN OUT BY HAND below, not computed with slugify() or
 * monthlyReportKey(). The parity check is route key === cron key === that
 * literal.
 *
 * Modules under test are loaded as `any`, and a missing
 * services/monthlyReport.ts is recorded as a failure rather than a crash, so
 * the SAME file runs against origin/main as the negative control.
 *
 * The process runs in America/Los_Angeles whatever the machine's zone, so an
 * instant whose UTC and local months differ (2026-09-01 03:00 UTC is still
 * August 31 in Pacific) tells a UTC month from a process-local one.
 *
 * Usage (from apps/api):
 *   npx ts-node scripts/test-monthly-report-key.ts
 */
import Module from 'node:module';

process.env.TZ = 'America/Los_Angeles';

const out = console.log.bind(console);

function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}

/** The given members work; any other property is a function that refuses. */
function only(name: string, members: Record<string, unknown>): unknown {
  return new Proxy({ __esModule: true, ...members }, {
    get: (target, prop) => (prop in target
      ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the N123 test`); }),
  });
}

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string, detail?: string): void {
  if (cond) { passes += 1; out(`  ✓ ${msg}`); }
  else      { failures += 1; out(`  ✗ FAIL: ${msg}${detail ? `\n      ${detail}` : ''}`); }
}
function section(title: string): void { out(`\n── ${title}`); }
const fmt = (v: unknown): string => (v === undefined ? 'undefined' : JSON.stringify(v));

// ── frozen clock ────────────────────────────────────────────────────────────
// 2026-09-26 19:00 UTC (12:00 PT): the previous month is August, August has
// ended, September has not.
const RealDate = Date;
const NOW_DEFAULT = RealDate.UTC(2026, 8, 26, 19, 0, 0);
let nowMs = NOW_DEFAULT;
class FrozenDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(nowMs);
    else super(...(args as [number]));
  }
  static now(): number { return nowMs; }
}
(globalThis as any).Date = FrozenDate;

// ── the fake world ──────────────────────────────────────────────────────────

const VISHNU_SUB = '00000000-0000-0000-0000-000000000000';
const ROW_GENERATED_OFFSET_MS = 1234;
const BUCKET_URL = 'https://guard-media-prod.s3.us-east-1.amazonaws.com/';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

interface FakeCompany { id: string; name: string; is_test: boolean }
const companies = new Map<string, FakeCompany>();   // by lowercase id
let activeForCron: string[] = [];                   // what the cron's company query returns
const uploads: Array<{ key: string; mime: string; bytes: number }> = [];
const inserts: Array<{ sql: string; params: unknown[] }> = [];
const builds: Array<{ company_id: string; start_date: string; end_date: string }> = [];
const sentryCalls: Array<{ err: unknown; ctx: any }> = [];
const logEvents: unknown[][] = [];
const failUploadFor = new Set<string>();            // lowercase company ids
function reset(): void {
  uploads.length = 0; inserts.length = 0; builds.length = 0;
  sentryCalls.length = 0; logEvents.length = 0; failUploadFor.clear();
}

function pgError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
/**
 * What a uuid parameter does in Postgres: any case, optional braces, optional
 * hyphens -> the canonical lowercase form; anything else -> 22P02. (Postgres
 * is slightly stricter about where hyphens may fall; no case here depends on it.)
 */
function pgUuid(v: unknown): string {
  const s = String(v).trim();
  const inner = s.startsWith('{') && s.endsWith('}') ? s.slice(1, -1) : s;
  const hex = inner.replace(/-/g, '');
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw pgError('22P02', `invalid input syntax for type uuid: ${fmt(v)}`);
  const h = hex.toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function lookup(v: unknown): FakeCompany | undefined {
  return companies.get(pgUuid(v));
}
/** What an INTEGER parameter does in Postgres: an integer or a digit string, or 22P02. */
function pgInt(v: unknown): number {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\s*-?\d+\s*$/.test(v)) return Number(v);
  throw pgError('22P02', `invalid input syntax for type integer: ${fmt(v)}`);
}
const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

async function fakeQuery(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
  const q = norm(sql);
  if (q === 'SELECT id FROM companies WHERE is_active = true AND is_test = false') {
    return { rows: activeForCron.map((id) => ({ id })) };
  }
  if (q === 'SELECT id, is_test FROM companies WHERE id = $1') {
    const c = lookup(params[0]);
    return { rows: c ? [{ id: c.id, is_test: c.is_test }] : [] };
  }
  if (q.startsWith('INSERT INTO monthly_hours_reports')) {
    const month = pgInt(params[1]);
    pgInt(params[2]);
    if (month < 1 || month > 12) throw pgError('23514', 'violates check constraint on month');
    if (!lookup(params[0])) throw pgError('23503', 'violates foreign key constraint on company_id');
    inserts.push({ sql: q, params });
    // A distinctive instant, so a caller that ignores RETURNING and falls back
    // to new Date() (the frozen nowMs) is caught.
    return { rows: [{ s3_url: params[3], generated_at: new RealDate(nowMs + ROW_GENERATED_OFFSET_MS) }] };
  }
  throw new Error(`fake pool: unexpected SQL: ${q.slice(0, 120)}`);
}

// ── stubs, before anything under test loads ─────────────────────────────────

inject('../src/db/pool', { pool: { query: fakeQuery } });
inject('../src/services/s3', only('s3', {
  uploadBufferToS3: async (key: string, buf: Buffer, mime: string) => {
    for (const id of failUploadFor) {
      if (key.toLowerCase().includes(id)) throw new Error('fake S3: PutObject failed');
    }
    uploads.push({ key, mime, bytes: buf.length });
    return `${BUCKET_URL}${key}`;
  },
  urlOrPresign: async (u: string | null) => (u ? `presigned:${u}` : u),
}));
inject('../src/services/sentry', only('sentry', {
  Sentry: only('Sentry', {
    captureException: (err: unknown, ctx: any) => { sentryCalls.push({ err, ctx }); return 'evt'; },
  }),
}));
inject('../src/services/email', only('email', {}));
inject('../src/services/hoursWorkbook', only('hoursWorkbook', {
  buildHoursWorkbook: () => ({}),
  workbookToBuffer: async () => Buffer.from('fake-xlsx'),
}));
const rolesByMiddleware = new Map<unknown, string[]>();
inject('../src/middleware/auth', only('auth middleware', {
  requireAuth: (...roles: string[]) => {
    const mw = (req: any, _res: unknown, next: () => void) => {
      req.user = { sub: VISHNU_SUB, role: 'vishnu' };
      next();
    };
    rolesByMiddleware.set(mw, roles);
    return mw;
  },
}));
inject('../src/routes/auth', only('routes/auth', {
  logEvent: async (...args: unknown[]) => { logEvents.push(args); },
}));
const jobs: Array<{ name: string; schedule: string; fn: () => Promise<void>; opts: any }> = [];
inject('../src/jobs/_run', only('_run', {
  runJob: (name: string, schedule: string, fn: () => Promise<void>, opts: any) => {
    jobs.push({ name, schedule, fn, opts });
  },
}));

// The real hoursExport module, with only the builder replaced: slugify() and
// the "unknown" name fallback stay what production runs.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const HE: any = require('../src/services/hoursExport');
const realSlugify: (name: string) => string = HE.slugify;
HE.buildHoursExport = async (opts: { company_id: string; start_date: string; end_date: string }) => {
  builds.push({ company_id: opts.company_id, start_date: opts.start_date, end_date: opts.end_date });
  const name = lookup(opts.company_id)?.name ?? 'unknown';
  return { company_id: opts.company_id, company_name: name, company_slug: realSlugify(name), rows: [] };
};

// ── the modules under test ──────────────────────────────────────────────────

let MR: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  MR = require('../src/services/monthlyReport');
} catch (err) {
  out(`(services/monthlyReport.ts did not load: ${String((err as Error).message).split('\n')[0]})`);
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const billing: any = require('../src/routes/billing').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('../src/jobs/monthlyHoursReport');
const job = jobs.find((j) => j.name === 'monthlyHoursReport');

// ── harness ─────────────────────────────────────────────────────────────────

/** Run fn with console.log/error captured instead of printed. */
async function quiet<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: unknown; logs: string[] }> {
  const logs: string[] = [];
  const log = console.log;
  const error = console.error;
  const capture = (...a: unknown[]) => {
    logs.push(a.map((x) => (x instanceof Error ? `Error: ${x.message}` : String(x))).join(' '));
  };
  console.log = capture;
  console.error = capture;
  try {
    return { value: await fn(), logs };
  } catch (err) {
    return { error: err, logs };
  } finally {
    console.log = log;
    console.error = error;
  }
}

function routeLayer(method: 'get' | 'post', path: string): any {
  return billing.stack.find((l: any) => l.route && l.route.path === path && l.route.methods[method]);
}

interface RouteResult { status?: number; body?: any; threw?: unknown; logs: string[] }
async function post(body: unknown): Promise<RouteResult> {
  const layer = routeLayer('post', '/hours-export/schedule');
  if (!layer) throw new Error('POST /hours-export/schedule not found on the billing router');
  const res: any = { statusCode: 200, body: undefined };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (payload: unknown) => { res.body = payload; return res; };
  const req: any = { body, query: {}, params: {}, headers: {}, ip: '127.0.0.1' };
  const r = await quiet(async () => {
    for (const h of layer.route.stack.map((s: any) => s.handle)) {
      let advanced = false;
      await h(req, res, () => { advanced = true; });
      if (!advanced) break;
    }
  });
  return r.error !== undefined
    ? { threw: r.error, logs: r.logs }
    : { status: res.statusCode, body: res.body, logs: r.logs };
}

async function runCron(ids: string[]): Promise<{ logs: string[]; error?: unknown }> {
  if (!job) throw new Error('monthlyHoursReport was not registered');
  activeForCron = ids;
  const r = await quiet(() => job.fn());
  return { logs: r.logs, error: r.error };
}

const uuidFor = (i: number): string => `c0ffee00-0000-4000-8000-${String(i).padStart(12, '0')}`;
function addCompany(i: number, name: string, is_test = false): FakeCompany {
  const c = { id: uuidFor(i), name, is_test };
  companies.set(c.id, c);
  return c;
}

// ── the cases ───────────────────────────────────────────────────────────────

/** [company name, the slug, written out by hand from the slugify rule]. */
const NAMES: Array<[string, string]> = [
  ['STARNET SECURITY',        'starnet-security'],
  ['Star Guard',              'star-guard'],
  ['starnet',                 'starnet'],
  ['A&B Security, Inc.',      'a-b-security-inc'],
  ['24/7 Patrol',             '24-7-patrol'],
  ['911',                     '911'],
  ['  --Weird__Name--  ',     'weird-name'],
  ['Café Sécurité',           'caf-s-curit'],          // non-ASCII letters are separators, not letters
  ['İstanbul Güvenlik',       'i-stanbul-g-venlik'],   // İ lowercases to i + U+0307
  ['!!!',                     'company'],              // empty slug -> the fallback
  ['🛡️🛡️',                   'company'],
  ['',                        'company'],
];

async function main(): Promise<void> {
  out('N123 — one monthly report key for both writers');
  out(`clock frozen at ${new RealDate(nowMs).toISOString()}`);

  section('the cron registration is unchanged');
  check(!!job, 'monthlyHoursReport registers through runJob');
  check(job?.schedule === '0 12 1 * *', `schedule '0 12 1 * *' (got ${fmt(job?.schedule)})`);
  check(job?.opts?.sentryMonitor === false, 'sentryMonitor: false');

  section('the key helper');
  check(MR !== null, 'services/monthlyReport.ts exists and loads');
  if (MR) {
    const STARNET = '27c4d404-8769-49ca-bfd6-93cb9b890067';
    check(
      MR.monthlyReportKey(STARNET, 'starnet-security', 2026, 8)
        === 'monthly-reports/27c4d404-8769-49ca-bfd6-93cb9b890067/netraops-hours-starnet-security-2026-08.xlsx',
      'STARNET August: monthly-reports/27c4d404-…/netraops-hours-starnet-security-2026-08.xlsx',
    );
    check(
      MR.monthlyReportKey(uuidFor(1), '', 2025, 12)
        === `monthly-reports/${uuidFor(1)}/netraops-hours-company-2025-12.xlsx`,
      "an empty slug becomes 'company'",
    );
    const refuses = (label: string, f: () => unknown): void => {
      let err: unknown = null;
      try { f(); } catch (e) { err = e; }
      check(err instanceof MR.MonthlyReportInputError, `refuses ${label}`,
        err ? `threw ${(err as Error).name}` : 'did not throw');
    };
    refuses('an uppercase company id', () => MR.monthlyReportKey(STARNET.toUpperCase(), 'x', 2026, 8));
    refuses('a braced company id', () => MR.monthlyReportKey(`{${STARNET}}`, 'x', 2026, 8));
    refuses('month 0', () => MR.monthlyReportKey(STARNET, 'x', 2026, 0));
    refuses('month 13', () => MR.monthlyReportKey(STARNET, 'x', 2026, 13));
    refuses('month 8.5', () => MR.monthlyReportKey(STARNET, 'x', 2026, 8.5));
    refuses('year 1999', () => MR.monthlyReportKey(STARNET, 'x', 1999, 8));
    refuses('year 10000', () => MR.monthlyReportKey(STARNET, 'x', 10000, 8));
    for (const bad of ['Starnet', 'a--b', '-a', 'a-', 'a/b', '../x', 'café', 'a b']) {
      refuses(`slug ${fmt(bad)}`, () => MR.monthlyReportKey(STARNET, bad, 2026, 8));
    }
    const pm = (iso: string) => MR.previousMonth(new RealDate(iso));
    check(fmt(pm('2026-09-26T19:00:00Z')) === fmt({ year: 2026, month: 8 }), 'previousMonth(2026-09-26) = 2026-08');
    check(fmt(pm('2026-01-01T12:00:00Z')) === fmt({ year: 2025, month: 12 }), 'previousMonth(2026-01-01) = 2025-12');
    check(fmt(pm('2026-09-01T03:00:00Z')) === fmt({ year: 2026, month: 8 }),
      'previousMonth(2026-09-01 03:00 UTC) = 2026-08 in UTC, although it is still Aug 31 in the process zone',
      `got ${fmt(pm('2026-09-01T03:00:00Z'))} (process TZ ${process.env.TZ})`);
    const ended = (y: number, m: number, iso: string) => MR.monthHasEnded(y, m, new RealDate(iso));
    check(ended(2026, 8, '2026-09-01T11:59:59.999Z') === false, 'August has not ended at 11:59:59.999 UTC on Sep 1');
    check(ended(2026, 8, '2026-09-01T12:00:00.000Z') === true,  'August has ended at 12:00:00.000 UTC on Sep 1');
    check(ended(2026, 12, '2027-01-01T12:00:00Z') === true,     'December ends at 12:00 UTC on Jan 1 of the next year');
    check(ended(2026, 9, '2026-09-26T19:00:00Z') === false,     'September has not ended on Sep 26');
    check(fmt(MR.monthRange(2024, 2)) === fmt({ start: '2024-02-01', end: '2024-02-29' }), 'monthRange(2024-02) ends on the 29th');
    check(fmt(MR.monthRange(2026, 8)) === fmt({ start: '2026-08-01', end: '2026-08-31' }), 'monthRange(2026-08) = 08-01..08-31');
  }

  section('both writers, one key — company-name slug edge cases (August 2026)');
  const insertSql = new Set<string>();
  for (let i = 0; i < NAMES.length; i += 1) {
    const [name, slug] = NAMES[i];
    const c = addCompany(100 + i, name);
    const expected = `monthly-reports/${c.id}/netraops-hours-${slug}-2026-08.xlsx`;

    reset();
    const cron = await runCron([c.id]);
    const cronKey = uploads[0]?.key;
    const cronRow = inserts[0]?.params;
    if (inserts[0]) insertSql.add(inserts[0].sql);
    const cronBuild = builds[0];

    reset();
    const route = await post({ company_id: c.id, year: 2026, month: 8 });
    const routeKey = uploads[0]?.key;
    const routeRow = inserts[0]?.params;
    if (inserts[0]) insertSql.add(inserts[0].sql);
    const routeBuild = builds[0];

    check(
      cronKey === expected && routeKey === expected,
      `${fmt(name)} -> …/netraops-hours-${slug}-2026-08.xlsx from BOTH`,
      `cron:  ${fmt(cronKey)}\n      route: ${fmt(routeKey)}${route.threw ? ` (route threw: ${(route.threw as Error).message})` : ''}${cron.error ? ` (cron threw)` : ''}`,
    );
    check(
      fmt(cronRow) === fmt(routeRow) && fmt(routeRow) === fmt([c.id, 8, 2026, `${BUCKET_URL}${expected}`]),
      `  and the same row: (${c.id.slice(0, 8)}…, 8, 2026, that key's URL)`,
      `cron:  ${fmt(cronRow)}\n      route: ${fmt(routeRow)}`,
    );
    if (i === 0) {
      check(
        fmt(cronBuild) === fmt(routeBuild)
          && fmt(routeBuild) === fmt({ company_id: c.id, start_date: '2026-08-01', end_date: '2026-08-31' }),
        '  and the same build range: 2026-08-01..2026-08-31',
        `cron:  ${fmt(cronBuild)}\n      route: ${fmt(routeBuild)}`,
      );
      check(uploads[0]?.mime === XLSX_MIME, '  uploaded as xlsx');
      check(cron.logs.includes(`[monthly-hours] Generated for company ${c.id} 2026-8`),
        "  the cron's log line is unchanged (docs/OPS/CRONS.md)");
    }
  }
  check(insertSql.size === 1, 'both writers issue ONE identical upsert statement', [...insertSql].join('\n      '));
  check([...insertSql][0]?.includes('DO UPDATE SET s3_url = EXCLUDED.s3_url, generated_at = NOW()') ?? false,
    '  which re-sets s3_url and restarts generated_at on conflict');

  section("the company id's spelling does not change the key");
  {
    const c = addCompany(200, 'STARNET SECURITY');
    reset();
    const r = await post({ company_id: c.id.toUpperCase(), year: 2026, month: 8 });
    const expected = `monthly-reports/${c.id}/netraops-hours-starnet-security-2026-08.xlsx`;
    check(uploads[0]?.key === expected, 'an UPPERCASE company_id writes the canonical lowercase key',
      `got ${fmt(uploads[0]?.key)}${r.threw ? ` (threw: ${(r.threw as Error).message})` : ''}`);
    check(inserts[0]?.params[0] === c.id, '  and the row carries the canonical id', `got ${fmt(inserts[0]?.params[0])}`);
    check(builds[0]?.company_id === c.id, '  and so does the workbook (NOTES prints it)', `got ${fmt(builds[0]?.company_id)}`);
  }

  section('month and year in the body');
  {
    const c = addCompany(300, 'Star Guard');
    const k = (y: number, m: string) => `monthly-reports/${c.id}/netraops-hours-star-guard-${y}-${m}.xlsx`;
    for (const [label, body, key] of [
      ['digit strings "8" / "2026"', { company_id: c.id, month: '8', year: '2026' }, k(2026, '08')],
      ['omitted: the previous month', { company_id: c.id }, k(2026, '08')],
      ['2025-12', { company_id: c.id, year: 2025, month: 12 }, k(2025, '12')],
    ] as Array<[string, unknown, string]>) {
      reset();
      const r = await post(body);
      check(r.status === 200 && uploads.length === 1 && uploads[0].key === key, `${label} -> ${key.split('/').pop()}`,
        `status ${fmt(r.status)}, uploads ${fmt(uploads.map((u) => u.key))}${r.threw ? `, threw ${(r.threw as Error).message}` : ''}`);
    }
  }

  section('refused BEFORE any upload, row write or Sentry event');
  {
    const real = addCompany(400, 'Refusal Co');
    const test = addCompany(401, 'Scratch Tenant', true);
    const cases: Array<[string, unknown, number, string]> = [
      ['no company_id',           { year: 2026, month: 8 },                                   400, 'INVALID_COMPANY_ID'],
      ['company_id "not-a-uuid"', { company_id: 'not-a-uuid', year: 2026, month: 8 },          400, 'INVALID_COMPANY_ID'],
      ['a braced company_id',     { company_id: `{${real.id}}`, year: 2026, month: 8 },        400, 'INVALID_COMPANY_ID'],
      ['a numeric company_id',    { company_id: 123, year: 2026, month: 8 },                   400, 'INVALID_COMPANY_ID'],
      ['month 13',                { company_id: real.id, year: 2026, month: 13 },              400, 'INVALID_MONTH'],
      ['month 0',                 { company_id: real.id, year: 2026, month: 0 },               400, 'INVALID_MONTH'],
      ['month 8.5',               { company_id: real.id, year: 2026, month: 8.5 },             400, 'INVALID_MONTH'],
      ['month "aug"',             { company_id: real.id, year: 2026, month: 'aug' },           400, 'INVALID_MONTH'],
      ['month [8]',               { company_id: real.id, year: 2026, month: [8] },             400, 'INVALID_MONTH'],
      ['month {}',                { company_id: real.id, year: 2026, month: {} },              400, 'INVALID_MONTH'],
      ['year 1999',               { company_id: real.id, year: 1999, month: 8 },               400, 'INVALID_MONTH'],
      ['year "2026x"',            { company_id: real.id, year: '2026x', month: 8 },            400, 'INVALID_MONTH'],
      ['2026-09, not yet closed', { company_id: real.id, year: 2026, month: 9 },               409, 'MONTH_NOT_ENDED'],
      ['2027-01, the future',     { company_id: real.id, year: 2027, month: 1 },               409, 'MONTH_NOT_ENDED'],
      ['an unknown company',      { company_id: uuidFor(499), year: 2026, month: 8 },          404, 'COMPANY_NOT_FOUND'],
      ['a test company',          { company_id: test.id, year: 2026, month: 8 },               409, 'TEST_COMPANY'],
    ];
    for (const [label, body, status, code] of cases) {
      reset();
      const r = await post(body);
      const ok = r.status === status && r.body?.code === code && typeof r.body?.error === 'string'
        && uploads.length === 0 && inserts.length === 0 && sentryCalls.length === 0;
      check(ok, `${label} -> ${status} ${code}, nothing written`,
        `got ${r.threw ? `THROW ${(r.threw as Error).message}` : `${fmt(r.status)} ${fmt(r.body)}`}; `
        + `uploads ${uploads.length}, rows ${inserts.length}, sentry ${sentryCalls.length}`);
    }

    // The 12:00 UTC boundary, through the route.
    nowMs = RealDate.UTC(2026, 8, 1, 11, 59, 59, 999);
    reset();
    const before = await post({ company_id: real.id, year: 2026, month: 8 });
    check(before.status === 409 && before.body?.code === 'MONTH_NOT_ENDED' && uploads.length === 0,
      'August at 11:59:59.999 UTC on Sep 1 -> 409, nothing written', `got ${fmt(before.status)}, uploads ${uploads.length}`);
    nowMs = RealDate.UTC(2026, 8, 1, 12, 0, 0, 0);
    reset();
    const at = await post({ company_id: real.id, year: 2026, month: 8 });
    check(at.status === 200 && uploads.length === 1, 'August at 12:00:00.000 UTC on Sep 1 -> 200, written',
      `got ${fmt(at.status)}, uploads ${uploads.length}`);

    // 03:00 UTC on Sep 1 is Aug 31 in the process zone: the default month is
    // still August (UTC), which has not ended — not July, which has.
    nowMs = RealDate.UTC(2026, 8, 1, 3, 0, 0, 0);
    reset();
    const dflt = await post({ company_id: real.id });
    check(dflt.status === 409 && dflt.body?.code === 'MONTH_NOT_ENDED' && uploads.length === 0,
      'month omitted at 03:00 UTC on Sep 1 -> defaults to August (UTC) -> 409, nothing written',
      `got ${fmt(dflt.status)} ${fmt(dflt.body)}, uploads ${fmt(uploads.map((u) => u.key))}`);
    nowMs = NOW_DEFAULT;

    // The cron refuses a test company too, if one ever reaches it.
    reset();
    await runCron([test.id]);
    check(uploads.length === 0 && inserts.length === 0, 'the cron writes nothing for a test company that slips past its filter');
  }

  section('the route: vishnu only, presigned, audited');
  {
    const post_ = routeLayer('post', '/hours-export/schedule');
    const roles = post_ ? rolesByMiddleware.get(post_.route.stack[0].handle) : undefined;
    check(fmt(roles) === fmt(['vishnu']), `POST /hours-export/schedule is requireAuth('vishnu') (got ${fmt(roles)})`);
    for (const p of ['/hours-export', '/hours-export/monthly']) {
      const l = routeLayer('get', p);
      const r = l ? rolesByMiddleware.get(l.route.stack[0].handle) : undefined;
      check(fmt(r) === fmt(['company_admin', 'vishnu']), `GET ${p} unchanged: company_admin + vishnu (got ${fmt(r)})`);
    }
    const c = addCompany(500, 'STARNET SECURITY');
    const key = `monthly-reports/${c.id}/netraops-hours-starnet-security-2026-08.xlsx`;
    reset();
    const r = await post({ company_id: c.id, year: 2026, month: 8 });
    check(r.status === 200 && r.body?.success === true, '200 success');
    check(r.body?.s3_url === `presigned:${BUCKET_URL}${key}`, 's3_url in the response is presigned', `got ${fmt(r.body?.s3_url)}`);
    check(r.body?.month === 8 && r.body?.year === 2026, 'month and year echoed as numbers');
    check(r.body?.generated_at?.getTime?.() === nowMs + ROW_GENERATED_OFFSET_MS,
      "generated_at is the upserted row's (RETURNING), not a fallback", `got ${fmt(r.body?.generated_at)}`);
    check(logEvents.length === 1 && logEvents[0][0] === VISHNU_SUB && logEvents[0][1] === 'vishnu'
      && logEvents[0][2] === 'monthly_report_regenerated',
      "logEvent(vishnu sub, 'vishnu', 'monthly_report_regenerated')", `got ${fmt(logEvents.map((a) => a.slice(0, 3)))}`);
    check(r.logs.includes(`[monthly-hours.regenerated] company=${c.id} month=2026-08 key=${key} by=vishnu`),
      'the [monthly-hours.regenerated] log line names company, month and key', fmt(r.logs));
  }

  section('a failure is reported to Sentry once, with ids and no names');
  {
    const bad = addCompany(600, 'Failing Guard Co');
    const good = addCompany(601, 'Healthy Guard Co');
    const tagsOk = (ctx: any) => ctx?.tags?.company_id === bad.id && ctx?.tags?.report_month === '2026-08';
    const nameFree = (ctx: any) => !/Failing|failing-guard-co/.test(JSON.stringify(ctx ?? {}));

    reset();
    failUploadFor.add(bad.id);
    const cron = await runCron([bad.id, good.id]);
    check(sentryCalls.length === 1, `cron: one Sentry event for the failed company (got ${sentryCalls.length})`);
    check(tagsOk(sentryCalls[0]?.ctx), '  tagged company_id + report_month=2026-08', fmt(sentryCalls[0]?.ctx));
    check(sentryCalls.length > 0 && nameFree(sentryCalls[0]?.ctx), '  and carrying no company name or slug', fmt(sentryCalls[0]?.ctx));
    check(uploads.length === 1 && uploads[0].key.includes(good.id), 'cron: the next company is still written');
    check(cron.logs.some((l) => l.startsWith(`[monthly-hours] Failed for company ${bad.id}:`)), "cron: the failure's log line is unchanged");
    check(cron.error === undefined, 'cron: the job itself does not throw (the heartbeat is unchanged)');

    reset();
    failUploadFor.add(bad.id);
    const r = await post({ company_id: bad.id, year: 2026, month: 8 });
    check(r.threw !== undefined, 'route: the error propagates (express-async-errors answers 500)');
    check(sentryCalls.length === 1 && tagsOk(sentryCalls[0]?.ctx) && nameFree(sentryCalls[0]?.ctx),
      'route: one Sentry event, same tags, no name', fmt(sentryCalls.map((s) => s.ctx)));
    check(inserts.length === 0 && logEvents.length === 0, 'route: no row written, nothing audited as regenerated');
  }

  section('nothing left the machine');
  {
    const OFF_MACHINE = /node_modules\/(?:aws-sdk|@aws-sdk|@smithy|pg|pg-pool|@sentry|@sendgrid|exceljs|firebase-admin)\//;
    // Control: the pattern must match where these packages really install
    // (require.resolve finds the path without loading anything), or the check
    // below could never fail. aws-sdk v2 is the SDK services/s3.ts imports.
    const unmatched: string[] = [];
    for (const pkg of ['aws-sdk', 'pg', 'pg-pool', '@sentry/node', '@sendgrid/mail', 'exceljs', 'firebase-admin']) {
      let p = '';
      try { p = require.resolve(pkg); } catch { p = `${pkg}: not resolvable`; }
      if (!OFF_MACHINE.test(p)) unmatched.push(p);
    }
    check(unmatched.length === 0, 'control: the pattern matches the installed path of every package it names',
      unmatched.join('\n      '));
    const loaded = Object.keys(require.cache).filter((k) => OFF_MACHINE.test(k));
    check(loaded.length === 0, 'no AWS, pg, Sentry, SendGrid, ExcelJS or Firebase module was loaded',
      loaded.slice(0, 5).join('\n      '));
  }

  out(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  out('CRASH:', err);
  process.exit(2);
});
