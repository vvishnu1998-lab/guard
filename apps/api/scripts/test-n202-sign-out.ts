/**
 * test-n202-sign-out.ts — a sign-out ends the session on the server, and the sign-in limit never refuses one (N202).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n202-sign-out.ts     (from apps/api)
 *
 * Vishnu's decisions 1a, 2a, 3a and 4a (2026-10-14). The web now calls POST /api/auth/logout on SIGN OUT
 * (apps/web/lib/signOut.ts; scripts/check-sign-out.ts there proves the browser half). Over HTTP:
 *
 *   L  the real authLimiter, mounted as index.ts mounts it: 25 sign-outs in a row from one address are never
 *      refused; the 21st sign-in after them still is, with BASE's message; a sign-out after that still passes
 *   S  a sign-out ends the session: the session token is refused at once ("Token has been revoked"), the refresh
 *      token sent with it no longer refreshes, and a sign-out without one (as the web now makes it, 2a) still
 *      ends the session token; the same token cannot sign out twice
 *   H  the admin's SIGN-IN HISTORY lists each sign-out, with its device, between the sign-ins around it (4a)
 *   C  middleware/rateLimits.ts is BASE's two limiters exactly, but for authLimiter's skip; index.ts is BASE's
 *      with the definitions replaced by the import, so both are mounted as before
 *   M  mutation controls: BASE's limiter refuses the 21st sign-out (what N202 fixes); a skip that lets every
 *      /api/auth request through; a skip on the wrong method; the history without sign-outs
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
/** main before N202 (PR #122's merge). */
const BASE = '26d38ae526e3f478053a30967dabd4b44f5b2150';
const LIMITS = 'src/middleware/rateLimits.ts';
const TOO_MANY = '{"error":"Too many login attempts, please try again later."}';
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

process.env.JWT_SECRET = 'test-only-n202';
process.env.JWT_REFRESH_SECRET = 'test-only-n202-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-n202-vishnu';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  if (process.env.DATABASE_URL) { console.error('REFUSING: DATABASE_URL is set.'); process.exit(2); }
}
function stubModule(name: string, overrides: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...overrides }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the N202 test`); }),
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
  if (s.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from.slice(0, 60))}`);
  return s.replace(from, to);
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
const pw = () => `T${crypto.randomBytes(12).toString('base64url')}`;

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
  const pool = ((await import('../src/db/pool')) as any).pool;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;
  const authRouter = (await import('../src/routes/auth')).default;
  const { signTokens } = await import('../src/routes/auth') as any;
  const adminRouter = (await import('../src/routes/admin')).default;

  const marker = `lhn202-${Date.now().toString(36)}`;
  const runStart = new Date();
  const swept = ((await q("DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn202-%')")).rowCount ?? 0)
    + ((await q("DELETE FROM company_admins WHERE email LIKE 'lhn202-%'")).rowCount ?? 0);
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  const admins: string[] = [];
  const jtis: string[] = [];
  const servers: Server[] = [];
  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const password = pw();
    const email = `${marker}-a@test.invalid`;
    const adminId = (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, $4, false, false) RETURNING id`,
      [STAR_GUARD, `${marker} a`, email, await bcrypt.hash(password, 4)])).rows[0].id as string;
    admins.push(adminId);
    // The limiter runs sign out a second admin, so the first one's history holds only section S's sessions.
    const limiterAdmin = (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, 'x', false, false) RETURNING id`,
      [STAR_GUARD, `${marker} l`, `${marker}-l@test.invalid`])).rows[0].id as string;
    admins.push(limiterAdmin);
    const jtiOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).jti as string;
    /** A fresh pair for the limiter runs' admin, as the login signs one; its ids are cleaned up after. */
    const pair = () => { const p = signTokens({ sub: limiterAdmin, role: 'company_admin', company_id: STAR_GUARD, is_primary: false }); jtis.push(jtiOf(p.access), jtiOf(p.refresh)); return p as { access: string; refresh: string }; };

    /** An app with /api/auth behind `limiter`, as index.ts mounts it, and /api/admin. */
    async function serve(limiter: any): Promise<string> {
      const app = express();
      app.set('trust proxy', 1);
      app.set('env', 'test');
      app.use(express.json());
      if (limiter) app.use('/api/auth', limiter, authRouter); else app.use('/api/auth', authRouter);
      app.use('/api/admin', adminRouter);
      const sv: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      servers.push(sv);
      return `http://127.0.0.1:${(sv.address() as AddressInfo).port}`;
    }
    async function call(origin: string, method: string, p: string, token: string | null, body?: unknown) {
      const r = await fetch(`${origin}${p}`, {
        method,
        headers: { 'user-agent': MAC_CHROME, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await r.text();
      let json: any = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: r.status, body: json, raw: text };
    }
    /** n sign-outs, each with a fresh session, then sign-ins with an unknown email until one is refused or `max` pass. */
    async function limiterRun(limiter: any, signOuts: number, signIns: number) {
      const origin = await serve(limiter);
      const out: number[] = [];
      for (let i = 0; i < signOuts; i += 1) { const p = pair(); out.push((await call(origin, 'POST', '/api/auth/logout', p.access, { refresh_token: p.refresh })).status); }
      const inn: Array<{ status: number; raw: string }> = [];
      for (let i = 0; i < signIns; i += 1) { const r = await call(origin, 'POST', '/api/auth/admin/login', null, { email: `${marker}-nobody@test.invalid`, password: 'not-the-password' }); inn.push({ status: r.status, raw: r.raw }); }
      const p = pair();
      const after = (await call(origin, 'POST', '/api/auth/logout', p.access, { refresh_token: p.refresh })).status;
      return { out, inn, after };
    }

    // ══════════════════════════════════════════════════════════════════════════
    section('L  the real authLimiter: sign-outs are never refused; sign-ins still are');
    const limits = await import('../src/middleware/rateLimits');
    const real = await limiterRun(limits.authLimiter, 25, 21);
    const lProblems = (r: typeof real) => {
      const p: string[] = [];
      if (!r.out.every((s) => s === 200)) p.push(`sign-outs ${show(r.out.filter((s) => s !== 200))}`);
      if (!r.inn.slice(0, 20).every((x) => x.status === 401)) p.push(`sign-ins 1-20 ${show(r.inn.slice(0, 20).map((x) => x.status))}`);
      if (!(r.inn[20]?.status === 429 && r.inn[20].raw === TOO_MANY)) p.push(`sign-in 21: ${r.inn[20]?.status} ${r.inn[20]?.raw}`);
      if (r.after !== 200) p.push(`the sign-out after the limit: ${r.after}`);
      return p;
    };
    const l = lProblems(real);
    check(l.length === 0, `25 sign-outs in a row: all 200; then sign-ins 1-20: 401, and the 21st: 429 ${TOO_MANY}; a sign-out after that: ${real.after} (${l.join('; ') || 'all right'})`);

    section('S  a sign-out ends the session');
    const open = await serve(null);
    {
      const login = await call(open, 'POST', '/api/auth/admin/login', null, { email, password });
      const before = await call(open, 'GET', '/api/admin/me/sign-ins', login.body.access);
      const out = await call(open, 'POST', '/api/auth/logout', login.body.access, { refresh_token: login.body.refresh });
      const afterUse = await call(open, 'GET', '/api/admin/me/sign-ins', login.body.access);
      const afterRefresh = await call(open, 'POST', '/api/auth/refresh', null, { refresh_token: login.body.refresh });
      jtis.push(jtiOf(login.body.access), jtiOf(login.body.refresh));
      check(login.status === 200 && before.status === 200 && out.status === 200 && show(out.body) === '{"success":true}'
        && afterUse.status === 401 && show(afterUse.body) === '{"error":"Token has been revoked"}' && afterRefresh.status === 401,
        `sign in ${login.status}; the session works (${before.status}); sign out ${out.status} ${show(out.body)}; then the session token gets ${afterUse.status} ${show(afterUse.body)} and the refresh token ${afterRefresh.status}`);
      const login2 = await call(open, 'POST', '/api/auth/admin/login', null, { email, password });
      jtis.push(jtiOf(login2.body.access), jtiOf(login2.body.refresh));
      const out2 = await call(open, 'POST', '/api/auth/logout', login2.body.access, {});
      const afterUse2 = await call(open, 'GET', '/api/admin/me/sign-ins', login2.body.access);
      const twice = await call(open, 'POST', '/api/auth/logout', login2.body.access, {});
      check(out2.status === 200 && afterUse2.status === 401 && twice.status === 401,
        `without a refresh token (the web's sign-out now): ${out2.status}, the session token refused after (${afterUse2.status}); the same token signing out again: ${twice.status}`);
    }

    section('H  the history lists each sign-out (4a)');
    {
      const login3 = await call(open, 'POST', '/api/auth/admin/login', null, { email, password });
      jtis.push(jtiOf(login3.body.access), jtiOf(login3.body.refresh));
      const h = await call(open, 'GET', '/api/admin/me/sign-ins', login3.body.access);
      const mine = (h.body?.events ?? []).filter((e: any) => new Date(e.at) >= runStart).map((e: any) => `${e.type}:${e.device}`);
      check(show(mine) === show(['login_success:Chrome on macOS', 'logout:Chrome on macOS', 'login_success:Chrome on macOS', 'logout:Chrome on macOS', 'login_success:Chrome on macOS']),
        `newest first: ${mine.join(', ')}`);
    }

    section('C  the limiters are BASE\'s, moved, with one skip added');
    {
      const baseIndex = base('src/index.ts');
      const block = (s: string, name: string) => s.slice(s.indexOf(`const ${name} = rateLimit({`), s.indexOf('});', s.indexOf(`const ${name} = rateLimit({`)) + 3);
      const norm = (s: string) => s.replace(/^export /, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      const nowLimits = read(LIMITS);
      const globalSame = norm(block(nowLimits, 'globalLimiter')) === norm(block(baseIndex, 'globalLimiter'));
      const authSame = norm(block(nowLimits, 'authLimiter')).replace("\n  skip: (req) => req.method === 'POST' && req.path === '/logout',", '') === norm(block(baseIndex, 'authLimiter'));
      const indexWant = once(once(once(baseIndex, "import rateLimit from 'express-rate-limit';\n", ''),
        "import { pool } from './db/pool';\n", "import { pool } from './db/pool';\nimport { authLimiter, globalLimiter } from './middleware/rateLimits';\n"),
        `// Rate limiting\n${block(baseIndex, 'globalLimiter')}\n${block(baseIndex, 'authLimiter')}\n`, '// Rate limiting: globalLimiter and authLimiter, in middleware/rateLimits.ts.\n');
      // N169 added one import to index.ts after N202; it is taken out, strictly, before the comparison.
      const indexNow = once(read('src/index.ts'), "// N169: what happens to an error that escapes everything. Second, so the handlers are in place before the rest\n"
        + "// of the API loads.\nimport './services/processHandlers';\n", '');
      check(globalSame && authSame && indexWant === indexNow,
        `globalLimiter is BASE's (${globalSame}); authLimiter is BASE's plus the skip (${authSame}); index.ts is BASE's with the definitions swapped for the import, mounts unchanged, N169's import aside (${indexWant === indexNow})`);
    }

    section('M  mutation controls');
    {
      const src = read(LIMITS);
      const SKIP = "  skip: (req) => req.method === 'POST' && req.path === '/logout',\n";
      const baseLike = await limiterRun(compileAt(LIMITS, once(src, SKIP, '')).authLimiter, 21, 0);
      const refusedAt = baseLike.out.findIndex((s) => s === 429) + 1;
      check(refusedAt === 21, `control — BASE's limiter (no skip): sign-out ${refusedAt} is refused 429, the session left alive; what N202 fixes, and what L refuses`);
      const tooWide = await limiterRun(compileAt(LIMITS, once(src, SKIP, '  skip: () => true,\n')).authLimiter, 0, 21);
      check(tooWide.inn[20]?.status === 401, `control — a skip that lets every /api/auth request through: sign-in 21 gets ${tooWide.inn[20]?.status}, not 429, which L refuses`);
      const wrongMethod = await limiterRun(compileAt(LIMITS, once(src, SKIP, "  skip: (req) => req.method === 'GET' && req.path === '/logout',\n")).authLimiter, 21, 0);
      check(wrongMethod.out.includes(429), `control — the skip on GET, not POST: sign-out ${wrongMethod.out.indexOf(429) + 1} refused, which L refuses`);
      const svc = compileAt('src/services/signInHistory.ts', once(read('src/services/signInHistory.ts'), ", 'password_reset_emailed', 'logout'] as const;", ", 'password_reset_emailed'] as const;"));
      const page = await svc.signInHistory(adminId, null);
      const outs = page.events.filter((e: any) => e.type === 'logout').length;
      check(outs === 0, `control — the history without 'logout': ${outs} sign-outs listed, which H refuses`);
    }
  } finally {
    for (const sv of servers) await new Promise<void>((resolve) => sv.close(() => resolve()));
    if (admins.length) {
      await q('DELETE FROM auth_events WHERE actor_id = ANY($1::uuid[])', [admins]);
      await q('DELETE FROM company_admins WHERE id = ANY($1::uuid[])', [admins]);
    }
    if (jtis.length) await q('DELETE FROM revoked_tokens WHERE jti = ANY($1::text[])', [jtis]);
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int + (SELECT count(*) FROM revoked_tokens WHERE jti = ANY($2::text[]))::int AS n`, [`${marker}%`, jtis])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
    await pool.end();
  }
  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('HARNESS ERROR', err); process.exit(1); });
