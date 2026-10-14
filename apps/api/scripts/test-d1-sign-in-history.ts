/**
 * test-d1-sign-in-history.ts — GET /api/admin/me/sign-ins, an admin's own sign-in history (Phase D, D1).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-d1-sign-in-history.ts     (from apps/api)
 *
 * Vishnu's decisions 1b and 2a (2026-10-14), within the locked 6a (own history only, no IP column). Over
 * HTTP with the real admin router, on auth_events rows written for the purpose:
 *
 *   O  only the caller's own rows: not another admin's, not a row of another role with the same id, not
 *      the event types 1b leaves out, not a row older than the 365-day retention; newest first
 *   F  each event is { at, type, device }: the time to the millisecond, the type, a device name; never the
 *      address or the raw user agent
 *   P  50 a page with a cursor, back to the end: no row missed or repeated, rows a microsecond apart across
 *      a page boundary and rows with the same instant included
 *   E  a malformed cursor is a 400; no token a 401; a guard's, client's or Vishnu's token a 403; an admin
 *      on a temporary password the N194 hold
 *   D  device names for the user agents auth_events records (admin web, guard app, curl) and the usual
 *      browsers
 *   S  admin.ts is BASE's source plus N201's zone, this route and its import
 *   M  mutation controls: the query without each of its filters, a cursor cut to milliseconds, the route
 *      open to another role, and iPhone read as macOS
 *
 * LOCAL DATABASES ONLY; fake admins on Star Guard's id. Sentry, email and S3 are stubbed.
 */
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
/** main before D1 (PR #120's merge). */
const BASE = '7245a0a95a3cfc175e4a775cbbf58471821fa2ee';
const HELD = '{"code":"PASSWORD_CHANGE_REQUIRED","error":"Change your temporary password to continue."}';

process.env.JWT_SECRET = 'test-only-d1';
process.env.JWT_REFRESH_SECRET = 'test-only-d1-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-d1-vishnu';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  if (process.env.DATABASE_URL) { console.error('REFUSING: DATABASE_URL is set.'); process.exit(2); }
}
function stubModule(name: string, overrides: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...overrides }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the D1 test`); }),
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
function compileAt(rel: string, src: string): any {
  const file = path.join(__dirname, '..', rel);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}
const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
function mutantOf(rel: string, from: string, to: string): any {
  const src = read(rel);
  if (src.split(from).length !== 2) throw new Error(`mutantOf(${rel}): ${JSON.stringify(from.slice(0, 50))} is not there exactly once`);
  return compileAt(rel, src.replace(from, to));
}

let failures = 0;
let passes = 0;
let finished = false;
process.on('beforeExit', () => { if (!finished) { console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)'); process.exitCode = 1; } });
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const show = (v: unknown) => JSON.stringify(v);

const UA = {
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  iPhoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  iPhoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0.6668.69 Mobile/15E148 Safari/604.1',
  iPadSafari: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  winEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.65',
  winChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.81 Mobile Safari/537.36',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
  chromebook: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  macOpera: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/114.0.0.0',
  guardIos: 'NetraOps/48 CFNetwork/1568.100.1 Darwin/24.0.0',
  guardAndroid: 'okhttp/4.12.0',
  curl: 'curl/8.7.1',
};
const DEVICE: Array<[string | null, string]> = [
  [UA.macChrome, 'Chrome on macOS'], [UA.macSafari, 'Safari on macOS'], [UA.iPhoneSafari, 'Safari on iPhone'],
  [UA.iPhoneChrome, 'Chrome on iPhone'], [UA.iPadSafari, 'Safari on iPad'], [UA.winEdge, 'Edge on Windows'],
  [UA.winChrome, 'Chrome on Windows'], [UA.winFirefox, 'Firefox on Windows'], [UA.androidChrome, 'Chrome on Android'],
  [UA.androidSamsung, 'Samsung Internet on Android'], [UA.linuxFirefox, 'Firefox on Linux'], [UA.chromebook, 'Chrome on ChromeOS'],
  [UA.macOpera, 'Opera on macOS'], [UA.guardIos, 'NetraOps app on iPhone'], [UA.guardAndroid, 'NetraOps app on Android'],
  [UA.curl, 'curl'], ['Mozilla/5.0 (Windows NT 10.0) SomethingNew/1.0', 'A browser on Windows'], ['', 'Unknown device'], [null, 'Unknown device'],
];

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  inject('../src/services/s3', stubModule('s3', { urlOrPresign: async (url: string | null) => url }));
  const jwt = (await import('jsonwebtoken')).default;
  const pool = ((await import('../src/db/pool')) as any).pool;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;

  const marker = `lhd1-${Date.now().toString(36)}`;
  const swept = ((await q("DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhd1-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM company_admins WHERE email LIKE 'lhd1-%'")).rowCount ?? 0);
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  const admins: string[] = [];
  let server: Server | null = null;
  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const mkAdmin = async (tag: string, temporary = false) => {
      const id = (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, 'x', false, $4) RETURNING id`,
        [STAR_GUARD, `${marker} ${tag}`, `${marker}-${tag}@test.invalid`, temporary])).rows[0].id as string;
      admins.push(id);
      return id;
    };
    const ev = (actor: string, type: string, at: string, ua: string | null = UA.macChrome, role = 'company_admin') =>
      q(`INSERT INTO auth_events (actor_id, role, event_type, ip_address, user_agent, created_at) VALUES ($1, $2, $3, '203.0.113.7', $4, $5::timestamptz)`, [actor, role, type, ua, at]);
    const tok = (sub: string, role: string) => jwt.sign({ sub, role, company_id: STAR_GUARD, iat: Math.floor(Date.now() / 1000) - 5 },
      role === 'vishnu' ? process.env.VISHNU_JWT_SECRET! : process.env.JWT_SECRET!, { expiresIn: '1h' });

    // ── A: one of every type, in and out of 1b, inside and outside 365 days; B: another admin; a guard-role row on A's id ──
    const a = await mkAdmin('a');
    const b = await mkAdmin('b');
    const now = Date.now();
    const ago = (days: number, extraMs = 0) => new Date(now - days * 86_400_000 - extraMs).toISOString();
    const IN = [
      ['login_success', ago(0, 60_000), UA.macChrome], ['login_failed', ago(1), UA.iPhoneSafari], ['login_blocked_locked', ago(2), UA.iPhoneSafari],
      ['password_changed', ago(3), UA.winEdge], ['password_reset_emailed', ago(4), null], ['login_success', ago(364), UA.curl],
    ] as const;
    for (const [t, at, ua] of IN) await ev(a, t, at, ua);
    for (const t of ['logout', 'token_refresh', 'welcome_email_resent', 'password_reset_email_failed', 'session_revoked', 'unlocked']) await ev(a, t, ago(1, 5000));
    await ev(a, 'login_success', ago(366));
    await ev(a, 'login_success', ago(0, 30_000), UA.macChrome, 'guard');
    await ev(b, 'login_success', ago(0, 10_000));
    const expectA = IN.map(([type, at, ua]) => ({ at: new Date(at).toISOString(), type, device: DEVICE.find(([u]) => u === ua)?.[1] ?? 'Unknown device' }));

    // ── C: 120 rows for paging; rows 49-51 a microsecond apart, rows 99-101 at one instant ──
    const c = await mkAdmin('c');
    const t0 = Date.parse('2026-09-01T12:00:00.000Z');
    for (let i = 0; i < 120; i += 1) {
      let at = new Date(t0 - i * 60_000).toISOString();
      // Sorted positions 49-51 (the first page ends at 49): one millisecond, three microseconds, between 11:12 and 11:08.
      if (i >= 49 && i <= 51) at = `2026-09-01T11:11:00.123${String(9 - (i - 49) * 3).padStart(3, '0')}Z`;   // .123009, .123006, .123003
      // Sorted positions 99-101 (the second page ends at 99): one instant, between 10:22 and 10:18; ids break the tie.
      if (i >= 99 && i <= 101) at = '2026-09-01T10:21:00.000000Z';
      await ev(c, 'login_success', at);
    }
    const expectC = (await q(`SELECT id::text, created_at FROM auth_events WHERE actor_id = $1 ORDER BY created_at DESC, id DESC`, [c])).rows.map((r: any) => r.id as string);
    const t = await mkAdmin('t', true);

    // ══ the real router, BASE's, and mutants ══
    const app = express();
    app.set('env', 'test');
    app.use(express.json());
    app.use('/api/admin', (await import('../src/routes/admin')).default);
    app.use('/api/admin-open', mutantOf('src/routes/admin.ts', "router.get('/me/sign-ins', requireAuth('company_admin'),", "router.get('/me/sign-ins', requireAuth('company_admin', 'vishnu'),").default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    const get = async (p: string, token?: string) => {
      const r = await fetch(`${origin}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      const text = await r.text();
      let body: any = null;
      try { body = JSON.parse(text); } catch { body = text; }
      return { status: r.status, body, raw: text };
    };
    type Page = { events: Array<Record<string, unknown>>; next: string | null };
    type Fetcher = (adminId: string, before: string | null) => Promise<Page>;
    const viaHttp: Fetcher = async (adminId, before) => (await get(`/api/admin/me/sign-ins${before ? `?before=${encodeURIComponent(before)}` : ''}`, tok(adminId, 'company_admin'))).body;
    const viaService = (svc: any): Fetcher => async (adminId, before) => {
      const cursor = svc.parseCursor(before === null ? undefined : before);
      return JSON.parse(JSON.stringify(await svc.signInHistory(adminId, cursor)));
    };
    /** Every page from the first, following `next`. */
    const all = async (f: Fetcher, adminId: string) => {
      const pages: Page[] = [];
      let before: string | null = null;
      do { const p = await f(adminId, before); pages.push(p); before = p.next; } while (before && pages.length < 10);
      return pages;
    };

    // ── the checks, each a function of the fetcher, so a mutant runs through the same one ──
    const ownProblems = async (f: Fetcher) => {
      const pa = await f(a, null);
      const pb = await f(b, null);
      const problems: string[] = [];
      if (show(pa.events) !== show(expectA) || pa.next !== null) problems.push(`A: ${show(pa.events.map((e) => `${e.type}@${String(e.at).slice(0, 16)}`))}`);
      if (pb.events.length !== 1) problems.push(`B: ${pb.events.length} events`);
      return problems;
    };
    const pageProblems = async (f: Fetcher) => {
      const pages = await all(f, c);
      const ids: string[] = [];
      for (const p of pages) for (const e of p.events) ids.push(String(e.at) + '|' + String(e.type));
      const sizes = pages.map((p) => p.events.length);
      const problems: string[] = [];
      if (show(sizes) !== '[50,50,20]') problems.push(`page sizes ${show(sizes)}`);
      const ats = pages.flatMap((p) => p.events.map((e) => String(e.at)));
      const wantAts = (await q(`SELECT created_at FROM auth_events WHERE actor_id = $1 ORDER BY created_at DESC, id DESC`, [c])).rows.map((r: any) => new Date(r.created_at).toISOString());
      if (show(ats) !== show(wantAts)) problems.push(`order or rows differ: ${ats.length} of ${wantAts.length}`);
      if (ids.length !== expectC.length) problems.push(`${ids.length} rows, want ${expectC.length}`);
      return problems;
    };

    section('O  only the caller\'s own rows, of the five types, within 365 days, newest first');
    const o = await ownProblems(viaHttp);
    check(o.length === 0, `admin A sees exactly its 6 rows of the 1b types within 365 days, newest first, and not: 6 rows of other types, a 366-day-old sign-in, a guard-role row on its id, admin B's row; B sees its 1 (${o.join('; ') || 'all right'})`);

    section('F  each event is the time, the type and a device name; never the address or the user agent');
    {
      const p = await viaHttp(a, null);
      const keys = [...new Set(p.events.map((e) => Object.keys(e).sort().join(',')))];
      const raw = (await get('/api/admin/me/sign-ins', tok(a, 'company_admin'))).raw;
      check(show(keys) === '["at,device,type"]' && !raw.includes('203.0.113.7') && !raw.includes('Mozilla') && !raw.includes('ip_address'),
        `every event has exactly at, device, type; the response never carries the address (203.0.113.7 in every row) or a raw user agent (${show(keys)})`);
      check(show(p.events.map((e) => e.device)) === show(['Chrome on macOS', 'Safari on iPhone', 'Safari on iPhone', 'Edge on Windows', 'Unknown device', 'curl']),
        `devices: ${p.events.map((e) => e.device).join(', ')}`);
    }

    section('P  50 a page, to the end, nothing missed or repeated');
    const pg = await pageProblems(viaHttp);
    check(pg.length === 0, `120 rows in pages of 50, 50 and 20, in order, with rows a microsecond apart across the first page's end and three rows at one instant across the second's (${pg.join('; ') || 'all right'})`);
    {
      const first = await viaHttp(c, null);
      check(typeof first.next === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z_[0-9a-f-]{36}$/.test(first.next), `the cursor keeps the microseconds: ${String(first.next).slice(0, 27)}…`);
    }

    section('E  errors and roles');
    {
      const bad = ['x', '2026-09-01T11:00:00.123Z_' + a, '2026-09-01T11:00:00.123009Z', `2026-09-01T11:00:00.123009Z_${a}'--`, ''];
      const statuses: number[] = [];
      for (const v of bad) statuses.push((await get(`/api/admin/me/sign-ins?before=${encodeURIComponent(v)}`, tok(a, 'company_admin'))).status);
      const twice = await get(`/api/admin/me/sign-ins?before=a&before=b`, tok(a, 'company_admin'));
      const body = (await get('/api/admin/me/sign-ins?before=x', tok(a, 'company_admin'))).body;
      check(statuses.every((s) => s === 400) && twice.status === 400 && show(body) === '{"code":"INVALID_CURSOR","error":"That page link is not valid."}',
        `malformed cursors (a word, milliseconds only, no id, a quote, empty) and two of them: 400 INVALID_CURSOR (${statuses.join(' ')} ${twice.status})`);
      const none = await get('/api/admin/me/sign-ins');
      const asGuard = await get('/api/admin/me/sign-ins', tok(a, 'guard'));
      const asClient = await get('/api/admin/me/sign-ins', tok(a, 'client'));
      const asVishnu = await get('/api/admin/me/sign-ins', tok('00000000-0000-0000-0000-000000000000', 'vishnu'));
      check(none.status === 401 && [asGuard, asClient, asVishnu].every((r) => r.status === 403),
        `no token ${none.status}; a guard's, a client's and Vishnu's token ${asGuard.status}, ${asClient.status}, ${asVishnu.status}`);
      const held = await get('/api/admin/me/sign-ins', tok(t, 'company_admin'));
      check(held.status === 403 && held.raw === HELD, `an admin on a temporary password gets N194's hold: ${held.status}`);
    }

    section('D  device names');
    {
      const { deviceLabel } = await import('../src/services/deviceLabel');
      const wrong = DEVICE.filter(([ua, want]) => deviceLabel(ua) !== want).map(([ua, want]) => `${String(ua).slice(0, 30)} → ${deviceLabel(ua)}, want ${want}`);
      check(wrong.length === 0, `${DEVICE.length} user agents named as expected (${wrong.join('; ') || 'all right'})`);
    }

    section('S  admin.ts is BASE plus N201\'s zone, this route and its import');
    {
      const base = execFileSync('git', ['show', `${BASE}:apps/api/src/routes/admin.ts`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
      const nowSrc = read('src/routes/admin.ts');
      let back = nowSrc.replace("import { parseCursor, signInHistory } from '../services/signInHistory';\n", '');
      const r0 = back.indexOf('// ── Phase D, D1: the admin\'s own sign-in history');
      const r1 = back.indexOf('export default router;', r0);
      back = r0 >= 0 && r1 >= 0 ? back.slice(0, r0) + back.slice(r1) : back;
      back = back.replace("  // N201: timezone lets the Vishnu companies page count a contract's days left\n  // at the site, not in the browser.\n", '').replace('       s.timezone,\n', '');
      check(back === base, 'with the route, its import and N201\'s zone taken out, admin.ts is BASE\'s source exactly');
    }

    section('M  mutation controls');
    {
      const svc = 'src/services/signInHistory.ts';
      const controls: Array<[string, () => Promise<string[]>]> = [
        ['the query without the actor filter: another admin\'s rows appear, which O refuses', () => ownProblems(viaService(mutantOf(svc, '      WHERE actor_id = $1\n        AND role', "      WHERE ($1::uuid IS NOT NULL)\n        AND role")))],
        ['without the role filter: the guard-role row on A\'s id appears, which O refuses', () => ownProblems(viaService(mutantOf(svc, "        AND role = 'company_admin'\n", '')))],
        ['without the type filter: logouts and refreshes appear, which O refuses', () => ownProblems(viaService(mutantOf(svc, '        AND event_type = ANY($2::text[])\n', "        AND $2::text[] IS NOT NULL\n")))],
        ['without the 365-day bound: the 366-day-old sign-in appears, which O refuses', () => ownProblems(viaService(mutantOf(svc, '        AND created_at > NOW() - make_interval(days => $3)\n', '        AND $3::int IS NOT NULL\n')))],
        ['a cursor cut to milliseconds: rows a microsecond apart are skipped, which P refuses', () => pageProblems(viaService(mutantOf(svc, "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"')", "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"000Z\"')")))],
        ['the route open to Vishnu: his token gets 200, which E refuses', async () => { const r = await get('/api/admin-open/me/sign-ins', tok('00000000-0000-0000-0000-000000000000', 'vishnu')); return r.status === 200 ? ['vishnu 200'] : []; }],
        ['iPhone read as macOS: the device names are wrong, which D refuses', async () => {
          const m = mutantOf('src/services/deviceLabel.ts', "  const os = /iPhone/.test(ua) ? 'iPhone'", "  const os = /Mac OS X/.test(ua) ? 'macOS' : /iPhone/.test(ua) ? 'iPhone'");
          return DEVICE.filter(([ua, want]) => m.deviceLabel(ua) !== want).map(([, want]) => want);
        }],
      ];
      let caught = 0;
      for (const [what, run] of controls) {
        const p = await run();
        if (p.length) caught += 1;
        check(p.length > 0, `control — ${what} (${p[0] ?? 'NOT caught'})`.slice(0, 220));
      }
      check(caught === controls.length, `${caught} of ${controls.length} mutants caught`);
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    if (admins.length) {
      await q('DELETE FROM auth_events WHERE actor_id = ANY($1::uuid[])', [admins]);
      await q('DELETE FROM company_admins WHERE id = ANY($1::uuid[])', [admins]);
    }
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int AS n`, [`${marker}%`])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
    await pool.end();
  }
  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR', err); process.exit(1); });
