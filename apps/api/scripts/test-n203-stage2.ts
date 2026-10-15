/**
 * test-n203-stage2.ts — N203 stage 2, the API's half: the cookie web's sessions are not handed to the page (3b),
 * an admin's preview reaches the client portal as its cookie (N206), and the guard/mobile sign-in is unchanged.
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n203-stage2.ts     (from apps/api)
 *
 * Vishnu, 2026-10-15: "1a 2a 3b 4a. 3b: stop returning tokens in the body only for web portal sign-ins from
 * production netraops.com origins. Previews keep the body tokens. The guard/mobile login must be byte-identical;
 * prove it." Over HTTP, through the real routers:
 *
 *   B  3b: an admin, client or Vishnu sign-in from a production netraops.com origin that names its portal (the web
 *      after stage 2) gets its session as the cookie only: no access or refresh token in the body, the rest of the
 *      body as before. The same sign-in without the portal named (a tab still on the web before stage 2), from a
 *      Vercel preview, from localhost, or with no origin: the tokens, as before. A client's site switch follows
 *      the same rule
 *   P  N206: an admin's "Preview as client" from the cookie web sets the client portal's cookie for the preview's
 *      30 minutes, with no token in the body; the cookie reads the client portal and writes nothing; from a
 *      preview origin the token comes in the body and no cookie
 *   G  the guard/mobile sign-in, refresh and sign-out: the router as it was at BASE and the router now answer the
 *      same requests (with and without an origin and a portal name, with a device token, refused, malformed) with
 *      the same status, the same headers and the same body byte for byte once the two tokens are set aside, and
 *      the tokens carry the same claims; the guard sign-in route's source is BASE's, and 541a6e1's, to the byte
 *   M  mutation controls
 *
 * LOCAL DATABASES ONLY; a fake admin, client and guard on Star Guard's id. Sentry, email and S3 are stubbed.
 */
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
/** main before N203 stage 2 (PR #124's merge). */
const BASE = '51814bca7831b43687109fd80974b20a09815c40';
/** main before N203 (PR #123's merge). */
const BEFORE_N203 = '541a6e107f23d4d0a5517185f742fa09fc1ee55d';
const WWW = 'https://www.netraops.com';
const APEX = 'https://netraops.com';
const APP = 'https://app.netraops.com';
const LOCAL_WEB = 'http://localhost:3105';
const PREVIEW = 'https://guard-git-feat-x-vvishnu1998-labs-projects.vercel.app';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const IPHONE_APP = 'NetraOps/1.0.18 CFNetwork/1568.300.101 Darwin/24.2.0';

process.env.JWT_SECRET = 'test-only-n203s2';
process.env.JWT_REFRESH_SECRET = 'test-only-n203s2-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-n203s2-vishnu';
process.env.ALLOWED_ORIGINS = `${WWW},${APEX},${APP},${LOCAL_WEB}`;
process.env.VISHNU_EMAIL = 'lhn203s2-vishnu@test.invalid';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  if (process.env.DATABASE_URL) { console.error('REFUSING: DATABASE_URL is set.'); process.exit(2); }
}
function stubModule(name: string, overrides: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...overrides }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the N203 stage 2 test`); }),
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
const gitShow = (sha: string, rel: string) => execFileSync('git', ['show', `${sha}:apps/api/${rel}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
function once(s: string, from: string, to: string): string {
  if (s.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from.slice(0, 70))}`);
  return s.replace(from, to);
}
/** A mutant's source, made before anything runs: one that no longer applies throws instead of reading as caught. */
const mutantOf = (rel: string, edit: (s: string) => string) => { const src = edit(read(rel)); return () => compileAt(rel, src); };

let failures = 0;
let passes = 0;
let finished = false;
process.on('beforeExit', () => { if (!finished) { console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)'); process.exitCode = 1; } });
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const show = (v: unknown) => JSON.stringify(v);
const pw = () => `T${crypto.randomBytes(12).toString('base64url')}`;
const claims = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
const jwtHeader = (t: string) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString());

type Res = { status: number; body: any; raw: string; cookies: string[]; headers: Record<string, string | string[] | undefined> };
type Headers = Record<string, string | undefined>;
function request(origin: string, method: string, p: string, h: Headers, body?: unknown, ua = MAC_CHROME): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(origin + p);
    const headers: Record<string, string> = { 'user-agent': ua };
    for (const [k, v] of Object.entries(h)) if (v !== undefined) headers[k] = v;
    const data = body === undefined ? undefined : JSON.stringify(body);
    if (data !== undefined) headers['content-type'] = 'application/json';
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers }, (r) => {
      let raw = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { raw += c; });
      r.on('end', () => {
        let json: any = null;
        try { json = JSON.parse(raw); } catch { json = null; }
        const sc = r.headers['set-cookie'];
        resolve({ status: r.statusCode ?? 0, body: json, raw, cookies: Array.isArray(sc) ? sc : sc ? [sc] : [], headers: r.headers });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const bearer = (t: string, origin?: string): Headers => ({ authorization: `Bearer ${t}`, origin });
const named = (portal: string, origin?: string): Headers => ({ 'x-netraops-portal': portal, origin });
const viaCookie = (portal: string, t: string, origin?: string): Headers => ({ cookie: `netraops_${portal}_session=${t}`, 'x-netraops-portal': portal, origin });
const cookieValue = (r: Res, portal: string) => (r.cookies.find((c) => c.startsWith(`netraops_${portal}_session=`)) ?? '').split(';')[0].split('=')[1] ?? '';

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  inject('../src/services/s3', stubModule('s3', { urlOrPresign: async (url: string | null) => url, presignAll: async (x: unknown) => x }));
  inject('../src/services/firebase', stubModule('firebase'));
  const bcrypt = (await import('bcrypt')).default;
  const vishnuPassword = pw();
  process.env.VISHNU_PASSWORD_HASH = await bcrypt.hash(vishnuPassword, 4);
  const pool = ((await import('../src/db/pool')) as any).pool;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;
  const authRouter = (await import('../src/routes/auth')).default;
  const adminRouter = (await import('../src/routes/admin')).default;
  const clientRouter = (await import('../src/routes/clientPortal')).default;
  const baseAuthRouter = compileAt('src/routes/auth.ts', gitShow(BASE, 'src/routes/auth.ts')).default;
  const session: any = await import('../src/services/webSession');

  const marker = `lhn203s2-${Date.now().toString(36)}`;
  const runStart = new Date();
  const swept = ((await q("DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn203s2-%' UNION ALL SELECT id FROM clients WHERE email LIKE 'lhn203s2-%' UNION ALL SELECT id FROM guards WHERE email LIKE 'lhn203s2-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM guard_devices WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn203s2-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM login_attempts WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn203s2-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM guard_site_assignments WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn203s2-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM client_sites WHERE client_id IN (SELECT id FROM clients WHERE email LIKE 'lhn203s2-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM admin_client_previews WHERE admin_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn203s2-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM clients WHERE email LIKE 'lhn203s2-%'")).rowCount ?? 0)
    + ((await q("DELETE FROM guards WHERE email LIKE 'lhn203s2-%'")).rowCount ?? 0)
    + ((await q("DELETE FROM company_admins WHERE email LIKE 'lhn203s2-%'")).rowCount ?? 0)
    + ((await q("DELETE FROM sites WHERE name LIKE 'lhn203s2-%'")).rowCount ?? 0);
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  const ids = { admins: [] as string[], clients: [] as string[], guards: [] as string[], sites: [] as string[] };
  const keys = new Set<string>();
  const seen = (...tokens: Array<string | undefined>) => {
    for (const t of tokens) {
      if (!t || t.split('.').length !== 3) continue;
      const c = claims(t);
      if (c.jti) keys.add(c.jti);
      if (c.sid) keys.add(`sid:${c.sid}`);
    }
  };
  const servers: Server[] = [];
  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const site = async (name: string) => {
      const id = (await q(`INSERT INTO sites (company_id, name, address, contract_start, contract_end) VALUES ($1, $2, '1 Example Way', '2026-01-01', '2026-12-31') RETURNING id`, [STAR_GUARD, `${marker} ${name}`])).rows[0].id as string;
      ids.sites.push(id);
      return id;
    };
    const north = await site('North');
    const south = await site('South');
    const A = { email: `${marker}-a@test.invalid`, password: pw(), id: '' };
    A.id = (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, $4, true, false) RETURNING id`,
      [STAR_GUARD, `${marker} a`, A.email, await bcrypt.hash(A.password, 4)])).rows[0].id;
    ids.admins.push(A.id);
    const C = { email: `${marker}-c@test.invalid`, password: pw(), id: '' };
    C.id = (await q(`INSERT INTO clients (site_id, company_id, name, email, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [north, STAR_GUARD, `${marker} c`, C.email, await bcrypt.hash(C.password, 4)])).rows[0].id;
    for (const s of [north, south]) await q('INSERT INTO client_sites (client_id, site_id) VALUES ($1, $2)', [C.id, s]);
    ids.clients.push(C.id);
    const G = { email: `${marker}-g@test.invalid`, password: pw(), id: '' };
    G.id = (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
      [STAR_GUARD, `${marker} g`, G.email, await bcrypt.hash(G.password, 4), `LHS2-${marker.slice(-6)}`])).rows[0].id;
    ids.guards.push(G.id);
    await q(`INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) VALUES ($1, $2, '2026-01-01')`, [G.id, north]);
    const V = { email: process.env.VISHNU_EMAIL!, password: vishnuPassword };

    async function serve(routers: { admin?: any; auth?: any } = {}): Promise<string> {
      const app = express();
      app.set('trust proxy', 1);
      app.set('env', 'test');
      app.use(express.json());
      app.use('/api/auth', routers.auth ?? authRouter);
      app.use('/api/auth-base', baseAuthRouter);
      app.use('/api/admin', routers.admin ?? adminRouter);
      app.use('/api/client', clientRouter);
      const sv: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      servers.push(sv);
      return `http://127.0.0.1:${(sv.address() as AddressInfo).port}`;
    }
    const api = await serve();
    const call = (method: string, p: string, h: Headers, body?: unknown, ua?: string) => request(api, method, p, h, body, ua);
    const signIn = async (portal: 'admin' | 'client' | 'vishnu', who: { email: string; password: string }, h: Headers, at = api) => {
      const r = await request(at, 'POST', `/api/auth/${portal}/login`, h, { email: who.email, password: who.password });
      seen(r.body?.access, r.body?.refresh, cookieValue(r, portal));
      return r;
    };

    // ══════════════════════════════════════════════════════════════════════════
    section('B  3b: the cookie web\'s sign-in gets no token in the body; everyone else still does');
    async function bProblems(at: string): Promise<string[]> {
      const problems: string[] = [];
      for (const [portal, who] of [['admin', A], ['client', C], ['vishnu', V]] as const) {
        const rest = portal === 'admin' ? 'must_change_password' : portal === 'client' ? 'must_change_password,sites' : '';
        for (const origin of [WWW, APEX, APP]) {
          const r = await signIn(portal, who, named(portal, origin), at);
          const sess = cookieValue(r, portal);
          if (r.status !== 200 || Object.keys(r.body ?? {}).sort().join(',') !== rest || 'access' in r.body || 'refresh' in r.body
            || !sess || claims(sess).role !== (portal === 'admin' ? 'company_admin' : portal) || !claims(sess).sid) {
            problems.push(`${portal} from ${origin}, portal named: ${r.status} body ${Object.keys(r.body ?? {}).join(',')} cookie ${sess ? 'set' : 'none'}`);
          }
        }
        const others: Array<[string, Headers]> = [
          ['www, no portal named (a tab on the web before stage 2)', { origin: WWW }],
          ['a Vercel preview, portal named', named(portal, PREVIEW)],
          ['localhost, portal named', named(portal, LOCAL_WEB)],
          ['no origin, portal named', named(portal)],
          ['www, a name that is no portal', { origin: WWW, 'x-netraops-portal': 'toString' }],
        ];
        for (const [what, h] of others) {
          const r = await signIn(portal, who, h, at);
          const keys = Object.keys(r.body ?? {}).sort().join(',');
          const want = ['access', 'refresh', ...(rest ? rest.split(',') : [])].sort().join(',');
          if (r.status !== 200 || keys !== want) problems.push(`${portal} ${what}: ${r.status} body ${keys}`);
        }
      }
      return problems;
    }
    const b = await bProblems(api);
    check(b.length === 0, `admin, client and Vishnu from ${WWW}, ${APEX} and ${APP} with the portal named: no access or refresh token in the body, the rest of the body as before, the session in the cookie; with no portal named, from a Vercel preview, from localhost, with no origin, or a name that is no portal: the tokens as before (${b.join('; ') || 'all right'})`);
    {
      const c = await signIn('client', C, named('client', WWW));
      const sw = await call('POST', '/api/client/switch-site', viaCookie('client', cookieValue(c, 'client'), WWW), { site_id: south });
      const s1 = await signIn('client', C, { origin: WWW });
      const old = await call('POST', '/api/client/switch-site', bearer(s1.body.access, WWW), { site_id: south });
      seen(cookieValue(sw, 'client'), old.body?.access, old.body?.refresh, cookieValue(old, 'client'));
      check(sw.status === 200 && sw.raw === '{}' && claims(cookieValue(sw, 'client')).site_id === south && old.status === 200 && Object.keys(old.body).sort().join(',') === 'access,refresh',
        `a site switch from the cookie web: ${sw.status} ${sw.raw}, the new site in the cookie; from a tab before stage 2 (bearer, no portal named): ${old.status} with ${Object.keys(old.body ?? {}).sort().join(',')}`);
    }

    section('P  N206: "Preview as client" reaches the client portal as its cookie');
    async function pRun(at: string) {
      const a = await signIn('admin', A, named('admin', WWW), at);
      const pv = await request(at, 'POST', `/api/admin/sites/${north}/preview-client-token`, viaCookie('admin', cookieValue(a, 'admin'), WWW), {});
      const tok = cookieValue(pv, 'client');
      const readC = tok ? await request(at, 'GET', '/api/client/site', viaCookie('client', tok)) : null;
      const writeC = tok ? await request(at, 'POST', '/api/client/switch-site', viaCookie('client', tok, WWW), { site_id: south }) : null;
      const b2 = await signIn('admin', A, { origin: PREVIEW }, at);
      const pvb = await request(at, 'POST', `/api/admin/sites/${north}/preview-client-token`, bearer(b2.body.access, PREVIEW), {});
      return { pv, tok, readC, writeC, pvb };
    }
    const pr = await pRun(api);
    const previewCookie = pr.pv.cookies.find((c) => c.startsWith('netraops_client_session=')) ?? '';
    check(pr.pv.status === 200 && pr.pv.raw === '{"expires_in":1800}' && /; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=1800$/.test(previewCookie)
      && claims(pr.tok).scope === 'preview' && claims(pr.tok).site_id === north,
      `from the cookie web: ${pr.pv.status} ${pr.pv.raw}; the client portal's cookie holds the preview token for 1800 s (${previewCookie.replace(/=[^;]+/, '=…')})`);
    check(pr.readC?.status === 200 && pr.readC.body?.id === north && pr.writeC?.status === 403 && pr.writeC.raw === '{"error":"Preview tokens are read-only"}',
      `the preview cookie reads the client portal (${pr.readC?.status}, the site) and writes nothing (${pr.writeC?.status} ${pr.writeC?.raw})`);
    check(pr.pvb.status === 200 && typeof pr.pvb.body?.access_token === 'string' && pr.pvb.body.expires_in === 1800 && pr.pvb.cookies.length === 0,
      `from a Vercel preview (bearer): ${pr.pvb.status}, the token in the body, no cookie (${show(pr.pvb.cookies)})`);

    section('G  the guard/mobile sign-in is the same, byte for byte');
    const span = (s: string) => s.slice(s.indexOf("router.post('/guard/login'"), s.indexOf("router.post('/guard/change-password'"));
    const routeNow = span(read('src/routes/auth.ts'));
    check(routeNow.length > 4000 && routeNow === span(gitShow(BASE, 'src/routes/auth.ts')) && routeNow === span(gitShow(BEFORE_N203, 'src/routes/auth.ts')),
      `the guard sign-in route (${routeNow.length} characters) is ${BASE.slice(0, 7)}'s and ${BEFORE_N203.slice(0, 7)}'s to the byte`);
    const DROP = new Set(['date', 'etag', 'connection', 'keep-alive']);
    /** A response with its two tokens set aside: status, headers, body, and what the tokens carry. */
    const face = (r: Res) => {
      let raw = r.raw;
      const toks: string[] = [];
      for (const k of ['access', 'refresh']) if (typeof r.body?.[k] === 'string') { toks.push(r.body[k]); raw = raw.replace(r.body[k], `<${k}>`); }
      const headers = Object.keys(r.headers).filter((k) => !DROP.has(k)).sort().map((k) => `${k}: ${show(r.headers[k])}`);
      const toks2 = toks.map((t) => { const { jti: _j, iat: _i, exp, ...c } = claims(t); return show({ header: jwtHeader(t), claims: c, life: exp - claims(t).iat }); });
      return { status: r.status, headers, raw, tokens: toks2 };
    };
    async function gRun(prefix: string) {
      const out: Array<[string, ReturnType<typeof face>]> = [];
      const login = (h: Headers, body: unknown) => request(api, 'POST', `${prefix}/guard/login`, h, body, IPHONE_APP);
      const cases: Array<[string, Headers, unknown]> = [
        ['no origin', {}, { email: G.email, password: G.password }],
        ['from www with a portal named', named('admin', WWW), { email: G.email, password: G.password }],
        ['a device token', { 'x-netraops-client': 'ios/1.0.18/48/1.0.18/update/abc' }, { email: G.email, password: G.password, fcm_token: `ExponentPushToken[${marker}]` }],
        ['a wrong password', {}, { email: G.email, password: 'not-the-password' }],
        ['no password', {}, { email: G.email }],
        ['a password that is not text', {}, { email: G.email, password: 12345678 }],
      ];
      let last: Res | null = null;
      for (const [what, h, body] of cases) {
        const r = await login(h, body);
        seen(r.body?.access, r.body?.refresh);
        out.push([`sign-in, ${what}`, face(r)]);
        if (r.status === 200) last = r;
      }
      await q('UPDATE login_attempts SET failed_count = 0, locked_at = NULL WHERE guard_id = $1', [G.id]);
      const fresh = await login({}, { email: G.email, password: G.password });
      seen(fresh.body?.access, fresh.body?.refresh);
      const rf = await request(api, 'POST', `${prefix}/refresh`, {}, { refresh_token: fresh.body.refresh }, IPHONE_APP);
      seen(rf.body?.access, rf.body?.refresh);
      out.push(['refresh', face(rf)]);
      const lo = await request(api, 'POST', `${prefix}/logout`, bearer(rf.body.access), { refresh_token: rf.body.refresh }, IPHONE_APP);
      out.push(['sign-out', face(lo)]);
      const after = await request(api, 'POST', `${prefix}/refresh`, {}, { refresh_token: rf.body.refresh }, IPHONE_APP);
      out.push(['the refresh token after sign-out', face(after)]);
      void last;
      return out;
    }
    const gBase = await gRun('/api/auth-base');
    const gNow = await gRun('/api/auth');
    const diffs = gNow.map(([what, f], i) => (show(f) === show(gBase[i]?.[1]) ? null : `${what}: now ${show(f).slice(0, 160)} | BASE ${show(gBase[i]?.[1]).slice(0, 160)}`)).filter(Boolean);
    check(diffs.length === 0 && gNow.length === 9,
      `${gNow.length} requests (the sign-in with no origin, from www with a portal named, with a device token, refused, malformed twice; refresh; sign-out; the refresh token after it): the same status, headers and body byte for byte with the tokens set aside, and tokens with the same header, claims and lifetime (${diffs.join(' || ') || 'all identical'})`);
    check(gNow[0][1].tokens.length === 2 && gNow[1][1].tokens.length === 2 && gNow[1][1].raw.includes('"access":"<access>","refresh":"<refresh>"'),
      `a guard signing in from www with a portal named still gets both tokens in the body (${gNow[1][1].raw.slice(0, 80)})`);

    section('M  mutation controls');
    {
      let caught = 0;
      const WS = 'src/services/webSession.ts';
      /** bodyTokens on 12 requests: which keep the tokens. */
      const bodies = (m: any) => {
        const cases: Array<[string | undefined, string | undefined]> = [
          [WWW, 'admin'], [APEX, 'client'], [APP, 'vishnu'], [WWW, undefined], [PREVIEW, 'admin'], [LOCAL_WEB, 'admin'],
          [undefined, 'admin'], [WWW, 'toString'], ['https://evil.netraops.com', 'admin'], ['http://www.netraops.com', 'admin'], [WWW, 'Admin'], [WWW, 'admin, client'],
        ];
        return cases.map(([origin, portal]) => Object.keys(m.bodyTokens({ headers: { ...(origin ? { origin } : {}), ...(portal ? { 'x-netraops-portal': portal } : {}) } }, { access: 'a', refresh: 'r' })).length);
      };
      const realBodies = bodies(session);
      check(show(realBodies) === show([0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2]), `M0 bodyTokens on 12 requests keeps the tokens on all but the three production origins with a portal named: ${show(realBodies)}`);
      const wsMutants: Array<[string, (s: string) => string]> = [
        ['tokens dropped for everyone, previews and the app included, which B refuses', (s) => once(s, '  return isCookieWebRequest(req) ? {} : tokens;\n', '  return {};\n')],
        ['tokens dropped without a portal named, which breaks a tab on the web before stage 2, which B refuses', (s) => once(s, "  if (!isAllowedOrigin(origin) || typeof named !== 'string' || !PORTALS.includes(named as Portal)) return false;\n", '  if (!isAllowedOrigin(origin)) return false;\n')],
        ['tokens dropped for any allowed origin, localhost included, which B refuses', (s) => once(s, "    return url.protocol === 'https:' && (url.hostname === 'netraops.com' || url.hostname.endsWith('.netraops.com'));\n", '    return !!url;\n')],
      ];
      for (const [what, edit] of wsMutants) {
        const got = bodies(compileAt(WS, edit(read(WS))));
        const differs = show(got) !== show(realBodies);
        if (differs) caught += 1;
        check(differs, `control — ${what}: ${show(got)}`);
      }
      const ADMIN = 'src/routes/admin.ts';
      const routeMutants: Array<[string, () => any, (r: Awaited<ReturnType<typeof pRun>>) => boolean]> = [
        ['a preview that sets no cookie, which P refuses',
          mutantOf(ADMIN, (s) => once(s, "  setSessionCookie(req, res, 'client', accessToken, ttlSeconds);\n", '')),
          (r) => !r.tok],
        ['a preview cookie that outlives the preview (8 hours), which P refuses',
          mutantOf(ADMIN, (s) => once(s, "  setSessionCookie(req, res, 'client', accessToken, ttlSeconds);\n", "  setSessionCookie(req, res, 'client', accessToken);\n")),
          (r) => /Max-Age=28800$/.test(r.pv.cookies.find((c) => c.startsWith('netraops_client_session=')) ?? '')],
      ];
      for (const [what, make, wrong] of routeMutants) {
        const at = await serve({ admin: make().default });
        const r = await pRun(at);
        seen(r.tok, r.pvb.body?.access_token);
        if (wrong(r)) caught += 1;
        check(wrong(r), `control — ${what}`);
      }
      {
        const make = mutantOf('src/routes/auth.ts', (s) => once(s, '  res.json({\n    ...tokens,\n    must_change_password: guard.must_change_password,\n', '  res.json({\n    ...bodyTokens(req, tokens),\n    must_change_password: guard.must_change_password,\n'));
        const at = await serve({ auth: make().default });
        const r = await request(at, 'POST', '/api/auth/guard/login', named('admin', WWW), { email: G.email, password: G.password }, IPHONE_APP);
        const wrong = r.status === 200 && !('access' in (r.body ?? {}));
        if (wrong) caught += 1;
        check(wrong, `control — the guard sign-in with the 3b rule applied, which G refuses: from www with a portal named the body is ${r.raw.slice(0, 60)}`);
      }
      const total = wsMutants.length + routeMutants.length + 1;
      check(caught === total, `${caught} of ${total} mutants caught`);
    }
  } finally {
    for (const sv of servers) await new Promise<void>((resolve) => sv.close(() => resolve()));
    const actors = [...ids.admins, ...ids.clients, ...ids.guards];
    if (actors.length) await q('DELETE FROM auth_events WHERE actor_id = ANY($1::uuid[])', [actors]);
    await q("DELETE FROM auth_events WHERE actor_id = '00000000-0000-0000-0000-000000000000' AND created_at >= $1", [runStart]);
    if (ids.guards.length) {
      await q('DELETE FROM guard_devices WHERE guard_id = ANY($1::uuid[])', [ids.guards]);
      await q('DELETE FROM login_attempts WHERE guard_id = ANY($1::uuid[])', [ids.guards]);
      await q('DELETE FROM guard_site_assignments WHERE guard_id = ANY($1::uuid[])', [ids.guards]);
      await q('DELETE FROM guards WHERE id = ANY($1::uuid[])', [ids.guards]);
    }
    if (ids.admins.length) await q('DELETE FROM admin_client_previews WHERE admin_id = ANY($1::uuid[])', [ids.admins]);
    if (ids.clients.length) {
      await q('DELETE FROM client_sites WHERE client_id = ANY($1::uuid[])', [ids.clients]);
      await q('DELETE FROM clients WHERE id = ANY($1::uuid[])', [ids.clients]);
    }
    if (ids.admins.length) await q('DELETE FROM company_admins WHERE id = ANY($1::uuid[])', [ids.admins]);
    if (ids.sites.length) await q('DELETE FROM sites WHERE id = ANY($1::uuid[])', [ids.sites]);
    if (keys.size) await q('DELETE FROM revoked_tokens WHERE jti = ANY($1::text[])', [[...keys]]);
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int + (SELECT count(*) FROM clients WHERE email LIKE $1)::int
      + (SELECT count(*) FROM guards WHERE email LIKE $1)::int + (SELECT count(*) FROM sites WHERE name LIKE $1)::int
      + (SELECT count(*) FROM revoked_tokens WHERE jti = ANY($2::text[]))::int AS n`, [`${marker}%`, [...keys]])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left (${keys.size} revocation keys swept)`);
    if (left !== 0) failures += 1;
    await pool.end();
  }
  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR', err); process.exit(1); });
