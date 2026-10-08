/**
 * test-letterhead-b1.ts — the company letterhead on the admin surfaces (Phase B, stage B1).
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-letterhead-b1.ts     (from apps/api)
 *
 * Needs poppler (pdftotext, pdfimages) and git: the "before" side of every
 * identity check is the file as it was at BASE (main before B1), read from
 * git and compiled beside the current one, so its relative imports resolve to
 * the same dependencies. LOCAL DATABASES ONLY; fake data on Star Guard's id
 * and on a second, invented company. Sentry, email and S3 are stubbed.
 *
 * ── WITH NO LETTERHEAD, NOTHING CHANGES ────────────────────────────────────
 * A letterhead lookup that fails returns null (services/letterhead never
 * throws), and every surface then has to produce exactly what it produced at
 * BASE. Each identity check below compares bytes under a frozen clock, and
 * each has a control that shows the comparison can fail.
 *
 *   T  contactLines() moved from letterhead/pdf.ts to letterhead/text.ts
 *   A  #1 Activity Logs PDF (services/pdf/activityLog.ts, POST /api/admin/activity-log/pdf)
 *   B  #4 billing hours XLSX and #5 the monthly archive (services/hoursWorkbook.ts,
 *      GET /api/billing/hours-export, generateMonthlyReport)
 *   C  #6 analytics CSV (GET /api/exports/analytics/csv; the base route itself, read from
 *      git, is mounted beside the current one)
 *
 * Then what each surface does WITH a letterhead: the tenant's own (never
 * another's), every line of it, and nothing else on the page moved.
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
import { pngImage, pngCorruptAfterHeader, jpegCorruptAfterHeader } from './image-fixtures';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** main before B1: PR #95's merge. Every "before" is read from here. */
const BASE = '09791ddc9326ffd1bb0639c6835819dafeaebd67';
const T0 = '2026-10-07T19:00:00Z';
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
/** A well-formed company id that no row has: its letterhead lookup returns null. */
const NO_SUCH_COMPANY = '00000000-0000-4000-8000-00000000b1b1';
const JWT_SECRET = 'test-only-letterhead-b1';
const S3_HOST = 'test-bucket.s3.us-east-1.amazonaws.com';

const VISHNU_SECRET = 'test-only-letterhead-b1-vishnu';

process.env.JWT_SECRET = JWT_SECRET;
process.env.VISHNU_JWT_SECRET = VISHNU_SECRET;

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
      : () => { throw new Error(`${name}.${String(prop)} called in the B1 letterhead test`); }),
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

// A harness that stops before its last check must not pass: an await that never
// settles drains the event loop, and Node would then exit 0 having printed nothing.
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

// ── the clock ──────────────────────────────────────────────────────────────
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

// ── the "before" side ──────────────────────────────────────────────────────
/**
 * `apps/api/<rel>` as it was at BASE (or that source run through `edit`),
 * compiled as a fresh module under the CURRENT file's path. It is not put in
 * require.cache: nothing else sees it, and its own requires resolve exactly as
 * the current file's do.
 */
function loadBase(rel: string, edit?: (src: string) => string): any {
  const file = path.join(__dirname, '..', rel);
  const src = execFileSync('git', ['show', `${BASE}:apps/api/${rel}`], { encoding: 'utf8' });
  const edited = edit ? edit(src) : src;
  if (edit && edited === src) throw new Error(`loadBase(${rel}): the edit changed nothing`);
  const js = ts.transpileModule(edited, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}

// ── letterheads ────────────────────────────────────────────────────────────
const LOGO = pngImage(400, 160);
const FULL = {
  companyName: 'Star Guard', contactEmail: 'dispatch@starguard.example', phone: '(408) 555-0142',
  address: '1200 Example Avenue, Suite 300\nSan Jose, CA 95110', licenceNumber: 'PPO 120456',
  website: 'https://www.starguard.example/', logo: LOGO,
};
const EMPTY = { companyName: 'Star Guard', contactEmail: null, phone: null, address: null, licenceNumber: null, website: null, logo: null };
const LONG = {
  companyName: 'Star Guard Protective Services & Event Security of Northern California, LLC',
  contactEmail: 'after-hours-dispatch-and-scheduling@starguard-protective-services.example', phone: '+1 (408) 555-0142 ext. 2201',
  address: '1200 Example Avenue, Building C, Suite 300, Attn: Operations Desk\nSan Jose, CA 95110-1234',
  licenceNumber: 'PPO 120456 / ALARM ACO 7781 / PI 29981', website: 'https://www.starguard-protective-services.example/locations', logo: LOGO,
};

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

/** A deterministic HoursExportDataset: `days` days from `start`, three guards on two sites. */
function hoursFixture(start: string, days: number): any {
  const guards = [['g1', 'Fixture Guard A', 'GRD9801'], ['g2', 'Fixture Guard B', 'GRD9802'], ['g3', 'Fixture Guard C', 'GRD9803']];
  const sites = [['s1', 'North Gate'], ['s2', 'South Lot']];
  const pad = (n: number) => String(n).padStart(2, '0');
  const label = (ms: number) => { const d = new RealDate(ms - 7 * 3600e3); return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00`; };
  const rows: any[] = [];
  const t0 = RealDate.parse(`${start}T15:00:00Z`);
  for (let d = 0; d < days; d++) guards.forEach(([gid, gname, badge], gi) => {
    const [sid, sname] = sites[gi % 2];
    const ss = t0 + d * 86400e3 + gi * 3600e3;
    const se = ss + 8 * 3600e3;
    const late = gi === 1 && d % 3 === 0 ? 50 : 0;
    const ci = ss + late * 60e3;
    const co = se - (gi === 0 && d % 4 === 0 ? 120 : 0) * 60e3;
    const hours = (co - ci) / 3600e3;
    const cov = Math.round(hours / 8 * 1000) / 10;
    const date = new RealDate(ci - 7 * 3600e3).toISOString().slice(0, 10);
    rows.push({ guard_id: gid, guard_name: gname, badge_number: badge, site_id: sid, site_name: sname, site_timezone: 'America/Los_Angeles',
      shift_id: `sh-${d}-${gi}`, session_id: `ss-${d}-${gi}`, shift_date: date, shift_date_label: label(ci).split(', ')[0], day_of_week: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new RealDate(ci - 7 * 3600e3).getUTCDay()],
      sched_start_iso: new RealDate(ss).toISOString(), sched_start_label: label(ss), sched_end_iso: new RealDate(se).toISOString(), sched_end_label: label(se),
      clock_in_iso: new RealDate(ci).toISOString(), clock_in_label: label(ci), clock_out_iso: new RealDate(co).toISOString(), clock_out_label: label(co),
      scheduled_hours: 8, actual_hours: +hours.toFixed(2), payable_hours: +hours.toFixed(2), break_hours: 0.5, offpost_hours: 0,
      variance_hours: +(hours - 8).toFixed(2), coverage_pct: cov, flags: cov < 80 ? ['SHORT'] : [] });
  });
  const agg = (sel: any[], g?: string[], st?: string[]) => {
    const sum = (k: string) => +sel.reduce((a, r) => a + r[k], 0).toFixed(2);
    const sch = sum('scheduled_hours'); const pay = sum('payable_hours');
    return { guard_id: g?.[0] ?? null, guard_name: g?.[1] ?? null, badge_number: g?.[2] ?? null, site_id: st?.[0] ?? null, site_name: st?.[1] ?? null,
      label: 'x', sessions: sel.length, shifts: sel.length, scheduled_hours: sch, actual_hours: sum('actual_hours'), payable_hours: pay,
      break_hours: sum('break_hours'), offpost_hours: 0, variance_hours: +(pay - sch).toFixed(2), coverage_pct: sch ? Math.round(pay / sch * 1000) / 10 : null,
      auto_closed_sessions: 0, flagged_count: sel.filter((r) => r.flags.length).length };
  };
  const end = new RealDate(RealDate.parse(`${start}T12:00:00Z`) + 6 * 86400e3).toISOString().slice(0, 10);
  return { company_id: STAR_GUARD, company_name: 'Star Guard', company_slug: 'star-guard', start_date: start, end_date: end, rows,
    by_guard: guards.map((g) => agg(rows.filter((r) => r.guard_id === g[0]), g)),
    by_site: sites.map((st) => agg(rows.filter((r) => r.site_id === st[0]), undefined, st)),
    by_guard_site: guards.map((g, gi) => agg(rows.filter((r) => r.guard_id === g[0]), g, sites[gi % 2])),
    overall: agg(rows) };
}

async function main(): Promise<void> {
  refuseUnlessLocal();
  if (spawnSync('pdftotext', ['-v']).status !== 0 || spawnSync('pdfimages', ['-v']).status !== 0) {
    console.error('poppler (pdftotext, pdfimages) is required.');
    process.exit(2);
  }
  const sentry: Array<{ what: unknown; ctx: any }> = [];
  inject('../src/services/sentry', {
    Sentry: {
      captureMessage: (what: unknown, ctx: unknown) => { sentry.push({ what, ctx }); return 'evt'; },
      captureException: (what: unknown, ctx: unknown) => { sentry.push({ what, ctx }); return 'evt'; },
      addBreadcrumb: () => undefined,
    },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  // The letterhead reads the logo through these three; nothing else may touch S3.
  class S3ObjectTooLargeError extends Error {}
  const s3Objects = new Map<string, Buffer>();
  const s3Fetches: string[] = [];
  const s3Uploads: Array<{ key: string; buf: Buffer; mime: string }> = [];
  inject('../src/services/s3', stubModule('s3', {
    S3ObjectTooLargeError,
    s3KeyFromPublicUrl: (url: string): string | null => {
      try {
        const u = new URL(url);
        if (u.hostname !== S3_HOST) return null;
        const key = u.pathname.replace(/^\//, '');
        return key.length > 0 ? key : null;
      } catch { return null; }
    },
    uploadBufferToS3: async (key: string, buf: Buffer, mime: string) => {
      s3Uploads.push({ key, buf, mime });
      return `https://${S3_HOST}/${key}`;
    },
    getS3ObjectBuffer: async (key: string) => {
      s3Fetches.push(key);
      const b = s3Objects.get(key);
      if (!b) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey', statusCode: 404 });
      return b;
    },
  }));
  const PDFDocument = (await import('pdfkit')).default;
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'letterhead-b1-'));
  const file = (buf: Buffer, name: string) => { const f = path.join(TMP, name); fs.writeFileSync(f, buf); return f; };
  // Whitespace collapsed: pdftotext's spacing between words is not stable, the words are.
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  const pdfPages = (f: string) => Number(execFileSync('pdfinfo', [f], { encoding: 'utf8' }).match(/^Pages:\s+(\d+)/m)?.[1]);
  const pageText = (f: string, p: number) => flat(execFileSync('pdftotext', ['-f', String(p), '-l', String(p), f, '-'], { encoding: 'utf8' }));
  const words = (f: string, p: number) => {
    const html = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-bbox', f, '-'], { encoding: 'utf8' });
    return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], w: m[5] }));
  };
  // Image rows only: an RGBA logo also lists an `smask` row, and both say "image" in the enc column.
  const imgs = (f: string) => execFileSync('pdfimages', ['-list', f], { encoding: 'utf8' }).split('\n').slice(2)
    .map((l) => l.trim().split(/\s+/)).filter((c) => c[2] === 'image');
  // The page count is drawn "1 / 2"; pdftotext joins it to "1/2", so it is matched either way.
  const pageCount = (t: string, n: number, of: number) => new RegExp(`(^|\\s)${n} ?/ ?${of}(\\s|$)`).test(t);

  /** A one-page document drawn with a letterhead module's header and footer. */
  async function letterheadPage(mod: any, lh: unknown): Promise<Buffer> {
    const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    mod.drawLetterheadHeader(doc, 'ACTIVITY LOGS', 1, 1, lh);
    mod.drawLetterheadFooter(doc, 'All sites  |  01/10/2026 – 07/10/2026', lh);
    doc.end();
    await done;
    return Buffer.concat(chunks);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section(`T  contactLines() moved to letterhead/text.ts: the letterhead PDF is the same bytes as at ${BASE.slice(0, 7)}`);
  {
    const { contactLines } = await import('../src/services/letterhead/text');
    check(JSON.stringify(contactLines(FULL as never)) === JSON.stringify([
      '1200 Example Avenue, Suite 300, San Jose, CA 95110',
      '(408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example',
      'License No. PPO 120456',
    ]), 'T1 contactLines: address on one line; phone · email · website (protocol and trailing slash dropped); License No.');
    check(contactLines(EMPTY as never).length === 0
      && JSON.stringify(contactLines({ ...EMPTY, contactEmail: 'a@b.example' } as never)) === '["a@b.example"]',
      'T2 contactLines skips every empty line: an empty profile has none; one field gives one line');
    const base = loadBase('src/services/letterhead/pdf.ts');
    const current = require('../src/services/letterhead/pdf');
    check(!String(base.drawLetterheadHeader).includes('text_1') && String(current.drawLetterheadHeader).includes('text_1.contactLines'),
      'T3 the base is the pre-move pdf.ts (contactLines inline), the current one calls it from text.ts');
    for (const [label, lh] of [['full profile with logo', FULL], ['empty profile', EMPTY], ['every field at an extreme length', LONG]] as const) {
      const before = await frozen(() => letterheadPage(base, lh));
      const after = await frozen(() => letterheadPage(current, lh));
      check(before.equals(after), `T4 ${label}: ${sha(before)} = ${sha(after)} (${after.length} bytes)`);
    }
    const mutant = loadBase('src/services/letterhead/pdf.ts', (s) => s.replace('`License No. ${lh.licenceNumber}`', '`License No: ${lh.licenceNumber}`'));
    const m = await frozen(() => letterheadPage(mutant, FULL));
    check(!m.equals(await frozen(() => letterheadPage(current, FULL))), 'T5 control: the base with one character of the licence line changed DIFFERS');
  }

  // ══ the database: Star Guard and an invented second company, fake data, local only ══
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  await import('express-async-errors');
  const express = (await import('express')).default;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `lhb1-${RealDate.now().toString(36)}`;
  const seeded: Record<string, string[]> = {
    reports: [], location_pings: [], shift_sessions: [], shifts: [], guards: [], sites: [], company_admins: [], companies: [],
  };
  const ins = async (table: string, sql: string, params: unknown[]) => {
    const id = (await q(sql, params)).rows[0].id as string;
    seeded[table].push(id);
    return id;
  };
  // Star Guard's row is created when this database has none, and its profile is put back either way.
  const PROFILE = ['contact_email', 'phone', 'address', 'licence_number', 'website', 'logo_url', 'logo_updated_at'];
  const priorStarGuard = (await q(`SELECT ${PROFILE.join(', ')} FROM companies WHERE id = $1`, [STAR_GUARD])).rows[0] ?? null;
  if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
  const logoKey = `company-logos/${STAR_GUARD}/${marker}.png`;
  s3Objects.set(logoKey, LOGO);
  await q(`UPDATE companies SET contact_email = $2, phone = $3, address = $4, licence_number = $5, website = $6,
             logo_url = $7, logo_updated_at = $8 WHERE id = $1`,
    [STAR_GUARD, FULL.contactEmail, FULL.phone, FULL.address, FULL.licenceNumber, FULL.website,
     `https://${S3_HOST}/${logoKey}`, new RealDate('2026-10-07T18:00:00Z')]);
  const OTHER_NAME = `Fixture Patrol ${marker}`;
  const other = await ins('companies', 'INSERT INTO companies (name) VALUES ($1) RETURNING id', [OTHER_NAME]);
  const mkAdmin = (companyId: string, tag: string) => ins('company_admins',
    `INSERT INTO company_admins (company_id, name, email, password_hash, is_primary) VALUES ($1, $2, $3, 'x', true) RETURNING id`,
    [companyId, `${marker} ${tag}`, `${marker}-${tag}@test.invalid`]);
  const adminA = await mkAdmin(STAR_GUARD, 'admin-a');
  const adminB = await mkAdmin(other, 'admin-b');
  const site = await ins('sites', `INSERT INTO sites (company_id, name, address, contract_start)
    VALUES ($1, $2, '1200 Example Avenue, San Jose', '2026-01-01') RETURNING id`, [STAR_GUARD, `${marker} North Gate`]);
  const guard = await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
    VALUES ($1, 'Fixture Guard A', $2, 'x', 'GRD9801') RETURNING id`, [STAR_GUARD, `${marker}-g@test.invalid`]);
  // One completed shift, 08:00-16:00 PT on 2026-09-15, with two pings and an activity report.
  const shiftStart = new RealDate('2026-09-15T15:00:00Z');
  const at = (min: number) => new RealDate(shiftStart.getTime() + min * 60e3);
  const shift = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
    VALUES ($1, $2, $3, $4, 'completed') RETURNING id`, [site, guard, shiftStart, at(480)]);
  const sess = await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords)
    VALUES ($1, $2, $3, $4, $5, '37.33,-121.89') RETURNING id`, [shift, guard, site, at(2), at(477)]);
  for (const min of [31, 62]) {
    await ins('location_pings', `INSERT INTO location_pings (shift_session_id, guard_id, site_id, latitude, longitude,
        is_within_geofence, ping_type, photo_delete_at, pinged_at)
      VALUES ($1, $2, $3, 37.33, -121.89, true, 'gps_only', $4, $5) RETURNING id`, [sess, guard, site, at(60 * 24 * 90), at(min)]);
  }
  await ins('reports', `INSERT INTO reports (shift_session_id, site_id, report_type, description, reported_at)
    VALUES ($1, $2, 'activity', 'Perimeter checked, gate secured, lobby clear.', $3) RETURNING id`, [sess, site, at(130)]);

  const hadMonthlyRow = (await q('SELECT 1 FROM monthly_hours_reports WHERE company_id = $1 AND year = 2026 AND month = 9', [STAR_GUARD])).rowCount > 0;

  // ══ the real routers over HTTP ══
  const app = express();
  app.use(express.json());
  app.use('/api/admin', (await import('../src/routes/admin')).default);
  app.use('/api/billing', (await import('../src/routes/billing')).default);
  app.use('/api/exports', (await import('../src/routes/exports')).default);
  app.use('/api/exports-base', loadBase('src/routes/exports.ts').default);
  app.use('/api/exports-mutant', loadBase('src/routes/exports.ts', (src) => src.replace("sections.push('GUARD HOURS\\n' + rowsToCsv(", "sections.push('GUARD HOURS \\n' + rowsToCsv(")).default);
  const server: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const adminToken = (sub: string, companyId: string) =>
    jwt.sign({ sub, role: 'company_admin', company_id: companyId, is_primary: true }, JWT_SECRET, { expiresIn: '1h' });
  const vishnuToken = jwt.sign({ sub: 'vishnu-fixture', role: 'vishnu' }, VISHNU_SECRET, { expiresIn: '1h' });
  async function call(method: string, pathname: string, token: string, body?: unknown) {
    const r = await fetch(`${origin}${pathname}`, {
      method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, type: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition') ?? '', body: Buffer.from(await r.arrayBuffer()) };
  }

  try {
    // ══════════════════════════════════════════════════════════════════════════
    section(`A  #1 Activity Logs PDF — no letterhead: the same bytes as at ${BASE.slice(0, 7)}; with one: the tenant's, and nothing else moves`);
    const fx = await import('../src/services/pdf/_activityLogFixture');
    const baseAL = loadBase('src/services/pdf/activityLog.ts');
    const curAL = require('../src/services/pdf/activityLog');
    check(!/\blh\b/.test(String(baseAL.renderActivityLogPdf)) && /\blh\b/.test(String(curAL.renderActivityLogPdf)),
      'A0 the base renderer predates the letterhead; the current one takes it');
    for (const [label, rows, meta] of [
      ['multi-page fixture', fx.FIXTURE_ROWS, fx.FIXTURE_META],
      ['one page, shift-scoped', fx.FIXTURE_ROWS_ONE_PAGE, fx.FIXTURE_META_WITH_SHIFT],
    ] as const) {
      const before = await frozen<Buffer>(() => baseAL.renderActivityLogPdf([...rows], { ...meta }));
      const absent = await frozen<Buffer>(() => curAL.renderActivityLogPdf([...rows], { ...meta }));
      const nul = await frozen<Buffer>(() => curAL.renderActivityLogPdf([...rows], { ...meta, lh: null }));
      check(before.equals(absent) && before.equals(nul),
        `A1 ${label}: base ${sha(before)} = lh absent ${sha(absent)} = lh null ${sha(nul)} (${pdfPages(file(nul, `a1-${rows.length}.pdf`))} pages)`);
    }
    {
      const mutant = loadBase('src/services/pdf/activityLog.ts', (src) => src.replace(".text('Activity Logs', ML, y);", ".text('Activity Logs', ML, y + 1);"));
      const m = await frozen<Buffer>(() => mutant.renderActivityLogPdf([...fx.FIXTURE_ROWS], { ...fx.FIXTURE_META }));
      const c = await frozen<Buffer>(() => curAL.renderActivityLogPdf([...fx.FIXTURE_ROWS], { ...fx.FIXTURE_META }));
      check(!m.equals(c), 'A2 control: the base with its title 1 pt lower DIFFERS');
    }
    const plain = await frozen<Buffer>(() => curAL.renderActivityLogPdf([...fx.FIXTURE_ROWS], { ...fx.FIXTURE_META }));
    const withLh = await frozen<Buffer>(() => curAL.renderActivityLogPdf([...fx.FIXTURE_ROWS], { ...fx.FIXTURE_META, lh: FULL }));
    const fp = file(plain, 'a-plain.pdf');
    const fl = file(withLh, 'a-letterhead.pdf');
    const n = pdfPages(fl);
    check(!withLh.equals(plain) && n === pdfPages(fp) && n >= 2, `A3 with a letterhead the document differs and keeps its page count (${n})`);
    {
      const missing: string[] = [];
      for (let p = 1; p <= n; p++) {
        const t = pageText(fl, p);
        for (const want of ['Star Guard', '1200 Example Avenue, Suite 300, San Jose, CA 95110',
          '(408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example', 'License No. PPO 120456',
          'ACTIVITY LOGS', `${fx.FIXTURE_META.siteLabel}  |`, 'Confidential — Star Guard', 'Powered by NetraOps']) {
          if (!t.includes(flat(want))) missing.push(`p${p} "${want}"`);
        }
        if (!pageCount(t, p, n)) missing.push(`p${p} "${p} / ${n}"`);
        if (/SECURITY MANAGEMENT|Confidential — NetraOps/.test(t)) missing.push(`p${p} still carries NetraOps chrome`);
      }
      check(missing.length === 0, `A4 every page: the company, its three contact lines, ACTIVITY LOGS, "n / ${n}", "<site>  |  <period>  |  Confidential — Star Guard", Powered by NetraOps; no NetraOps chrome (${missing.join('; ') || 'nothing missing'})`);
    }
    {
      const li = imgs(fl);
      check(li.length === n && new Set(li.map((c) => c[10])).size === 1 && imgs(fp).length === 0,
        `A5 one embedded logo object, drawn on each of the ${n} pages (pdfimages: ${li.map((c) => `p${c[0]} obj ${c[10]}`).join(', ')})`);
    }
    {
      let moved = 0;
      let compared = 0;
      for (let p = 1; p <= n; p++) {
        // Sorted: pdftotext's reading order between equal-looking pages is not stable; text and place are.
        const body = (f: string) => words(f, p).filter((w) => w.y0 >= 75 && w.y1 <= 842 - 30)
          .map((w) => `${w.w}@${w.x0.toFixed(2)},${w.y0.toFixed(2)}`).sort();
        const a = body(fp);
        compared += a.length;
        if (a.join('|') !== body(fl).join('|')) moved += 1;
      }
      check(moved === 0 && compared > 100, `A6 the body did not move: ${compared} words on ${n} pages, the same text at the same place with and without the letterhead (${moved} pages differ)`);
    }
    {
      const hw = words(fl, 1).filter((w) => w.y0 < 80);
      const outside = hw.filter((w) => w.y1 > 70 || w.x0 < 0 || w.x1 > 595 - 50 + 0.5);
      const overlaps: string[] = [];
      for (let i = 0; i < hw.length; i++) for (let j = i + 1; j < hw.length; j++) {
        const a = hw[i]; const b = hw[j];
        if (a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5) overlaps.push(`${a.w}/${b.w}`);
      }
      check(hw.length > 10 && outside.length === 0 && overlaps.length === 0,
        `A7 page 1 header: ${hw.length} words, all inside x 0..545 y 0..70, none overlapping (outside ${outside.map((w) => w.w).join(' ') || 'none'}; overlaps ${overlaps.join(' ') || 'none'})`);
    }
    // ── the route ──
    const from = '2026-09-15T07:00:00.000Z';
    const to = '2026-09-16T06:59:59.999Z';
    {
      const r = await frozen(() => call('POST', '/api/admin/activity-log/pdf', adminToken(adminA, STAR_GUARD), { from, to }));
      const f = file(r.body, 'a-route-star-guard.pdf');
      const t = r.status === 200 ? pageText(f, 1) : r.body.toString().slice(0, 200);
      check(r.status === 200 && r.type.startsWith('application/pdf') && t.includes('Star Guard')
        && t.includes('License No. PPO 120456') && t.includes('Powered by NetraOps') && t.includes('Perimeter checked')
        && imgs(f).length === pdfPages(f),
        `A8 POST /api/admin/activity-log/pdf as Star Guard's admin: 200, its rows under Star Guard's letterhead and logo (${r.status}: ${t.slice(0, 80)})`);
      check(s3Fetches.includes(logoKey) && !sentry.some((e) => /letterhead/.test(String(e.what))),
        `A8b the logo was read from Star Guard's own key, and no letterhead warning was sent (fetches ${s3Fetches.length}, sentry ${sentry.length})`);
    }
    {
      const r = await frozen(() => call('POST', '/api/admin/activity-log/pdf', adminToken(adminB, other), { from, to }));
      const f = file(r.body, 'a-route-other.pdf');
      const t = r.status === 200 ? pageText(f, 1) : '';
      check(r.status === 200 && t.includes(OTHER_NAME) && !t.includes('Star Guard') && !t.includes('License No.')
        && !t.includes('Perimeter checked') && imgs(f).length === 0,
        `A9 as the other company's admin: its own name and no logo; nothing of Star Guard's (${r.status})`);
    }
    {
      // requireAuth re-reads the ADMIN row, not the company, so a token naming a company with no row
      // reaches the handler: no rows, and a letterhead lookup that returns null.
      const r = await frozen(() => call('POST', '/api/admin/activity-log/pdf', adminToken(adminA, NO_SUCH_COMPANY), { from, to }));
      const expected = await frozen<Buffer>(() => baseAL.renderActivityLogPdf([], { siteLabel: 'All sites', fromIso: from, toIso: to }));
      check(r.status === 200 && r.body.equals(expected),
        `A10 a company with no row: the lookup returns null and the route's PDF is the base renderer's, byte for byte (${sha(r.body)} = ${sha(expected)})`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    section(`B  #4/#5 hours XLSX — no letterhead: the same bytes as at ${BASE.slice(0, 7)}; with one: the block, the print chrome, nothing else moved`);
    const ExcelJS = (await import('exceljs')).default;
    const loadXlsx = async (buf: Buffer) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as never); return wb; };
    const baseWB = loadBase('src/services/hoursWorkbook.ts');
    const curWB = require('../src/services/hoursWorkbook');
    const xlsx = (mod: any, data: unknown, ...lh: unknown[]) => frozen<Buffer>(() => mod.workbookToBuffer(mod.buildHoursWorkbook(data, ...lh)));
    const week = hoursFixture('2026-09-14', 7);
    const empty = { ...hoursFixture('2026-09-14', 0), end_date: '2026-09-20' };
    check(!String(baseWB.buildHoursWorkbook).includes('writeLetterheadBlock') && String(curWB.buildHoursWorkbook).includes('writeLetterheadBlock'),
      'B0 the base workbook predates the letterhead; the current one writes it');
    for (const [label, data] of [['a week, three guards, two sites', week], ['no rows', empty]] as const) {
      const before = await xlsx(baseWB, data);
      const absent = await xlsx(curWB, data);
      const nul = await xlsx(curWB, data, null);
      check(before.equals(absent) && before.equals(nul), `B1 ${label}: base ${sha(before)} = lh absent ${sha(absent)} = lh null ${sha(nul)} (${nul.length} bytes)`);
    }
    {
      const mutant = loadBase('src/services/hoursWorkbook.ts', (src) => src.replace("s.addRow(['NetraOps — Hours Report']).font = { bold: true, size: 16,", "s.addRow(['NetraOps — Hours Report']).font = { bold: true, size: 15,"));
      check(!(await xlsx(mutant, week)).equals(await xlsx(curWB, week)), 'B2 control: the base with its title one point smaller DIFFERS');
    }
    const wbNull = await loadXlsx(await xlsx(curWB, week, null));
    const wbFull = await loadXlsx(await xlsx(curWB, week, FULL));
    const S = wbFull.getWorksheet('SUMMARY')!;
    const cell = (ws: any, addr: string) => ws.getCell(addr).value;
    check(cell(S, 'A1') === null && cell(S, 'B1') === 'Star Guard' && cell(S, 'B2') === '1200 Example Avenue, Suite 300, San Jose, CA 95110'
      && cell(S, 'B3') === '(408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example' && cell(S, 'B4') === 'License No. PPO 120456'
      && (S.getCell('B1').font as any)?.bold === true && (S.getCell('B1').font as any)?.size === 16,
      'B3 SUMMARY rows 1-4: column A left to the logo; the name (bold 16) and the three contact lines in column B');
    check(String(cell(S, 'A5')) === 'Hours Report   ·   Period 14-Sep-26 to 20-Sep-26' && cell(S, 'K5') === 'Powered by NetraOps'
      && cell(S, 'A6') === null && cell(S, 'A7') === 'Shifts',
      `B4 row 5 "Hours Report · Period …" with "Powered by NetraOps" at K5; the KPI header at row 7 (A5 ${JSON.stringify(cell(S, 'A5'))})`);
    const rowsFrom = (ws: any, first: number) => { const out: string[] = []; ws.eachRow({ includeEmpty: true }, (row: any, n: number) => { if (n >= first) out.push(JSON.stringify(row.values)); }); return out; };
    {
      const a = rowsFrom(S, 7);
      const b = rowsFrom(wbNull.getWorksheet('SUMMARY'), 4);
      check(a.length > 20 && a.join('\n') === b.join('\n'), `B5 SUMMARY from the KPI row down is the null workbook's, three rows lower (${a.length} rows)`);
      for (const name of ['HOURS DETAIL', 'EXCEPTIONS', 'NOTES']) {
        const x = rowsFrom(wbFull.getWorksheet(name), 1);
        check(x.length > 1 && x.join('\n') === rowsFrom(wbNull.getWorksheet(name), 1).join('\n'), `B6 ${name}: every row the same as without the letterhead (${x.length} rows)`);
      }
    }
    {
      const media = (wbFull as any).model.media as Array<{ extension: string }>;
      const pics = S.getImages();
      const r = pics[0]?.range as any;
      const w = r?.ext?.width; const h = r?.ext?.height;
      check(media.length === 1 && media[0].extension === 'png' && pics.length === 1 && r.tl.nativeCol === 0 && r.tl.nativeRow === 0
        && w <= 147 && h <= 61 && Math.abs(w / h - 400 / 160) < 0.05,
        `B7 one picture, the logo, anchored in A1 inside the 147 x 61 px box with its aspect kept (${media.length} media, ${w} x ${h} px)`);
    }
    {
      const heads: string[] = [];
      let ok = 0;
      wbFull.eachSheet((ws: any) => {
        heads.push(ws.name);
        if (ws.headerFooter.oddHeader === '&L&BStar Guard&RHours Report'
          && ws.headerFooter.oddFooter === '&L&8Confidential — Star Guard&C&8Page &P of &N&R&8Powered by NetraOps') ok += 1;
      });
      let none = 0;
      wbNull.eachSheet((ws: any) => { if (!ws.headerFooter?.oddHeader && !ws.headerFooter?.oddFooter) none += 1; });
      check(ok === 4 && none === 4, `B8 all 4 sheets print with "Star Guard | Hours Report" and "Confidential — Star Guard | Page n of N | Powered by NetraOps"; none without a letterhead (${heads.join(', ')})`);
      check(wbFull.company === 'Star Guard' && !wbNull.company, `B8b the file's Company property is the company, and blank without a letterhead (${JSON.stringify(wbNull.company)})`);
    }
    {
      const noLogo = await loadXlsx(await xlsx(curWB, week, { ...FULL, logo: null }));
      const s1 = noLogo.getWorksheet('SUMMARY')!;
      check(cell(s1, 'A1') === 'Star Guard' && cell(s1, 'A4') === 'License No. PPO 120456' && cell(s1, 'B1') === null
        && (noLogo as any).model.media.length === 0 && s1.getImages().length === 0, 'B9 logo null: no picture, and the text starts in column A');
      const emptyLh = await loadXlsx(await xlsx(curWB, week, EMPTY));
      const s2 = emptyLh.getWorksheet('SUMMARY')!;
      check(cell(s2, 'A1') === 'Star Guard' && cell(s2, 'A2') === null && cell(s2, 'A3') === null && cell(s2, 'A4') === null
        && String(cell(s2, 'A5')).startsWith('Hours Report') && cell(s2, 'A7') === 'Shifts', 'B10 empty profile: the name alone, rows 2-4 blank, the rest where it always is');
      const amp = await loadXlsx(await xlsx(curWB, week, { ...EMPTY, companyName: 'Star Guard & Patrol' }));
      check(amp.getWorksheet('SUMMARY')!.headerFooter.oddHeader === '&L&BStar Guard && Patrol&RHours Report' && cell(amp.getWorksheet('SUMMARY'), 'A1') === 'Star Guard & Patrol',
        'B11 an & in the name prints as one: written && in the header/footer codes, as itself in the cell');
      for (const [label, bad] of [['PNG', pngCorruptAfterHeader(400, 160)], ['JPEG', jpegCorruptAfterHeader(400, 160)]] as const) {
        let threw: unknown = null;
        let wb: any = null;
        try { wb = await loadXlsx(await xlsx(curWB, week, { ...FULL, logo: bad })); } catch (e) { threw = e; }
        const s3s = wb?.getWorksheet('SUMMARY');
        check(threw === null && wb.model.media.length === 0 && cell(s3s, 'A1') === 'Star Guard' && cell(s3s, 'A2') === '1200 Example Avenue, Suite 300, San Jose, CA 95110',
          `B12 N167: a ${label} with a valid header and a garbage body: the workbook is produced, no picture, the name in its place (threw ${String(threw)})`);
      }
    }
    // ── the routes ──
    {
      const r = await frozen(() => call('GET', '/api/billing/hours-export?start_date=2026-09-15&end_date=2026-09-15', adminToken(adminA, STAR_GUARD)));
      const wb = r.status === 200 ? await loadXlsx(r.body) : null;
      const s0 = wb?.getWorksheet('SUMMARY');
      const detail = wb ? rowsFrom(wb.getWorksheet('HOURS DETAIL'), 2).join(' ') : '';
      check(r.status === 200 && cell(s0, 'B1') === 'Star Guard' && cell(s0, 'B4') === 'License No. PPO 120456' && (wb as any).model.media.length === 1
        && detail.includes('Fixture Guard A') && r.disposition === 'attachment; filename="netraops-hours-star-guard-2026-09-15-to-2026-09-15.xlsx"',
        `B13 GET /api/billing/hours-export as Star Guard's admin: Star Guard's block and logo over its own hours; the filename unchanged (${r.status} ${r.disposition})`);
    }
    {
      const r = await frozen(() => call('GET', `/api/billing/hours-export?company_id=${other}&start_date=2026-09-15&end_date=2026-09-15`, vishnuToken));
      const wb = r.status === 200 ? await loadXlsx(r.body) : null;
      const s0 = wb?.getWorksheet('SUMMARY');
      check(r.status === 200 && cell(s0, 'A1') === OTHER_NAME && !JSON.stringify(rowsFrom(s0, 1)).includes('Star Guard') && (wb as any).model.media.length === 0,
        `B14 as Vishnu, for the other company: that company's block, nothing of Star Guard's (${r.status})`);
    }
    {
      const MR = require('../src/services/monthlyReport');
      s3Uploads.length = 0;
      const res = await frozen<any>(() => MR.generateMonthlyReport(STAR_GUARD, 2026, 9));
      const up = s3Uploads[0];
      const wb = up ? await loadXlsx(up.buf) : null;
      const s0 = wb?.getWorksheet('SUMMARY');
      check(s3Uploads.length === 1 && up.key === `monthly-reports/${STAR_GUARD}/netraops-hours-star-guard-2026-09.xlsx` && res?.key === up.key
        && cell(s0, 'B1') === 'Star Guard' && String(cell(s0, 'A5')) === 'Hours Report   ·   Period 01-Sep-26 to 30-Sep-26'
        && (wb as any).model.media.length === 1 && rowsFrom(wb!.getWorksheet('HOURS DETAIL'), 2).join(' ').includes('Fixture Guard A'),
        `B15 #5 generateMonthlyReport(Star Guard, 2026-09): the archived file carries the letterhead over September's hours, under the same key (${up?.key})`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    section(`C  #6 analytics CSV — no letterhead: the same bytes as the ${BASE.slice(0, 7)} route; with one: the preamble, and the export below it unchanged`);
    const get = (pathname: string, token: string) => frozen(() => call('GET', pathname, token));
    const BOM = '﻿';
    const range = 'date_from=2026-09-15&date_to=2026-09-15';
    for (const [label, token] of [['Vishnu (every company)', vishnuToken], ['an admin whose company has no row', adminToken(adminA, NO_SUCH_COMPANY)]] as const) {
      for (const type of ['', '&type=violations', '&type=hours']) {
        const b = await get(`/api/exports-base/analytics/csv?${range}${type}`, token);
        const c = await get(`/api/exports/analytics/csv?${range}${type}`, token);
        check(b.status === 200 && c.status === 200 && b.body.equals(c.body) && b.disposition === c.disposition,
          `C1 ${label}${type ? `, ${type.slice(1)}` : ''}: base route ${sha(b.body)} = current ${sha(c.body)} (${c.body.length} bytes)`);
      }
    }
    {
      const m = await get(`/api/exports-mutant/analytics/csv?${range}`, vishnuToken);
      const c = await get(`/api/exports/analytics/csv?${range}`, vishnuToken);
      check(m.status === 200 && !m.body.equals(c.body), 'C2 control: the base route with one space added to a section title DIFFERS');
    }
    const PREAMBLE = ['"Star Guard"', '"1200 Example Avenue, Suite 300, San Jose, CA 95110"',
      '"Tel (408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example"', '"License No. PPO 120456"', '"Powered by NetraOps"'].join('\n');
    {
      const b = await get(`/api/exports-base/analytics/csv?${range}`, adminToken(adminA, STAR_GUARD));
      const c = await get(`/api/exports/analytics/csv?${range}`, adminToken(adminA, STAR_GUARD));
      const base = b.body.toString('utf8');
      const now = c.body.toString('utf8');
      check(c.status === 200 && base.startsWith(`${BOM}GUARD HOURS`) && now === `${BOM}${PREAMBLE}\n\n${base.slice(1)}` && c.disposition === b.disposition,
        "C3 Star Guard's admin: the BOM, the five preamble lines, one blank line, then the base route's export unchanged; the filename unchanged");
      check(now.includes('Fixture Guard A') && now.includes('Perimeter checked'), "C3b ...over Star Guard's own hours and reports");
      const rows = parseCsv(now.slice(1));
      const want = [['Star Guard'], ['1200 Example Avenue, Suite 300, San Jose, CA 95110'],
        ['Tel (408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example'], ['License No. PPO 120456'],
        ['Powered by NetraOps'], [''], ['GUARD HOURS']];
      check(JSON.stringify(rows.slice(0, 7)) === JSON.stringify(want),
        'C3c a CSV parser reads each preamble line back as one cell, then a blank row, then the first section title');
    }
    {
      const b = await get(`/api/exports-base/analytics/csv?${range}&type=violations`, adminToken(adminA, STAR_GUARD));
      const c = await get(`/api/exports/analytics/csv?${range}&type=violations`, adminToken(adminA, STAR_GUARD));
      const base = b.body.toString('utf8');
      check(base.startsWith(`${BOM}\nGEOFENCE VIOLATIONS`) && c.body.toString('utf8') === `${BOM}${PREAMBLE}\n${base.slice(1)}`,
        'C4 type=violations (the live-status download), whose section already starts with a blank line: still exactly one blank line after the preamble');
    }
    {
      const c = await get(`/api/exports/analytics/csv?${range}`, adminToken(adminB, other));
      const now = c.body.toString('utf8');
      check(c.status === 200 && now.startsWith(`${BOM}"${OTHER_NAME}"\n"Powered by NetraOps"\n\nGUARD HOURS`) && !now.includes('Star Guard') && !now.includes('Fixture Guard A'),
        "C5 the other company's admin: its own name and an empty profile; nothing of Star Guard's");
    }
    {
      const { csvPreamble, withCsvPreamble } = await import('../src/services/letterhead/csv');
      const pre = (lh: object) => csvPreamble({ ...EMPTY, ...lh } as never);
      const dq = '"';
      check(JSON.stringify(pre({ companyName: `Star ${dq}Guard${dq}` })) === JSON.stringify([`${dq}Star ${dq}${dq}Guard${dq}${dq}${dq}`, `${dq}Powered by NetraOps${dq}`]),
        'C6 a quote in a line is doubled inside its quoted cell');
      check(pre({ phone: '+1 (408) 555-0142' })[1] === '"Tel +1 (408) 555-0142"', 'C7 a "+1" phone leads its line labelled "Tel", so the guard never needs to fire on it');
      check(pre({ address: `=HYPERLINK(${dq}http://x.example${dq},${dq}click${dq})` })[1] === `${dq}'=HYPERLINK(${dq}${dq}http://x.example${dq}${dq},${dq}${dq}click${dq}${dq})${dq}`,
        'C8 a line a spreadsheet would run as a formula gets a leading apostrophe, inside the quotes');
      check(['-1 Main St', '@corp', '+x', '=1+1'].every((a) => pre({ address: a })[1].startsWith(`${dq}'`)) && pre({ address: '1 Main St' })[1] === '"1 Main St"',
        'C8b = + - @ all trigger the guard, and an ordinary line does not');
      check(pre({ contactEmail: 'ops@starguard.example' })[1] === '"ops@starguard.example"', 'C9 no phone: the line starts with the email, unlabelled');
      check(withCsvPreamble(null, 'GUARD HOURS\nx') === 'GUARD HOURS\nx' && withCsvPreamble(null, '\nGEO') === '\nGEO', 'C10 no letterhead: the body comes back untouched');
    }

    // ── (next section) ──
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (!hadMonthlyRow) await q('DELETE FROM monthly_hours_reports WHERE company_id = $1 AND year = 2026 AND month = 9', [STAR_GUARD]);
    for (const table of ['reports', 'location_pings', 'shift_sessions', 'shifts', 'guards', 'sites', 'company_admins', 'companies']) {
      if (seeded[table].length) await q(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [seeded[table]]);
    }
    if (priorStarGuard) {
      await q(`UPDATE companies SET ${PROFILE.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [STAR_GUARD, ...PROFILE.map((c) => priorStarGuard[c])]);
    } else {
      await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    }
    const left = (await q(`SELECT (SELECT count(*) FROM sites WHERE name LIKE $1)::int + (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM companies WHERE name LIKE $2)::int AS n`, [`${marker}%`, `%${marker}`])).rows[0].n;
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
