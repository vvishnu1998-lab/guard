/**
 * test-phase-c-change-password.ts — what Settings → YOUR ACCOUNT → CHANGE PASSWORD leads to (Phase C).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-phase-c-change-password.ts     (from apps/api)
 *
 * Phase C adds a link, not an endpoint (Vishnu's decisions 1a and 2a, 2026-10-13): Settings opens
 * /admin/change-password?from=settings, which posts to the POST /api/auth/admin/change-password a
 * temporary password has always used, and the admin signs in again afterwards. The link is for every
 * admin, so this proves that route over HTTP, as the page calls it, for a primary admin, a secondary
 * one and an admin on a temporary password, on a local database:
 *
 *   P  a primary admin: the change, the new hash, the event; every old session ends; the new password signs in
 *   S  a secondary admin: the same
 *   T  an admin on a temporary password, through the same route: the flag clears
 *   E  a refused change leaves everything as it was: a wrong current password, a new one outside 8-128,
 *      no current password, another role's token; one admin's change touches no other admin
 *   M  mutation controls: the route without the session stamp, without the current-password check,
 *      without the length rule, each caught by the check written for it
 *
 * LOCAL DATABASES ONLY; fake admins on Star Guard's id and on an invented company, with passwords
 * generated here and never printed. Sentry and email are stubbed, and /api/auth is mounted without its
 * rate limiter (20 requests per 15 minutes per IP in production; this makes about 60).
 */
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';

process.env.JWT_SECRET = 'test-only-phase-c';
process.env.JWT_REFRESH_SECRET = 'test-only-phase-c-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-phase-c-vishnu';

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
      : () => { throw new Error(`${name}.${String(prop)} called in the Phase C test`); }),
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
/** `apps/api/<rel>` from the working tree run through `edit`, compiled under its own path: a mutant. */
function mutantOf(rel: string, edit: (src: string) => string): any {
  const file = path.join(__dirname, '..', rel);
  const src = fs.readFileSync(file, 'utf8');
  const edited = edit(src);
  if (edited === src) throw new Error(`mutantOf(${rel}): the edit changed nothing`);
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

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  inject('../src/services/s3', stubModule('s3', { urlOrPresign: async (url: string | null) => url }));

  const bcrypt = (await import('bcrypt')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;

  const marker = `lhpc-${Date.now().toString(36)}`;
  const admins: string[] = [];
  const companies: string[] = [];
  let swept = 0;
  for (const sql of [
    "DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhpc-%')",
    "DELETE FROM company_admins WHERE email LIKE 'lhpc-%'",
    "DELETE FROM companies WHERE name LIKE 'Fixture Patrol lhpc-%'",
  ]) swept += (await q(sql)).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  let server: Server | null = null;

  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const other = (await q('INSERT INTO companies (name) VALUES ($1) RETURNING id', [`Fixture Patrol ${marker}`])).rows[0].id as string;
    companies.push(other);
    /** A fixture admin with a fresh password; the primary flag and a temporary password as asked. */
    const mkAdmin = async (companyId: string, tag: string, o: { primary?: boolean; temporary?: boolean } = {}) => {
      const password = pw();
      const email = `${marker}-${tag}@test.invalid`;
      const id = (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [companyId, `${marker} ${tag}`, email, await bcrypt.hash(password, 4), o.primary === true, o.temporary === true])).rows[0].id as string;
      admins.push(id);
      return { id, email, password };
    };
    // Star Guard has its primary; every other fixture admin there is secondary (one primary per company).
    const prim = await mkAdmin(STAR_GUARD, 'primary', { primary: !(await q('SELECT 1 FROM company_admins WHERE company_id = $1 AND is_primary AND is_active', [STAR_GUARD])).rowCount });
    const second = await mkAdmin(STAR_GUARD, 'secondary');
    const temp = await mkAdmin(STAR_GUARD, 'temporary', { temporary: true });
    const otherAdmin = await mkAdmin(other, 'other', { primary: true });
    const isPrimary = (await q('SELECT is_primary FROM company_admins WHERE id = $1', [prim.id])).rows[0].is_primary as boolean;

    // ══ the real routers over HTTP, and three mutants of the auth router ══
    const authRoutes = (await import('../src/routes/auth')).default;
    const app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);
    app.use('/api/admin/company', (await import('../src/routes/companyProfile')).default);
    const ADMIN_ROUTE = "router.post('/admin/change-password', requireAuth('company_admin'), async (req: Request, res: Response) => {\n  const { current_password, new_password } = req.body;\n  const policyErr = validatePassword(new_password);";
    app.use('/api/auth-m1', mutantOf('src/routes/auth.ts', (s) => s.replace(
      "'UPDATE company_admins SET password_hash = $1, must_change_password = false, tokens_not_before = NOW() WHERE id = $2',",
      "'UPDATE company_admins SET password_hash = $1, must_change_password = false WHERE id = $2',")).default);
    app.use('/api/auth-m2', mutantOf('src/routes/auth.ts', (s) => s.replace(
      'const valid = await bcrypt.compare(current_password, adminResult.rows[0].password_hash);', 'const valid = true;')).default);
    app.use('/api/auth-m3', mutantOf('src/routes/auth.ts', (s) => s.replace(ADMIN_ROUTE,
      ADMIN_ROUTE.replace('const policyErr = validatePassword(new_password);', 'const policyErr = null as string | null;'))).default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;

    async function post(p: string, body: unknown, token?: string) {
      const r = await fetch(`${origin}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => null) as any };
    }
    const login = (email: string, password: string) => post('/api/auth/admin/login', { email, password });
    const change = (token: string, current: unknown, next: unknown, prefix = '/api/auth') =>
      post(`${prefix}/admin/change-password`, current === undefined ? { new_password: next } : { current_password: current, new_password: next }, token);
    /** GET /api/admin/company with this token: what Settings loads, and a route that ends with the session. */
    const settings = async (token: string) => (await fetch(`${origin}/api/admin/company`, { headers: { authorization: `Bearer ${token}` } })).status;
    const refresh = async (token: string) => (await post('/api/auth/refresh', { refresh_token: token })).status;
    /** The session stamp has second precision against the token's iat (middleware: (iat + 1) s <= stamp), so a change
     *  is made only once the login's second has passed, as any change made by a person is. */
    const pastIat = async (access: string) => {
      const iat = (jwt.decode(access) as { iat: number }).iat;
      const wait = (iat + 1) * 1000 + 60 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    };
    const rowOf = async (id: string) => (await q('SELECT password_hash, must_change_password, tokens_not_before FROM company_admins WHERE id = $1', [id])).rows[0];
    const eventsOf = async (id: string) => (await q("SELECT role FROM auth_events WHERE actor_id = $1 AND event_type = 'password_changed'", [id])).rows as Array<{ role: string }>;

    /** The whole change, as the page makes it, for one admin; returns what each later section needs. */
    async function changesAndSignsInAgain(label: string, who: { id: string; email: string; password: string }) {
      const l = await login(who.email, who.password);
      check(l.status === 200 && typeof l.body?.access === 'string' && l.body.must_change_password === false,
        `${label}1 sign in: 200, no temporary password (${l.status})`);
      const before = await rowOf(who.id);
      await pastIat(l.body.access);
      const next = pw();
      const t0 = Date.now();
      const c = await change(l.body.access, who.password, next);
      check(c.status === 200 && show(c.body) === '{"success":true}', `${label}2 POST /api/auth/admin/change-password with the current password: 200 {"success":true} (${c.status} ${show(c.body)})`);
      const after = await rowOf(who.id);
      const stamp = after.tokens_not_before ? new Date(after.tokens_not_before).getTime() : 0;
      const events = await eventsOf(who.id);
      check(after.password_hash !== before.password_hash && await bcrypt.compare(next, after.password_hash) && !(await bcrypt.compare(who.password, after.password_hash))
        && after.must_change_password === false && stamp >= t0 - 1000 && stamp <= Date.now() + 1000 && show(events) === '[{"role":"company_admin"}]',
        `${label}3 the new password is the one stored, the flag is clear, tokens_not_before is the change's time, and one "password_changed" event (role company_admin)`);
      const oldAccess = await settings(l.body.access);
      const oldRefresh = await refresh(l.body.refresh);
      check(oldAccess === 401 && oldRefresh === 401, `${label}4 every old session ends: the old access token gets ${oldAccess} from Settings' route, the old refresh token ${oldRefresh}`);
      const withOld = await login(who.email, who.password);
      const withNew = await login(who.email, next);
      const settingsAfter = withNew.status === 200 ? await settings(withNew.body.access) : 0;
      check(withOld.status === 401 && withNew.status === 200 && settingsAfter === 200,
        `${label}5 sign in again, as the login page asks: the old password ${withOld.status}, the new one ${withNew.status}, and Settings loads (${settingsAfter})`);
      return { ...who, password: next };
    }

    // ══════════════════════════════════════════════════════════════════════════
    section(`P  a primary admin (is_primary ${isPrimary})`);
    const primAfter = await changesAndSignsInAgain('P', prim);
    check(isPrimary || (await q('SELECT 1 FROM company_admins WHERE company_id = $1 AND is_primary AND is_active AND id <> $2', [STAR_GUARD, prim.id])).rowCount === 1,
      `P6 the fixture "primary" is the company's primary, or this database already has one (then P ran as a second secondary)`);

    section('S  a secondary admin (is_primary false)');
    check((await q('SELECT is_primary FROM company_admins WHERE id = $1', [second.id])).rows[0].is_primary === false, 'S0 the fixture is a secondary admin');
    await changesAndSignsInAgain('S', second);

    section('T  an admin on a temporary password: the same route, the flag clears');
    {
      const l = await login(temp.email, temp.password);
      check(l.status === 200 && l.body?.must_change_password === true, `T1 sign in: must_change_password true, so the login page sends this admin to /admin/change-password (${l.status})`);
      await pastIat(l.body.access);
      const next = pw();
      const c = await change(l.body.access, temp.password, next);
      const again = await login(temp.email, next);
      check(c.status === 200 && (await rowOf(temp.id)).must_change_password === false && again.status === 200 && again.body?.must_change_password === false,
        `T2 the change clears the flag; the next sign-in goes straight in (${c.status}, ${again.status}, ${show(again.body?.must_change_password)})`);
    }

    section('E  a refused change leaves everything as it was');
    {
      const l = await login(primAfter.email, primAfter.password);
      await pastIat(l.body.access);
      const before = await rowOf(primAfter.id);
      const events = (await eventsOf(primAfter.id)).length;
      const unchanged = async () => { const r = await rowOf(primAfter.id); return r.password_hash === before.password_hash && String(r.tokens_not_before) === String(before.tokens_not_before) && (await eventsOf(primAfter.id)).length === events; };
      const wrong = await change(l.body.access, `${primAfter.password}x`, pw());
      check(wrong.status === 401 && wrong.body?.error === 'Current password is incorrect' && await unchanged() && await settings(l.body.access) === 200,
        `E1 a wrong current password: 401 "Current password is incorrect"; nothing stored, no event, and the session goes on (${wrong.status} ${show(wrong.body)})`);
      const short = await change(l.body.access, primAfter.password, 'Ab3$xyz');
      const long = await change(l.body.access, primAfter.password, 'x'.repeat(129));
      check(short.status === 400 && long.status === 400 && short.body?.error === 'Minimum 8 characters.' && await unchanged() && await settings(l.body.access) === 200,
        `E2 a new password of 7 or 129 characters: 400 "Minimum 8 characters." (${short.status}, ${long.status}); nothing stored`);
      const none = await change(l.body.access, undefined, pw());
      check(none.status >= 400 && await unchanged() && await settings(l.body.access) === 200,
        `E3 no current password at all: refused (${none.status}${none.status === 500 ? ', a 500 rather than a 400: N195' : ''}); nothing stored`);
      const guardToken = jwt.sign({ sub: primAfter.id, role: 'guard', company_id: STAR_GUARD }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      const clientToken = jwt.sign({ sub: primAfter.id, role: 'client', site_id: STAR_GUARD }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      const asGuard = await change(guardToken, primAfter.password, pw());
      const asClient = await change(clientToken, primAfter.password, pw());
      check([401, 403].includes(asGuard.status) && [401, 403].includes(asClient.status) && await unchanged(),
        `E4 a guard's or a client's token on the admin route: refused (${asGuard.status}, ${asClient.status}); nothing stored`);
      const otherBefore = (await rowOf(otherAdmin.id)).password_hash;
      const o = await login(otherAdmin.email, otherAdmin.password);
      await pastIat(o.body.access);
      const oc = await change(o.body.access, otherAdmin.password, pw());
      check(oc.status === 200 && (await rowOf(otherAdmin.id)).password_hash !== otherBefore && await unchanged(),
        `E5 another company's admin changes their own password; this admin's row is untouched (${oc.status})`);
    }

    section('M  mutation controls: each check above can fail');
    {
      let caught = 0;
      {
        const a = await mkAdmin(other, 'm1');
        const l = await login(a.email, a.password);
        await pastIat(l.body.access);
        const c = await change(l.body.access, a.password, pw(), '/api/auth-m1');
        const ok = c.status === 200 && await settings(l.body.access) === 200;
        if (ok) caught += 1;
        check(ok, 'M1 control — the route without the tokens_not_before stamp: the old session goes on, which section P4 refuses');
      }
      {
        const a = await mkAdmin(other, 'm2');
        const l = await login(a.email, a.password);
        await pastIat(l.body.access);
        const c = await change(l.body.access, `${a.password}x`, pw(), '/api/auth-m2');
        const ok = c.status === 200;
        if (ok) caught += 1;
        check(ok, `M2 control — the route without the current-password check: a wrong one is taken (${c.status}), which E1 refuses`);
      }
      {
        const a = await mkAdmin(other, 'm3');
        const l = await login(a.email, a.password);
        await pastIat(l.body.access);
        const c = await change(l.body.access, a.password, 'Ab3$xyz', '/api/auth-m3');
        const ok = c.status === 200;
        if (ok) caught += 1;
        check(ok, `M3 control — the route without the length rule: a 7-character password is taken (${c.status}), which E2 refuses`);
      }
      check(caught === 3, `M4 ${caught} of 3 mutants behave as the checks above would catch`);
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    if (admins.length) {
      await q('DELETE FROM auth_events WHERE actor_id = ANY($1::uuid[])', [admins]);
      await q('DELETE FROM company_admins WHERE id = ANY($1::uuid[])', [admins]);
    }
    if (companies.length) await q('DELETE FROM companies WHERE id = ANY($1::uuid[])', [companies]);
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int + (SELECT count(*) FROM companies WHERE name LIKE $2)::int AS n`,
      [`${marker}%`, `%${marker}`])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
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
