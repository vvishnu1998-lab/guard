/**
 * test-pdf-polish.ts — the polish pass on the two client-facing PDFs (fix/pdf-polish).
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test TZ=UTC \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-pdf-polish.ts     (from apps/api)
 *
 * TZ=UTC is required. Railway sets no TZ, so production runs in UTC, and N105 only
 * shows there. The harness also renders the same request with process.env.TZ switched
 * to America/Los_Angeles at runtime (Node re-reads it), which is how it proves the
 * output no longer depends on the process's zone.
 *
 * Needs poppler (pdftotext, pdftoppm, pdfinfo) and git: BASE is main before this PR,
 * and every "before" is its file, read from git and compiled under the current path.
 * LOCAL DATABASES ONLY; fake data on Star Guard's id. Sentry, email, S3 and Firebase are
 * stubbed. PDF_POLISH_SAMPLES_DIR, when set, keeps the before/after documents.
 *
 *   P  the pure pieces: monthDayYear and hourMinute in a named zone, across midnight and
 *      both DST changes, the same from either process zone; lateBy; contactLines and the
 *      CSV preamble print one comma where an address line ends in one (control: BASE's
 *      contactLines prints two)
 *   C  the site security report, over HTTP the way the portal asks for it
 *      C1 the same bytes in UTC and in Pacific; control: BASE's bytes differ between them
 *      C2 N105: in UTC, every time, day group, incident and maintenance date is Pacific,
 *         and a report from 18:30 PT is filed under its own day; control: BASE's is not
 *      C3 every date spells its month, in US order: the cover, the footer on every page,
 *         the timeline, the incidents, the maintenance table; none numeric or day-first
 *      C4 N177: at 100 h and up the label clears the total by the gap a two-digit total
 *         has always had; under 100 h it does not move
 *      C5 nothing else changed: against BASE rendered in Pacific (where its zone-less
 *         formatters happened to be right), every other body word keeps its text and its
 *         place, and every date keeps its value
 *      C6 the letterhead's address prints one comma where its line ends in one
 *   A  the activity log (services/pdf/activityLog.ts)
 *      A1 the same bytes in UTC and in Pacific
 *      A2 every date spells its month, in US order; none numeric or day-first
 *      A3 nothing else changed: the body says what BASE's says, word for word, apart from
 *         the dates; the same page count
 *      A4 on every row the guard's name is 10 pt further right and the detail line 3 pt
 *         lower; the time and the badge did not move
 *      A5 on the page (pixels at 200 dpi): at least 2 pt of clear paper under every badge
 *         that has a detail line, and at least 10 pt before the guard's name; control:
 *         BASE fails both
 *   R  "answered … late" over HTTP: GET /api/activity-log and POST
 *      /api/admin/activity-log/pdf say "15 seconds" for a window answered 15 s after it
 *      closed and "3 minutes" for one answered 3 min after; control: BASE's feed says
 *      "0 minutes"
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
/** main before this PR: PR #100's merge. */
const BASE = 'c2786897a4650e1100890226a11c57262d6d14bb';
/** 21:30 PT on Oct 11, 04:30 UTC on Oct 12: a date printed in the wrong zone shows. */
const T0 = '2026-10-12T04:30:00Z';
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const JWT_SECRET = 'test-only-pdf-polish';
const LA = 'America/Los_Angeles';
const PAGE_H = 842;
/** The body band: below the 72 pt header, above the 30 pt footer. */
const BODY_TOP = 76;
const BODY_BOTTOM = PAGE_H - 31;
/**
 * The report's period as instants: Sep 1-30 in Pacific. NOT the zone-less strings the portal
 * sends today ("2026-09-01", "…T23:59:59"), which the route reads as UTC, printing the period a
 * day early and querying 17:00-16:59 PT: N178, logged for a decision, not changed here.
 */
const FROM = '2026-09-01T07:00:00.000Z';
const TO = '2026-10-01T06:59:59.999Z';

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
      : () => { throw new Error(`${name}.${String(prop)} called in the PDF polish test`); }),
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

/** `apps/api/<rel>` at BASE, compiled as a fresh module under the current file's path. */
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

/** Star Guard's profile for this run. Its address has a line that ends in a comma. */
const FULL = {
  companyName: 'Star Guard', contactEmail: 'dispatch@starguard.example', phone: '(408) 555-0142',
  address: '1200 Example Avenue, Suite 300,\nSan Jose, CA 95110', licenceNumber: 'PPO 120456',
  website: 'https://www.starguard.example/', logo: null,
};
const ADDRESS_ONE_LINE = '1200 Example Avenue, Suite 300, San Jose, CA 95110';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A numeric date, en-GB's short month ("Sept"), or a day-first date: anything this PR replaced. */
const OLD_DATE = /\b\d{1,2}\/\d{1,2}\/\d{4}\b|\bSept\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{4}\b/i;
/** A date as BASE printed it, with the time an incident card prints after it. */
const DATE_BASE = /\b\d{2}\/\d{2}\/\d{4},?|\b\d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec) \d{4}(?:, \d{2}:\d{2})?/gi;
/** A date as this PR prints it ("Sep 8, 2026", any case), with that time. */
const DATE_NEW = /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}(?:, \d{2}:\d{2})?/gi;
/** BASE's date forms rewritten as this PR prints them, so the rest of the text can be compared. */
function newStyleDates(t: string): string {
  return t
    .replace(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g, (_, d, m, y) => `${MONTHS[+m - 1]} ${+d}, ${y}`)
    .replace(/\b(\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec) (\d{4})\b/gi, (_, d, mon, y) => {
      const m = MONTHS[MONTHS.findIndex((x) => x.toLowerCase() === mon.slice(0, 3).toLowerCase())];
      return `${mon === mon.toUpperCase() ? m.toUpperCase() : m} ${+d}, ${y}`;
    });
}

async function main(): Promise<void> {
  refuseUnlessLocal();
  if (process.env.TZ !== 'UTC') {
    console.error('REFUSING: run with TZ=UTC. Railway sets no TZ, so production runs in UTC, and N105 only shows there.');
    process.exit(2);
  }
  for (const tool of ['pdftotext', 'pdftoppm', 'pdfinfo']) {
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
  const PDFDocument = (await import('pdfkit')).default;

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-polish-'));
  const keep = process.env.PDF_POLISH_SAMPLES_DIR;
  const file = (buf: Buffer, name: string) => {
    const f = path.join(TMP, name);
    fs.writeFileSync(f, buf);
    if (keep) fs.writeFileSync(path.join(keep, name), buf);
    return f;
  };
  const flat = (t: string) => t.replace(/\s+/g, ' ').trim();
  const pdfPages = (f: string) => Number(execFileSync('pdfinfo', [f], { encoding: 'utf8' }).match(/^Pages:\s+(\d+)/m)?.[1]);
  const pageText = (f: string, p: number) => flat(execFileSync('pdftotext', ['-f', String(p), '-l', String(p), f, '-'], { encoding: 'utf8' }));
  const allText = (f: string) => Array.from({ length: pdfPages(f) }, (_, i) => pageText(f, i + 1)).join(' ');
  type Word = { x0: number; y0: number; x1: number; y1: number; w: string };
  const words = (f: string, p: number): Word[] => {
    const html = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-bbox', f, '-'], { encoding: 'utf8' });
    return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], w: m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') }));
  };
  /** Body words of every page in reading order (page, line, x): pagination moves rows, not their order. */
  const bodyWords = (f: string): Word[] => {
    const out: Word[] = [];
    for (let p = 1; p <= pdfPages(f); p++) {
      out.push(...words(f, p).filter((w) => w.y0 >= BODY_TOP && w.y1 <= BODY_BOTTOM)
        .sort((a, b) => (Math.abs(a.y0 - b.y0) < 0.05 ? a.x0 - b.x0 : a.y0 - b.y0)));
    }
    return out;
  };
  /** Page `p` of `f` at 200 dpi, grey: luminance 0..255 by pixel. Cached per page. */
  const rasters = new Map<string, { s: number; w: number; h: number; at: (px: number, py: number) => number }>();
  const raster = (f: string, p: number) => {
    const hit = rasters.get(`${f}#${p}`);
    if (hit) return hit;
    const out = path.join(TMP, `ras-${path.basename(f, '.pdf')}-${p}`);
    execFileSync('pdftoppm', ['-r', '200', '-gray', '-f', String(p), '-l', String(p), '-singlefile', f, out]);
    const pgm = fs.readFileSync(`${out}.pgm`);
    const head = pgm.subarray(0, 64).toString('latin1').match(/^P5\s+(\d+)\s+(\d+)\s+255\s/);
    if (!head) throw new Error(`not a P5 PGM: ${out}.pgm`);
    const w = +head[1];
    const h = +head[2];
    const data = pgm.subarray(head[0].length);
    const s = 200 / 72;
    const r = { s, w, h, at: (px: number, py: number) => (px < 0 || py < 0 || px >= w || py >= h ? 255 : data[py * w + px]) };
    rasters.set(`${f}#${p}`, r);
    return r;
  };

  // A BASE file loaded beside the current tree still imports the CURRENT letterhead text,
  // so while a BASE document renders, BASE's contactLines stands in (the letterhead module
  // reads it off text.ts's exports at call time).
  const textMod: any = await import('../src/services/letterhead/text');
  const baseContactLines = loadBase('src/services/letterhead/text.ts').contactLines;
  const asBase = async <T>(fn: () => Promise<T>): Promise<T> => {
    const real = textMod.contactLines;
    textMod.contactLines = baseContactLines;
    try { return await fn(); } finally { textMod.contactLines = real; }
  };

  // ══════════════════════════════════════════════════════════════════════════
  section('P  the pure pieces');
  const { monthDayYear, hourMinute } = await import('../src/services/pdf/dates');
  {
    const cases: Array<[string, string, string]> = [
      // instant, Pacific date, Pacific time
      ['2026-09-02T16:00:00Z', 'Sep 2, 2026', '09:00'],
      ['2026-09-03T01:30:00Z', 'Sep 2, 2026', '18:30'],   // 18:30 PT, already Sep 3 in UTC
      ['2026-09-03T06:59:00Z', 'Sep 2, 2026', '23:59'],
      ['2026-09-03T07:00:00Z', 'Sep 3, 2026', '00:00'],   // midnight is 00:00, never 24:00
      ['2026-03-08T09:59:00Z', 'Mar 8, 2026', '01:59'],   // the last minute of PST
      ['2026-03-08T10:00:00Z', 'Mar 8, 2026', '03:00'],   // PDT begins
      ['2026-11-01T08:30:00Z', 'Nov 1, 2026', '01:30'],   // the first 01:30, PDT
      ['2026-11-01T09:30:00Z', 'Nov 1, 2026', '01:30'],   // the second, PST
      ['2026-11-02T07:30:00Z', 'Nov 1, 2026', '23:30'],
    ];
    const run = () => cases.map(([iso]) => `${monthDayYear(iso, LA)} ${hourMinute(iso, LA)}`);
    const inUtc = await inZone('UTC', async () => run());
    const inLa = await inZone(LA, async () => run());
    const want = cases.map(([, d, t]) => `${d} ${t}`);
    const bad = cases.filter((_, i) => inUtc[i] !== want[i] || inLa[i] !== want[i]).map(([iso], i) => `${iso} -> ${inUtc[i]} / ${inLa[i]}`);
    check(bad.length === 0, `P1 monthDayYear/hourMinute: ${cases.length} instants across midnight and both DST changes, the same from a UTC or a Pacific process (${bad.join('; ') || 'all as expected'})`);
    check(monthDayYear('2026-09-03T01:30:00Z', 'UTC') === 'Sep 3, 2026' && hourMinute('2026-09-03T01:30:00Z', 'UTC') === '01:30',
      'P1b the zone argument is honoured: the same instant in UTC is Sep 3, 01:30');
  }
  {
    const { lateBy } = await import('../src/services/answeredLate');
    const got = [400, 9_000, 15_200, 29_400, 59_499, 59_500, 90_000, 7_200_000].map((ms) => lateBy(ms));
    const want = ['1 second', '9 seconds', '15 seconds', '29 seconds', '59 seconds', '1 minute', '2 minutes', '120 minutes'];
    check(JSON.stringify(got) === JSON.stringify(want), `P2 lateBy: seconds under a minute, never 0; minutes from there (${got.join(', ')})`);
  }
  {
    const { contactLines } = await import('../src/services/letterhead/text');
    const { csvPreamble } = await import('../src/services/letterhead/csv');
    const addr = (address: string) => contactLines({ ...FULL, address } as never)[0];
    const cases: Array<[string, string]> = [
      ['4000 Mowry Ave, Ste 12,\nFremont, CA 94538', '4000 Mowry Ave, Ste 12, Fremont, CA 94538'],
      ['Ste 12,\r\nFremont', 'Ste 12, Fremont'],
      [' , Suite 5 ,\n,San Jose,\n\n', 'Suite 5, San Jose'],
      ['A\n , ,\nB', 'A, B'],
      ['Bldg 4, Floor 2\nSan Jose, CA', 'Bldg 4, Floor 2, San Jose, CA'],
    ];
    const bad = cases.filter(([a, w]) => addr(a) !== w).map(([a]) => `${JSON.stringify(a)} -> ${JSON.stringify(addr(a))}`);
    check(bad.length === 0, `P3 contactLines: each address line loses its own edge commas before the join; commas inside a line stay (${bad.join('; ') || `${cases.length} cases`})`);
    const pre = csvPreamble(FULL as never).join('\n');
    check(pre.includes(ADDRESS_ONE_LINE) && !pre.includes(',,'), 'P3b the CSV preamble carries the address with one comma');
    const baseAddr = baseContactLines(FULL)[0] as string;
    check(baseAddr === '1200 Example Avenue, Suite 300,, San Jose, CA 95110',
      `P3c control: BASE's contactLines doubles the comma (${JSON.stringify(baseAddr)})`);
  }

  // ══ the database: Star Guard, fake data, local only ══
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  await import('express-async-errors');
  const express = (await import('express')).default;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `pdfp-${RealDate.now().toString(36)}`;
  const seeded: Record<string, string[]> = {
    missed_pings: [], location_pings: [], reports: [], clients: [], shift_sessions: [], shifts: [], guards: [], sites: [], company_admins: [],
  };
  const ins = async (table: string, sql: string, params: unknown[]) => {
    const id = (await q(sql, params)).rows[0].id as string;
    seeded[table].push(id);
    return id;
  };
  // Rows an earlier run left behind, swept by this harness's own markers before anything is written.
  for (const sql of [
    "DELETE FROM missed_pings WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'pdfp-%')",
    "DELETE FROM location_pings WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'pdfp-%')",
    "DELETE FROM reports WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'pdfp-%')",
    "DELETE FROM clients WHERE email LIKE 'pdfp-%'",
    "DELETE FROM shift_sessions WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'pdfp-%')",
    "DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'pdfp-%')",
    "DELETE FROM guards WHERE email LIKE 'pdfp-%'",
    "DELETE FROM sites WHERE name LIKE 'pdfp-%'",
    "DELETE FROM company_admins WHERE email LIKE 'pdfp-%'",
  ]) await q(sql);
  const PROFILE = ['contact_email', 'phone', 'address', 'licence_number', 'website', 'logo_url', 'logo_updated_at'];
  const priorStarGuard = (await q(`SELECT ${PROFILE.join(', ')} FROM companies WHERE id = $1`, [STAR_GUARD])).rows[0] ?? null;
  let server: Server | null = null;
  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    await q(`UPDATE companies SET contact_email = $2, phone = $3, address = $4, licence_number = $5, website = $6,
               logo_url = NULL, logo_updated_at = NULL WHERE id = $1`,
      [STAR_GUARD, FULL.contactEmail, FULL.phone, FULL.address, FULL.licenceNumber, FULL.website]);

    /**
     * A Star Guard site with `guards` guards, one 08:00-16:00 PT shift each from Sep 2 on
     * (7 h 52 min worked), the given reports, and a client of it.
     */
    async function clientSite(tag: string, guards: number, reports: Array<[string, string, string, string | null]>) {
      const site = await ins('sites', `INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1200 Example Avenue, San Jose, CA', '2026-01-01') RETURNING id`,
        [STAR_GUARD, `${marker} ${tag} Gate`]);
      const sessions: string[] = [];
      for (let g = 0; g < guards; g++) {
        const nn = String(g + 1).padStart(2, '0');
        const guard = await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
          [STAR_GUARD, `Fixture Guard ${tag}${nn}`, `${marker}-${tag}-${nn}@test.invalid`, `GRD96${'CST'.indexOf(tag) + 1}${nn}`]);
        const start = new RealDate(RealDate.UTC(2026, 8, 2 + g, 15, 0, 0));
        const shift = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
          [site, guard, start, new RealDate(start.getTime() + 8 * 3600e3)]);
        sessions.push(await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords)
          VALUES ($1, $2, $3, $4, $5, '37.33,-121.89') RETURNING id`,
          [shift, guard, site, new RealDate(start.getTime() + 3 * 60e3), new RealDate(start.getTime() + 8 * 3600e3 - 5 * 60e3)]));
      }
      for (let i = 0; i < reports.length; i++) {
        const [type, at, description, severity] = reports[i];
        await ins('reports', `INSERT INTO reports (shift_session_id, site_id, report_type, description, severity, reported_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [sessions[i % sessions.length], site, type, description, severity, new RealDate(at)]);
      }
      const client = await ins('clients', `INSERT INTO clients (site_id, name, email, password_hash, company_id, is_active) VALUES ($1, $2, $3, 'x', $4, true) RETURNING id`,
        [site, `Fixture Client ${tag}`, `${marker}-client-${tag}@test.invalid`, STAR_GUARD]);
      return { site, client, name: `${marker} ${tag} Gate` };
    }
    // C: 14 guards, 110.1 h, and reports either side of Pacific midnight. In UTC every one of
    // these but the first is on a different day, or at a different time, than in Pacific.
    const siteC = await clientSite('C', 14, [
      ['activity', '2026-09-02T16:00:00Z', 'Morning round: gates locked, lot lights on.', null],                  // 09:00 PT Sep 2
      ['activity', '2026-09-03T01:30:00Z', 'Evening round: loading bay clear, doors secured.', null],             // 18:30 PT Sep 2
      ['activity', '2026-09-03T06:59:00Z', 'Last round before midnight: nothing to report.', null],               // 23:59 PT Sep 2
      ['activity', '2026-09-03T07:00:00Z', 'Midnight round: perimeter walked.', null],                            // 00:00 PT Sep 3
      ['incident', '2026-09-04T04:15:00Z', 'An unauthorised vehicle in the loading bay; the driver left when asked.', 'high'], // 21:15 PT Sep 3
      ['incident', '2026-09-04T18:00:00Z', 'A visitor without a badge; escorted to reception.', 'low'],           // 11:00 PT Sep 4
      ['maintenance', '2026-09-05T03:30:00Z', 'Light out in the north stairwell; ticket raised.', null],          // 20:30 PT Sep 4
      ['maintenance', '2026-09-05T17:00:00Z', 'Gate motor noisy; facilities told.', null],                        // 10:00 PT Sep 5
    ]);
    // S: 3 guards, 23.6 h, daytime reports only.
    const siteS = await clientSite('S', 3, [
      ['activity', '2026-09-02T16:00:00Z', 'Morning round: gates locked, lot lights on.', null],
      ['incident', '2026-09-03T21:15:00Z', 'A visitor without a badge; escorted to reception.', 'low'],
      ['maintenance', '2026-09-04T18:30:00Z', 'Light out in the north stairwell; ticket raised.', null],
    ]);

    // T: 1 guard, 7.9 h: a total narrower than "00.0", whose label must not move either.
    const siteT = await clientSite('T', 1, [['activity', '2026-09-02T16:00:00Z', 'Morning round: gates locked, lot lights on.', null]]);

    // R: one shift, 08:00-16:00 PT on Sep 16, and three missed windows: answered 15 s after
    // it closed, answered 3 min after, and never answered.
    const admin = await ins('company_admins', `INSERT INTO company_admins (company_id, name, email, password_hash, is_primary) VALUES ($1, $2, $3, 'x', true) RETURNING id`,
      [STAR_GUARD, `${marker} admin`, `${marker}-admin@test.invalid`]);
    const siteR = await ins('sites', `INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1200 Example Avenue, San Jose, CA', '2026-01-01') RETURNING id`,
      [STAR_GUARD, `${marker} R Gate`]);
    const guardR = await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, 'Fixture Guard R', $2, 'x', 'GRD9631') RETURNING id`,
      [STAR_GUARD, `${marker}-r@test.invalid`]);
    const rStart = new RealDate('2026-09-16T15:00:00Z');
    const rAt = (iso: string) => new RealDate(iso);
    const shiftR = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
      [siteR, guardR, rStart, new RealDate(rStart.getTime() + 8 * 3600e3)]);
    const sessR = await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords, ping_interval_minutes)
      VALUES ($1, $2, $3, $4, $5, '37.33,-121.89', 30) RETURNING id`,
      [shiftR, guardR, siteR, new RealDate(rStart.getTime() + 2 * 60e3), new RealDate(rStart.getTime() + 477 * 60e3)]);
    const ping = (at: string, label: string) => ins('location_pings', `INSERT INTO location_pings (shift_session_id, guard_id, site_id, latitude, longitude,
        is_within_geofence, ping_type, photo_delete_at, pinged_at, window_label, submitted_late)
      VALUES ($1, $2, $3, 37.33, -121.89, true, 'gps_only', $4, $5, $6, true) RETURNING id`,
      [sessR, guardR, siteR, rAt('2026-12-31T00:00:00Z'), rAt(at), label]);
    const miss = (start: string, end: string, label: string, by: string | null, at: string | null) => ins('missed_pings',
      `INSERT INTO missed_pings (shift_session_id, site_id, guard_id, window_start, window_end, window_label, missed_at, resolved_at, resolved_by_ping_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [sessR, siteR, guardR, rAt(start), rAt(end), label, new RealDate(rAt(end).getTime() + 1100), at ? rAt(at) : null, by, rAt('2026-12-31T00:00:00Z')]);
    await miss('2026-09-16T16:00:00Z', '2026-09-16T16:30:00Z', '09:00', await ping('2026-09-16T16:30:15Z', '09:00'), '2026-09-16T16:30:15Z');
    await miss('2026-09-16T17:00:00Z', '2026-09-16T17:30:00Z', '10:00', await ping('2026-09-16T17:33:00Z', '10:00'), '2026-09-16T17:33:00Z');
    await miss('2026-09-16T18:00:00Z', '2026-09-16T18:30:00Z', '11:00', null, null);

    // ══ the routers over HTTP: the current ones, and BASE's beside them ══
    const app = express();
    app.use(express.json());
    app.use('/api/client', (await import('../src/routes/clientPortal')).default);
    app.use('/api/client-base', loadBase('src/routes/clientPortal.ts').default);
    app.use('/api/activity-log', (await import('../src/routes/activityLog')).default);
    app.use('/api/activity-log-base', loadBase('src/routes/activityLog.ts').default);
    app.use('/api/admin', (await import('../src/routes/admin')).default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    // Long enough that no keep-alive socket closes under fetch between sections (ECONNRESET).
    listening.keepAliveTimeout = 600_000;
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    /** The portal's two steps, in the frozen clock and the given process zone. */
    const clientPdf = (s: { site: string; client: string }, prefix: string, tz: string) => (prefix.endsWith('-base') ? asBase : <T>(f: () => Promise<T>) => f())(() => inZone(tz, () => frozen(async () => {
      const token = jwt.sign({ sub: s.client, role: 'client', site_id: s.site }, JWT_SECRET, { expiresIn: '1h' });
      const link = await fetch(`${origin}${prefix}/reports/pdf-link`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: TO }),
      });
      const lj = (await link.json()) as { url?: string };
      if (link.status !== 200 || !lj.url?.startsWith('/api/client/reports/pdf?dl=')) throw new Error(`pdf-link ${prefix}: ${link.status} ${JSON.stringify(lj)}`);
      const r = await fetch(`${origin}${prefix}${lj.url.slice('/api/client'.length)}`);
      const body = Buffer.from(await r.arrayBuffer());
      if (r.status !== 200 || !body.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`report ${prefix}: ${r.status}`);
      return body;
    })));
    const adminToken = () => jwt.sign({ sub: admin, role: 'company_admin', company_id: STAR_GUARD, is_primary: true }, JWT_SECRET, { expiresIn: '1h' });

    // ══════════════════════════════════════════════════════════════════════════
    section('C  the site security report, over HTTP');
    const cur = { C: await clientPdf(siteC, '/api/client', 'UTC'), S: await clientPdf(siteS, '/api/client', 'UTC') };
    const curLa = { C: await clientPdf(siteC, '/api/client', LA), S: await clientPdf(siteS, '/api/client', LA) };
    const base = { C: await clientPdf(siteC, '/api/client-base', 'UTC'), S: await clientPdf(siteS, '/api/client-base', 'UTC') };
    const baseLa = { C: await clientPdf(siteC, '/api/client-base', LA), S: await clientPdf(siteS, '/api/client-base', LA) };
    const fC = file(cur.C, 'client-report-after.pdf');
    const fS = file(cur.S, 'client-report-small-after.pdf');
    const fBC = file(base.C, 'client-report-before.pdf');
    const fBS = file(base.S, 'client-report-small-before.pdf');
    const fBLC = file(baseLa.C, 'client-report-before-in-pacific.pdf');
    const fBLS = file(baseLa.S, 'client-report-small-before-in-pacific.pdf');
    const fT = file(await clientPdf(siteT, '/api/client', 'UTC'), 'client-report-tiny-after.pdf');
    const fBT = file(await clientPdf(siteT, '/api/client-base', 'UTC'), 'client-report-tiny-before.pdf');

    check(cur.C.equals(curLa.C) && cur.S.equals(curLa.S) && !base.C.equals(baseLa.C),
      `C1 the report is the same bytes from a UTC process and a Pacific one (${sha(cur.C)} = ${sha(curLa.C)}; ${sha(cur.S)} = ${sha(curLa.S)}); control: BASE's differ (${sha(base.C)} ≠ ${sha(baseLa.C)})`);
    {
      const t = allText(fC);
      const tb = allText(fBC);
      const i2 = t.indexOf('Sep 2, 2026');
      const i3 = t.indexOf('Sep 3, 2026');
      const order = ['09:00', '18:30', '23:59'].map((x) => t.indexOf(x, i2));
      const utcTimes = ['16:00', '01:30', '06:59', '04:15', '03:30'].filter((x) => new RegExp(`(^|\\s)${x}(\\s|$)`).test(t));
      check(i2 >= 0 && i3 > i2 && order.every((i) => i > i2 && i < i3) && t.indexOf('00:00', i3) > i3 && utcTimes.length === 0
        && t.includes('Sep 3, 2026, 21:15') && t.includes('Sep 4, 2026, 11:00')
        && /Sep 4, 2026 20:30/.test(t) && /Sep 5, 2026 10:00/.test(t),
        `C2 N105, rendered in UTC: 09:00, 18:30 and 23:59 PT under "Sep 2, 2026" and 00:00 under "Sep 3, 2026"; the incidents at "Sep 3, 2026, 21:15" and "Sep 4, 2026, 11:00"; the maintenance rows "Sep 4, 2026 20:30" and "Sep 5, 2026 10:00"; no UTC time anywhere (${utcTimes.join(' ') || 'none'})`);
      check(/(^|\s)01:30(\s|$)/.test(tb) && /(^|\s)16:00(\s|$)/.test(tb) && tb.includes('04 Sept 2026, 04:15'),
        'C2b control: BASE, rendered in UTC, prints those reports at 01:30 and 16:00 and the incident at "04 Sept 2026, 04:15"');
    }
    {
      const bad: string[] = [];
      for (const f of [fC, fS]) {
        for (let p = 1; p <= pdfPages(f); p++) {
          const t = pageText(f, p);
          const m = t.match(OLD_DATE);
          if (m) bad.push(`${path.basename(f)} p${p} "${m[0]}"`);
          if (!t.includes('Sep 1, 2026 – Sep 30, 2026')) bad.push(`${path.basename(f)} p${p} no period in its footer`);
        }
      }
      const cover = pageText(fC, 1);
      check(bad.length === 0 && cover.includes('Report Period: Sep 1, 2026 – Sep 30, 2026 | Generated: Oct 11, 2026')
        && allText(fC).includes('Sep 2, 2026') && OLD_DATE.test(allText(fBC)),
        `C3 every date spells its month, in US order: the cover reads "Report Period: Sep 1, 2026 – Sep 30, 2026 | Generated: Oct 11, 2026" (21:30 PT on Oct 11 is already Oct 12 in UTC), every page's footer carries the period, and no page prints a numeric or day-first date (${bad.slice(0, 4).join('; ') || 'none'}); control: BASE does`);
    }
    {
      const lineOf = (f: string, word: string) => words(f, 1).find((w) => w.w === word);
      const hoursC = lineOf(fC, 'hours');
      const totalC = words(fC, 1).find((w) => /^\d{3,}\.\d$/.test(w.w) && hoursC && Math.abs(w.y0 - hoursC.y0) < 12);
      const hoursS = lineOf(fS, 'hours');
      const totalS = words(fS, 1).find((w) => /^\d{1,2}\.\d$/.test(w.w) && hoursS && Math.abs(w.y0 - hoursS.y0) < 12);
      const hoursBS = lineOf(fBS, 'hours');
      const hoursT = lineOf(fT, 'hours');
      const hoursBT = lineOf(fBT, 'hours');
      const totalT = words(fT, 1).find((w) => /^\d\.\d$/.test(w.w) && hoursT && Math.abs(w.y0 - hoursT.y0) < 12);
      const hoursBC = lineOf(fBC, 'hours');
      const totalBC = words(fBC, 1).find((w) => /^\d{3,}\.\d$/.test(w.w));
      const gapC = hoursC && totalC ? hoursC.x0 - totalC.x1 : NaN;
      const gapS = hoursS && totalS ? hoursS.x0 - totalS.x1 : NaN;
      const gapBC = hoursBC && totalBC ? hoursBC.x0 - totalBC.x1 : NaN;
      check(Number(totalC?.w) >= 100 && totalS?.w === '23.6' && Math.abs(gapC - gapS) < 0.6 && gapC > 8
        && hoursS?.x0 === hoursBS?.x0 && totalT !== undefined && hoursT?.x0 === hoursBT?.x0 && gapBC < 0,
        `C4 N177: "${totalC?.w}" h is followed by its label after ${gapC.toFixed(2)} pt, the gap "${totalS?.w}" has (${gapS.toFixed(2)}); under 100 h the label did not move ("${totalS?.w}" x ${hoursS?.x0} = BASE ${hoursBS?.x0}; "${totalT?.w}" x ${hoursT?.x0} = BASE ${hoursBT?.x0}); control: BASE overlaps (${gapBC.toFixed(2)} pt)`);
    }
    {
      /** Every body word of `fc` and `fb` with its text and place, the dates by value; the planned changes left out. */
      const differences = (pairs: ReadonlyArray<readonly [string, string, string]>) => {
      const bad: string[] = [];
      let compared = 0;
      for (const [fc, fb, label] of pairs) {
        const n = pdfPages(fc);
        if (n !== pdfPages(fb)) { bad.push(`${label}: ${n} pages vs ${pdfPages(fb)}`); continue; }
        for (let p = 1; p <= n; p++) {
          const keepWord = (ws: Word[]) => {
            // Leave out the cover's period line (everything after the period moves), the N177
            // label, and the dates, whose words are compared by value below.
            const periodY = ws.find((w) => w.w === 'Period:')?.y0;
            const hoursY = ws.find((w) => w.w === 'hours')?.y0;
            const out: Word[] = [];
            const body = ws.filter((w) => w.y0 >= BODY_TOP && w.y1 <= BODY_BOTTOM
              && !(p === 1 && periodY !== undefined && Math.abs(w.y0 - periodY) < 1)
              && !(p === 1 && hoursY !== undefined && Math.abs(w.y0 - hoursY) < 1 && w.x0 > 120));
            const line = body.map((w) => w.w).join(' ');
            const dated = new Set<number>();
            // Word indexes covered by a date in either form.
            let offset = 0;
            const starts = body.map((w) => { const s = offset; offset += w.w.length + 1; return s; });
            for (const re of [DATE_BASE, DATE_NEW]) {
              for (const m of line.matchAll(re)) {
                const a = m.index ?? 0;
                const b = a + m[0].length;
                starts.forEach((s, i) => { if (s >= a && s < b) dated.add(i); });
              }
            }
            body.forEach((w, i) => { if (!dated.has(i)) out.push(w); });
            return { out, dates: line.match(DATE_NEW) ?? [], baseDates: newStyleDates(line).match(DATE_NEW) ?? [] };
          };
          const a = keepWord(words(fc, p));
          const b = keepWord(words(fb, p));
          const key = (w: Word) => `${w.w}@${w.x0.toFixed(2)},${w.y0.toFixed(2)}`;
          const sa = a.out.map(key).sort().join('|');
          const sb = b.out.map(key).sort().join('|');
          compared += a.out.length;
          if (sa !== sb) {
            const setB = new Set(b.out.map(key));
            const setA = new Set(a.out.map(key));
            bad.push(`${label} p${p}: +${a.out.map(key).filter((k) => !setB.has(k)).slice(0, 3).join(' ')} -${b.out.map(key).filter((k) => !setA.has(k)).slice(0, 3).join(' ')}`);
          }
          if (JSON.stringify(a.dates) !== JSON.stringify(b.baseDates)) bad.push(`${label} p${p} dates ${a.dates.join(',')} vs BASE ${b.baseDates.join(',')}`);
        }
      }
      return { bad, compared };
      };
      // Against BASE rendered in PACIFIC, where its zone-less formatters happened to be right.
      const r = differences([[fC, fBLC, 'C'], [fS, fBLS, 'S']]);
      check(r.bad.length === 0 && r.compared > 400,
        `C5 nothing else changed: against BASE rendered in Pacific, ${r.compared} body words keep their text and their place, and every date its value (${r.bad.slice(0, 4).join('; ') || 'none differ'})`);
      const control = differences([[fC, fBC, 'C']]);
      check(control.bad.length > 0,
        `C5b control: the same comparison against BASE rendered in UTC finds what N105 changed (${control.bad.slice(0, 1).join('') || 'nothing'})`);
    }
    {
      const t = allText(fC);
      check(pageText(fC, 1).includes(ADDRESS_ONE_LINE) && !t.includes(',,') && allText(fBC).includes('Suite 300,, San Jose'),
        `C6 the letterhead prints "${ADDRESS_ONE_LINE}", with no doubled comma anywhere; control: BASE's report prints "Suite 300,, San Jose"`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    section('A  the activity log PDF');
    const fx = await import('../src/services/pdf/_activityLogFixture');
    const curAL = await import('../src/services/pdf/activityLog');
    const baseAL = loadBase('src/services/pdf/activityLog.ts');
    const { badge } = await import('../src/services/pdf/theme');
    const render = (mod: any, rows: unknown[], meta: object, tz = 'UTC') => (mod === baseAL ? asBase : <T>(f: () => Promise<T>) => f())(
      () => inZone(tz, () => frozen<Buffer>(() => mod.renderActivityLogPdf(JSON.parse(JSON.stringify(rows)), { ...meta }))));
    const docsA = [
      ['multi', fx.FIXTURE_ROWS, fx.FIXTURE_META],
      ['one-page', fx.FIXTURE_ROWS_ONE_PAGE, fx.FIXTURE_META_WITH_SHIFT],
      ['prod-range', fx.FIXTURE_ROWS, fx.FIXTURE_META_PROD_RANGE],
    ] as const;
    const al: Record<string, { cur: string; base: string }> = {};
    {
      const same: string[] = [];
      let allSame = true;
      for (const [label, rows, meta] of docsA) {
        const c = await render(curAL, rows as unknown[], meta);
        const cl = await render(curAL, rows as unknown[], meta, LA);
        const b = await render(baseAL, rows as unknown[], meta);
        al[label] = { cur: file(c, `activity-log-${label}-after.pdf`), base: file(b, `activity-log-${label}-before.pdf`) };
        same.push(`${label} ${sha(c)} ${c.equals(cl) ? '=' : '≠'} ${sha(cl)}`);
        allSame &&= c.equals(cl);
      }
      check(allSame, `A1 the same bytes from a UTC process and a Pacific one (${same.join('; ')})`);
    }
    {
      const bad: string[] = [];
      for (const [label] of docsA) {
        const f = al[label].cur;
        for (let p = 1; p <= pdfPages(f); p++) {
          const m = pageText(f, p).match(OLD_DATE);
          if (m) bad.push(`${label} p${p} "${m[0]}"`);
        }
      }
      const one = pageText(al['one-page'].cur, 1);
      const multi = allText(al.multi.cur);
      check(bad.length === 0 && one.includes('Period Sep 1, 2026 – Sep 8, 2026') && one.includes('Sep 8, 2026, 12:00 PT')
        && one.includes('Generated Oct 11, 2026, 21:30:00 PT') && multi.includes('TUESDAY, SEP 8, 2026')
        && pageText(al['prod-range'].cur, 1).includes('Aug 24, 2026 – Sep 22, 2026'),
        `A2 every date spells its month, in US order: Period "Sep 1, 2026 – Sep 8, 2026", Shift "… Sep 8, 2026, 12:00 PT", Generated "Oct 11, 2026, 21:30:00 PT" (21:30 PT, not 04:30 UTC), day header "TUESDAY, SEP 8, 2026"; nothing numeric or day-first (${bad.slice(0, 4).join('; ') || 'none'})`);
    }
    {
      const bad: string[] = [];
      for (const [label] of docsA) {
        const a = bodyWords(al[label].cur).map((w) => w.w).join(' ');
        const b = newStyleDates(bodyWords(al[label].base).map((w) => w.w).join(' '));
        const pa = pdfPages(al[label].cur);
        const pb = pdfPages(al[label].base);
        if (a !== b || pa !== pb) {
          let i = 0;
          while (i < a.length && a[i] === b[i]) i += 1;
          bad.push(`${label} (${pa}/${pb} pages) differs at ${JSON.stringify(a.slice(Math.max(0, i - 30), i + 30))} vs ${JSON.stringify(b.slice(Math.max(0, i - 30), i + 30))}`);
        }
      }
      check(bad.length === 0, `A3 nothing else changed: the body says what BASE's says, word for word, once BASE's dates are written the new way; the same page count (${bad.join('; ') || 'identical'})`);
      const raw = bodyWords(al.multi.base).map((w) => w.w).join(' ');
      check(raw !== bodyWords(al.multi.cur).map((w) => w.w).join(' '),
        'A3b control: without BASE\'s dates rewritten, the same comparison finds them');
    }
    // Rows by their badge: the label's first word sits at COL_STATUS_X + 6.
    type Row = { page: number; labelY: number; label: string; time?: Word; guard?: Word; detail?: Word };
    const LABELS = new Set<string>(Object.values(curAL.STATUS_LABEL));
    const rowsOf = (f: string): Row[] => {
      const out: Row[] = [];
      for (let p = 1; p <= pdfPages(f); p++) {
        const ws = words(f, p);
        for (const w of ws.filter((x) => Math.abs(x.x0 - (curAL.COL_STATUS_X + 6)) < 0.6)) {
          const label = ws.filter((x) => Math.abs(x.y0 - w.y0) < 0.3 && x.x0 >= w.x0 && x.x0 < 215).sort((a, b) => a.x0 - b.x0).map((x) => x.w).join(' ');
          // Only a badge: BASE's day header "08 SEPT 2026" puts SEPT at x 115.9 too.
          if (!LABELS.has(label)) continue;
          const line = ws.filter((x) => Math.abs(x.y0 - (w.y0 - 1.5)) < 0.3);
          out.push({
            page: p, labelY: w.y0, label,
            time: line.find((x) => x.x0 < curAL.COL_STATUS_X),
            guard: line.filter((x) => x.x0 > 216 && x.x0 < 480).sort((a, b) => a.x0 - b.x0)[0],
            detail: ws.filter((x) => Math.abs(x.x0 - (curAL.COL_STATUS_X)) < 0.6 && x.y0 > w.y0 + 1 && x.y0 < w.y0 + 20)
              .sort((a, b) => a.y0 - b.y0)[0],
          });
        }
      }
      // Page order, then down the page: pdftotext lists words in content-stream order, which differs.
      return out.sort((a, b) => a.page - b.page || a.labelY - b.labelY);
    };
    {
      const bad: string[] = [];
      let n = 0;
      let withDetail = 0;
      for (const [label] of docsA) {
        const rc = rowsOf(al[label].cur);
        const rb = rowsOf(al[label].base);
        if (rc.length !== rb.length) { bad.push(`${label}: ${rc.length} rows vs ${rb.length}`); continue; }
        rc.forEach((c, i) => {
          const b = rb[i];
          n += 1;
          const dGuard = (c.guard?.x0 ?? NaN) - (b.guard?.x0 ?? NaN);
          const ok = c.label === b.label && c.time?.w === b.time?.w && c.time?.x0 === b.time?.x0
            && Math.abs(dGuard - 10) < 0.01 && c.guard?.w === b.guard?.w && !!c.detail === !!b.detail
            && (!c.detail || Math.abs((c.detail.y0 - c.labelY) - (b.detail!.y0 - b.labelY) - 3) < 0.01);
          if (c.detail) withDetail += 1;
          if (!ok) bad.push(`${label} row ${i} "${c.label}"/"${b.label}": guard ${dGuard.toFixed(2)} pt (${c.guard?.w}/${b.guard?.w}), time ${c.time?.w}@${c.time?.x0}/${b.time?.w}@${b.time?.x0}, `
            + `detail ${c.detail && b.detail ? ((c.detail.y0 - c.labelY) - (b.detail.y0 - b.labelY)).toFixed(2) : `${!!c.detail}/${!!b.detail}`}`);
        });
      }
      check(bad.length === 0 && n > 50 && withDetail > 20,
        `A4 on all ${n} rows the guard's name is exactly 10 pt further right and, on the ${withDetail} with a detail line, that line exactly 3 pt lower; the time and the badge did not move (${bad.slice(0, 3).join('; ') || 'all as planned'})`);
    }
    {
      // On the page. From the badge's left padding (pure fill), down to its last dark row, then
      // the clear rows below it across the badge's width; and from its right edge to the first
      // ink of the guard's name.
      const probe = new PDFDocument({ margin: 0, size: 'A4' });
      const measure = (f: string) => {
        const below: number[] = [];
        const right: number[] = [];
        for (const r of rowsOf(f)) {
          const ras = raster(f, r.page);
          const { s } = ras;
          const left = curAL.COL_STATUS_X;
          const w = badge(probe, 0, 0, r.label, '#000000');
          const top = r.labelY - 3.5;            // the badge's top: its label sits 3.5 pt inside
          const x0 = Math.round((left + 2) * s);
          let yb = Math.round((top + 7) * s);    // inside the badge, in its left padding
          while (ras.at(x0, yb + 1) < 230) yb += 1;
          if (r.detail) {
            let clear = 0;
            for (let y = yb + 1; y < yb + 40; y++) {
              let ink = false;
              for (let x = Math.round((left + 1) * s); x <= Math.round((left + w - 1) * s); x++) if (ras.at(x, y) < 235) { ink = true; break; }
              if (ink) break;
              clear += 1;
            }
            below.push(clear / s);
          }
          const yPad = Math.round((top + 1.2) * s);  // a row inside the badge above its label
          let xr = Math.round((left + w - 3) * s);
          while (ras.at(xr + 1, yPad) < 230) xr += 1;
          let gap = 0;
          outer: for (let x = xr + 1; x < xr + 60 * s; x++) {
            for (let y = Math.round((top + 2) * s); y <= Math.round((top + 10) * s); y++) if (ras.at(x, y) < 160) break outer;
            gap += 1;
          }
          right.push(gap / s);
        }
        return { below: Math.min(...below), right: Math.min(...right), badges: right.length, details: below.length };
      };
      const c = measure(al.multi.cur);
      const b = measure(al.multi.base);
      check(c.below >= 2 && c.right >= 10 && c.badges > 30 && c.details >= 10,
        `A5 on the page, ${c.badges} badges: at least ${c.below.toFixed(2)} pt of clear paper under each of the ${c.details} with a detail line (want ≥ 2) and ${c.right.toFixed(2)} pt before the guard's name (want ≥ 10)`);
      check(b.below < 1 && b.right < 6,
        `A5b control: BASE on the same page measures ${b.below.toFixed(2)} pt under its badges and ${b.right.toFixed(2)} pt before the name — the instrument sees the old layout`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    section('R  "answered … late" over HTTP');
    {
      const from = '2026-09-16T07:00:00.000Z';
      const to = '2026-09-17T06:59:59.999Z';
      const feed = (prefix: string) => frozen(async () => {
        const r = await fetch(`${origin}${prefix}?from=${from}&to=${to}&site_id=${siteR}&page_size=100`, { headers: { authorization: `Bearer ${adminToken()}` } });
        return { status: r.status, body: (await r.json()) as { rows: Array<{ status: string; status_kind: string }> } };
      });
      const statuses = (b: { rows: Array<{ status: string; status_kind: string }> }) =>
        b.rows.filter((x) => x.status_kind === 'missed_answered_late' || x.status_kind === 'missed').map((x) => x.status).sort();
      const c = await feed('/api/activity-log');
      const b = await feed('/api/activity-log-base');
      const sc = c.status === 200 ? statuses(c.body) : [];
      const sb = b.status === 200 ? statuses(b.body) : [];
      check(JSON.stringify(sc) === JSON.stringify(['Missed Ping', 'Missed — answered 15 seconds late', 'Missed — answered 3 minutes late']),
        `R1 GET /api/activity-log: ${JSON.stringify(sc)} (${c.status})`);
      check(sb.includes('Missed — answered 0 minutes late') && sb.includes('Missed — answered 3 minutes late'),
        `R1b control: BASE's feed says ${JSON.stringify(sb)}`);
      const pdf = await frozen(async () => {
        const r = await fetch(`${origin}/api/admin/activity-log/pdf`, {
          method: 'POST', headers: { authorization: `Bearer ${adminToken()}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to, site_id: siteR }),
        });
        return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
      });
      const fR = pdf.status === 200 ? file(pdf.body, 'activity-log-route-after.pdf') : '';
      const t = fR ? allText(fR) : pdf.body.toString().slice(0, 200);
      check(pdf.status === 200 && t.includes('Missed — answered 15 seconds late') && t.includes('Missed — answered 3 minutes late')
        && !t.includes('0 minutes') && t.includes(ADDRESS_ONE_LINE),
        `R2 POST /api/admin/activity-log/pdf prints "Missed — answered 15 seconds late" and "… 3 minutes late", under the letterhead's one-comma address (${pdf.status})`);
      // The same rows as BASE's feed gave them, through BASE's renderer: the "before" sample.
      if (keep && b.status === 200) {
        const full = await frozen(async () => {
          const r = await fetch(`${origin}/api/activity-log-base?from=${from}&to=${to}&site_id=${siteR}&page_size=100`, { headers: { authorization: `Bearer ${adminToken()}` } });
          return ((await r.json()) as { rows: unknown[] }).rows;
        });
        file(await render(baseAL, full, { siteLabel: `${marker} R Gate`, fromIso: from, toIso: to, lh: FULL }), 'activity-log-route-before.pdf');
      }
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    for (const table of ['missed_pings', 'location_pings', 'reports', 'clients', 'shift_sessions', 'shifts', 'guards', 'sites', 'company_admins']) {
      if (seeded[table].length) await q(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [seeded[table]]);
    }
    if (priorStarGuard) {
      await q(`UPDATE companies SET ${PROFILE.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [STAR_GUARD, ...PROFILE.map((c) => priorStarGuard[c])]);
    } else {
      await q('DELETE FROM companies WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM sites WHERE company_id = $1)', [STAR_GUARD]);
    }
    const left = (await q(`SELECT (SELECT count(*) FROM sites WHERE name LIKE $1)::int + (SELECT count(*) FROM guards WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM clients WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int AS n`, [`${marker}%`])).rows[0].n;
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
