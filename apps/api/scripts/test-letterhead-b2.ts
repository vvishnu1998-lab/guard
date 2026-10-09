/**
 * test-letterhead-b2.ts — the employer's letterhead on the guard's own hours PDF
 * (Phase B, stage B2; surface #3).
 *
 *   PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-letterhead-b2.ts     (from apps/api)
 *
 * Needs poppler (pdftotext, pdfimages) and git: the "before" side of every identity
 * check is services/pdf/guardHours.ts as it was at BASE (main before B2), read from
 * git and compiled beside the current one. LOCAL DATABASES ONLY; fake data on Star
 * Guard's id and on an invented company. Sentry, email, S3 and Firebase are stubbed.
 *
 *   G  the renderer: no letterhead gives the same bytes as at BASE (lh absent and
 *      null; a 9-row and a 120-row document), with a control; with one, every
 *      page carries it, one logo object, the body does not move, the header stays
 *      in its band
 *   H  GET /api/shifts/my-hours.pdf over HTTP through the real router: a guard
 *      gets their own employer's letterhead and logo, never another company's; and
 *      when the lookup gives null, the route's PDF is byte for byte the BASE route's
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
/** main before B2: PR #98's merge. */
const BASE = 'ee347219d39ee951be186bdd91c7b8be2bffd733';
const T0 = '2026-10-09T19:00:00Z';
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const JWT_SECRET = 'test-only-letterhead-b2';
const S3_HOST = 'test-bucket.s3.us-east-1.amazonaws.com';

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
      : () => { throw new Error(`${name}.${String(prop)} called in the B2 letterhead test`); }),
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
  website: 'https://www.starguard.example/', logo: LOGO,
};

/** The guard-hours document the B0 harness renders: n rows over 2026-09-01..2026-10-04. */
function ghDoc(n: number, lh?: unknown): any {
  return {
    guardName: 'Sample Guard', badgeNumber: 'GRD0099', employer: 'Star Guard',
    from: '2026-09-01', to: '2026-10-04', timeZone: 'America/Los_Angeles',
    generatedAt: new RealDate('2026-10-06T19:00:00Z'),
    rows: Array.from({ length: n }, (_, i) => {
      const start = new RealDate(RealDate.UTC(2026, 8, 1 + (i % 34), 14, 0, 0));
      return {
        session_id: `00000000-0000-4000-8000-${String(100000000000 + i)}`, shift_id: `00000000-0000-4000-9000-${String(100000000000 + i)}`,
        clocked_in_at: new RealDate(start.getTime() + 4 * 60e3), clocked_out_at: new RealDate(start.getTime() + 8 * 3600e3 - 2 * 60e3),
        scheduled_start: start, scheduled_end: new RealDate(start.getTime() + 8 * 3600e3),
        handed_off: i === 3, took_over: i === 4, legacy_break: i === 5,
        site_name: i % 2 ? 'Sample Site North' : 'Sample Site South',
        scheduled_hours: 8, actual_hours: 7.9, break_hours: 0.5, violation_hours: i % 7 === 6 ? 0.25 : 0,
      };
    }),
    ...(lh === undefined ? {} : { lh }),
  };
}

async function main(): Promise<void> {
  refuseUnlessLocal();
  if (spawnSync('pdftotext', ['-v']).status !== 0 || spawnSync('pdfimages', ['-v']).status !== 0) {
    console.error('poppler (pdftotext, pdfimages) is required.');
    process.exit(2);
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

  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'letterhead-b2-'));
  const file = (buf: Buffer, name: string) => { const f = path.join(TMP, name); fs.writeFileSync(f, buf); return f; };
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
  const pageCount = (t: string, n: number, of: number) => new RegExp(`(^|\\s)${n} ?/ ?${of}(\\s|$)`).test(t);

  /** Render a guard-hours document with `mod` into a Buffer. */
  async function render(mod: any, doc: unknown): Promise<Buffer> {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise<void>((r) => sink.on('end', () => r()));
    await mod.renderGuardHoursPdf(doc, sink);
    await ended;
    return Buffer.concat(chunks);
  }

  // ══════════════════════════════════════════════════════════════════════════
  section(`G  the guard hours renderer — no letterhead: the same bytes as at ${BASE.slice(0, 7)}; with one: on every page, and nothing else moves`);
  const baseGH = loadBase('src/services/pdf/guardHours.ts');
  const curGH = require('../src/services/pdf/guardHours');
  check(!String(baseGH.renderGuardHoursPdf).includes('data.lh') && String(curGH.renderGuardHoursPdf).includes('data.lh'),
    'G0 the base renderer predates the letterhead; the current one takes it');
  for (const n of [9, 120]) {
    const before = await frozen(() => render(baseGH, ghDoc(n)));
    const absent = await frozen(() => render(curGH, ghDoc(n)));
    const nul = await frozen(() => render(curGH, ghDoc(n, null)));
    check(before.equals(absent) && before.equals(nul),
      `G1 ${n} rows: base ${sha(before)} = lh absent ${sha(absent)} = lh null ${sha(nul)} (${pdfPages(file(nul, `g1-${n}.pdf`))} pages)`);
  }
  {
    const mutant = loadBase('src/services/pdf/guardHours.ts', (src) => src.replace(".text(data.guardName, ML, y);", ".text(data.guardName, ML, y + 1);"));
    check(!(await frozen(() => render(mutant, ghDoc(9)))).equals(await frozen(() => render(curGH, ghDoc(9)))),
      'G2 control: the base with the guard name 1 pt lower DIFFERS');
  }
  const plain = await frozen(() => render(curGH, ghDoc(120)));
  const withLh = await frozen(() => render(curGH, ghDoc(120, FULL)));
  const fp = file(plain, 'g-plain.pdf');
  const fl = file(withLh, 'g-letterhead.pdf');
  const n = pdfPages(fl);
  check(!withLh.equals(plain) && n === pdfPages(fp) && n >= 2, `G3 with a letterhead the document differs and keeps its page count (${n})`);
  {
    const missing: string[] = [];
    for (let p = 1; p <= n; p++) {
      const t = pageText(fl, p);
      for (const want of ['Star Guard', '1200 Example Avenue, Suite 300, San Jose, CA 95110',
        '(408) 555-0142  ·  dispatch@starguard.example  ·  www.starguard.example', 'License No. PPO 120456',
        'GUARD HOURS', 'Sample Guard (GRD0099)  |', 'Confidential — Star Guard', 'Powered by NetraOps']) {
        if (!t.includes(flat(want))) missing.push(`p${p} "${want}"`);
      }
      if (!pageCount(t, p, n)) missing.push(`p${p} "${p} / ${n}"`);
      if (/SECURITY MANAGEMENT|Confidential — NetraOps/.test(t)) missing.push(`p${p} still carries NetraOps chrome`);
    }
    check(missing.length === 0, `G4 every page: the company, its contact lines, GUARD HOURS, "n / ${n}", "<guard> (<badge>)  |  <period>  |  Confidential — Star Guard", Powered by NetraOps; no NetraOps chrome (${missing.join('; ') || 'nothing missing'})`);
  }
  {
    const li = imgs(fl);
    check(li.length === n && new Set(li.map((c) => c[10])).size === 1 && imgs(fp).length === 0,
      `G5 one embedded logo object, drawn on each of the ${n} pages`);
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
    check(moved === 0 && compared > 200, `G6 the body did not move: ${compared} words on ${n} pages, the same text at the same place with and without the letterhead (${moved} pages differ)`);
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
      `G7 page 1 header: ${hw.length} words, all inside x 0..545 y 0..70, none overlapping (outside ${outside.map((w) => w.w).join(' ') || 'none'}; overlaps ${overlaps.join(' ') || 'none'})`);
  }

  // ══ the database and the route ══
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  await import('express-async-errors');
  const express = (await import('express')).default;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const marker = `lhb2-${RealDate.now().toString(36)}`;
  const seeded: Record<string, string[]> = { shift_sessions: [], shifts: [], guards: [], sites: [], companies: [] };
  const ins = async (table: string, sql: string, params: unknown[]) => {
    const id = (await q(sql, params)).rows[0].id as string;
    seeded[table].push(id);
    return id;
  };
  // Rows an earlier run left behind, swept by this harness's own markers before anything is written.
  for (const sql of [
    "DELETE FROM shift_sessions WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb2-%')",
    "DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb2-%')",
    "DELETE FROM guards WHERE email LIKE 'lhb2-%'",
    "DELETE FROM sites WHERE name LIKE 'lhb2-%'",
    "DELETE FROM companies WHERE name LIKE 'Fixture Patrol lhb2-%'",
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
       `https://${S3_HOST}/${logoKey}`, new RealDate('2026-10-09T18:00:00Z')]);
    const OTHER_NAME = `Fixture Patrol ${marker}`;
    const other = await ins('companies', 'INSERT INTO companies (name) VALUES ($1) RETURNING id', [OTHER_NAME]);
    async function guardWithShifts(companyId: string, tag: string, days: number) {
      const site = await ins('sites', `INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1200 Example Avenue, San Jose', '2026-01-01') RETURNING id`,
        [companyId, `${marker} ${tag} Gate`]);
      const guard = await ins('guards', `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
        [companyId, `Fixture Guard ${tag}`, `${marker}-${tag}@test.invalid`, `GRD98${tag === 'A' ? '01' : '02'}`]);
      for (let d = 0; d < days; d++) {
        const start = new RealDate(RealDate.UTC(2026, 8, 15 + d, 15, 0, 0));
        const shift = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status) VALUES ($1, $2, $3, $4, 'completed') RETURNING id`,
          [site, guard, start, new RealDate(start.getTime() + 8 * 3600e3)]);
        await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords)
          VALUES ($1, $2, $3, $4, $5, '37.33,-121.89') RETURNING id`,
          [shift, guard, site, new RealDate(start.getTime() + 3 * 60e3), new RealDate(start.getTime() + 8 * 3600e3 - 5 * 60e3)]);
      }
      return guard;
    }
    const guardA = await guardWithShifts(STAR_GUARD, 'A', 3);
    const guardB = await guardWithShifts(other, 'B', 1);

    const app = express();
    app.use(express.json());
    app.use('/api/shifts', (await import('../src/routes/shifts')).default);
    // The route as it was at BASE, read from git, and a second copy of the CURRENT route whose
    // letterhead lookup returns null (as it does on any failure). Both under their own prefixes.
    app.use('/api/shifts-base', loadBase('src/routes/shifts.ts').default);
    {
      const shiftsPath = require.resolve('../src/routes/shifts');
      const lhPath = require.resolve('../src/services/letterhead');
      const realShifts = require.cache[shiftsPath];
      const realLh = require.cache[lhPath];
      delete require.cache[shiftsPath];
      inject('../src/services/letterhead', { __esModule: true, letterheadForGuard: async () => null,
        letterheadForCompany: async () => null, letterheadForSite: async () => null });
      app.use('/api/shifts-null', require('../src/routes/shifts').default);
      require.cache[shiftsPath] = realShifts;
      if (realLh) require.cache[lhPath] = realLh; else delete require.cache[lhPath];
    }
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    // Signed inside the frozen clock, so iat and exp are relative to T0, the instant the route sees.
    const get = (sub: string, companyId: string, prefix = '/api/shifts') => frozen(async () => {
      const token = jwt.sign({ sub, role: 'guard', company_id: companyId }, JWT_SECRET, { expiresIn: '1h' });
      const r = await fetch(`${origin}${prefix}/my-hours.pdf?from=2026-09-14&to=2026-09-20`, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, type: r.headers.get('content-type') ?? '', count: r.headers.get('x-netraops-shift-count'), body: Buffer.from(await r.arrayBuffer()) };
    });

    // ══════════════════════════════════════════════════════════════════════════
    section('H  GET /api/shifts/my-hours.pdf over HTTP: each guard gets their own employer\'s letterhead');
    {
      const r = await get(guardA, STAR_GUARD);
      const f = file(r.body, 'h-star-guard.pdf');
      const t = r.status === 200 ? pageText(f, 1) : r.body.toString().slice(0, 200);
      check(r.status === 200 && r.type.startsWith('application/pdf') && r.count === '3' && t.includes('Fixture Guard A')
        && t.includes('Star Guard') && t.includes('License No. PPO 120456') && t.includes('Confidential — Star Guard') && t.includes('Powered by NetraOps')
        && imgs(f).length === pdfPages(f),
        `H1 Star Guard's guard: 200, their 3 shifts under Star Guard's letterhead and logo (${r.status}, X-NetraOps-Shift-Count ${r.count}: ${t.slice(0, 90)})`);
      check(s3Fetches.includes(logoKey) && !sentry.some((e) => /letterhead/.test(String(e.what))),
        `H2 the logo was read from Star Guard's own key, and no letterhead warning was sent (fetches ${s3Fetches.length}, sentry ${sentry.length})`);
    }
    {
      const r = await get(guardB, other);
      const f = file(r.body, 'h-other.pdf');
      const t = r.status === 200 ? pageText(f, 1) : '';
      check(r.status === 200 && r.count === '1' && t.includes(OTHER_NAME) && t.includes(`Confidential — ${OTHER_NAME}`)
        && !t.includes('Star Guard') && !t.includes('License No.') && imgs(f).length === 0,
        `H3 the other company's guard: its own employer's name, no logo, nothing of Star Guard's (${r.status})`);
    }
    {
      const b = await get(guardA, STAR_GUARD, '/api/shifts-base');
      const nul = await get(guardA, STAR_GUARD, '/api/shifts-null');
      const cur = await get(guardA, STAR_GUARD);
      check(b.status === 200 && nul.status === 200 && b.body.equals(nul.body) && !cur.body.equals(nul.body) && b.count === nul.count,
        `H4 a lookup that gives null: the route's PDF is the base route's, byte for byte (${sha(b.body)} = ${sha(nul.body)}); with the letterhead it differs (${sha(cur.body)})`);
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    for (const table of ['shift_sessions', 'shifts', 'guards', 'sites', 'companies']) {
      if (seeded[table].length) await q(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [seeded[table]]);
    }
    if (priorStarGuard) {
      await q(`UPDATE companies SET ${PROFILE.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [STAR_GUARD, ...PROFILE.map((c) => priorStarGuard[c])]);
    } else {
      await q('DELETE FROM companies WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM sites WHERE company_id = $1)', [STAR_GUARD]);
    }
    const left = (await q(`SELECT (SELECT count(*) FROM sites WHERE name LIKE $1)::int + (SELECT count(*) FROM guards WHERE email LIKE $1)::int
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
