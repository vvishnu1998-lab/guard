/**
 * test-letterhead-b3.ts — the security company's letterhead on the client's site
 * security report (Phase B, stage B3; surface #2).
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-letterhead-b3.ts     (from apps/api)
 *
 * Needs poppler (pdftotext, pdfimages, pdftoppm, pdfinfo) and git: the "before" side
 * of every identity check is routes/clientPortal.ts as it was at BASE (main before
 * B3), read from git and compiled beside the current one. LOCAL DATABASES ONLY; fake
 * data on Star Guard's id and on an invented company. Sentry, email, S3 and Firebase
 * are stubbed.
 *
 * Every request goes the way the portal goes: POST /api/client/reports/pdf-link with
 * the client's token, then GET the returned ?dl= URL.
 *
 * Unlike the B1 and B2 documents, this report draws each page's header BEFORE its
 * body, so whatever the letterhead header leaves behind (font, colour, line width,
 * cursor) could reach the body. B6 holds the words in place and at their width; B7
 * compares the rendered pixels of the body band, page by page, which also catches a
 * colour or a line width that moved nothing.
 *
 *   B0  the base route predates the letterhead; the current route looks it up
 *   B1  no letterhead (the lookup gives null, as on any failure): the same bytes as
 *       the BASE route, a 5-page report and one with continuation pages in every
 *       section; B1b the null copy really is the current route; B2 a control that
 *       must differ
 *   B3  with Star Guard's full letterhead and logo the report differs and keeps its
 *       page count; B4 every page carries it with its own title and "n / 5" and the
 *       client footer; B5 one logo object; B6 the body words do not move; B7 the
 *       body pixels do not change; B8 the header stays in its band; B9 the logo came
 *       from Star Guard's own key, with no warning
 *   B10 another company's client gets its own company's name only
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
import { pngImage } from './image-fixtures';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** main before B3: PR #99's merge. */
const BASE = '9298b6c27ef45c1f1d76e628ecfa4f186bf19190';
const T0 = '2026-10-11T19:00:00Z';
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const JWT_SECRET = 'test-only-letterhead-b3';
const S3_HOST = 'test-bucket.s3.us-east-1.amazonaws.com';
const FROM = '2026-09-01';
const TO = '2026-09-30';

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
      : () => { throw new Error(`${name}.${String(prop)} called in the B3 letterhead test`); }),
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

/** `apps/api/<rel>` as it was at BASE (or that source run through `edit`), compiled under the current file's path. */
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

const LOGO = pngImage(400, 160);
const FULL = {
  companyName: 'Star Guard', contactEmail: 'dispatch@starguard.example', phone: '(408) 555-0142',
  address: '1200 Example Avenue, Suite 300\nSan Jose, CA 95110', licenceNumber: 'PPO 120456',
  website: 'https://www.starguard.example/',
};

async function main(): Promise<void> {
  refuseUnlessLocal();
  for (const tool of ['pdftotext', 'pdfimages', 'pdftoppm', 'pdfinfo']) {
    if (spawnSync(tool, ['-v']).status !== 0) { console.error(`poppler (${tool}) is required.`); process.exit(2); }
  }
  const sentry: Array<{ what: unknown }> = [];
  inject('../src/services/sentry', {
    Sentry: {
      captureMessage: (what: unknown) => { sentry.push({ what }); return 'evt'; },
      captureException: (what: unknown) => { sentry.push({ what }); return 'evt'; },
      addBreadcrumb: () => undefined,
    },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  inject('../src/services/firebase', stubModule('firebase'));
  class S3ObjectTooLargeError extends Error {}
  const s3Objects = new Map<string, Buffer>();
  const s3Fetches: string[] = [];
  inject('../src/services/s3', stubModule('s3', {
    S3ObjectTooLargeError,
    s3KeyFromPublicUrl: (url: string): string | null => {
      try { const u = new URL(url); return u.hostname === S3_HOST ? u.pathname.replace(/^\//, '') || null : null; } catch { return null; }
    },
    getS3ObjectBuffer: async (key: string) => {
      s3Fetches.push(key);
      const b = s3Objects.get(key);
      if (!b) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey', statusCode: 404 });
      return b;
    },
  }));

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'letterhead-b3-'));
  const keep = process.env.LH_B3_SAMPLES_DIR;
  const file = (buf: Buffer, name: string) => {
    const f = path.join(TMP, name);
    fs.writeFileSync(f, buf);
    if (keep) fs.writeFileSync(path.join(keep, name), buf);
    return f;
  };
  const flat = (t: string) => t.replace(/\s+/g, ' ');
  const pdfPages = (f: string) => Number(execFileSync('pdfinfo', [f], { encoding: 'utf8' }).match(/^Pages:\s+(\d+)/m)?.[1]);
  const pageText = (f: string, p: number) => flat(execFileSync('pdftotext', ['-f', String(p), '-l', String(p), f, '-'], { encoding: 'utf8' }));
  const words = (f: string, p: number) => {
    const html = execFileSync('pdftotext', ['-f', String(p), '-l', String(p), '-bbox', f, '-'], { encoding: 'utf8' });
    return [...html.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)]
      .map((m) => ({ x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4], w: m[5] }));
  };
  const imgs = (f: string) => execFileSync('pdfimages', ['-list', f], { encoding: 'utf8' }).split('\n').slice(2)
    .map((l) => l.trim().split(/\s+/)).filter((c) => c[2] === 'image');
  /**
   * Page `p` of `f` rendered at 200 dpi: the raw RGB rows of the body band, y 76..808 pt. At 100 dpi
   * a rule drawn 0.75 pt instead of 1 pt rasterises the same; at 200 dpi it does not.
   */
  const bodyPixels = (f: string, p: number): Buffer => {
    const out = path.join(TMP, `ras-${path.basename(f, '.pdf')}-${p}`);
    execFileSync('pdftoppm', ['-r', '200', '-f', String(p), '-l', String(p), '-singlefile', f, out]);
    const ppm = fs.readFileSync(`${out}.ppm`);
    const head = ppm.subarray(0, 64).toString('latin1').match(/^P6\s+(\d+)\s+(\d+)\s+255\s/);
    if (!head) throw new Error(`not a P6 PPM: ${out}.ppm`);
    const w = +head[1];
    const data = ppm.subarray(head[0].length);
    const top = Math.ceil((76 * 200) / 72);
    const bottom = Math.floor((808 * 200) / 72);
    return data.subarray(top * w * 3, bottom * w * 3);
  };
  /** The title the NetraOps header draws on page p (13 pt, right-aligned at y 26), read by position. */
  const nullTitle = (f: string, p: number) => words(f, p).filter((w) => w.y0 >= 22 && w.y0 < 40 && w.x0 > 200)
    .sort((a, b) => a.x0 - b.x0).map((w) => w.w).join(' ');
  /** The footer's lead on page p of a no-letterhead render: "<site> | <period>", as flattened text. */
  const nullLead = (f: string, p: number, site: string) => {
    const esc = site.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const period = pageText(f, p).match(new RegExp(`${esc} \\| ([^|]+?) \\| Confidential — NetraOps`))?.[1];
    return period ? `${site} | ${period}` : '';
  };
  /** The "n" of the NetraOps header's "n / 5" on page p (8 pt, right-aligned at y 44). */
  const nullSection = (f: string, p: number) => words(f, p).filter((w) => w.y0 >= 42 && w.y0 < 56 && w.x0 > 400)
    .sort((a, b) => a.x0 - b.x0).map((w) => w.w).join(' ').match(/^(\d) \/ 5$/)?.[1] ?? '?';

  // ══ the database and the routes ══
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  await import('express-async-errors');
  const express = (await import('express')).default;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `lhb3-${RealDate.now().toString(36)}`;
  const seeded: Record<string, string[]> = { reports: [], clients: [], shift_sessions: [], shifts: [], guards: [], sites: [], companies: [] };
  const ins = async (table: string, sql: string, params: unknown[]) => {
    const id = (await q(sql, params)).rows[0].id as string;
    seeded[table].push(id);
    return id;
  };
  // Rows an earlier run left behind, swept by this harness's own markers before anything is written.
  for (const sql of [
    "DELETE FROM reports WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb3-%')",
    "DELETE FROM clients WHERE email LIKE 'lhb3-%'",
    "DELETE FROM shift_sessions WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb3-%')",
    "DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb3-%')",
    "DELETE FROM guards WHERE email LIKE 'lhb3-%'",
    "DELETE FROM sites WHERE name LIKE 'lhb3-%'",
    "DELETE FROM companies WHERE name LIKE 'Fixture Patrol lhb3-%'",
  ]) await q(sql);
  const PROFILE = ['contact_email', 'phone', 'address', 'licence_number', 'website', 'logo_url', 'logo_updated_at'];
  const priorStarGuard = (await q(`SELECT ${PROFILE.join(', ')} FROM companies WHERE id = $1`, [STAR_GUARD])).rows[0] ?? null;
  let server: Server | null = null;
  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const logoKey = `company-logos/${STAR_GUARD}/${marker}.png`;
    s3Objects.set(logoKey, LOGO);
    await q(`UPDATE companies SET contact_email = $2, phone = $3, address = $4, licence_number = $5, website = $6,
               logo_url = $7, logo_updated_at = $8 WHERE id = $1`,
      [STAR_GUARD, FULL.contactEmail, FULL.phone, FULL.address, FULL.licenceNumber, FULL.website,
       `https://${S3_HOST}/${logoKey}`, new RealDate('2026-10-11T18:00:00Z')]);
    const OTHER_NAME = `Fixture Patrol ${marker}`;
    const other = await ins('companies', 'INSERT INTO companies (name) VALUES ($1) RETURNING id', [OTHER_NAME]);

    /**
     * A site under `companyId` with `guards` guards, one September shift each, and
     * reports: `activityDays` lists how many activity reports land on each day from
     * 09-02 on, then `incidents` incidents (low/medium/high in turn) and `maintenance`
     * maintenance reports. Returns the site and a client of it.
     */
    async function siteWith(companyId: string, tag: string, o: { guards: number; activityDays: number[]; incidents: number; maintenance: number }) {
      const site = await ins('sites', `INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1200 Example Avenue, San Jose, CA', '2026-01-01') RETURNING id`,
        [companyId, `${marker} ${tag} Gate`]);
      const sessions: string[] = [];
      for (let g = 0; g < o.guards; g++) {
        const nn = String(g + 1).padStart(2, '0');
        const guard = await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
          [companyId, `Fixture Guard ${tag}${nn}`, `${marker}-${tag}-${nn}@test.invalid`, `GRD97${tag === 'A' ? '1' : tag === 'S' ? '2' : '3'}${nn}`]);
        const start = new RealDate(RealDate.UTC(2026, 8, 2 + (g % 25), 15, 0, 0));
        const shift = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
          [site, guard, start, new RealDate(start.getTime() + 8 * 3600e3)]);
        sessions.push(await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords)
          VALUES ($1, $2, $3, $4, $5, '37.33,-121.89') RETURNING id`,
          [shift, guard, site, new RealDate(start.getTime() + 3 * 60e3), new RealDate(start.getTime() + 8 * 3600e3 - 5 * 60e3)]));
      }
      let n = 0;
      const report = async (type: string, at: Date, description: string, severity: string | null) => {
        await ins('reports', `INSERT INTO reports (shift_session_id, site_id, report_type, description, severity, reported_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [sessions[n % sessions.length], site, type, description, severity, at]);
        n += 1;
      };
      for (let d = 0; d < o.activityDays.length; d++) {
        for (let i = 0; i < o.activityDays[d]; i++) {
          await report('activity', new RealDate(RealDate.UTC(2026, 8, 2 + d, 16, 0, 0) + i * 20 * 60e3),
            `Patrol round ${d + 1}.${i + 1}: all doors secured, lot lights on, nothing to report at the gate.`, null);
        }
      }
      for (let i = 0; i < o.incidents; i++) {
        await report('incident', new RealDate(RealDate.UTC(2026, 8, 3 + (i % 20), 21, 15, 0)),
          `Incident ${i + 1}: an unauthorised vehicle in the loading bay; the driver was asked to leave and did.`, ['low', 'medium', 'high'][i % 3]);
      }
      for (let i = 0; i < o.maintenance; i++) {
        await report('maintenance', new RealDate(RealDate.UTC(2026, 8, 4 + (i % 20), 18, 30, 0)),
          `Light ${i + 1} out in the north stairwell; ticket raised with facilities.`, null);
      }
      const client = await ins('clients', `INSERT INTO clients (site_id, name, email, password_hash, company_id, is_active) VALUES ($1, $2, $3, 'x', $4, true) RETURNING id`,
        [site, `Fixture Client ${tag}`, `${marker}-client-${tag}@test.invalid`, companyId]);
      return { site, client, name: `${marker} ${tag} Gate` };
    }
    // Large: every section runs onto continuation pages — the timeline breaks both
    // inside a day (18 on 09-02) and between days, incidents, maintenance and the
    // 30-guard summary each overflow.
    const large = await siteWith(STAR_GUARD, 'A', { guards: 30, activityDays: [18, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2], incidents: 16, maintenance: 45 });
    // Small: exactly the designed five pages.
    const small = await siteWith(STAR_GUARD, 'S', { guards: 3, activityDays: [2, 1], incidents: 2, maintenance: 2 });
    const theirs = await siteWith(other, 'B', { guards: 1, activityDays: [1], incidents: 1, maintenance: 1 });

    const app = express();
    app.use(express.json());
    app.use('/api/client', (await import('../src/routes/clientPortal')).default);
    // The route as it was at BASE, read from git, and a second copy of the CURRENT route whose
    // letterhead lookup returns null (as it does on any failure). Both under their own prefixes.
    app.use('/api/client-base', loadBase('src/routes/clientPortal.ts').default);
    let nullLookups = 0;
    {
      const cpPath = require.resolve('../src/routes/clientPortal');
      const lhPath = require.resolve('../src/services/letterhead');
      const realCp = require.cache[cpPath];
      const realLh = require.cache[lhPath];
      delete require.cache[cpPath];
      inject('../src/services/letterhead', { __esModule: true, letterheadForGuard: async () => null,
        letterheadForCompany: async () => null, letterheadForSite: async () => { nullLookups += 1; return null; } });
      app.use('/api/client-null', require('../src/routes/clientPortal').default);
      require.cache[cpPath] = realCp;
      if (realLh) require.cache[lhPath] = realLh; else delete require.cache[lhPath];
    }
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    // The portal's two steps, inside the frozen clock (iat/exp relative to T0, the instant the route sees).
    const getPdf = (s: { site: string; client: string }, prefix = '/api/client') => frozen(async () => {
      const token = jwt.sign({ sub: s.client, role: 'client', site_id: s.site }, JWT_SECRET, { expiresIn: '1h' });
      const link = await fetch(`${origin}${prefix}/reports/pdf-link`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: TO }),
      });
      const lj = (await link.json()) as { url?: string };
      if (link.status !== 200 || !lj.url?.startsWith('/api/client/reports/pdf?dl=')) {
        return { status: link.status, type: '', body: Buffer.from(JSON.stringify(lj)) };
      }
      const r = await fetch(`${origin}${prefix}${lj.url.slice('/api/client'.length)}`);
      return { status: r.status, type: r.headers.get('content-type') ?? '', body: Buffer.from(await r.arrayBuffer()) };
    });

    // ══════════════════════════════════════════════════════════════════════════
    section(`B  GET /api/client/reports/pdf: no letterhead is the BASE (${BASE.slice(0, 7)}) report byte for byte; with one it is on every page and the body does not change`);
    {
      const baseSrc = execFileSync('git', ['show', `${BASE}:apps/api/src/routes/clientPortal.ts`], { encoding: 'utf8' });
      const curSrc = fs.readFileSync(path.join(__dirname, '..', 'src/routes/clientPortal.ts'), 'utf8');
      check(!baseSrc.includes('letterhead') && curSrc.includes('await letterheadForSite(payload.site_id)'),
        'B0 the base route predates the letterhead; the current one looks it up by the token\'s site');
    }
    const docs: Record<string, { base: Buffer; nul: Buffer; cur: Buffer }> = {};
    for (const [label, s] of [['small', small], ['large', large]] as const) {
      const base = await getPdf(s, '/api/client-base');
      const nul = await getPdf(s, '/api/client-null');
      const cur = await getPdf(s);
      docs[label] = { base: base.body, nul: nul.body, cur: cur.body };
      const pages = base.status === 200 ? pdfPages(file(base.body, `b-${label}-base.pdf`)) : 0;
      check(base.status === 200 && nul.status === 200 && base.type.startsWith('application/pdf') && base.body.equals(nul.body)
        && (label === 'small' ? pages === 5 : pages > 5),
        `B1 ${label} (${pages} pages): a lookup that gives null renders the base route's PDF byte for byte (${sha(base.body)} = ${sha(nul.body)}; ${base.status}/${nul.status})`);
    }
    check(nullLookups === 2, `B1b the null copy is the current route: its lookup ran once per report (${nullLookups})`);
    {
      const mutant = loadBase('src/routes/clientPortal.ts',
        (src) => src.replace(".text(siteName, ML, y);", ".text(siteName, ML, y + 1);"));
      const listening2: Server = await new Promise((resolve) => {
        const a2 = express(); a2.use(express.json()); a2.use('/api/client', mutant.default);
        const sv = a2.listen(0, '127.0.0.1', () => resolve(sv));
      });
      const origin2 = `http://127.0.0.1:${(listening2.address() as AddressInfo).port}`;
      const m = await frozen(async () => {
        const token = jwt.sign({ sub: small.client, role: 'client', site_id: small.site }, JWT_SECRET, { expiresIn: '1h' });
        const lj = (await (await fetch(`${origin2}/api/client/reports/pdf-link`, { method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ from: FROM, to: TO }) })).json()) as { url: string };
        return Buffer.from(await (await fetch(`${origin2}${lj.url}`)).arrayBuffer());
      });
      await new Promise<void>((resolve) => listening2.close(() => resolve()));
      check(m.length > 1000 && !m.equals(docs.small.base), 'B2 control: the base with the site name 1 pt lower DIFFERS');
    }

    const fNul = file(docs.large.nul, 'b-large-null.pdf');
    const fCur = file(docs.large.cur, 'b-large-letterhead.pdf');
    file(docs.small.cur, 'b-small-letterhead.pdf');
    const n = pdfPages(fCur);
    check(!docs.large.cur.equals(docs.large.nul) && n === pdfPages(fNul) && n > 5,
      `B3 with Star Guard's letterhead the report differs and keeps its page count (${n})`);
    {
      const missing: string[] = [];
      let cont = 0;
      for (let p = 1; p <= n; p++) {
        const t = pageText(fCur, p);
        const title = nullTitle(fNul, p);
        if (title.includes('(cont.)')) cont += 1;
        const sectionNo = nullSection(fNul, p);
        // The footer keeps the no-letterhead render's lead, site and period, word for word.
        const lead = nullLead(fNul, p, large.name);
        if (!lead.startsWith(`${large.name} |`) || !/\d{2}\/\d{2}\/\d{4}/.test(lead)) missing.push(`p${p} no-letterhead lead "${lead}"`);
        for (const want of ['Star Guard', '1200 Example Avenue, Suite 300, San Jose, CA 95110',
          '(408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example', 'License No. PPO 120456',
          `${lead} | Confidential — Star Guard`, 'Powered by NetraOps']) {
          if (!t.includes(flat(want))) missing.push(`p${p} "${want}"`);
        }
        // "n / 5" is drawn with its spaces; pdftotext keeps or drops them by size and alignment.
        if (!new RegExp(`(^|\\s)${sectionNo} ?/ ?5(\\s|$)`).test(t)) missing.push(`p${p} "${sectionNo} / 5"`);
        if (!title || !t.includes(title)) missing.push(`p${p} title "${title}"`);
        if (/SECURITY MANAGEMENT|Confidential — NetraOps/.test(t)) missing.push(`p${p} still carries NetraOps chrome`);
      }
      check(missing.length === 0 && cont >= 4,
        `B4 every page (${cont} of them continuation pages): the company, its contact lines, the page's own title and "n / 5", "<site>  |  <period>  |  Confidential — Star Guard", Powered by NetraOps; no NetraOps chrome (${missing.slice(0, 6).join('; ') || 'nothing missing'})`);
    }
    {
      const li = imgs(fCur);
      check(li.length === n && new Set(li.map((c) => c[10])).size === 1 && imgs(fNul).length === 0,
        `B5 one embedded logo object, drawn on each of the ${n} pages`);
    }
    {
      let moved = 0;
      let compared = 0;
      for (let p = 1; p <= n; p++) {
        // Sorted: pdftotext's reading order between equal-looking pages is not stable; text and place are.
        const body = (f: string) => words(f, p).filter((w) => w.y0 >= 75 && w.y1 <= 842 - 30)
          .map((w) => `${w.w}@${w.x0.toFixed(2)},${w.y0.toFixed(2)},${w.x1.toFixed(2)}`).sort();
        const a = body(fNul);
        compared += a.length;
        if (a.join('|') !== body(fCur).join('|')) moved += 1;
      }
      check(moved === 0 && compared > 1500, `B6 the body did not move: ${compared} words on ${n} pages, the same text at the same place and width with and without the letterhead (${moved} pages differ)`);
    }
    {
      const differ: number[] = [];
      for (let p = 1; p <= n; p++) if (!bodyPixels(fNul, p).equals(bodyPixels(fCur, p))) differ.push(p);
      const control = !bodyPixels(fNul, 1).equals(bodyPixels(fNul, 2));
      check(differ.length === 0 && control,
        `B7 the body's pixels did not change: y 76–808 pt at 200 dpi, identical on all ${n} pages (differ: ${differ.join(', ') || 'none'}); control: pages 1 and 2 differ (${control})`);
    }
    {
      const bad: string[] = [];
      const contPage = Array.from({ length: n }, (_, i) => i + 1).find((p) => nullTitle(fNul, p).includes('(cont.)')) ?? 2;
      for (const p of [1, contPage]) {
        const hw = words(fCur, p).filter((w) => w.y0 < 80);
        const outside = hw.filter((w) => w.y1 > 70 || w.x0 < 0 || w.x1 > 595 - 50 + 0.5);
        for (const w of outside) bad.push(`p${p} outside: ${w.w}`);
        for (let i = 0; i < hw.length; i++) for (let j = i + 1; j < hw.length; j++) {
          const a = hw[i]; const b = hw[j];
          if (a.x0 < b.x1 - 0.5 && b.x0 < a.x1 - 0.5 && a.y0 < b.y1 - 0.5 && b.y0 < a.y1 - 0.5) bad.push(`p${p} overlap: ${a.w}/${b.w}`);
        }
        if (hw.length < 10) bad.push(`p${p} only ${hw.length} header words`);
      }
      check(bad.length === 0, `B8 the header stays in its band on page 1 and on continuation page ${contPage}: x 0..545, y 0..70, nothing overlapping (${bad.slice(0, 5).join('; ') || 'clean'})`);
    }
    check(s3Fetches.includes(`company-logos/${STAR_GUARD}/${marker}.png`) && !sentry.some((e) => /letterhead/.test(String(e.what))),
      `B9 the logo was read from Star Guard's own key, and no letterhead warning was sent (fetches ${s3Fetches.length}, sentry ${sentry.length})`);
    {
      const r = await getPdf(theirs);
      const f = file(r.body, 'b-other-company.pdf');
      const pages = r.status === 200 ? pdfPages(f) : 0;
      const all = r.status === 200 ? Array.from({ length: pages }, (_, i) => pageText(f, i + 1)).join(' ') : r.body.toString().slice(0, 200);
      check(r.status === 200 && pages === 5 && all.includes(OTHER_NAME) && all.includes(`Confidential — ${OTHER_NAME}`)
        && !all.includes('Star Guard') && !all.includes('License No.') && !all.includes('SECURITY MANAGEMENT') && imgs(f).length === 0,
        `B10 another company's client: that company's name on all ${pages} pages, no logo, nothing of Star Guard's (${r.status})`);
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    for (const table of ['reports', 'clients', 'shift_sessions', 'shifts', 'guards', 'sites', 'companies']) {
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
