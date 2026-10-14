/**
 * test-n200-login-input.ts — a sign-in with an email or password that is not text is a 400, not a 500 (N200).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n200-login-input.ts     (from apps/api)
 *
 * The four login routes (guard, admin, client, vishnu) and forgot-password checked that `email` and
 * `password` were present, not that they were strings, so a truthy non-string reached email.toLowerCase()
 * or bcrypt.compare, which throw, and the error handler answered 500. Each route is driven over HTTP as it
 * is now and as it was at BASE (main before N200, read from git), with the same requests and the same
 * database state before each one:
 *
 *   C  an email or password that is a number, an object, an array or true: BASE 500, now the route's own
 *      400; nothing recorded against the account
 *   U  every other request gets BASE's answer: missing or empty fields, null and 0, an unknown email, a
 *      wrong password, the right one (the same token shape and flags), a locked account; forgot-password's
 *      missing portal, wrong portal, unknown email and the vishnu portal
 *   S  every email.toLowerCase() and every bcrypt.compare of a body password in routes/auth.ts sits behind
 *      the check in its own route
 *   M  mutation controls: each route without the check answers 500 again
 *
 * LOCAL DATABASES ONLY; fake rows on Star Guard's id, passwords generated here and never printed, and the
 * vishnu login pointed at a test email and hash. Sentry, email and S3 are stubbed, and /api/auth is mounted
 * without its rate limiter.
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
const VISHNU_ID = '00000000-0000-0000-0000-000000000000';
/** main before N200 (PR #120's merge). */
const BASE = '7245a0a95a3cfc175e4a775cbbf58471821fa2ee';
const AUTH_ROUTES = 'src/routes/auth.ts';

process.env.JWT_SECRET = 'test-only-n200';
process.env.JWT_REFRESH_SECRET = 'test-only-n200-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-n200-vishnu';

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
      : () => { throw new Error(`${name}.${String(prop)} called in the N200 test`); }),
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
/** `src` compiled as if it were `apps/api/<rel>`, so its imports resolve to the working tree's modules. */
function compileAt(rel: string, src: string): any {
  const file = path.join(__dirname, '..', rel);
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
/** The body of one route in routes/auth.ts: from its `router.post(` line to the next route's. */
function routeSpan(src: string, routePath: string): [number, number] {
  const at = src.indexOf(`router.post('${routePath}', `);
  if (at < 0) throw new Error(`no ${routePath} route`);
  const next = src.indexOf('\nrouter.', at + 1);
  return [at, next < 0 ? src.length : next];
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
const show = (v: unknown) => JSON.stringify(v);
/** A test password, never printed. */
const pw = () => `T${crypto.randomBytes(12).toString('base64url')}`;

type Role = 'guard' | 'admin' | 'client' | 'vishnu';
const ROLES: Role[] = ['guard', 'admin', 'client', 'vishnu'];
const NOT_TEXT: Array<[string, unknown]> = [['a number', 12345678], ['an object', { v: 'x' }], ['an array', ['x']], ['true', true]];
const LOGIN_400 = '{"error":"email and password required"}';
const FORGOT_400 = '{"error":"email and portal required"}';

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  inject('../src/services/s3', stubModule('s3', { urlOrPresign: async (url: string | null) => url }));

  const bcrypt = (await import('bcrypt')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;

  const marker = `lhn200-${Date.now().toString(36)}`;
  const runStart = new Date();
  const made: Record<string, string[]> = { company_admins: [], clients: [], guards: [], sites: [] };
  let swept = 0;
  for (const sql of [
    "DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn200-%' UNION ALL SELECT id FROM clients WHERE email LIKE 'lhn200-%' UNION ALL SELECT id FROM guards WHERE email LIKE 'lhn200-%')",
    "DELETE FROM login_attempts WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn200-%')",
    "DELETE FROM guard_site_assignments WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn200-%')",
    "DELETE FROM client_sites WHERE client_id IN (SELECT id FROM clients WHERE email LIKE 'lhn200-%')",
    "DELETE FROM company_admins WHERE email LIKE 'lhn200-%'",
    "DELETE FROM clients WHERE email LIKE 'lhn200-%'",
    "DELETE FROM guards WHERE email LIKE 'lhn200-%'",
    "DELETE FROM sites WHERE name LIKE 'lhn200-%'",
  ]) swept += (await q(sql)).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  const priorVishnu = (await q('SELECT failed_login_count, locked_at, tokens_not_before FROM vishnu_state WHERE id = 1')).rows[0] ?? null;
  if (!priorVishnu) { console.error('REFUSING: no vishnu_state row in this database.'); process.exit(2); }
  let server: Server | null = null;

  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const site = (await q(`INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1 Example Way', '2026-01-01') RETURNING id`,
      [STAR_GUARD, `${marker} North Gate`])).rows[0].id as string;
    made.sites.push(site);
    const secret: Record<Role, { email: string; password: string; id: string }> = {} as any;
    const hash = (p: string) => bcrypt.hash(p, 4);
    {
      const password = pw();
      const email = `${marker}-admin@test.invalid`;
      const id = (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, $4, false, false) RETURNING id`,
        [STAR_GUARD, `${marker} admin`, email, await hash(password)])).rows[0].id as string;
      made.company_admins.push(id);
      secret.admin = { email, password, id };
    }
    {
      const password = pw();
      const email = `${marker}-guard@test.invalid`;
      const id = (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [STAR_GUARD, `${marker} guard`, email, await hash(password), `LH200-${marker.slice(-6)}`])).rows[0].id as string;
      made.guards.push(id);
      await q(`INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) VALUES ($1, $2, '2026-01-01')`, [id, site]);
      secret.guard = { email, password, id };
    }
    {
      const password = pw();
      const email = `${marker}-client@test.invalid`;
      const id = (await q(`INSERT INTO clients (site_id, company_id, name, email, password_hash, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
        [site, STAR_GUARD, `${marker} client`, email, await hash(password)])).rows[0].id as string;
      made.clients.push(id);
      await q('INSERT INTO client_sites (client_id, site_id) VALUES ($1, $2)', [id, site]);
      secret.client = { email, password, id };
    }
    {
      const password = pw();
      const email = `${marker}-vishnu@test.invalid`;
      process.env.VISHNU_EMAIL = email;
      process.env.VISHNU_PASSWORD_HASH = await hash(password);
      secret.vishnu = { email, password, id: VISHNU_ID };
    }
    /** The account's lock state, as the next request should find it. */
    async function reset(role: Role): Promise<void> {
      if (role === 'admin') await q('UPDATE company_admins SET failed_login_count = 0, locked_at = NULL WHERE id = $1', [secret.admin.id]);
      if (role === 'guard') await q('DELETE FROM login_attempts WHERE guard_id = $1', [secret.guard.id]);
      if (role === 'vishnu') await q('UPDATE vishnu_state SET failed_login_count = 0, locked_at = NULL WHERE id = 1');
    }
    async function lock(role: Role): Promise<void> {
      if (role === 'admin') await q('UPDATE company_admins SET failed_login_count = 5, locked_at = NOW() WHERE id = $1', [secret.admin.id]);
      if (role === 'guard') await q('INSERT INTO login_attempts (guard_id, failed_count, locked_at, updated_at) VALUES ($1, 5, NOW(), NOW())', [secret.guard.id]);
      if (role === 'vishnu') await q('UPDATE vishnu_state SET failed_login_count = 5, locked_at = NOW() WHERE id = 1');
    }
    /** What a request may change on the account: its failure count and lock, and its auth events (by type). */
    async function state(role: Role): Promise<{ n: number | null; locked: boolean; events: Record<string, number> }> {
      const row = role === 'admin' ? (await q('SELECT failed_login_count AS n, locked_at FROM company_admins WHERE id = $1', [secret.admin.id])).rows[0]
        : role === 'guard' ? (await q('SELECT failed_count AS n, locked_at FROM login_attempts WHERE guard_id = $1', [secret.guard.id])).rows[0] ?? null
          : role === 'vishnu' ? (await q('SELECT failed_login_count AS n, locked_at FROM vishnu_state WHERE id = 1')).rows[0] : null;
      const events: Record<string, number> = {};
      for (const r of (await q('SELECT event_type, count(*)::int AS n FROM auth_events WHERE actor_id = $1 AND created_at >= $2 GROUP BY event_type', [secret[role].id, runStart])).rows) events[r.event_type] = r.n;
      return { n: row?.n ?? null, locked: !!row?.locked_at, events };
    }
    /** The account after a request, and the events that request added. */
    const change = (a: Awaited<ReturnType<typeof state>>, b: Awaited<ReturnType<typeof state>>) => show({
      n: b.n, locked: b.locked,
      added: Object.fromEntries(Object.keys(b.events).filter((k) => b.events[k] !== (a.events[k] ?? 0)).sort().map((k) => [k, b.events[k] - (a.events[k] ?? 0)])),
    });

    // ══ the router as it is, as it was at BASE, and without N200's check in one route at a time ══
    const baseSrc = execFileSync('git', ['show', `${BASE}:apps/api/${AUTH_ROUTES}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    const ROUTE_OF: Record<Role | 'forgot', string> = { guard: '/guard/login', admin: '/admin/login', client: '/client/login', vishnu: '/vishnu/login', forgot: '/forgot-password' };
    const CHECK_OF: Record<Role | 'forgot', [string, string]> = {
      guard: ["  if (!isFilledString(email) || !isFilledString(password)) return", "  if (!email || !password) return"],
      admin: ["  if (!isFilledString(email) || !isFilledString(password)) return", "  if (!email || !password) return"],
      client: ["  if (!isFilledString(email) || !isFilledString(password)) return", "  if (!email || !password) return"],
      vishnu: ["  if (!isFilledString(email) || !isFilledString(password)) return", "  if (!email || !password) return"],
      forgot: ["  if (!isFilledString(email) || !portal) return", "  if (!email || !portal) return"],
    };
    const app = express();
    app.set('env', 'test'); // Express's own 500, without its stack trace on the console
    app.use(express.json());
    app.use('/api/auth', (await import('../src/routes/auth')).default);
    app.use('/api/auth-base', compileAt(AUTH_ROUTES, baseSrc).default);
    const nowSrc = fs.readFileSync(path.join(__dirname, '..', AUTH_ROUTES), 'utf8');
    for (const key of Object.keys(ROUTE_OF) as Array<Role | 'forgot'>) {
      const [from, to] = routeSpan(nowSrc, ROUTE_OF[key]);
      const [checkNow, checkOld] = CHECK_OF[key];
      const i = nowSrc.indexOf(checkNow, from);
      if (i < 0 || i >= to) throw new Error(`no N200 check in ${ROUTE_OF[key]}`);
      app.use(`/api/auth-no-check-${key}`, compileAt(AUTH_ROUTES, nowSrc.slice(0, i) + checkOld + nowSrc.slice(i + checkNow.length)).default);
    }
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    async function post(prefix: string, route: string, body: unknown) {
      const r = await fetch(`${origin}${prefix}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: r.status, body: json };
    }
    /** A response with the per-request parts (tokens) reduced to their shape. */
    const shape = (r: { status: number; body: any }) => show({ status: r.status, body: r.body && typeof r.body.access === 'string'
      ? { ...r.body, access: 'jwt', refresh: typeof r.body.refresh === 'string' ? 'jwt' : r.body.refresh } : r.body });
    /** The same request through BASE and now, each from the same account state. */
    async function both(role: Role, body: unknown, prep: () => Promise<void> = () => reset(role)) {
      await prep();
      const b0 = await state(role);
      const base = await post('/api/auth-base', ROUTE_OF[role], body);
      const baseTrace = change(b0, await state(role));
      await prep();
      const n0 = await state(role);
      const now = await post('/api/auth', ROUTE_OF[role], body);
      const nowTrace = change(n0, await state(role));
      return { base, now, baseTrace, nowTrace };
    }

    // ══════════════════════════════════════════════════════════════════════════
    section('C  an email or password that is not text: BASE 500, now the route\'s own 400');
    for (const role of ROLES) {
      const seen: string[] = [];
      let ok = true;
      for (const [label, value] of NOT_TEXT) {
        for (const [field, body] of [['password', { email: secret[role].email, password: value }], ['email', { email: value, password: secret[role].password }]] as const) {
          const r = await both(role, body);
          const { base, now } = r;
          // After reset(): admin and vishnu keep a count of 0, a guard has no login_attempts row, a client has no count.
          const untouched = show({ n: role === 'admin' || role === 'vishnu' ? 0 : null, locked: false, added: {} });
          if (!(base.status === 500 && now.status === 400 && show(now.body) === LOGIN_400 && r.nowTrace === untouched && r.baseTrace === untouched)) ok = false;
          seen.push(`${field} ${label} ${base.status}→${now.status}`);
        }
      }
      check(ok, `C1 ${ROUTE_OF[role]}: all ${NOT_TEXT.length * 2} go from BASE's 500 to 400 ${LOGIN_400}, recording nothing against the account (${seen.join(', ')})`);
    }
    {
      const seen: string[] = [];
      let ok = true;
      for (const [label, value] of NOT_TEXT) {
        const base = await post('/api/auth-base', '/forgot-password', { email: value, portal: 'admin' });
        const now = await post('/api/auth', '/forgot-password', { email: value, portal: 'admin' });
        if (!(base.status === 500 && now.status === 400 && show(now.body) === FORGOT_400)) ok = false;
        seen.push(`${label} ${base.status}→${now.status}`);
      }
      check(ok, `C2 /forgot-password: an email that is not text goes from BASE's 500 to 400 ${FORGOT_400} (${seen.join(', ')})`);
    }

    section('U  every other request gets BASE\'s answer');
    for (const role of ROLES) {
      const s = secret[role];
      const asks: Array<[string, unknown, (() => Promise<void>)?]> = [
        ['an empty body', {}],
        ['no password', { email: s.email }],
        ['an empty email', { email: '', password: s.password }],
        ['an empty password', { email: s.email, password: '' }],
        ['null for the email', { email: null, password: s.password }],
        ['0 for the password', { email: s.email, password: 0 }],
        ['false for the email', { email: false, password: s.password }],
        ['an unknown email', { email: `${marker}-nobody@test.invalid`, password: s.password }],
        ['a wrong password', { email: s.email, password: `${s.password}x` }],
        ['the right password', { email: s.email, password: s.password }],
        ['the email in capitals with spaces round it', { email: `  ${s.email.toUpperCase()} `, password: s.password }],
      ];
      if (role !== 'client') asks.push(['the right password on a locked account', { email: s.email, password: s.password }, async () => { await reset(role); await lock(role); }]);
      const differ: string[] = [];
      const seen: string[] = [];
      for (const [label, body, prep] of asks) {
        const r = await both(role, body, prep);
        seen.push(String(r.now.status));
        if (shape(r.base) !== shape(r.now) || r.baseTrace !== r.nowTrace || r.base.status === 500) {
          differ.push(`${label}: BASE ${shape(r.base)} ${r.baseTrace}, now ${shape(r.now)} ${r.nowTrace}`);
        }
      }
      check(differ.length === 0, `U1 ${ROUTE_OF[role]}: ${asks.length} requests, each answered as BASE answers it (status, body, token shape), each leaving the account as BASE leaves it, none a 500 (${seen.join(' ')})${differ.length ? ` — ${differ.join('; ')}` : ''}`);
    }
    {
      const asks: Array<[string, unknown]> = [
        ['an empty body', {}],
        ['no portal', { email: `${marker}-nobody@test.invalid` }],
        ['an unknown portal', { email: `${marker}-nobody@test.invalid`, portal: 'staff' }],
        ['a portal that is not text', { email: `${marker}-nobody@test.invalid`, portal: ['admin'] }],
        ['an unknown email, admin portal', { email: `${marker}-nobody@test.invalid`, portal: 'admin' }],
        ['an unknown email, guard portal', { email: `${marker}-nobody@test.invalid`, portal: 'guard' }],
        ['an unknown email, client portal', { email: `${marker}-nobody@test.invalid`, portal: 'client' }],
        ['the vishnu portal', { email: secret.vishnu.email, portal: 'vishnu' }],
      ];
      const differ: string[] = [];
      const seen: string[] = [];
      for (const [label, body] of asks) {
        const base = await post('/api/auth-base', '/forgot-password', body);
        const now = await post('/api/auth', '/forgot-password', body);
        seen.push(String(now.status));
        if (show(base) !== show(now) || base.status === 500) differ.push(`${label}: BASE ${show(base)}, now ${show(now)}`);
      }
      check(differ.length === 0, `U2 /forgot-password: ${asks.length} requests answered as BASE answers them, none a 500 (${seen.join(' ')})${differ.length ? ` — ${differ.join('; ')}` : ''}`);
    }

    section('S  every read of a body email or password sits behind the check in its own route');
    {
      const src = nowSrc;
      const spans = (Object.keys(ROUTE_OF) as Array<Role | 'forgot'>).map((k) => [k, ...routeSpan(src, ROUTE_OF[k])] as const);
      // Code only: a match on a comment line (this route's own docblock names both calls) is prose.
      const onComment = (i: number) => /^\s*(\*|\/\/)/.test(src.slice(src.lastIndexOf('\n', i) + 1, i));
      const reads = [...src.matchAll(/email\.toLowerCase\(\)|bcrypt\.compare\(password,/g)].map((m) => m.index ?? -1).filter((i) => !onComment(i));
      const unguarded = reads.filter((i) => {
        const span = spans.find(([, a, b]) => i > a && i < b);
        if (!span) return true;
        const guard = src.indexOf(CHECK_OF[span[0]][0], span[1]);
        return guard < 0 || guard > i;
      });
      check(reads.length === 9 && unguarded.length === 0,
        `S1 ${reads.length} reads (5 email.toLowerCase(), 4 bcrypt.compare(password, …)), every one inside one of the 5 routes and after its check (${unguarded.length} not)`);
    }

    section('M  mutation controls: each route without the check answers 500 again');
    {
      let caught = 0;
      for (const key of Object.keys(ROUTE_OF) as Array<Role | 'forgot'>) {
        const body = key === 'forgot' ? { email: 12345678, portal: 'admin' } : { email: secret[key].email, password: 12345678 };
        if (key !== 'forgot') await reset(key);
        const r = await post(`/api/auth-no-check-${key}`, ROUTE_OF[key], body);
        const ok = r.status === 500;
        if (ok) caught += 1;
        check(ok, `M1 control — ${ROUTE_OF[key]} without the check: ${r.status} for a number, which C refuses`);
      }
      check(caught === 5, `M2 ${caught} of 5 mutants caught`);
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    const ids = [...made.company_admins, ...made.clients, ...made.guards];
    if (ids.length) await q('DELETE FROM auth_events WHERE actor_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM auth_events WHERE actor_id = $1 AND created_at >= $2', [VISHNU_ID, runStart]);
    await q('UPDATE vishnu_state SET failed_login_count = $1, locked_at = $2, tokens_not_before = $3 WHERE id = 1',
      [priorVishnu.failed_login_count, priorVishnu.locked_at, priorVishnu.tokens_not_before]);
    if (made.guards.length) {
      await q('DELETE FROM login_attempts WHERE guard_id = ANY($1::uuid[])', [made.guards]);
      await q('DELETE FROM guard_site_assignments WHERE guard_id = ANY($1::uuid[])', [made.guards]);
      await q('DELETE FROM guard_devices WHERE guard_id = ANY($1::uuid[])', [made.guards]);
    }
    if (made.clients.length) await q('DELETE FROM client_sites WHERE client_id = ANY($1::uuid[])', [made.clients]);
    for (const t of ['company_admins', 'clients', 'guards', 'sites']) if (made[t].length) await q(`DELETE FROM ${t} WHERE id = ANY($1::uuid[])`, [made[t]]);
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int + (SELECT count(*) FROM clients WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM guards WHERE email LIKE $1)::int + (SELECT count(*) FROM sites WHERE name LIKE $1)::int AS n`, [`${marker}%`])).rows[0].n;
    const vs = (await q('SELECT failed_login_count, locked_at, tokens_not_before FROM vishnu_state WHERE id = 1')).rows[0];
    const restored = show(vs) === show(priorVishnu);
    console.log(`\ncleanup: ${left} seeded rows left; vishnu_state ${restored ? 'restored' : 'NOT restored'}`);
    if (left !== 0 || !restored) failures += 1;
    await pool.end();
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
