/**
 * test-n203-session-cookie.ts — N203 stage 1 and N205: the API also keeps the web's session in an HttpOnly
 * cookie, and a client's site switch or any web sign-out ends the whole sign-in.
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n203-session-cookie.ts     (from apps/api)
 *
 * Vishnu's decisions 1a 2a 3a 4a, with N205 folded in (2026-10-14). Through the real routers, over HTTP:
 *
 *   K  each web sign-in from an allowed origin also sets its portal's cookie: the access token, HttpOnly,
 *      SameSite=Lax, Path=/, Secure on https, 8 hours, host-only. None without an origin, for another origin,
 *      or for a Vercel preview (2a). The body is unchanged. Every web sign-in gets a sid, shared by its tokens
 *   A  the cookie authenticates a request that has no Authorization header and names its portal in
 *      X-NetraOps-Portal, and only then: not without the header, not another portal's, not a token of another
 *      role, not a name with two values. A bearer token still wins; route roles hold as for a bearer token
 *   O  a write the cookie authenticates needs an allowed Origin (3a); a read does not; a bearer write does not
 *   R  N205: a site switch ends the client's sign-in, every token minted from it or from its refreshes, and
 *      starts a new one; two racing switches make one; sign-out ends the sign-in in every portal; tokens minted
 *      before this change still work and still sign out
 *   P  a change of password clears the cookie
 *   G  every token without a sid (guards', and every one minted before this change) meets BASE's middleware
 *      exactly: the same answer and the same queries
 *   M  mutation controls
 *
 * LOCAL DATABASES ONLY; fake admins, clients and a guard on Star Guard's id. Sentry, email and S3 are stubbed.
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
/** main before N203 stage 1 (PR #123's merge, N202). */
const BASE = '541a6e107f23d4d0a5517185f742fa09fc1ee55d';
const WWW = 'https://www.netraops.com';
const LOCAL_WEB = 'http://localhost:3105';
const PREVIEW = 'https://guard-git-feat-x-vvishnu1998-labs-projects.vercel.app';
const EVIL = 'https://evil.example.com';
const VISHNU_SUB = '00000000-0000-0000-0000-000000000000';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const MISSING = '{"error":"Missing authorization token"}';
const REVOKED = '{"error":"Token has been revoked"}';

process.env.JWT_SECRET = 'test-only-n203';
process.env.JWT_REFRESH_SECRET = 'test-only-n203-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-n203-vishnu';
process.env.ALLOWED_ORIGINS = `${WWW}, ${LOCAL_WEB}`;
process.env.VISHNU_EMAIL = 'lhn203-vishnu@test.invalid';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  if (process.env.DATABASE_URL) { console.error('REFUSING: DATABASE_URL is set.'); process.exit(2); }
}
function stubModule(name: string, overrides: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...overrides }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the N203 test`); }),
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
const base = (rel: string) => execFileSync('git', ['show', `${BASE}:apps/api/${rel}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
function once(s: string, from: string, to: string): string {
  if (s.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from.slice(0, 70))}`);
  return s.replace(from, to);
}
const mutantOf = (rel: string, edit: (s: string) => string) => compileAt(rel, edit(read(rel)));

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

type Res = { status: number; body: any; raw: string; cookies: string[] };
type Headers = Record<string, string | undefined>;
function request(origin: string, method: string, p: string, h: Headers, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const u = new URL(origin + p);
    const headers: Record<string, string> = { 'user-agent': MAC_CHROME };
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
        resolve({ status: r.statusCode ?? 0, body: json, raw, cookies: Array.isArray(sc) ? sc : sc ? [sc] : [] });
      });
    });
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}
const bearer = (t: string, origin?: string): Headers => ({ authorization: `Bearer ${t}`, origin });
const viaCookie = (portal: string, t: string, origin?: string): Headers => ({ cookie: `netraops_${portal}_session=${t}`, 'x-netraops-portal': portal, origin });
const cookieLine = (portal: string, value: string, secure: boolean, maxAge: number) =>
  `netraops_${portal}_session=${value}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=${maxAge}`;

/** The middleware called directly, as n194's harness does: its answer, or whether it lets the request through. */
type Probe = { outcome: string; queries: string[] };
let queryLog: string[] | null = null;
function probe(mw: (req: any, res: any, next: () => void) => unknown, req: { method: string; headers: Headers }): Promise<Probe> {
  return new Promise((resolve) => {
    const queries: string[] = [];
    queryLog = queries;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = v;
    const res = {
      statusCode: 200,
      status(c: number) { this.statusCode = c; return this; },
      json(b: unknown) { queryLog = null; resolve({ outcome: `${this.statusCode} ${show(b)}`, queries }); return this; },
    };
    void mw({ method: req.method, headers }, res, () => { queryLog = null; resolve({ outcome: 'through', queries }); });
  });
}

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
  const jwt = (await import('jsonwebtoken')).default;
  const vishnuPassword = pw();
  process.env.VISHNU_PASSWORD_HASH = await bcrypt.hash(vishnuPassword, 4);
  const pool = ((await import('../src/db/pool')) as any).pool;
  const realQuery = pool.query.bind(pool);
  pool.query = (sql: any, params?: any) => {
    if (queryLog) queryLog.push(`${typeof sql === 'string' ? sql : sql.text} ${show(params ?? [])}`);
    return realQuery(sql, params);
  };
  const q = (sql: string, params: unknown[] = []) => realQuery(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;
  const authRouter = (await import('../src/routes/auth')).default;
  const { signTokens } = await import('../src/routes/auth') as any;
  const adminRouter = (await import('../src/routes/admin')).default;
  const clientRouter = (await import('../src/routes/clientPortal')).default;
  const mw: any = await import('../src/middleware/auth');
  const session: any = await import('../src/services/webSession');

  const marker = `lhn203-${Date.now().toString(36)}`;
  const runStart = new Date();
  const swept = ((await q("DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn203-%' UNION ALL SELECT id FROM clients WHERE email LIKE 'lhn203-%' UNION ALL SELECT id FROM guards WHERE email LIKE 'lhn203-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM client_sites WHERE client_id IN (SELECT id FROM clients WHERE email LIKE 'lhn203-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM clients WHERE email LIKE 'lhn203-%'")).rowCount ?? 0)
    + ((await q("DELETE FROM guards WHERE email LIKE 'lhn203-%'")).rowCount ?? 0)
    + ((await q("DELETE FROM company_admins WHERE email LIKE 'lhn203-%'")).rowCount ?? 0)
    + ((await q("DELETE FROM sites WHERE name LIKE 'lhn203-%'")).rowCount ?? 0);
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  const ids = { admins: [] as string[], clients: [] as string[], guards: [] as string[], sites: [] as string[] };
  const keys = new Set<string>();
  /** Every token the run sees: its jti and its sign-in are cleaned up after. */
  const seen = (...tokens: Array<string | undefined>) => {
    for (const t of tokens) {
      if (!t) continue;
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
    const admin = async (tag: string) => {
      const password = pw();
      const email = `${marker}-${tag}@test.invalid`;
      const id = (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, $4, false, false) RETURNING id`,
        [STAR_GUARD, `${marker} ${tag}`, email, await bcrypt.hash(password, 4)])).rows[0].id as string;
      ids.admins.push(id);
      return { id, email, password };
    };
    const client = async (tag: string, sites: string[]) => {
      const password = pw();
      const email = `${marker}-${tag}@test.invalid`;
      const id = (await q(`INSERT INTO clients (site_id, company_id, name, email, password_hash) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [sites[0], STAR_GUARD, `${marker} ${tag}`, email, await bcrypt.hash(password, 4)])).rows[0].id as string;
      for (const s of sites) await q('INSERT INTO client_sites (client_id, site_id) VALUES ($1, $2)', [id, s]);
      ids.clients.push(id);
      return { id, email, password };
    };
    const A = await admin('a');
    const AP = await admin('p');
    const C = await client('c', [north, south]);
    const CP = await client('q', [north]);
    const guardId = (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number, must_change_password) VALUES ($1, $2, $3, 'x', $4, false) RETURNING id`,
      [STAR_GUARD, `${marker} g`, `${marker}-g@test.invalid`, `LHN203-${marker.slice(-6)}`])).rows[0].id as string;
    ids.guards.push(guardId);

    async function serve(routers: { auth?: any; client?: any } = {}): Promise<string> {
      const app = express();
      app.set('trust proxy', 1);
      app.set('env', 'test');
      app.use(express.json());
      app.use('/api/auth', routers.auth ?? authRouter);
      app.use('/api/admin', adminRouter);
      app.use('/api/client', routers.client ?? clientRouter);
      const sv: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      servers.push(sv);
      return `http://127.0.0.1:${(sv.address() as AddressInfo).port}`;
    }
    const api = await serve();
    const call = (method: string, p: string, h: Headers, body?: unknown) => request(api, method, p, h, body);
    const signIn = async (portal: 'admin' | 'client' | 'vishnu', who: { email: string; password: string }, origin?: string, at = api) => {
      const r = await request(at, 'POST', `/api/auth/${portal}/login`, { origin }, { email: who.email, password: who.password });
      seen(r.body?.access, r.body?.refresh);
      return r;
    };
    const V = { email: process.env.VISHNU_EMAIL!, password: vishnuPassword };
    const READ: Record<string, string> = { admin: '/api/admin/me/sign-ins', client: '/api/client/site', vishnu: '/api/admin/vishnu-kpis' };

    // ══════════════════════════════════════════════════════════════════════════
    section('K  a web sign-in from an allowed origin also sets its portal\'s cookie (1a, 2a)');
    {
      const problems: string[] = [];
      const sids: string[] = [];
      for (const [portal, who] of [['admin', A], ['client', C], ['vishnu', V]] as const) {
        const www = await signIn(portal, who, WWW);
        const local = await signIn(portal, who, LOCAL_WEB);
        if (www.status !== 200 || local.status !== 200) { problems.push(`${portal}: ${www.status}/${local.status}`); continue; }
        if (show(www.cookies) !== show([cookieLine(portal, www.body.access, true, 28800)])) problems.push(`${portal} www: ${show(www.cookies)}`);
        if (show(local.cookies) !== show([cookieLine(portal, local.body.access, false, 28800)])) problems.push(`${portal} localhost: ${show(local.cookies)}`);
        const keysWant = portal === 'admin' ? 'access,must_change_password,refresh' : portal === 'client' ? 'access,must_change_password,refresh,sites' : 'access,refresh';
        if (Object.keys(www.body).sort().join(',') !== keysWant) problems.push(`${portal} body keys ${Object.keys(www.body).sort().join(',')}`);
        for (const origin of [undefined, EVIL, PREVIEW]) {
          const r = await signIn(portal, who, origin);
          if (r.status !== 200 || r.cookies.length) problems.push(`${portal} from ${origin ?? 'no origin'}: ${r.status} ${show(r.cookies)}`);
        }
        const a = claims(www.body.access);
        const b = claims(www.body.refresh);
        if (!/^[0-9a-f-]{36}$/.test(a.sid ?? '') || a.sid !== b.sid) problems.push(`${portal} sid ${a.sid}/${b.sid}`);
        sids.push(a.sid, claims(local.body.access).sid);
      }
      check(problems.length === 0, `admin, client and Vishnu: from ${WWW} the cookie is the access token, Path=/, HttpOnly, SameSite=Lax, Secure, Max-Age=28800, no Domain; from ${LOCAL_WEB} the same without Secure; nothing without an origin, from ${EVIL} or from a Vercel preview; the body's keys as before; access and refresh share a sid (${problems.join('; ') || 'all right'})`);
      check(new Set(sids).size === sids.length, `each sign-in its own sid: ${sids.length} sign-ins, ${new Set(sids).size} sids`);
      const g = signTokens({ sub: guardId, role: 'guard', company_id: STAR_GUARD });
      seen(g.access, g.refresh);
      const res = { cookies: [] as string[], append(_n: string, v: string) { this.cookies.push(v); } };
      session.setSessionCookie({ headers: { origin: WWW } }, res, 'guard', g.access);
      check(claims(g.access).sid === undefined && res.cookies.length === 0 && read('src/routes/auth.ts').includes("  const tokens = signTokens({ sub: guard.id, role: 'guard', company_id: guard.company_id });\n"),
        `a guard's sign-in mints BASE's token, with no sid, and no cookie is ever set for a guard (${show(res.cookies)})`);
    }

    section('A  the cookie authenticates a request that names its portal, and only that way');
    {
      const a = (await signIn('admin', A, WWW)).body;
      const c = (await signIn('client', C, WWW)).body;
      const v = (await signIn('vishnu', V, WWW)).body;
      const r = {
        admin: await call('GET', READ.admin, viaCookie('admin', a.access)),
        client: await call('GET', READ.client, viaCookie('client', c.access)),
        vishnu: await call('GET', READ.vishnu, viaCookie('vishnu', v.access)),
        noHeader: await call('GET', READ.admin, { cookie: `netraops_admin_session=${a.access}` }),
        otherPortal: await call('GET', READ.admin, { cookie: `netraops_admin_session=${a.access}`, 'x-netraops-portal': 'client' }),
        otherRole: await call('GET', READ.client, { cookie: `netraops_admin_session=${c.access}`, 'x-netraops-portal': 'admin' }),
        twoValues: await call('GET', READ.admin, { cookie: `netraops_admin_session=${a.access}; netraops_admin_session=${v.access}`, 'x-netraops-portal': 'admin' }),
        sameTwice: await call('GET', READ.admin, { cookie: `netraops_admin_session=${a.access}; netraops_admin_session=${a.access}`, 'x-netraops-portal': 'admin' }),
        oddNames: await Promise.all(['toString', 'Admin', 'admin, client', ''].map((n) => call('GET', READ.admin, { cookie: `netraops_admin_session=${a.access}`, 'x-netraops-portal': n }))),
        roleRoute: await call('GET', READ.admin, viaCookie('client', c.access)),
        basic: await call('GET', READ.admin, { ...viaCookie('admin', a.access), authorization: 'Basic eDp5' }),
      };
      const old = (await signIn('admin', A)).body;
      await call('POST', '/api/auth/logout', bearer(old.access));
      const bearerWins = await call('GET', READ.admin, { ...viaCookie('admin', a.access), ...bearer(old.access) });
      check(r.admin.status === 200 && r.client.status === 200 && r.vishnu.status === 200,
        `each portal's cookie, named by X-NetraOps-Portal, reads its own route: admin ${r.admin.status}, client ${r.client.status}, Vishnu ${r.vishnu.status}`);
      check(r.noHeader.raw === MISSING && r.otherPortal.raw === MISSING && r.twoValues.raw === MISSING && r.oddNames.every((x) => x.raw === MISSING) && r.basic.raw === MISSING,
        `refused as having no session: no portal header (${r.noHeader.status}), another portal named (${r.otherPortal.status}), one name with two values (${r.twoValues.status}), the names ${show(['toString', 'Admin', 'admin, client', ''])} (${r.oddNames.map((x) => x.status).join('/')}), an Authorization header that is not a bearer token (${r.basic.status})`);
      check(r.otherRole.status === 401 && r.otherRole.raw === '{"error":"Invalid token"}' && r.sameTwice.status === 200,
        `a client's token in the admin cookie: ${r.otherRole.status} ${r.otherRole.raw}; the same value twice is one session: ${r.sameTwice.status}`);
      check(r.roleRoute.status === 403 && r.roleRoute.raw === '{"error":"Insufficient permissions"}' && bearerWins.status === 401 && bearerWins.raw === REVOKED,
        `route roles hold as for a bearer token (a client's cookie on an admin route: ${r.roleRoute.status}); a bearer token wins over the cookie (a signed-out one beside a live cookie: ${bearerWins.status} ${bearerWins.raw})`);
    }

    section('O  a write the cookie authenticates needs an allowed Origin (3a)');
    {
      const a = (await signIn('admin', A, WWW)).body;
      const wrong = { current_password: 'not-the-password', new_password: 'whatever-123' };
      const change = (h: Headers) => call('POST', '/api/auth/admin/change-password', h, wrong);
      const r = {
        www: await change(viaCookie('admin', a.access, WWW)),
        local: await change(viaCookie('admin', a.access, LOCAL_WEB)),
        none: await change(viaCookie('admin', a.access)),
        evil: await change(viaCookie('admin', a.access, EVIL)),
        preview: await change(viaCookie('admin', a.access, PREVIEW)),
        bearer: await change(bearer(a.access)),
        read: await call('GET', READ.admin, viaCookie('admin', a.access)),
      };
      const reached = '{"error":"Current password is incorrect"}';
      const refused = '{"error":"Origin not allowed"}';
      check(r.www.raw === reached && r.local.raw === reached && r.bearer.raw === reached,
        `the write reaches the route from ${WWW} (${r.www.status}) and ${LOCAL_WEB} (${r.local.status}), and with a bearer token and no Origin (${r.bearer.status})`);
      check([r.none, r.evil, r.preview].every((x) => x.status === 403 && x.raw === refused) && r.read.status === 200,
        `refused 403 ${refused}: no Origin, ${EVIL}, a Vercel preview (${[r.none, r.evil, r.preview].map((x) => x.status).join('/')}); a read with no Origin passes (${r.read.status})`);
      const c = (await signIn('client', C, WWW)).body;
      const sw = await call('POST', '/api/client/switch-site', viaCookie('client', c.access, EVIL), { site_id: south });
      const still = await call('GET', READ.client, viaCookie('client', c.access));
      check(sw.status === 403 && sw.raw === refused && still.status === 200,
        `a site switch from ${EVIL} is refused before it ends anything: ${sw.status}, and the session still reads (${still.status})`);
    }

    section('R  N205: a site switch, and any sign-out, ends the whole sign-in');
    {
      const problems: string[] = [];
      const s1 = (await signIn('client', C, WWW)).body;
      const ref = await call('POST', '/api/auth/refresh', {}, { refresh_token: s1.refresh });
      seen(ref.body?.access, ref.body?.refresh);
      if (ref.status !== 200 || claims(ref.body.access).sid !== claims(s1.access).sid) problems.push(`refresh ${ref.status}, sid kept: ${claims(ref.body?.access ?? s1.access).sid === claims(s1.access).sid}`);
      const sw1 = await call('POST', '/api/client/switch-site', bearer(ref.body.access, WWW), { site_id: south });
      seen(sw1.body?.access, sw1.body?.refresh);
      const s2 = sw1.body;
      if (sw1.status !== 200 || claims(s2.access).site_id !== south || claims(s2.access).sid === claims(s1.access).sid
        || show(sw1.cookies) !== show([cookieLine('client', s2.access, true, 28800)])) problems.push(`switch 1: ${sw1.status} ${show(sw1.cookies).slice(0, 80)}`);
      const after1 = {
        login: (await call('GET', READ.client, bearer(s1.access))).raw,
        refreshed: (await call('GET', READ.client, bearer(ref.body.access))).raw,
        refreshedRefresh: (await call('POST', '/api/auth/refresh', {}, { refresh_token: ref.body.refresh })).raw,
        newOne: (await call('GET', READ.client, bearer(s2.access))).status,
      };
      if (after1.login !== REVOKED || after1.refreshed !== REVOKED || after1.refreshedRefresh !== REVOKED || after1.newOne !== 200) problems.push(`after switch 1: ${show(after1)}`);
      const sw2 = await call('POST', '/api/client/switch-site', viaCookie('client', s2.access, WWW), { site_id: north });
      // N203 stage 2 (3b): a switch by the cookie web from www carries no token in its body; the new session is the cookie.
      const s3 = { access: (sw2.cookies[0] ?? '').split(';')[0].split('=')[1] ?? '' };
      seen(s3.access);
      const after2 = [(await call('GET', READ.client, bearer(s2.access))).raw, (await call('POST', '/api/auth/refresh', {}, { refresh_token: s2.refresh })).raw];
      if (sw2.status !== 200 || after2.some((x) => x !== REVOKED)) problems.push(`switch 2 (by cookie): ${sw2.status}, then ${show(after2)}`);
      const race = await Promise.all([1, 2].map(() => call('POST', '/api/client/switch-site', bearer(s3.access, WWW), { site_id: south })));
      race.forEach((x) => seen(x.body?.access, x.body?.refresh));
      const won = race.filter((x) => x.status === 200);
      const lost = race.filter((x) => x.status === 401);
      if (won.length !== 1 || lost.length !== 1 || ![REVOKED, '{"error":"Session revoked"}'].includes(lost[0].raw)) problems.push(`race: ${race.map((x) => `${x.status} ${x.raw.slice(0, 40)}`).join(' | ')}`);
      const s4 = won[0]?.body;
      const out = await call('POST', '/api/auth/logout', viaCookie('client', s4.access, WWW), {});
      const after3 = [(await call('GET', READ.client, bearer(s4.access))).raw, (await call('POST', '/api/auth/refresh', {}, { refresh_token: s4.refresh })).raw];
      if (out.status !== 200 || show(out.cookies) !== show([cookieLine('client', '', true, 0)]) || after3.some((x) => x !== REVOKED)) problems.push(`sign-out by cookie: ${out.status} ${show(out.cookies)} then ${show(after3)}`);
      check(problems.length === 0, 'a client: sign in, refresh (the sid kept), switch site with the refreshed token: the sign-in\'s tokens, the refreshed pair included, are refused, the new site\'s token reads; a second switch (by cookie) ends that one too; two racing switches make one new sign-in; a sign-out by cookie clears it and ends it' + ` (${problems.join('; ') || 'all right'})`);

      const ends: string[] = [];
      for (const [portal, who] of [['admin', A], ['vishnu', V]] as const) {
        const l = (await signIn(portal, who, WWW)).body;
        const rf = await call('POST', '/api/auth/refresh', {}, { refresh_token: l.refresh });
        seen(rf.body?.access, rf.body?.refresh);
        const o = await call('POST', '/api/auth/logout', bearer(rf.body.access, WWW), {});
        const first = await call('GET', READ[portal], bearer(l.access));
        const refreshedRefresh = await call('POST', '/api/auth/refresh', {}, { refresh_token: rf.body.refresh });
        if (o.status !== 200 || show(o.cookies) !== show([cookieLine(portal, '', true, 0)]) || first.raw !== REVOKED || refreshedRefresh.raw !== REVOKED) {
          ends.push(`${portal}: sign-out ${o.status} ${show(o.cookies)}, the first token ${first.status}, the refreshed refresh token ${refreshedRefresh.status}`);
        }
        const row = (await q('SELECT extract(epoch from expires_at - now())::int AS s FROM revoked_tokens WHERE jti = $1', [`sid:${claims(l.access).sid}`])).rows[0];
        if (!row || Math.abs(row.s - 30 * 86400) > 120) ends.push(`${portal}: the sign-in's row expires in ${row?.s}s`);
      }
      check(ends.length === 0, `admin and Vishnu: sign in, refresh, sign out with the refreshed token (no refresh token sent): the first token and the refreshed refresh token are refused too, and the sign-in's row lasts the refresh token's 30 days (${ends.join('; ') || 'all right'})`);

      const legacy = signTokens({ sub: A.id, role: 'company_admin', company_id: STAR_GUARD, is_primary: false });
      seen(legacy.access, legacy.refresh);
      const lRead = await call('GET', READ.admin, bearer(legacy.access));
      const lOut = await call('POST', '/api/auth/logout', bearer(legacy.access), {});
      const lAfter = await call('GET', READ.admin, bearer(legacy.access));
      const lc = signTokens({ sub: C.id, role: 'client', site_id: north });
      seen(lc.access, lc.refresh);
      const lSw = await call('POST', '/api/client/switch-site', bearer(lc.access), { site_id: south });
      seen(lSw.body?.access, lSw.body?.refresh);
      const lcAfter = await call('GET', READ.client, bearer(lc.access));
      check(lRead.status === 200 && lOut.status === 200 && lAfter.raw === REVOKED && lSw.status === 200 && /^[0-9a-f-]{36}$/.test(claims(lSw.body.access).sid ?? '') && lcAfter.raw === REVOKED,
        `a token minted before this change (no sid): reads ${lRead.status}, signs out ${lOut.status}, refused after (${lAfter.status}); a client's switches site (${lSw.status}, the new pair with a sid) and is refused after (${lcAfter.status})`);
    }

    section('P  a change of password clears the cookie');
    {
      const a = (await signIn('admin', AP, WWW)).body;
      const ca = await call('POST', '/api/auth/admin/change-password', bearer(a.access, WWW), { current_password: AP.password, new_password: pw() });
      const c = (await signIn('client', CP, WWW)).body;
      const cc = await call('POST', '/api/auth/client/change-password', bearer(c.access, WWW), { current_password: CP.password, new_password: pw() });
      const a2 = (await call('POST', '/api/auth/admin/login', {}, { email: AP.email, password: AP.password })).status;
      check(ca.status === 200 && show(ca.cookies) === show([cookieLine('admin', '', true, 0)]) && cc.status === 200 && show(cc.cookies) === show([cookieLine('client', '', true, 0)]) && a2 === 401,
        `admin ${ca.status} ${show(ca.cookies)}; client ${cc.status} ${show(cc.cookies)}; the old password is refused after (${a2})`);
    }

    section('G  every token without a sid meets BASE\'s middleware exactly');
    {
      const baseMw: any = compileAt('src/middleware/auth.ts', base('src/middleware/auth.ts'));
      const g = signTokens({ sub: guardId, role: 'guard', company_id: STAR_GUARD });
      const gRevoked = signTokens({ sub: guardId, role: 'guard', company_id: STAR_GUARD });
      const la = signTokens({ sub: A.id, role: 'company_admin', company_id: STAR_GUARD, is_primary: false });
      const lc = signTokens({ sub: C.id, role: 'client', site_id: north });
      const lv = signTokens({ sub: VISHNU_SUB, role: 'vishnu' });
      seen(g.access, g.refresh, gRevoked.access, gRevoked.refresh, la.access, la.refresh, lc.access, lc.refresh, lv.access, lv.refresh);
      await q('INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, now() + interval \'1 hour\')', [claims(gRevoked.access).jti]);
      const now = Math.floor(Date.now() / 1000);
      const expired = jwt.sign({ sub: A.id, role: 'company_admin', company_id: STAR_GUARD, jti: crypto.randomUUID(), iat: now - 7200, exp: now - 3600 }, process.env.JWT_SECRET!);
      const preview = jwt.sign({ sub: 'admin-preview', role: 'client', site_id: north, scope: 'preview' }, process.env.JWT_SECRET!, { expiresIn: 1800 });
      const cases: Array<[string, string[], string, Headers]> = [
        ['a guard\'s token, GET', ['guard'], 'GET', bearer(g.access)],
        ['a guard\'s token, POST', ['guard'], 'POST', bearer(g.access)],
        ['a guard\'s revoked token', ['guard'], 'GET', bearer(gRevoked.access)],
        ['an admin token from before, GET', ['company_admin'], 'GET', bearer(la.access)],
        ['an admin token from before, POST, no Origin', ['company_admin'], 'POST', bearer(la.access)],
        ['a client token from before', ['client'], 'GET', bearer(lc.access)],
        ['a Vishnu token from before', ['vishnu'], 'GET', bearer(lv.access)],
        ['an admin token on a client route', ['client'], 'GET', bearer(la.access)],
        ['an expired token', ['company_admin'], 'GET', bearer(expired)],
        ['a token that is not one', ['company_admin'], 'GET', bearer('not.a.token')],
        ['a preview token, GET', ['client'], 'GET', bearer(preview)],
        ['a preview token, POST', ['client'], 'POST', bearer(preview)],
        ['no Authorization header, a cookie but no portal header', ['company_admin'], 'GET', { cookie: `netraops_admin_session=${la.access}` }],
        ['a Basic Authorization header beside a named cookie', ['company_admin'], 'GET', { ...viaCookie('admin', la.access), authorization: 'Basic eDp5' }],
      ];
      const diffs: string[] = [];
      for (const [what, roles, method, headers] of cases) {
        const b = await probe(baseMw.requireAuth(...roles), { method, headers });
        const n = await probe(mw.requireAuth(...roles), { method, headers });
        if (b.outcome !== n.outcome || show(b.queries) !== show(n.queries)) diffs.push(`${what}: BASE ${b.outcome} ${b.queries.length}q, now ${n.outcome} ${n.queries.length}q`);
      }
      check(diffs.length === 0, `${cases.length} cases, guards' included, give BASE's answer with BASE's queries, statement for statement (${diffs.join('; ') || 'all identical'})`);
      const withSid = signTokens({ sub: A.id, role: 'company_admin', company_id: STAR_GUARD, is_primary: false, sid: crypto.randomUUID() });
      seen(withSid.access, withSid.refresh);
      const b = await probe(baseMw.requireAuth('company_admin'), { method: 'GET', headers: bearer(withSid.access) });
      const n = await probe(mw.requireAuth('company_admin'), { method: 'GET', headers: bearer(withSid.access) });
      const differ = b.queries.map((x, i) => (x === n.queries[i] ? null : i)).filter((i) => i !== null);
      check(b.outcome === 'through' && n.outcome === 'through' && b.queries.length === n.queries.length && differ.length === 1
        && n.queries[differ[0]!].startsWith('SELECT 1 FROM revoked_tokens WHERE jti = $1 OR jti = $2 LIMIT 1 '),
        `a token with a sid: the one statement that differs asks for its jti or its sign-in (${differ.length === 1 ? n.queries[differ[0]!].slice(0, 70) : show(differ)})`);
      check(session.allowedOrigins().join(',') === `${WWW},${LOCAL_WEB}` && read('src/index.ts').includes("const allowedOrigins = process.env.ALLOWED_ORIGINS\n  .split(',')\n  .map((o) => o.trim())\n  .filter(Boolean);\n"),
        `ALLOWED_ORIGINS is read as index.ts reads it for CORS: split on commas, trimmed, blanks dropped (${show(session.allowedOrigins())})`);
    }

    section('M  mutation controls');
    {
      const a = (await signIn('admin', A, WWW)).body;
      const c = (await signIn('client', C, WWW)).body;
      const ended = (await signIn('client', C, WWW)).body;
      await session.endSignIn(claims(ended.access).sid);
      const MW = 'src/middleware/auth.ts';
      const sees = async (m: any) => ({
        read: (await probe(m.requireAuth('company_admin'), { method: 'GET', headers: viaCookie('admin', a.access) })).outcome,
        noHeader: (await probe(m.requireAuth('company_admin'), { method: 'GET', headers: { cookie: `netraops_admin_session=${a.access}` } })).outcome,
        otherRole: (await probe(m.requireAuth('company_admin', 'client'), { method: 'GET', headers: { cookie: `netraops_admin_session=${c.access}`, 'x-netraops-portal': 'admin' } })).outcome,
        writeNoOrigin: (await probe(m.requireAuth('company_admin'), { method: 'POST', headers: viaCookie('admin', a.access) })).outcome,
        endedSignIn: (await probe(m.requireAuth('client'), { method: 'GET', headers: bearer(ended.access) })).outcome,
      });
      const real = await sees(mw);
      check(show(real) === show({ read: 'through', noHeader: `401 ${MISSING}`, otherRole: '401 {"error":"Invalid token"}', writeNoOrigin: '403 {"error":"Origin not allowed"}', endedSignIn: `401 ${REVOKED}` }),
        `M0 the probe reads the real middleware as HTTP does: ${show(real)}`);
      let caught = 0;
      const mwMutants: Array<[string, (s: string) => string, (p: typeof real) => boolean]> = [
        ['no Origin check on a cookie write, which O refuses',
          (s) => once(s, "      if (!SAFE_METHODS.has(req.method) && !isAllowedOrigin(req.headers.origin)) {\n        return res.status(403).json({ error: 'Origin not allowed' });\n      }\n", ''), (p) => p.writeNoOrigin === 'through'],
        ['the admin cookie read when no portal is named, which A refuses',
          (s) => once(s, 'sessionFromCookie(req)', "sessionFromCookie({ ...req, headers: { 'x-netraops-portal': 'admin', ...req.headers } } as Request)"), (p) => p.noHeader === 'through'],
        ['a cookie\'s token not matched to its portal, which A refuses',
          (s) => once(s, "      if (payload.role !== fromCookie.role) {\n        return res.status(401).json({ error: 'Invalid token' });\n      }\n", ''), (p) => p.otherRole === 'through'],
        ['the revocation check without the sign-in, which R refuses',
          (s) => once(s, '        const revoked = payload.sid\n', '        const revoked = false\n'), (p) => p.endedSignIn === 'through'],
      ];
      for (const [what, edit, wrong] of mwMutants) {
        const p = await sees(mutantOf(MW, edit));
        if (wrong(p)) caught += 1;
        check(wrong(p), `control — the middleware with ${what}: ${show(p)}`);
      }

      /** The R scenarios, against routers that may be mutants: does each earlier token stay refused? */
      async function routeRun(routers: { auth?: any; client?: any }) {
        const at = await serve(routers);
        const s1 = (await signIn('client', C, WWW, at)).body;
        const sw = await request(at, 'POST', '/api/client/switch-site', bearer(s1.access, WWW), { site_id: south });
        seen(sw.body?.access, sw.body?.refresh);
        const afterSwitch = (await request(at, 'GET', READ.client, bearer(s1.access), undefined)).status;
        const refreshAfterSwitch = (await request(at, 'POST', '/api/auth/refresh', {}, { refresh_token: s1.refresh })).status;
        const l = (await signIn('admin', A, WWW, at)).body;
        const rf = await request(at, 'POST', '/api/auth/refresh', {}, { refresh_token: l.refresh });
        seen(rf.body?.access, rf.body?.refresh);
        await request(at, 'POST', '/api/auth/logout', bearer(rf.body.access, WWW), {});
        const afterSignOut = (await request(at, 'GET', READ.admin, bearer(l.access), undefined)).status;
        return { afterSwitch, refreshAfterSwitch, afterSignOut };
      }
      const realRun = await routeRun({});
      check(show(realRun) === show({ afterSwitch: 401, refreshAfterSwitch: 401, afterSignOut: 401 }), `M5 the route runs refuse each earlier token with the real routers: ${show(realRun)}`);
      const AUTH = 'src/routes/auth.ts';
      const CP_ROUTES = 'src/routes/clientPortal.ts';
      const routeMutants: Array<[string, { auth?: any; client?: any }, (r: typeof realRun) => boolean]> = [
        ['a site switch that ends nothing, which R refuses',
          { client: mutantOf(CP_ROUTES, (s) => once(s, "  if (!(await endSignInForSwitch(req.user!))) {\n    return res.status(401).json({ error: 'Session revoked' });\n  }\n", '')).default },
          (r) => r.afterSwitch === 200],
        ['a sign-out that ends only its own token, which R refuses',
          { auth: mutantOf(AUTH, (s) => once(s, '  for (const sid of new Set([req.user?.sid, refreshSid])) {\n    await endSignIn(sid).catch(() => undefined);\n  }\n', '')).default },
          (r) => r.afterSignOut === 200],
        ['a refresh that ignores an ended sign-in, which R refuses',
          { auth: mutantOf(AUTH, (s) => once(s, "  if (payload.sid) {\n    const ended = await pool.query('SELECT id FROM revoked_tokens WHERE jti = $1', [sidKey(payload.sid)]);\n    if (ended.rows.length > 0) {\n      return res.status(401).json({ error: 'Token has been revoked' });\n    }\n  }\n", '')).default },
          (r) => r.refreshAfterSwitch === 200],
        ['a refresh that drops the sid, so signing out with its token leaves the sign-in, which R refuses',
          { auth: mutantOf(AUTH, (s) => once(s, 'const { iat: _iat, exp: _exp, jti: _jti, ...rest } = payload;', 'const { iat: _iat, exp: _exp, jti: _jti, sid: _sid, ...rest } = payload;')).default },
          (r) => r.afterSignOut === 200],
      ];
      for (const [what, routers, wrong] of routeMutants) {
        const r = await routeRun(routers);
        if (wrong(r)) caught += 1;
        check(wrong(r), `control — ${what}: ${show(r)}`);
      }

      const WS = 'src/services/webSession.ts';
      const cookiesFrom = (m: any) => {
        const out: string[] = [];
        for (const [origin, role] of [[WWW, 'company_admin'], [undefined, 'company_admin'], [EVIL, 'client'], [PREVIEW, 'vishnu'], [WWW, 'guard']] as const) {
          const res = { cookies: [] as string[], append(_n: string, v: string) { this.cookies.push(v); } };
          m.setSessionCookie({ headers: origin ? { origin } : {} }, res, role, 'tok');
          out.push(...res.cookies);
        }
        return out;
      };
      const realCookies = cookiesFrom(session);
      check(show(realCookies) === show([cookieLine('admin', 'tok', true, 28800)]), `M6 one cookie of five calls, the allowed origin's: ${show(realCookies)}`);
      const wsMutants: Array<[string, (s: string) => string]> = [
        ['a cookie for any origin, which K refuses', (s) => once(s, '  if (!isWebRole(role) || !isAllowedOrigin(origin)) return;\n', "  if (!isWebRole(role) || typeof origin !== 'string') return;\n")],
        ['a cookie a script can read, which K refuses', (s) => once(s, "['Path=/', 'HttpOnly', 'SameSite=Lax',", "['Path=/', 'SameSite=Lax',")],
        ['a cookie shared with every netraops.com host, which K refuses', (s) => once(s, "['Path=/', 'HttpOnly', 'SameSite=Lax',", "['Path=/', 'HttpOnly', 'SameSite=Lax', 'Domain=netraops.com',")],
      ];
      for (const [what, edit] of wsMutants) {
        const got = cookiesFrom(mutantOf(WS, edit));
        const differs = show(got) !== show(realCookies);
        if (differs) caught += 1;
        check(differs, `control — ${what}: ${show(got).slice(0, 110)}`);
      }
      const total = mwMutants.length + routeMutants.length + wsMutants.length;
      check(caught === total, `${caught} of ${total} mutants caught`);
    }
  } finally {
    for (const sv of servers) await new Promise<void>((resolve) => sv.close(() => resolve()));
    const actors = [...ids.admins, ...ids.clients, ...ids.guards];
    if (actors.length) await q('DELETE FROM auth_events WHERE actor_id = ANY($1::uuid[])', [actors]);
    await q('DELETE FROM auth_events WHERE actor_id = $1 AND created_at >= $2', [VISHNU_SUB, runStart]);
    if (ids.clients.length) {
      await q('DELETE FROM client_sites WHERE client_id = ANY($1::uuid[])', [ids.clients]);
      await q('DELETE FROM clients WHERE id = ANY($1::uuid[])', [ids.clients]);
    }
    if (ids.guards.length) await q('DELETE FROM guards WHERE id = ANY($1::uuid[])', [ids.guards]);
    if (ids.admins.length) await q('DELETE FROM company_admins WHERE id = ANY($1::uuid[])', [ids.admins]);
    if (ids.sites.length) await q('DELETE FROM sites WHERE id = ANY($1::uuid[])', [ids.sites]);
    if (keys.size) await q('DELETE FROM revoked_tokens WHERE jti = ANY($1::text[])', [[...keys]]);
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int + (SELECT count(*) FROM clients WHERE email LIKE $1)::int
      + (SELECT count(*) FROM guards WHERE email LIKE $1)::int + (SELECT count(*) FROM sites WHERE name LIKE $1)::int
      + (SELECT count(*) FROM revoked_tokens WHERE jti = ANY($2::text[]))::int AS n`, [`${marker}%`, [...keys]])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left (${keys.size} revocation keys swept)`);
    if (left !== 0) failures += 1;
    pool.query = realQuery;
    await pool.end();
  }
  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR', err); process.exit(1); });
