/**
 * test-letterhead-pdf.ts — the PDF letterhead (Phase B, stage B0).
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-letterhead-pdf.ts     (from apps/api)
 *
 * Needs poppler (pdftotext, pdfimages) and git (the base theme is read from
 * the repository). LOCAL DATABASES ONLY, as test-company-profile.ts.
 *
 * ── B0 MUST SHIP WITH ZERO VISIBLE CHANGE ──────────────────────────────────
 *
 * Every PDF the three theme callers produce today is rendered twice, back to
 * back: once against theme.ts AS IT WAS at 5def3a5 (blob 5d66bfac…, read from
 * git, compiled, and put in require.cache under theme.ts's own path), once
 * against the current code. The two must be the same BYTES.
 *   I1  services/pdf/activityLog.ts   multi-page fixture; one-page fixture with a shift
 *   I2  services/pdf/guardHours.ts    one page; four pages
 *   I3  routes/clientPortal.ts        GET /api/client/reports/pdf over HTTP through the
 *                                     real router, on a local Postgres seeded with FAKE
 *                                     data on Star Guard's id: a period, and all time
 *   I4  the theme entry points called directly with an explicit `null` letterhead
 * All under a frozen clock: pdfkit stamps CreationDate (an indirect object) and
 * an /ID derived from it, and two of the documents print the time themselves.
 *
 * Controls, run every time, so that IDENTICAL cannot be vacuous:
 *   X1  the base theme with its title moved 1 pt: every document DIFFERS
 *   X2  the current code under a live clock, 1.1 s apart: DIFFERS
 *   X3  the same calls WITH a letterhead: DIFFER, and carry it
 *
 * Then the letterhead itself, which B0 ships unused (P): its text, its boxes
 * (pdftotext -bbox: nothing overlaps, nothing leaves the band), one embedded
 * logo however many pages draw it, and the fallbacks.
 */
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import { execFileSync, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';
import { pngImage } from './image-fixtures';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
/** apps/api/src/services/pdf/theme.ts at 5def3a5, the last commit before the letterhead. */
const BASE_THEME_BLOB = '5d66bfac3437b731164e260a917259693a1d2969';
const T0 = '2026-10-06T19:00:00Z';
const JWT_SECRET = 'test-only-letterhead-pdf';

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
function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}
function stubModule(name: string): unknown {
  return new Proxy({ __esModule: true }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the letterhead PDF test`); }),
  });
}

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 16);

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

// ── which theme the callers get ────────────────────────────────────────────
const THEME = require.resolve('../src/services/pdf/theme');
const CALLERS = ['../src/services/pdf/activityLog', '../src/services/pdf/guardHours', '../src/routes/clientPortal', '../src/routes/activityLog']
  .map((r) => require.resolve(r));
const baseSource = execFileSync('git', ['cat-file', '-p', BASE_THEME_BLOB], { encoding: 'utf8' });
const mutantSource = baseSource.replace("text(title, 0, 26, { align: 'right'", "text(title, 0, 27, { align: 'right'");
type Variant = 'current' | 'base' | 'mutant';
function useTheme(v: Variant): void {
  for (const k of [THEME, ...CALLERS]) delete require.cache[k];
  if (v === 'current') return;
  const js = ts.transpileModule(v === 'base' ? baseSource : mutantSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m = new Module(THEME, module) as Module & { _compile(code: string, file: string): void; paths: string[] };
  m.filename = THEME;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(THEME));
  m._compile(js, THEME);
  m.loaded = true;
  require.cache[THEME] = m;
}

async function main(): Promise<void> {
  refuseUnlessLocal();
  if (spawnSync('pdftotext', ['-v']).status !== 0 || spawnSync('pdfimages', ['-v']).status !== 0) {
    console.error('poppler (pdftotext, pdfimages) is required.');
    process.exit(2);
  }
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'letterhead-pdf-'));
  const PDFDocument = (await import('pdfkit')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  await import('express-async-errors');
  const express = (await import('express')).default;
  const fx = await import('../src/services/pdf/_activityLogFixture');
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);

  // ── guard-hours fixtures ──
  const ghDoc = (n: number) => ({
    guardName: 'Sample Guard', badgeNumber: 'GRD0099', employer: 'Star Guard',
    from: '2026-09-01', to: '2026-10-04', timeZone: 'America/Los_Angeles',
    generatedAt: new RealDate('2026-10-06T19:00:00Z'),
    rows: Array.from({ length: n }, (_, i) => {
      const start = new RealDate(RealDate.UTC(2026, 8, 1 + i, 14, 0, 0));
      return {
        session_id: `00000000-0000-4000-8000-${String(100000000000 + i)}`, shift_id: `00000000-0000-4000-9000-${String(100000000000 + i)}`,
        clocked_in_at: new RealDate(start.getTime() + 4 * 60e3), clocked_out_at: new RealDate(start.getTime() + 8 * 3600e3 - 2 * 60e3),
        scheduled_start: start, scheduled_end: new RealDate(start.getTime() + 8 * 3600e3),
        handed_off: i === 3, took_over: i === 4, legacy_break: i === 5,
        site_name: i % 2 ? 'Sample Site North' : 'Sample Site South',
        scheduled_hours: 8, actual_hours: 7.9, break_hours: 0.5, violation_hours: i % 7 === 6 ? 0.25 : 0,
      };
    }),
  });

  // ── the client report's data (fake, Star Guard's id, local only) ──
  const marker = `lhpdf-${Date.now().toString(36)}`;
  const seeded: Record<string, string[]> = { reports: [], shift_sessions: [], shifts: [], guards: [], sites: [] };
  await q('DELETE FROM companies WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM sites WHERE company_id = $1)', [STAR_GUARD]);
  const hadCompany = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rowCount > 0;
  if (!hadCompany) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
  const ins = async (table: string, sql: string, params: unknown[]) => {
    const id = (await q(sql, params)).rows[0].id;
    seeded[table].push(id);
    return id as string;
  };
  const siteId = await ins('sites', `INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1200 Example Avenue, San Jose', '2026-01-01') RETURNING id`, [STAR_GUARD, `${marker} Report Site`]);
  const guards = [
    await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, 'Fixture Guard A', $2, 'x', 'GRD9701') RETURNING id`, [STAR_GUARD, `${marker}-a@test.invalid`]),
    await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, 'Fixture Guard B', $2, 'x', 'GRD9702') RETURNING id`, [STAR_GUARD, `${marker}-b@test.invalid`]),
  ];
  const kinds: Array<[string, string | null, string]> = [
    ['activity', null, 'Perimeter checked, gate secured, lobby clear.'],
    ['incident', 'high', 'Unauthorised person at the loading dock; asked to leave, complied.'],
    ['maintenance', 'low', 'Light out above the east stairwell.'],
    ['activity', null, 'Patrol round complete, all doors locked.'],
  ];
  for (let d = 0; d < 6; d++) {
    const g = guards[d % 2];
    const start = new RealDate(RealDate.UTC(2026, 8, 10 + d * 3, 15, 0, 0));
    const shift = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
      [siteId, g, start, new RealDate(start.getTime() + 8 * 3600e3)]);
    const sess = await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords) VALUES ($1, $2, $3, $4, $5, '37.33,-121.89') RETURNING id`,
      [shift, g, siteId, new RealDate(start.getTime() + 3 * 60e3), new RealDate(start.getTime() + 8 * 3600e3 - 5 * 60e3)]);
    for (let r = 0; r < kinds.length; r++) {
      const [type, sev, desc] = kinds[(d + r) % kinds.length];
      await ins('reports', `INSERT INTO reports (shift_session_id, site_id, report_type, severity, description, reported_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [sess, siteId, type, sev, desc, new RealDate(start.getTime() + (1 + r * 2) * 3600e3)]);
    }
  }

  // ── the client report over HTTP ──
  let currentRouter: any = null;
  const app = express();
  app.use(express.json());
  app.use('/api/client', (req: any, res: any, next: any) => currentRouter(req, res, next));
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dlFor = (from?: string, to?: string) => jwt.sign({ sub: 'client-fixture', role: 'client', site_id: siteId, purpose: 'pdf_download', from, to }, JWT_SECRET, { expiresIn: 3600 });
  const dlPeriod = dlFor('2026-09-01', '2026-10-31');
  const dlAllTime = dlFor();

  // ── the documents ──
  async function collect(doc: InstanceType<typeof PDFDocument>, draw: () => void): Promise<Buffer> {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    draw();
    doc.end();
    await done;
    return Buffer.concat(chunks);
  }
  /** The four theme entry points, called directly; `lh` is passed through as given. */
  async function synthetic(lh: unknown): Promise<Buffer[]> {
    const theme = require(THEME);
    const direct = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
    const a = await collect(direct, () => {
      theme.drawHeader(direct, 'SITE SECURITY REPORT', 1, 2, lh);
      direct.fontSize(11).fillColor('#1E293B').text('Body of page one.', 50, 100);
      theme.drawFooter(direct, 'Sample Site', '01/09/2026 – 30/09/2026', lh);
      direct.addPage();
      theme.drawHeader(direct, 'GUARD ACTIVITY SUMMARY (cont.)', 2, 2, lh);
      direct.text('Body of page two.', 50, 100);
      theme.drawGuardFooter(direct, 'Sample Guard', 'GRD0099', '21 Sept 2026 — 04 Oct 2026', lh);
    });
    const stamped = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true, bufferPages: true });
    const b = await collect(stamped, () => {
      for (let p = 0; p < 3; p++) { if (p) stamped.addPage(); stamped.fontSize(11).text(`Stamped body, page ${p + 1}.`, 50, 100); }
      theme.stampPages(stamped, 'ACTIVITY LOGS', (d: unknown) => theme.drawFooter(d, 'Sample Site', '01/09/2026 – 30/09/2026', lh), lh);
    });
    return [a, b];
  }
  async function renderAll(): Promise<Array<[string, Buffer]>> {
    const { renderActivityLogPdf } = require('../src/services/pdf/activityLog');
    const { renderGuardHoursPdf } = require('../src/services/pdf/guardHours');
    currentRouter = require('../src/routes/clientPortal').default;
    const hours = async (n: number) => {
      const sink = new PassThrough();
      const chunks: Buffer[] = [];
      sink.on('data', (c: Buffer) => chunks.push(c));
      const ended = new Promise<void>((r) => sink.on('end', () => r()));
      await renderGuardHoursPdf(ghDoc(n), sink);
      await ended;
      return Buffer.concat(chunks);
    };
    const client = async (dl: string) => {
      const r = await fetch(`${base}/api/client/reports/pdf?dl=${encodeURIComponent(dl)}`);
      const body = Buffer.from(await r.arrayBuffer());
      if (r.status !== 200 || !body.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error(`client report: ${r.status} ${body.subarray(0, 120).toString()}`);
      return body;
    };
    const [s1, s2] = await synthetic(null);
    return [
      ['I1 activity log, multi-page fixture', await renderActivityLogPdf([...fx.FIXTURE_ROWS], fx.FIXTURE_META)],
      ['I1 activity log, one page, shift-scoped', await renderActivityLogPdf([...fx.FIXTURE_ROWS_ONE_PAGE], fx.FIXTURE_META_WITH_SHIFT)],
      ['I2 guard hours, 9 rows', await hours(9)],
      ['I2 guard hours, 120 rows', await hours(120)],
      ['I3 client report, a period', await client(dlPeriod)],
      ['I3 client report, all time', await client(dlAllTime)],
      ['I4 drawHeader/drawFooter/drawGuardFooter(…, null)', s1],
      ['I4 stampPages(…, null) + drawFooter(…, null)', s2],
    ];
  }
  const pdfInfoPages = (buf: Buffer, name: string) => {
    const f = path.join(TMP, `${name}.pdf`);
    fs.writeFileSync(f, buf);
    return Number(execFileSync('pdfinfo', [f], { encoding: 'utf8' }).match(/^Pages:\s+(\d+)/m)?.[1]);
  };

  try {
    // ══════════════════════════════════════════════════════════════════════
    section(`I  zero visible change: theme.ts at 5def3a5 vs now, same bytes (frozen clock ${T0})`);
    check(baseSource.includes('export function drawHeader') && !baseSource.includes('lh?:') && mutantSource !== baseSource,
      `base theme read from git blob ${BASE_THEME_BLOB.slice(0, 8)} (${baseSource.length} bytes), mutant differs from it`);
    useTheme('base');
    const before = await frozen(renderAll);
    useTheme('current');
    const after = await frozen(renderAll);
    check(String(require(THEME).drawHeader).includes('drawLetterheadHeader') && !baseSource.includes('drawLetterheadHeader'),
      'the second run used the CURRENT theme.ts (its drawHeader branches to the letterhead; the base one cannot)');
    before.forEach(([label, buf], i) => {
      const now = after[i][1];
      check(buf.equals(now), `${label}: ${sha(buf)} = ${sha(now)} (${buf.length} bytes, ${pdfInfoPages(now, `i-${i}`)} pages)`);
    });

    // ══════════════════════════════════════════════════════════════════════
    section('X  controls: the comparison above can fail');
    useTheme('mutant');
    const mutated = await frozen(renderAll);
    useTheme('current');
    mutated.forEach(([label, buf], i) => check(!buf.equals(after[i][1]), `X1 base theme with the title 1 pt lower: ${label} DIFFERS (${sha(buf)})`));
    const live1 = await renderAll();
    await new Promise((r) => setTimeout(r, 1100));
    const live2 = await renderAll();
    check(live1.every(([, b], i) => !b.equals(live2[i][1])), 'X2 the current code under a live clock, 1.1 s apart: every document DIFFERS (the freeze is load-bearing)');

    // ══════════════════════════════════════════════════════════════════════
    section('P  the letterhead itself (B0 ships it unused)');
    const logo = pngImage(400, 440);
    const full = {
      companyName: 'Star Guard', contactEmail: 'dispatch@starguard.example', phone: '+1 (408) 555-0142',
      address: '1200 Example Avenue, Suite 300\nSan Jose, CA 95110', licenceNumber: 'PPO 120456',
      website: 'https://www.starguard.example/', logo,
    };
    const [fullDirect, fullStamped] = await frozen(() => synthetic(full));
    const [nullDirect, nullStamped] = await frozen(() => synthetic(null));
    check(!fullDirect.equals(nullDirect) && !fullStamped.equals(nullStamped), 'X3 the same calls WITH a letterhead: both documents DIFFER from the null renders');
    const file = (buf: Buffer, name: string) => { const f = path.join(TMP, `${name}.pdf`); fs.writeFileSync(f, buf); return f; };
    // Whitespace collapsed: pdftotext's spacing between words is not stable, the words are.
    const flat = (s: string) => s.replace(/\s+/g, ' ');
    const pageText = (f: string, p: number) => flat(execFileSync('pdftotext', ['-f', String(p), '-l', String(p), f, '-'], { encoding: 'utf8' }));
    const fd = file(fullDirect, 'full-direct');
    const fs3 = file(fullStamped, 'full-stamped');
    const t1 = pageText(fd, 1);
    const t2 = pageText(fd, 2);
    // The page count is drawn "1 / 2"; pdftotext joins it to "1/2", so it is matched either way.
    const pageCount = (t: string, n: number, of: number) => new RegExp(`(^|\\s)${n} ?/ ?${of}(\\s|$)`).test(t);
    check(pageCount(t1, 1, 2), 'P1 page 1 carries the page count 1 / 2');
    for (const s of ['Star Guard', 'SITE SECURITY REPORT', '1200 Example Avenue, Suite 300, San Jose, CA 95110',
      '+1 (408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example', 'License No. PPO 120456',
      'Sample Site  |  01/09/2026 – 30/09/2026  |  Confidential — Star Guard', 'Powered by NetraOps']) {
      check(t1.includes(flat(s)), `P1 page 1 carries "${s}"`);
    }
    check(!/SECURITY MANAGEMENT|Confidential — NetraOps|Licence/.test(t1 + t2), 'P1 no NetraOps header, no "Confidential — NetraOps", no British "Licence" anywhere');
    check(t2.includes(flat('Sample Guard (GRD0099)  |  21 Sept 2026 — 04 Oct 2026  |  Confidential — Star Guard')) && t2.includes('Powered by NetraOps'),
      'P2 drawGuardFooter with a letterhead: "<guard> (<badge>)  |  <period>  |  Confidential — <company>" + Powered by NetraOps');
    check(pdfInfoPages(fullStamped, 'full-stamped-pages') === 3 && [1, 2, 3].every((p) => {
      const t = pageText(fs3, p);
      return t.includes('Star Guard') && pageCount(t, p, 3) && t.includes('ACTIVITY LOGS') && t.includes('Powered by NetraOps');
    }), 'P3 stampPages with a letterhead: all 3 pages carry the company, "n / 3", the title and the footer');
    // Image rows only: an RGBA logo also lists an `smask` row, and both say "image" in the enc column.
    const imgs = (f: string) => execFileSync('pdfimages', ['-list', f], { encoding: 'utf8' }).split('\n').slice(2)
      .map((l) => l.trim().split(/\s+/)).filter((c) => c[2] === 'image');
    const st = imgs(fs3);
    check(st.length === 3 && new Set(st.map((c) => c[10])).size === 1 && st.map((c) => c[0]).join(',') === '1,2,3',
      `P4 one embedded logo object, drawn on each of the 3 pages (pdfimages: ${st.map((c) => `p${c[0]} obj ${c[10]}`).join(', ')})`);

    // Layout boxes: every word of the header band stays in the band, and no two overlap.
    const words = (f: string, p: number) => {
      const html = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-bbox', f, '-'], { encoding: 'utf8' });
      return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
        .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], w: m[5] }));
    };
    const headerOk = (f: string, label: string) => {
      const hw = words(f, 1).filter((w) => w.y0 < 80);
      const outside = hw.filter((w) => w.y1 > 70 || w.x0 < 0 || w.x1 > 595 - 50 + 0.5);
      const overlaps: string[] = [];
      for (let i = 0; i < hw.length; i++) for (let j = i + 1; j < hw.length; j++) {
        const a = hw[i]; const b = hw[j];
        if (a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5) overlaps.push(`${a.w}/${b.w}`);
      }
      check(hw.length > 0 && outside.length === 0 && overlaps.length === 0,
        `P5 ${label}: ${hw.length} header words, all inside x 0..545 y 0..70, none overlapping (outside ${outside.map((w) => w.w).join(' ') || 'none'}; overlaps ${overlaps.join(' ') || 'none'})`);
      return hw;
    };
    headerOk(fd, 'full profile with logo');
    {
      const noLogo = { ...full, logo: null };
      const [d] = await frozen(() => synthetic(noLogo));
      const f = file(d, 'no-logo');
      const hw = headerOk(f, 'full profile, logo null');
      const name = hw.find((w) => w.w === 'Star');
      check(imgs(f).length === 0 && !!name && Math.abs(name.x0 - 50) < 1, `P6 logo null: no image embedded, the name starts at the margin (x ${name?.x0})`);
    }
    {
      const emptyProfile = { companyName: 'Star Guard', contactEmail: null, phone: null, address: null, licenceNumber: null, website: null, logo: null };
      const [d] = await frozen(() => synthetic(emptyProfile));
      const f = file(d, 'empty');
      const t = pageText(f, 1);
      headerOk(f, 'empty profile');
      check(t.includes('Star Guard') && !t.includes('License No.') && !t.includes('·') && t.includes('Powered by NetraOps'),
        'P7 empty profile: the name alone in the header, no contact lines, the footer intact');
    }
    {
      const long = {
        companyName: 'Star Guard Protective Services & Event Security of Northern California, LLC',
        contactEmail: 'after-hours-dispatch-and-scheduling@starguard-protective-services.example', phone: '+1 (408) 555-0142 ext. 2201',
        address: '1200 Example Avenue, Building C, Suite 300, Attn: Operations Desk\nSan Jose, CA 95110-1234',
        licenceNumber: 'PPO 120456 / ALARM ACO 7781 / PI 29981 / ADDITIONAL LICENSE FIELDS THAT RUN ON AND ON',
        website: 'https://www.starguard-protective-services.example/locations/san-jose/downtown', logo,
      };
      const [d, s] = await frozen(() => synthetic(long));
      const f = file(d, 'long');
      headerOk(f, 'every field at an extreme length');
      const t = pageText(f, 1);
      check(t.includes('…') && pdfInfoPages(d, 'long-pages') === 2 && pdfInfoPages(s, 'long-stamped') === 3,
        'P8 long fields are cut with an ellipsis, never wrapped: page counts unchanged (2 and 3)');
    }
    {
      // A logo that cannot even be opened (the letterhead never hands one over; this is the backstop).
      const broken = { ...full, logo: Buffer.from('not an image at all') };
      let threw: unknown = null;
      let d: Buffer = Buffer.alloc(0);
      try { [d] = await frozen(() => synthetic(broken)); } catch (e) { threw = e; }
      const f = file(d, 'broken');
      check(threw === null && imgs(f).length === 0 && pageText(f, 1).includes('Star Guard'),
        `P9 bytes pdfkit cannot open: the document still renders, name only (threw ${String(threw)})`);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [table, list] of Object.entries(seeded)) {
      if (list.length) await q(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [list]);
    }
    if (!hadCompany) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM sites WHERE name LIKE $1)::int + (SELECT count(*) FROM guards WHERE email LIKE $1)::int AS n`, [`${marker}%`])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
    await pool.end();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
