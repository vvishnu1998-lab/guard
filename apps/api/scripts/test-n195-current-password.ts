/**
 * test-n195-current-password.ts — a change of password with no current password is a 400, not a 500 (N195).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n195-current-password.ts     (from apps/api)
 *
 * The three change-password routes (admin, client, guard) handed `current_password` to bcrypt.compare,
 * which throws on anything but a string, and the error handler answered 500. Each route is driven over
 * HTTP as it is now and as it was at BASE (main before N195, read from git), with the same requests:
 *
 *   C  no current password, or one that is not a string: BASE answers 500, the route now 400
 *      "Current password is required"; nothing is stored either way
 *   U  every other request gets BASE's answer, status and body: the length rule first, an empty or wrong
 *      current password's 401, a new password that is not a string, and the change itself
 *   S  the three routes are the only ones that compare a current password, and each checks it first
 *   M  mutation controls: each route without its check answers 500 again
 *
 * LOCAL DATABASES ONLY; fake rows on Star Guard's id, passwords generated here and never printed. Sentry,
 * email and S3 are stubbed, and /api/auth is mounted without its rate limiter.
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
/** main before N195 (PR #119's merge). */
const BASE = 'fe57a5c608d9c7ac4a5740a4e792bd5e4cf07dbb';
const AUTH_ROUTES = 'src/routes/auth.ts';
const CHECK = '  const currentErr = currentPasswordError(current_password);\n  if (currentErr) return res.status(400).json({ error: currentErr });\n';

process.env.JWT_SECRET = 'test-only-n195';
process.env.JWT_REFRESH_SECRET = 'test-only-n195-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-n195-vishnu';

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
      : () => { throw new Error(`${name}.${String(prop)} called in the N195 test`); }),
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
/** `apps/api/<rel>` from the working tree run through `edit`: a mutant. */
function mutantOf(rel: string, edit: (src: string) => string): any {
  const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  const edited = edit(src);
  if (edited === src) throw new Error(`mutantOf(${rel}): the edit changed nothing`);
  return compileAt(rel, edited);
}
/** The body of one route in routes/auth.ts: from its `router.post(` line to the next route's. */
function routeSpan(src: string, seg: string): [number, number] {
  const at = src.indexOf(`router.post('/${seg}/change-password', `);
  if (at < 0) throw new Error(`no /${seg}/change-password route`);
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

type Role = 'company_admin' | 'client' | 'guard';
const ROUTES: Array<[Role, string]> = [['company_admin', 'admin'], ['client', 'client'], ['guard', 'guard']];
/** current_password values that are not a string; `undefined` leaves the key out of the body. */
const NOT_STRINGS: Array<[string, unknown]> = [['absent', undefined], ['null', null], ['a number', 12345678], ['true', true], ['an object', { p: 'x' }], ['an array', ['x']]];

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

  const marker = `lhn195-${Date.now().toString(36)}`;
  const made: Record<string, string[]> = { company_admins: [], clients: [], guards: [], sites: [] };
  let swept = 0;
  for (const sql of [
    "DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn195-%' UNION ALL SELECT id FROM clients WHERE email LIKE 'lhn195-%' UNION ALL SELECT id FROM guards WHERE email LIKE 'lhn195-%')",
    "DELETE FROM guard_devices WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn195-%')",
    "DELETE FROM company_admins WHERE email LIKE 'lhn195-%'",
    "DELETE FROM clients WHERE email LIKE 'lhn195-%'",
    "DELETE FROM guards WHERE email LIKE 'lhn195-%'",
    "DELETE FROM sites WHERE name LIKE 'lhn195-%'",
  ]) swept += (await q(sql)).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  let server: Server | null = null;

  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const site = (await q(`INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1 Example Way', '2026-01-01') RETURNING id`,
      [STAR_GUARD, `${marker} North Gate`])).rows[0].id as string;
    made.sites.push(site);
    const tableOf = (role: Role) => (role === 'company_admin' ? 'company_admins' : role === 'client' ? 'clients' : 'guards');
    let n = 0;
    /** A fixture of one role, with a fresh password, and an access token signed as its login would sign it. */
    async function person(role: Role) {
      n += 1;
      const password = pw();
      const email = `${marker}-${role}-${n}@test.invalid`;
      const hash = await bcrypt.hash(password, 4);
      const id = role === 'company_admin'
        ? (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, $4, false, false) RETURNING id`,
          [STAR_GUARD, `${marker} ${n}`, email, hash])).rows[0].id as string
        : role === 'client'
          ? (await q(`INSERT INTO clients (site_id, company_id, name, email, password_hash, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
            [site, STAR_GUARD, `${marker} ${n}`, email, hash])).rows[0].id as string
          : (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
            [STAR_GUARD, `${marker} ${n}`, email, hash, `LH95-${marker.slice(-6)}-${n}`])).rows[0].id as string;
      made[tableOf(role)].push(id);
      const claims = role === 'company_admin' ? { sub: id, role, company_id: STAR_GUARD, is_primary: false }
        : role === 'client' ? { sub: id, role, site_id: site } : { sub: id, role, company_id: STAR_GUARD };
      // Signed a few seconds back, as any session a person uses is, so a change's tokens_not_before never meets the iat second.
      const token = jwt.sign({ ...claims, iat: Math.floor(Date.now() / 1000) - 5 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      return { id, password, token, role };
    }
    type Who = Awaited<ReturnType<typeof person>>;
    const rowOf = async (who: Who) => (await q(`SELECT password_hash, must_change_password, tokens_not_before FROM ${tableOf(who.role)} WHERE id = $1`, [who.id])).rows[0];
    const eventsOf = async (who: Who) => Number((await q("SELECT count(*) FROM auth_events WHERE actor_id = $1 AND event_type = 'password_changed'", [who.id])).rows[0].count);
    const snapshot = async (who: Who) => show({ ...(await rowOf(who)), events: await eventsOf(who) });

    // ══ the router as it is, as it was at BASE, and without N195's check in one route at a time ══
    const baseSrc = execFileSync('git', ['show', `${BASE}:apps/api/${AUTH_ROUTES}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    const app = express();
    app.set('env', 'test'); // Express's own 500, without its stack trace on the console
    app.use(express.json());
    app.use('/api/auth', (await import('../src/routes/auth')).default);
    app.use('/api/auth-base', compileAt(AUTH_ROUTES, baseSrc).default);
    for (const [, seg] of ROUTES) {
      app.use(`/api/auth-no-check-${seg}`, mutantOf(AUTH_ROUTES, (s) => {
        const [from, to] = routeSpan(s, seg);
        const i = s.indexOf(CHECK, from);
        if (i < 0 || i >= to) throw new Error(`no N195 check in /${seg}/change-password`);
        return s.slice(0, i) + s.slice(i + CHECK.length);
      }).default);
    }
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    async function post(prefix: string, seg: string, body: unknown, token: string) {
      const r = await fetch(`${origin}${prefix}/${seg}/change-password`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const text = await r.text();
      let json: unknown = null;
      try { json = JSON.parse(text); } catch { json = null; }
      return { status: r.status, body: json as any };
    }
    const withCurrent = (current: unknown, next: unknown) => (current === undefined ? { new_password: next } : { current_password: current, new_password: next });

    // ══════════════════════════════════════════════════════════════════════════
    section('C  no current password, or one that is not a string: BASE 500, now 400');
    for (const [role, seg] of ROUTES) {
      const who = await person(role);
      const before = await snapshot(who);
      const seen: string[] = [];
      let ok = true;
      for (const [label, current] of NOT_STRINGS) {
        const base = await post('/api/auth-base', seg, withCurrent(current, pw()), who.token);
        const now = await post('/api/auth', seg, withCurrent(current, pw()), who.token);
        if (!(base.status === 500 && now.status === 400 && show(now.body) === '{"error":"Current password is required"}')) ok = false;
        seen.push(`${label} ${base.status}→${now.status}`);
      }
      check(ok, `C1 ${seg}: every one of the ${NOT_STRINGS.length} goes from BASE's 500 to 400 {"error":"Current password is required"} (${seen.join(', ')})`);
      check(await snapshot(who) === before, `C2 ${seg}: nothing stored, no event, by either`);
    }

    section('U  every other request gets BASE\'s answer, status and body');
    for (const [role, seg] of ROUTES) {
      const who = await person(role);
      const before = await snapshot(who);
      const asks: Array<[string, unknown]> = [
        ['an empty body', {}],
        ['no current password and a 7-character new one', { new_password: 'Ab3$xyz' }],
        ['a number for the current password and a 129-character new one', { current_password: 5, new_password: 'x'.repeat(129) }],
        ['the right current password and no new one', { current_password: who.password }],
        ['an empty current password', { current_password: '', new_password: pw() }],
        ['a wrong current password', { current_password: `${who.password}x`, new_password: pw() }],
        ['the right current password and a 7-character new one', { current_password: who.password, new_password: 'Ab3$xyz' }],
        ['the right current password and a 129-character new one', { current_password: who.password, new_password: 'y'.repeat(129) }],
        ['the right current password and a number for the new one', { current_password: who.password, new_password: 12345678 }],
      ];
      const differ: string[] = [];
      const seen: string[] = [];
      for (const [label, body] of asks) {
        const base = await post('/api/auth-base', seg, body, who.token);
        const now = await post('/api/auth', seg, body, who.token);
        seen.push(`${now.status}`);
        if (base.status !== now.status || show(base.body) !== show(now.body) || base.status === 500) differ.push(`${label}: BASE ${base.status} ${show(base.body)}, now ${now.status} ${show(now.body)}`);
      }
      check(differ.length === 0, `U1 ${seg}: ${asks.length} refused requests, each answered as BASE answers it, none a 500 (${seen.join(' ')})${differ.length ? ` — ${differ.join('; ')}` : ''}`);
      check(await snapshot(who) === before, `U2 ${seg}: nothing stored, no event`);
      // The change itself, once through each router, each on its own fixture.
      const a = await person(role);
      const b = await person(role);
      const nextA = pw();
      const nextB = pw();
      const base = await post('/api/auth-base', seg, { current_password: a.password, new_password: nextA }, a.token);
      const now = await post('/api/auth', seg, { current_password: b.password, new_password: nextB }, b.token);
      const ra = await rowOf(a);
      const rb = await rowOf(b);
      check(base.status === 200 && now.status === 200 && show(base.body) === show(now.body)
        && await bcrypt.compare(nextA, ra.password_hash) && await bcrypt.compare(nextB, rb.password_hash)
        && ra.must_change_password === false && rb.must_change_password === false && ra.tokens_not_before !== null && rb.tokens_not_before !== null
        && await eventsOf(a) === 1 && await eventsOf(b) === 1,
        `U3 ${seg}: the change itself, as at BASE: ${now.status} ${show(now.body)}, the new password stored, the flag clear, every old session ended, one event`);
    }

    section('S  the three routes are the only ones that compare a current password, and each checks it first');
    {
      const src = fs.readFileSync(path.join(__dirname, '..', AUTH_ROUTES), 'utf8');
      const compares = src.split('bcrypt.compare(current_password,').length - 1;
      const everywhere = execFileSync('git', ['grep', '-c', 'current_password', '--', 'src'], { cwd: path.join(__dirname, '..'), encoding: 'utf8' }).trim();
      check(compares === 3 && everywhere === `${AUTH_ROUTES}:${src.split('\n').filter((l) => l.includes('current_password')).length}`,
        `S1 bcrypt.compare(current_password, …) appears 3 times, all in routes/auth.ts, the one file under src that reads current_password (${compares}; ${everywhere.replace(/\n/g, ', ')})`);
      const order = ROUTES.map(([, seg]) => {
        const [from, to] = routeSpan(src, seg);
        const body = src.slice(from, to);
        const policy = body.indexOf('if (policyErr) return res.status(400)');
        const check1 = body.indexOf(CHECK);
        const compare = body.indexOf('bcrypt.compare(current_password,');
        const query = body.indexOf('pool.query(');
        return policy >= 0 && check1 > policy && check1 < query && query < compare;
      });
      check(order.every(Boolean), `S2 in each route the check comes after the new-password rule and before the first query and the compare (${order.join(', ')})`);
    }

    section('M  mutation controls: each route without its check answers 500 again');
    {
      let caught = 0;
      for (const [role, seg] of ROUTES) {
        const who = await person(role);
        const r = await post(`/api/auth-no-check-${seg}`, seg, { new_password: pw() }, who.token);
        const ok = r.status === 500;
        if (ok) caught += 1;
        check(ok, `M1 control — /${seg}/change-password without the check: ${r.status} for no current password, which C1 refuses`);
      }
      check(caught === ROUTES.length, `M2 ${caught} of ${ROUTES.length} mutants caught`);
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    const ids = [...made.company_admins, ...made.clients, ...made.guards];
    if (ids.length) await q('DELETE FROM auth_events WHERE actor_id = ANY($1::uuid[])', [ids]);
    if (made.guards.length) await q('DELETE FROM guard_devices WHERE guard_id = ANY($1::uuid[])', [made.guards]);
    for (const t of ['company_admins', 'clients', 'guards', 'sites']) if (made[t].length) await q(`DELETE FROM ${t} WHERE id = ANY($1::uuid[])`, [made[t]]);
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    const left = (await q(`SELECT (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int + (SELECT count(*) FROM clients WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM guards WHERE email LIKE $1)::int + (SELECT count(*) FROM sites WHERE name LIKE $1)::int AS n`, [`${marker}%`])).rows[0].n;
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
