/**
 * test-n194-temporary-password-hold.ts — an admin on a temporary password can only change it (N194).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n194-temporary-password-hold.ts     (from apps/api)
 *
 * requireAuth now refuses an admin whose company_admins.must_change_password is set with 403
 * {"code":"PASSWORD_CHANGE_REQUIRED","error":<a sentence>}, which the admin web answers by opening
 * /admin/change-password. POST /api/auth/admin/change-password and POST /api/auth/logout take the session
 * as before, through requireAuthAllowingTemporaryPassword. Over HTTP, with the real routers:
 *
 *   H  the hold: an admin signed in on a temporary password is refused Settings' route, the nav's chat poll,
 *      the sites list and a write (nothing written); a refreshed session is held too; the checks that came
 *      first still answer first (a deactivated admin, a revoked session)
 *   A  what stays open: sign-out, and the change itself (the flag clears, the old sessions end, the new
 *      sign-in reaches every route)
 *   N  who is not held: an admin with a password of their own (the same write goes through); a guard and a
 *      client whose must_change_password is set, whose apps handle it (N199)
 *   S  requireAuthAllowingTemporaryPassword is used by those two routes and no other
 *   M  mutation controls: the middleware called directly, without the hold, with a hold that ignores the
 *      allowance, reading the admin row without the column, and holding ahead of the deactivation check;
 *      the auth router with sign-out or the change behind plain requireAuth
 *
 * LOCAL DATABASES ONLY; fake rows on Star Guard's id, passwords generated here and never printed. Sentry,
 * email, S3 and Firebase are stubbed, and /api/auth is mounted without its rate limiter.
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
const HELD = '{"code":"PASSWORD_CHANGE_REQUIRED","error":"Change your temporary password to continue."}';

process.env.JWT_SECRET = 'test-only-n194';
process.env.JWT_REFRESH_SECRET = 'test-only-n194-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-n194-vishnu';

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
      : () => { throw new Error(`${name}.${String(prop)} called in the N194 test`); }),
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
/** `s` with `from` replaced, which must occur exactly once. */
function once(s: string, from: string, to: string): string {
  const n = s.split(from).length - 1;
  if (n !== 1) throw new Error(`expected one ${JSON.stringify(from.slice(0, 60))}, found ${n}`);
  return s.replace(from, to);
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

// The middleware's hold, as written, and the two lines a mutant needs to find.
const HOLD_BLOCK = "      if (adminRow.must_change_password && !opts.allowTemporaryPassword) {\n        return res.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', error: 'Change your temporary password to continue.' });\n      }\n";
const ADMIN_SELECT = "'SELECT is_active, tokens_not_before, must_change_password FROM company_admins WHERE id = $1'";
const ADMIN_ROW = '      const adminRow = adminResult.rows[0];\n';

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  inject('../src/services/s3', stubModule('s3', { urlOrPresign: async (url: string | null) => url }));
  inject('../src/services/firebase', stubModule('firebase'));

  const bcrypt = (await import('bcrypt')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;

  const marker = `lhn194-${Date.now().toString(36)}`;
  const made: Record<string, string[]> = { company_admins: [], clients: [], guards: [], sites: [] };
  let swept = 0;
  for (const sql of [
    "DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn194-%' UNION ALL SELECT id FROM clients WHERE email LIKE 'lhn194-%' UNION ALL SELECT id FROM guards WHERE email LIKE 'lhn194-%')",
    "DELETE FROM guard_devices WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn194-%')",
    "DELETE FROM company_admins WHERE email LIKE 'lhn194-%'",
    "DELETE FROM clients WHERE email LIKE 'lhn194-%'",
    "DELETE FROM guards WHERE email LIKE 'lhn194-%'",
    "DELETE FROM sites WHERE name LIKE 'lhn194-%'",
  ]) swept += (await q(sql)).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  const jtis: string[] = [];
  let server: Server | null = null;

  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const siteName = `${marker} North Gate`;
    const site = (await q(`INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1 Example Way', '2026-01-01') RETURNING id`,
      [STAR_GUARD, siteName])).rows[0].id as string;
    made.sites.push(site);
    let n = 0;
    /** A fixture admin (secondary), with a fresh password; `temporary` sets must_change_password. */
    async function mkAdmin(o: { temporary: boolean; active?: boolean }) {
      n += 1;
      const password = pw();
      const email = `${marker}-admin-${n}@test.invalid`;
      const id = (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password, is_active)
        VALUES ($1, $2, $3, $4, false, $5, $6) RETURNING id`, [STAR_GUARD, `${marker} ${n}`, email, await bcrypt.hash(password, 4), o.temporary, o.active ?? true])).rows[0].id as string;
      made.company_admins.push(id);
      return { id, email, password };
    }
    /** An access token signed as the admin login signs one, a few seconds back. */
    const adminToken = (id: string) => jwt.sign({ sub: id, role: 'company_admin', company_id: STAR_GUARD, is_primary: false, iat: Math.floor(Date.now() / 1000) - 5 }, process.env.JWT_SECRET!, { expiresIn: '1h' });

    // ══ the real routers over HTTP, and two mutants of the auth router ══
    const app = express();
    app.set('env', 'test'); // Express's own 500, without its stack trace on the console
    app.use(express.json());
    app.use('/api/auth', (await import('../src/routes/auth')).default);
    app.use('/api/admin/company', (await import('../src/routes/companyProfile')).default);
    app.use('/api/chat', (await import('../src/routes/chat')).default);
    app.use('/api/sites', (await import('../src/routes/sites')).default);
    app.use('/api/client', (await import('../src/routes/clientPortal')).default);
    app.use('/api/auth-m-logout', mutantOf('src/routes/auth.ts', (s) => once(s,
      "router.post('/logout', requireAuthAllowingTemporaryPassword('guard', 'company_admin', 'client', 'vishnu'), ",
      "router.post('/logout', requireAuth('guard', 'company_admin', 'client', 'vishnu'), ")).default);
    app.use('/api/auth-m-change', mutantOf('src/routes/auth.ts', (s) => once(s,
      "router.post('/admin/change-password', requireAuthAllowingTemporaryPassword('company_admin'), ",
      "router.post('/admin/change-password', requireAuth('company_admin'), ")).default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;

    async function call(method: string, p: string, token: string | null, body?: unknown) {
      const r = await fetch(`${origin}${p}`, {
        method,
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await r.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: r.status, body: json as any, raw: text };
    }
    const login = (email: string, password: string) => call('POST', '/api/auth/admin/login', null, { email, password });
    /** The admin routes a signed-in admin reaches first: Settings, the nav's chat poll, the sites list. */
    const reads = async (token: string) => Promise.all([
      call('GET', '/api/admin/company', token), call('GET', '/api/chat/rooms', token), call('GET', '/api/sites', token),
    ]);
    const siteNameNow = async () => (await q('SELECT name FROM sites WHERE id = $1', [site])).rows[0].name as string;
    /** The session stamp has second precision against the token's iat, so a change is made once the login's second has passed. */
    const pastIat = async (access: string) => {
      const iat = (jwt.decode(access) as { iat: number }).iat;
      const wait = (iat + 1) * 1000 + 60 - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    };
    const remember = (refresh: string) => { const d = jwt.decode(refresh) as { jti?: string } | null; if (d?.jti) jtis.push(d.jti); };

    // ══════════════════════════════════════════════════════════════════════════
    section('H  the hold: an admin on a temporary password');
    const temp = await mkAdmin({ temporary: true });
    const l1 = await login(temp.email, temp.password);
    remember(l1.body?.refresh);
    check(l1.status === 200 && l1.body?.must_change_password === true && typeof l1.body?.access === 'string',
      `H0 sign in with the temporary password: 200, must_change_password true, so the login page opens /admin/change-password (${l1.status})`);
    {
      const [company, rooms, sites] = await reads(l1.body.access);
      check([company, rooms, sites].every((r) => r.status === 403 && r.raw === HELD),
        `H1 GET /api/admin/company, /api/chat/rooms, /api/sites: 403 ${HELD} (${company.status}, ${rooms.status}, ${sites.status})`);
      const put = await call('PUT', `/api/sites/${site}`, l1.body.access, { name: `${marker} renamed` });
      check(put.status === 403 && put.raw === HELD && await siteNameNow() === siteName, `H2 a write, PUT /api/sites/:id: 403, the hold's body; the site keeps its name (${put.status})`);
      const r = await call('POST', '/api/auth/refresh', null, { refresh_token: l1.body.refresh });
      remember(r.body?.refresh);
      const again = r.status === 200 ? await call('GET', '/api/admin/company', r.body.access) : null;
      check(r.status === 200 && again?.status === 403 && again.raw === HELD,
        `H3 a refreshed session is held the same: refresh ${r.status}, then Settings' route ${again?.status}`);
      const gone = await mkAdmin({ temporary: true, active: false });
      const deactivated = await call('GET', '/api/admin/company', adminToken(gone.id));
      const revokedAdmin = await mkAdmin({ temporary: true });
      await q('UPDATE company_admins SET tokens_not_before = NOW() WHERE id = $1', [revokedAdmin.id]);
      const revoked = await call('GET', '/api/admin/company', adminToken(revokedAdmin.id));
      check(deactivated.status === 403 && show(deactivated.body) === '{"error":"Account deactivated"}' && revoked.status === 401 && show(revoked.body) === '{"error":"Session revoked by administrator"}',
        `H4 the checks that came first answer first: a deactivated admin on a temporary password ${deactivated.status} ${show(deactivated.body)}, a revoked session ${revoked.status} ${show(revoked.body)}`);
    }

    section('A  what stays open: sign-out, and the change itself');
    {
      const l2 = await login(temp.email, temp.password);
      remember(l2.body?.refresh);
      const out = await call('POST', '/api/auth/logout', l2.body.access, { refresh_token: l2.body.refresh });
      const after = await call('POST', '/api/auth/refresh', null, { refresh_token: l2.body.refresh });
      check(out.status === 200 && show(out.body) === '{"success":true}' && after.status === 401,
        `A1 POST /api/auth/logout: ${out.status} ${show(out.body)}; the refresh token it ended is refused after (${after.status})`);
      await pastIat(l1.body.access);
      const next = pw();
      const c = await call('POST', '/api/auth/admin/change-password', l1.body.access, { current_password: temp.password, new_password: next });
      const row = (await q('SELECT must_change_password, tokens_not_before FROM company_admins WHERE id = $1', [temp.id])).rows[0];
      check(c.status === 200 && show(c.body) === '{"success":true}' && row.must_change_password === false && row.tokens_not_before !== null,
        `A2 POST /api/auth/admin/change-password: ${c.status} ${show(c.body)}; the flag clears and the old sessions end`);
      const old = await call('GET', '/api/admin/company', l1.body.access);
      check(old.status === 401 && show(old.body) === '{"error":"Session revoked by administrator"}',
        `A3 the temporary session now ends as any changed password's does: ${old.status} ${show(old.body)}`);
      const l3 = await login(temp.email, next);
      remember(l3.body?.refresh);
      const reached = l3.status === 200 ? await reads(l3.body.access) : [];
      check(l3.status === 200 && l3.body?.must_change_password === false && reached.length === 3 && reached.every((r) => r.status === 200),
        `A4 sign in with the new password: must_change_password ${show(l3.body?.must_change_password)}, and every route answers (${reached.map((r) => r.status).join(', ')})`);
    }

    section('N  who is not held');
    {
      const own = await mkAdmin({ temporary: false });
      const l = await login(own.email, own.password);
      remember(l.body?.refresh);
      const reached = await reads(l.body.access);
      const put = await call('PUT', `/api/sites/${site}`, l.body.access, { name: `${marker} renamed` });
      check(l.body?.must_change_password === false && reached.every((r) => r.status === 200) && put.status === 200 && await siteNameNow() === `${marker} renamed`,
        `N1 an admin with a password of their own: every route answers (${reached.map((r) => r.status).join(', ')}), and the write H2 refused goes through (${put.status})`);
      await q('UPDATE sites SET name = $1 WHERE id = $2', [siteName, site]);
      const gPassword = pw();
      const guard = (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number, must_change_password) VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [STAR_GUARD, `${marker} guard`, `${marker}-guard@test.invalid`, await bcrypt.hash(gPassword, 4), `LH94-${marker.slice(-6)}`])).rows[0].id as string;
      made.guards.push(guard);
      const gToken = jwt.sign({ sub: guard, role: 'guard', company_id: STAR_GUARD, iat: Math.floor(Date.now() / 1000) - 5 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      const gRooms = await call('GET', '/api/chat/rooms', gToken);
      const gWrong = await call('POST', '/api/auth/guard/change-password', gToken, { current_password: `${gPassword}x`, new_password: pw() });
      check(gRooms.status === 200 && gWrong.status === 401,
        `N2 a guard whose must_change_password is set: chat rooms ${gRooms.status}, a wrong current password ${gWrong.status} (the mobile app holds them itself)`);
      const client = (await q(`INSERT INTO clients (site_id, company_id, name, email, password_hash, must_change_password) VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
        [site, STAR_GUARD, `${marker} client`, `${marker}-client@test.invalid`, await bcrypt.hash(pw(), 4)])).rows[0].id as string;
      made.clients.push(client);
      const cToken = jwt.sign({ sub: client, role: 'client', site_id: site, iat: Math.floor(Date.now() / 1000) - 5 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      const cSite = await call('GET', '/api/client/site', cToken);
      check(cSite.status === 200 && cSite.body?.id === site, `N3 a client whose must_change_password is set: GET /api/client/site ${cSite.status} (not held: N199)`);
    }

    section('S  requireAuthAllowingTemporaryPassword is used by those two routes and no other');
    {
      const uses = execFileSync('git', ['grep', '-n', 'requireAuthAllowingTemporaryPassword(', '--', 'src'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' })
        .trim().split('\n').filter((l) => !l.startsWith('src/middleware/auth.ts:'));
      const routes = uses.map((l) => l.replace(/^[^:]+:\d+:/, '').trim().split(', async')[0]);
      check(show(routes) === show([
        "router.post('/admin/change-password', requireAuthAllowingTemporaryPassword('company_admin')",
        "router.post('/logout', requireAuthAllowingTemporaryPassword('guard', 'company_admin', 'client', 'vishnu')",
      ]) && uses.every((l) => l.startsWith('src/routes/auth.ts:')), `S1 two call sites, both in routes/auth.ts: ${routes.join(' | ')}`);
    }

    section('M  mutation controls');
    {
      // The middleware called directly: the answer it gives, or whether it lets the request through.
      type Probe = { through: boolean; status: number; body: string };
      const probe = (mw: (req: any, res: any, next: () => void) => unknown, token: string): Promise<Probe> => new Promise((resolve) => {
        const res = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { resolve({ through: false, status: this.statusCode, body: show(b) }); return this; } };
        void mw({ headers: { authorization: `Bearer ${token}` }, method: 'GET' }, res, () => resolve({ through: true, status: 0, body: '' }));
      });
      const real: any = await import('../src/middleware/auth');
      const t = await mkAdmin({ temporary: true });
      const tGone = await mkAdmin({ temporary: true, active: false });
      const own = await mkAdmin({ temporary: false });
      const tTok = adminToken(t.id);
      const sees = async (m: any) => ({
        held: await probe(m.requireAuth('company_admin'), tTok),
        allowed: await probe(m.requireAuthAllowingTemporaryPassword('company_admin'), tTok),
        gone: await probe(m.requireAuth('company_admin'), adminToken(tGone.id)),
        own: await probe(m.requireAuth('company_admin'), adminToken(own.id)),
      });
      const r = await sees(real);
      check(!r.held.through && r.held.status === 403 && r.held.body === HELD && r.allowed.through && r.gone.body === '{"error":"Account deactivated"}' && r.own.through,
        'M0 the probe reads the real middleware as HTTP does: held 403, allowed through, deactivated first, an own password through');
      let caught = 0;
      const mutants: Array<[string, string, (s: string) => string, (p: Awaited<ReturnType<typeof sees>>) => boolean]> = [
        ['M1', 'no hold: the temporary password goes through, which H1 refuses',
          (s) => once(s, HOLD_BLOCK, ''), (p) => p.held.through],
        ['M2', 'a hold that ignores the allowance: the change itself is refused, which A2 refuses',
          (s) => once(s, 'if (adminRow.must_change_password && !opts.allowTemporaryPassword) {', 'if (adminRow.must_change_password) {'), (p) => !p.allowed.through],
        ['M3', 'the admin row read without must_change_password: nothing is held, which H1 refuses',
          (s) => once(s, ADMIN_SELECT, "'SELECT is_active, tokens_not_before FROM company_admins WHERE id = $1'"), (p) => p.held.through],
        ['M4', 'the hold ahead of the deactivation check: a deactivated admin hears "change your password", which H4 refuses',
          (s) => once(once(s, HOLD_BLOCK, ''), ADMIN_ROW, ADMIN_ROW + HOLD_BLOCK), (p) => p.gone.body === HELD],
      ];
      for (const [id, what, edit, wrong] of mutants) {
        const p = await sees(mutantOf('src/middleware/auth.ts', edit));
        const ok = wrong(p);
        if (ok) caught += 1;
        check(ok, `${id} control — the middleware with ${what}`);
      }
      {
        const l = await login(t.email, t.password);
        remember(l.body?.refresh);
        const out = await call('POST', '/api/auth-m-logout/logout', l.body.access, { refresh_token: l.body.refresh });
        const ok = out.status === 403 && out.raw === HELD;
        if (ok) caught += 1;
        check(ok, `M5 control — sign-out behind plain requireAuth: ${out.status}, which A1 refuses`);
        await pastIat(l.body.access);
        const c = await call('POST', '/api/auth-m-change/admin/change-password', l.body.access, { current_password: t.password, new_password: pw() });
        const ok2 = c.status === 403 && c.raw === HELD;
        if (ok2) caught += 1;
        check(ok2, `M6 control — the change behind plain requireAuth: ${c.status}; the admin could never leave the temporary password, which A2 refuses`);
      }
      check(caught === 6, `M7 ${caught} of 6 mutants caught`);
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    const ids = [...made.company_admins, ...made.clients, ...made.guards];
    if (ids.length) await q('DELETE FROM auth_events WHERE actor_id = ANY($1::uuid[])', [ids]);
    if (jtis.length) await q('DELETE FROM revoked_tokens WHERE jti = ANY($1::text[])', [jtis]);
    if (made.guards.length) await q('DELETE FROM guard_devices WHERE guard_id = ANY($1::uuid[])', [made.guards]);
    for (const t of ['company_admins', 'clients', 'guards', 'sites']) if (made[t].length) await q(`DELETE FROM ${t} WHERE id = ANY($1::uuid[])`, [made[t]]);
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int + (SELECT count(*) FROM clients WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM guards WHERE email LIKE $1)::int + (SELECT count(*) FROM sites WHERE name LIKE $1)::int
                                + (SELECT count(*) FROM revoked_tokens WHERE jti = ANY($2::text[]))::int AS n`, [`${marker}%`, jtis])).rows[0].n;
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
