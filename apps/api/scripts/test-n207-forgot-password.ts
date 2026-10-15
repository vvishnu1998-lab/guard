/**
 * test-n207-forgot-password.ts — a password reset no longer replaces the password (N207; Vishnu's 1a 2a 3a 4a).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-n207-forgot-password.ts     (from apps/api)
 *
 * The real auth router over HTTP, on a local database that this script brings to schema_v83 itself (the file is
 * idempotent). SendGrid is a recorder, so the real reset email is rendered and its password read from it.
 *
 *   R  a reset request, for an admin, a client and a guard: the same answer as for no account, given before the
 *      email goes out; the password and must_change_password untouched; one row holding a cost-12 bcrypt hash of
 *      the emailed password, never the password, for 24 hours; one email, saying under the password that it works
 *      for 24 hours (RESET_TTL_HOURS), and ending with 4a's line
 *   C  the current password still signs in, and ends the pending reset: the emailed one is then refused
 *   T  the emailed password signs in: it becomes the password, with must_change_password in the answer and the
 *      row; the pending row goes; the old password is refused; change-password takes it as the current one
 *   E  past expires_at (moved back here), the emailed password is refused and the current one works
 *   P  pacing: a second request inside 15 minutes sends nothing and keeps the first password; after 15 minutes
 *      (created_at moved back) a new one replaces it; two requests at once send one email
 *   F  a refused send leaves no row behind, so an immediate retry sends
 *   L  a locked guard: the request alone leaves the lock; the emailed password signs in past it and clears it;
 *      a wrong password still counts
 *   X  change-password ends a pending reset; a deactivated account gets nothing
 *   V  the hand-apply scripts on a throwaway database with production's default privileges: the preview leaves
 *      nothing; the COMMIT copy makes the table, and the read-only role can read every column but password_hash;
 *      a second COMMIT is refused by the precondition
 *   S  the source: the scripts' V83 block is schema_v83.sql byte for byte; the COMMIT copy differs in one line;
 *      migrate.ts ends with schema_v83.sql
 *   M  mutation controls: BASE's route (the password replaced at once); no pacing; no expiry; the current
 *      password not ending a reset; the answer after the work; the hash stored plain; no way past a lock
 *
 * LOCAL DATABASES ONLY; fake accounts on Star Guard's id, passwords generated here and never printed. Sentry and
 * S3 are stubbed, and /api/auth is mounted without its rate limiter.
 */
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
/** main at PR #125's merge: routes/auth.ts and services/email.ts as N207 found them (PR #126 did not touch them). */
const BASE = '2324b59264babddc783c7ead8b798a3db17f7121';
const API = path.join(__dirname, '..');
const REPO = path.join(API, '..', '..');
const SAFE = '{"message":"If that email is registered, a temporary password has been sent."}';
const SUBJECT = 'NetraOps password reset';
const NEW_LINE = "If you didn't ask for this, ignore this email: your current password still works.";
const OLD_LINE = "If you didn't request this, contact your administrator immediately.";
/** Vishnu, 2026-10-15: "Add the "It works for 24 hours." line", under the temporary password. */
const EXPIRY_LINE = 'It works for 24 hours.';
const CHANGE_LINE = 'You will be required to change this on next login.';
const SEND_DELAY_MS = 1500;

process.env.JWT_SECRET = 'test-only-n207';
process.env.JWT_REFRESH_SECRET = 'test-only-n207-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-n207-vishnu';
process.env.SENDGRID_API_KEY = 'SG.test-only-n207';
process.env.SENDGRID_FROM_EMAIL = 'alerts@example.invalid';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  if (process.env.DATABASE_URL) { console.error('REFUSING: DATABASE_URL is set.'); process.exit(2); }
}
function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}
const read = (rel: string) => fs.readFileSync(path.join(API, rel), 'utf8');
const base = (rel: string) => execFileSync('git', ['show', `${BASE}:apps/api/${rel}`], { cwd: API, encoding: 'utf8' });
function once(s: string, from: string, to: string): string {
  if (s.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from.slice(0, 60))}`);
  return s.replace(from, to);
}
const ROUTE = 'src/routes/auth.ts';
const SERVICE = 'src/services/pendingPasswordReset.ts';
/** The auth router, built from the files on disk or from these sources at the same paths (the service first). */
function authRouter(overrides: Record<string, string> = {}): any {
  for (const rel of [ROUTE, SERVICE]) delete require.cache[path.join(API, rel)];
  for (const rel of [SERVICE, ROUTE]) {
    if (!(rel in overrides)) continue;
    const file = path.join(API, rel);
    const js = ts.transpileModule(overrides[rel], { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
    const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
    m.filename = file;
    m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
    require.cache[file] = m;
    m._compile(js, file);
    m.loaded = true;
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require(path.join(API, ROUTE)).default;
}

let failures = 0;
let passes = 0;
let finished = false;
process.on('beforeExit', () => { if (!finished) { console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)'); process.exitCode = 1; } });
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const pw = () => `T${crypto.randomBytes(12).toString('base64url')}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const show = (faults: string[]) => (faults.length ? ` [${faults.join('; ')}]` : '');

type Portal = 'admin' | 'client' | 'guard';
const ROLE = { admin: 'company_admin', client: 'client', guard: 'guard' } as const;
const TABLE = { admin: 'company_admins', client: 'clients', guard: 'guards' } as const;
interface Account { portal: Portal; id: string; email: string; password: string }

async function main(): Promise<void> {
  refuseUnlessLocal();
  // SendGrid: a recorder that can be told to wait, or to fail the next sends.
  const sent: Array<{ to: string; subject: string; html: string }> = [];
  let delayMs = 0;
  let failNext = 0;
  inject('@sendgrid/mail', {
    __esModule: true,
    default: {
      setApiKey: () => undefined,
      send: async (msg: any) => {
        if (delayMs > 0) await sleep(delayMs);
        if (failNext > 0) { failNext -= 1; const e: any = new Error('Forbidden'); e.code = 403; throw e; }
        sent.push({ to: msg.to, subject: msg.subject, html: msg.html });
        return [{ statusCode: 202 }];
      },
    },
  });
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/s3', { __esModule: true, urlOrPresign: async (url: string | null) => url });

  const bcrypt = (await import('bcrypt')).default;
  const pool = ((await import('../src/db/pool')) as any).pool;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;

  // The table, as migrate.ts would make it (schema_v83.sql is idempotent).
  await q(read('src/db/schema_v83.sql'));

  const marker = `lhn207-${Date.now().toString(36)}`;
  const sweep = [
    "DELETE FROM pending_password_resets WHERE account_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn207-%' UNION ALL SELECT id FROM clients WHERE email LIKE 'lhn207-%' UNION ALL SELECT id FROM guards WHERE email LIKE 'lhn207-%')",
    "DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhn207-%' UNION ALL SELECT id FROM clients WHERE email LIKE 'lhn207-%' UNION ALL SELECT id FROM guards WHERE email LIKE 'lhn207-%')",
    "DELETE FROM login_attempts WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn207-%')",
    "DELETE FROM guard_devices WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn207-%')",
    "DELETE FROM guard_site_assignments WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhn207-%')",
    "DELETE FROM client_sites WHERE client_id IN (SELECT id FROM clients WHERE email LIKE 'lhn207-%')",
    "DELETE FROM company_admins WHERE email LIKE 'lhn207-%'",
    "DELETE FROM clients WHERE email LIKE 'lhn207-%'",
    "DELETE FROM guards WHERE email LIKE 'lhn207-%'",
    "DELETE FROM sites WHERE name LIKE 'lhn207-%'",
  ];
  let swept = 0;
  for (const sql of sweep) swept += (await q(sql)).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  const servers: Server[] = [];
  let ttlHours = 0;
  let made = 0;
  let siteId = '';

  async function accounts(): Promise<Record<Portal, Account>> {
    made += 1;
    const n = `${marker}-${made}`;
    const out = {} as Record<Portal, Account>;
    for (const portal of ['admin', 'client', 'guard'] as Portal[]) {
      const password = pw();
      const email = `${n}-${portal}@test.invalid`;
      const hash = await bcrypt.hash(password, 4);
      let id: string;
      if (portal === 'admin') {
        id = (await q('INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, $4, false, false) RETURNING id',
          [STAR_GUARD, `${n} admin`, email, hash])).rows[0].id;
      } else if (portal === 'client') {
        id = (await q('INSERT INTO clients (site_id, company_id, name, email, password_hash, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id',
          [siteId, STAR_GUARD, `${n} client`, email, hash])).rows[0].id;
        await q('INSERT INTO client_sites (client_id, site_id) VALUES ($1, $2)', [id, siteId]);
      } else {
        id = (await q('INSERT INTO guards (company_id, name, email, password_hash, badge_number, must_change_password) VALUES ($1, $2, $3, $4, $5, false) RETURNING id',
          [STAR_GUARD, `${n} guard`, email, hash, `LHN207-${crypto.randomBytes(3).toString('hex')}`])).rows[0].id;
        await q("INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) VALUES ($1, $2, '2026-01-01')", [id, siteId]);
      }
      out[portal] = { portal, id, email, password };
    }
    return out;
  }
  async function serve(router: any): Promise<string> {
    const app = express();
    app.set('trust proxy', 1);
    app.set('env', 'test');
    app.use(express.json());
    app.use('/api/auth', router);
    const sv: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    servers.push(sv);
    return `http://127.0.0.1:${(sv.address() as AddressInfo).port}`;
  }
  async function call(origin: string, p: string, token: string | null, body: unknown) {
    const t0 = Date.now();
    const r = await fetch(`${origin}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    let json: any = null;
    try { json = JSON.parse(raw); } catch { json = null; }
    return { status: r.status, body: json, raw, ms: Date.now() - t0 };
  }
  const reset = (origin: string, a: Account, email = a.email) => call(origin, '/api/auth/forgot-password', null, { email, portal: a.portal });
  const login = (origin: string, a: Account, password: string) => call(origin, `/api/auth/${a.portal}/login`, null, { email: a.email, password });
  const dbNow = async (): Promise<Date> => (await q('SELECT clock_timestamp() AS t')).rows[0].t;
  const events = async (a: Account, since: Date): Promise<string[]> =>
    (await q('SELECT event_type FROM auth_events WHERE actor_id = $1 AND created_at >= $2 ORDER BY created_at', [a.id, since])).rows.map((r: any) => r.event_type);
  /** Waits for the work after a reset request: until `done` holds for the account's events since `since`. */
  async function settled(a: Account, since: Date, done: (ev: string[]) => boolean, timeoutMs = 10_000): Promise<string[]> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const ev = await events(a, since);
      if (done(ev) || Date.now() > end) return ev;
      await sleep(40);
    }
  }
  const sentOnce = (ev: string[]) => ev.includes('password_reset_emailed') || ev.includes('password_reset_email_failed') || ev.includes('password_reset_throttled');
  const mails = (a: Account) => sent.filter((m) => m.to === a.email && m.subject === SUBJECT);
  const tempIn = (html: string | undefined) => (html ? /Your temporary password is:[\s\S]*?<div[^>]*>\s*([A-Za-z0-9]+)\s*<\/div>/.exec(html)?.[1] ?? null : null);
  const lastTemp = (a: Account) => tempIn(mails(a).at(-1)?.html);
  const pending = async (a: Account) => (await q(
    'SELECT password_hash, EXTRACT(EPOCH FROM (expires_at - created_at))::int AS ttl FROM pending_password_resets WHERE role = $1 AND account_id = $2',
    [ROLE[a.portal], a.id])).rows[0] ?? null;
  const row = async (a: Account) => (await q(`SELECT password_hash, must_change_password FROM ${TABLE[a.portal]} WHERE id = $1`, [a.id])).rows[0];
  /** A reset request whose email has gone out; the emailed password. */
  async function emailed(origin: string, a: Account): Promise<string | null> {
    const since = await dbNow();
    await reset(origin, a);
    await settled(a, since, sentOnce);
    return lastTemp(a);
  }

  // ── The sections, each a list of what went wrong, so a mutant can be run through the same one ──
  async function partR(origin: string): Promise<string[]> {
    const f: string[] = [];
    const accts = await accounts();
    for (const a of Object.values(accts)) {
      const before = await row(a);
      const since = await dbNow();
      delayMs = SEND_DELAY_MS;
      const known = await reset(origin, a);
      const unknown = await reset(origin, a, `${marker}-nobody-${a.portal}@test.invalid`);
      const ev = await settled(a, since, sentOnce);
      delayMs = 0;
      if (known.status !== 200 || known.raw !== SAFE) f.push(`${a.portal}: answered ${known.status} ${known.raw}`);
      if (unknown.status !== known.status || unknown.raw !== known.raw) f.push(`${a.portal}: no account answered ${unknown.status} ${unknown.raw}`);
      if (!(known.ms < SEND_DELAY_MS / 2 && unknown.ms < SEND_DELAY_MS / 2)) f.push(`${a.portal}: answered after ${known.ms} ms (no account: ${unknown.ms} ms); the send takes ${SEND_DELAY_MS}`);
      const after = await row(a);
      if (after.password_hash !== before.password_hash || after.must_change_password !== before.must_change_password) f.push(`${a.portal}: the password or must_change_password changed`);
      if (mails(a).length !== 1) f.push(`${a.portal}: ${mails(a).length} emails`);
      if (sent.some((m) => m.to.includes('-nobody-'))) f.push(`${a.portal}: an email to no account`);
      const html = mails(a)[0]?.html ?? '';
      if (!html.includes(NEW_LINE) || html.includes(OLD_LINE)) f.push(`${a.portal}: the email's last line`);
      const temp = lastTemp(a);
      const at = (x: string) => html.indexOf(x);
      if (html.split(EXPIRY_LINE).length !== 2 || !temp || !(at(temp) < at(EXPIRY_LINE) && at(EXPIRY_LINE) < at(CHANGE_LINE))) f.push(`${a.portal}: "${EXPIRY_LINE}" is not once, between the password and "${CHANGE_LINE}"`);
      if (!html.includes(`It works for ${ttlHours} hours.`)) f.push(`${a.portal}: the email's hours are not RESET_TTL_HOURS (${ttlHours})`);
      const p = await pending(a);
      if (!p) f.push(`${a.portal}: no pending row`);
      else {
        if (!/^\$2[aby]\$12\$/.test(p.password_hash)) f.push(`${a.portal}: the stored value is not a cost-12 bcrypt hash`);
        if (temp && p.password_hash.includes(temp)) f.push(`${a.portal}: the emailed password is stored plain`);
        if (!temp || !/^\$2/.test(p.password_hash) || !(await bcrypt.compare(temp, p.password_hash))) f.push(`${a.portal}: the stored hash is not the emailed password's`);
        if (Math.abs(p.ttl - ttlHours * 3600) > 5) f.push(`${a.portal}: it expires ${p.ttl} s after it was made`);
      }
      if (!ev.includes('password_reset_emailed')) f.push(`${a.portal}: events ${ev.join(',')}`);
    }
    return f;
  }
  async function partC(origin: string): Promise<string[]> {
    const f: string[] = [];
    for (const a of Object.values(await accounts())) {
      const temp = await emailed(origin, a);
      const cur = await login(origin, a, a.password);
      if (cur.status !== 200 || cur.body?.must_change_password !== false) f.push(`${a.portal}: the current password got ${cur.status}, must_change_password ${cur.body?.must_change_password}`);
      if (await pending(a)) f.push(`${a.portal}: the pending reset outlived a sign-in with the current password`);
      const old = temp ? await login(origin, a, temp) : null;
      if (old?.status !== 401) f.push(`${a.portal}: the emailed password after that got ${old?.status}`);
    }
    return f;
  }
  async function partT(origin: string): Promise<string[]> {
    const f: string[] = [];
    for (const a of Object.values(await accounts())) {
      const temp = await emailed(origin, a);
      const p = await pending(a);
      const r = temp ? await login(origin, a, temp) : null;
      if (r?.status !== 200 || r.body?.must_change_password !== true) f.push(`${a.portal}: the emailed password got ${r?.status}, must_change_password ${r?.body?.must_change_password}`);
      const after = await row(a);
      if (!p || after.password_hash !== p.password_hash || after.must_change_password !== true) f.push(`${a.portal}: it did not become the password, with a forced change`);
      if (await pending(a)) f.push(`${a.portal}: the pending row is still there`);
      const old = await login(origin, a, a.password);
      if (old.status !== 401) f.push(`${a.portal}: the old password got ${old.status}`);
      const next = pw();
      const ch = await call(origin, `/api/auth/${a.portal}/change-password`, r?.body?.access ?? null, { current_password: temp, new_password: next });
      if (ch.status !== 200) f.push(`${a.portal}: change-password from it got ${ch.status} ${ch.raw}`);
      const fresh = await login(origin, a, next);
      if (fresh.status !== 200 || fresh.body?.must_change_password !== false) f.push(`${a.portal}: the new password got ${fresh.status}, must_change_password ${fresh.body?.must_change_password}`);
    }
    return f;
  }
  async function partE(origin: string): Promise<string[]> {
    const f: string[] = [];
    for (const a of Object.values(await accounts())) {
      const temp = await emailed(origin, a);
      await q("UPDATE pending_password_resets SET expires_at = NOW() - interval '1 second' WHERE role = $1 AND account_id = $2", [ROLE[a.portal], a.id]);
      const late = temp ? await login(origin, a, temp) : null;
      if (late?.status !== 401) f.push(`${a.portal}: the emailed password after expiry got ${late?.status}`);
      const cur = await login(origin, a, a.password);
      if (cur.status !== 200) f.push(`${a.portal}: the current password got ${cur.status}`);
    }
    return f;
  }
  async function partP(origin: string): Promise<string[]> {
    const f: string[] = [];
    const { admin: a, client: c } = await accounts();
    const t1 = await emailed(origin, a);
    const since = await dbNow();
    await reset(origin, a);
    const ev = await settled(a, since, sentOnce);
    if (!ev.includes('password_reset_throttled') || mails(a).length !== 1) f.push(`a second request inside 15 minutes: events ${ev.join(',')}, ${mails(a).length} emails`);
    const kept = await pending(a);
    if (!kept || !t1 || !(await bcrypt.compare(t1, kept.password_hash))) f.push('the first emailed password is no longer the pending one');
    await q("UPDATE pending_password_resets SET created_at = NOW() - interval '16 minutes' WHERE role = $1 AND account_id = $2", [ROLE.admin, a.id]);
    const t2 = await emailed(origin, a);
    if (mails(a).length !== 2 || !t2 || t2 === t1) f.push(`after 15 minutes: ${mails(a).length} emails`);
    const r1 = t1 ? await login(origin, a, t1) : null;
    const r2 = t2 ? await login(origin, a, t2) : null;
    if (r1?.status !== 401 || r2?.status !== 200) f.push(`the replaced password got ${r1?.status}, the new one ${r2?.status}`);
    const both = await dbNow();
    await Promise.all([reset(origin, c), reset(origin, c)]);
    const ev2 = await settled(c, both, (e) => e.filter((x) => x.startsWith('password_reset_')).length >= 2);
    if (mails(c).length !== 1) f.push(`two requests at once: ${mails(c).length} emails (events ${ev2.join(',')})`);
    return f;
  }
  async function partF(origin: string): Promise<string[]> {
    const f: string[] = [];
    const { guard: g } = await accounts();
    failNext = 1;
    const since = await dbNow();
    await reset(origin, g);
    const ev = await settled(g, since, sentOnce);
    failNext = 0;
    if (!ev.includes('password_reset_email_failed') || (await pending(g)) || mails(g).length !== 0) f.push(`a refused send: events ${ev.join(',')}, ${mails(g).length} emails, row ${!!(await pending(g))}`);
    const temp = await emailed(origin, g);
    if (!temp || mails(g).length !== 1 || !(await pending(g))) f.push(`the retry right after: ${mails(g).length} emails`);
    return f;
  }
  async function partL(origin: string): Promise<string[]> {
    const f: string[] = [];
    const { guard: g } = await accounts();
    await q(`INSERT INTO login_attempts (guard_id, failed_count, locked_at, updated_at) VALUES ($1, 5, NOW(), NOW())
             ON CONFLICT (guard_id) DO UPDATE SET failed_count = 5, locked_at = NOW(), updated_at = NOW()`, [g.id]);
    const lock = async () => (await q('SELECT failed_count, locked_at FROM login_attempts WHERE guard_id = $1', [g.id])).rows[0];
    const temp = await emailed(origin, g);
    const l1 = await lock();
    if (l1?.failed_count !== 5 || !l1?.locked_at) f.push(`the request alone changed the lock: ${l1?.failed_count}`);
    const cur = await login(origin, g, g.password);
    if (cur.status !== 423) f.push(`the current password while locked got ${cur.status}`);
    const r = temp ? await login(origin, g, temp) : null;
    if (r?.status !== 200 || r.body?.must_change_password !== true) f.push(`the emailed password while locked got ${r?.status}`);
    const l2 = await lock();
    if (l2?.failed_count !== 0 || l2?.locked_at !== null) f.push(`after it the lock is ${l2?.failed_count}`);
    const wrong = await login(origin, g, pw());
    const l3 = await lock();
    if (wrong.status !== 401 || l3?.failed_count !== 1) f.push(`a wrong password got ${wrong.status} and counted ${l3?.failed_count}`);
    return f;
  }
  async function partX(origin: string): Promise<string[]> {
    const f: string[] = [];
    const { client: c, guard: g } = await accounts();
    const s = await login(origin, c, c.password);
    const temp = await emailed(origin, c);
    const next = pw();
    const ch = await call(origin, '/api/auth/client/change-password', s.body?.access ?? null, { current_password: c.password, new_password: next });
    if (ch.status !== 200 || (await pending(c))) f.push(`change-password ${ch.status}; pending row left ${!!(await pending(c))}`);
    const old = temp ? await login(origin, c, temp) : null;
    if (old?.status !== 401) f.push(`the emailed password after a change got ${old?.status}`);
    await q('UPDATE guards SET is_active = false WHERE id = $1', [g.id]);
    const r = await reset(origin, g);
    await sleep(400);
    if (r.raw !== SAFE || mails(g).length !== 0 || (await pending(g))) f.push(`a deactivated account: ${r.raw}, ${mails(g).length} emails`);
    return f;
  }

  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    siteId = (await q(`INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1 Example Way', '2026-01-01') RETURNING id`,
      [STAR_GUARD, `${marker} site`])).rows[0].id;
    const live = await serve(authRouter());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ttlHours = require(path.join(API, SERVICE)).RESET_TTL_HOURS;

    section('R  a reset request (admin, client, guard)');
    const r = await partR(live);
    check(r.length === 0 && ttlHours === 24, `the same answer as for no account, given before the ${SEND_DELAY_MS} ms send; the password and must_change_password untouched; one row with a cost-12 bcrypt hash of the emailed password, for ${ttlHours} h; one email, with "${EXPIRY_LINE}" under the password and ending "${NEW_LINE}"${show(r)}`);

    section('C  the current password');
    const c = await partC(live);
    check(c.length === 0, `still signs in, without a forced change, and ends the pending reset: the emailed password is then refused${show(c)}`);

    section('T  the emailed password');
    const t = await partT(live);
    check(t.length === 0, `signs in and becomes the password, with must_change_password in the answer and the row; the pending row goes; the old password is refused; change-password takes it as the current one${show(t)}`);

    section('E  expiry (2a)');
    const e = await partE(live);
    check(e.length === 0, `past expires_at the emailed password is refused; the current one signs in${show(e)}`);

    section('P  pacing (3a)');
    const p = await partP(live);
    check(p.length === 0, `inside 15 minutes a second request sends nothing and keeps the first password; after, a new one replaces it; two requests at once send one email${show(p)}`);

    section('F  a refused send');
    const fr = await partF(live);
    check(fr.length === 0, `no row is left behind (password_reset_email_failed recorded), so a retry right after sends${show(fr)}`);

    section('L  a locked guard');
    const l = await partL(live);
    check(l.length === 0, `the request alone leaves the lock; the emailed password signs in past it and clears it; a wrong password still counts${show(l)}`);

    section('X  change-password; a deactivated account');
    const x = await partX(live);
    check(x.length === 0, `change-password ends a pending reset; a deactivated account gets the same answer and nothing else${show(x)}`);

    section('V  the hand-apply scripts, on a throwaway database with production\'s default privileges');
    {
      const db = `n207_v83_${crypto.randomBytes(3).toString('hex')}_test`;
      const hadRole = (await q("SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly'")).rowCount === 1;
      const psql = (args: string[]) => spawnSync('psql', ['-X', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args], { encoding: 'utf8', env: { ...process.env, PGDATABASE: db } });
      const preview = path.join(REPO, 'scripts/ops/v83_pending_password_resets.sql');
      const commit = path.join(REPO, 'scripts/ops/v83_pending_password_resets_COMMIT.sql');
      await q(`CREATE DATABASE ${db}`);
      try {
        if (!hadRole) await q('CREATE ROLE claude_readonly NOLOGIN');
        const setup = psql(['-c', 'CREATE TABLE company_profile_audit (id int)',
          '-c', 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO claude_readonly']);
        const v1 = psql(['-f', preview]);
        const after1 = psql(['-c', "SELECT to_regclass('public.pending_password_resets') IS NULL"]);
        const v2 = psql(['-f', commit]);
        const privs = psql(['-c', `SELECT has_table_privilege('claude_readonly', 'pending_password_resets', 'SELECT') || ',' ||
          string_agg(attname || '=' || has_column_privilege('claude_readonly', 'pending_password_resets', attname, 'SELECT'), ',' ORDER BY attnum)
          FROM pg_attribute WHERE attrelid = 'pending_password_resets'::regclass AND attnum > 0 AND NOT attisdropped`]);
        const v3 = psql(['-f', commit]);
        const replay = psql(['-c', 'BEGIN', '-f', path.join(API, 'src/db/schema_v83.sql'), '-c', 'COMMIT']);
        check(setup.status === 0 && v1.status === 0 && /^t\|0\|f\|t$/m.test(v1.stdout) && /ROLLBACK/.test(v1.stdout) && after1.stdout.trim() === 't',
          `the preview printed t|0|f|t and ROLLBACK, and left no table (exit ${v1.status}; ${v1.stderr.trim().split('\n').slice(-1)[0] ?? ''})`);
        check(v2.status === 0 && /^t\|0\|f\|t$/m.test(v2.stdout) && /COMMIT/.test(v2.stdout)
          && privs.stdout.trim() === 'false,role=true,account_id=true,password_hash=false,expires_at=true,created_at=true',
          `the COMMIT copy made the table; the read-only role: ${privs.stdout.trim()}`);
        check(v3.status === 3 && v3.stderr.includes('v83 precondition: pending_password_resets already exists'),
          `a second COMMIT is refused by the precondition (exit ${v3.status})`);
        check(replay.status === 0, `schema_v83.sql replays over it, as migrate.ts would (exit ${replay.status})`);
      } finally {
        await q(`DROP DATABASE IF EXISTS ${db}`);
        if (!hadRole) await q('DROP ROLE IF EXISTS claude_readonly');
      }
    }

    section('S  the source');
    {
      const schema = read('src/db/schema_v83.sql');
      const body = schema.slice(schema.indexOf("SET LOCAL lock_timeout = '3s';"));
      const prev = fs.readFileSync(path.join(REPO, 'scripts/ops/v83_pending_password_resets.sql'), 'utf8');
      const comm = fs.readFileSync(path.join(REPO, 'scripts/ops/v83_pending_password_resets_COMMIT.sql'), 'utf8');
      const block = prev.slice(prev.indexOf('-- ── BEGIN V83 (schema_v83.sql, verbatim)'), prev.indexOf('-- ── END V83'));
      check(block.slice(block.indexOf('\n') + 1) === body, "the scripts' V83 block is schema_v83.sql from its SET LOCAL line to the end, byte for byte");
      const pl = prev.split('\n');
      const cl = comm.split('\n');
      const diff = pl.map((x, i) => (x === cl[i] ? null : i)).filter((i) => i !== null);
      check(pl.length === cl.length && diff.length === 1 && pl[diff[0]!] === 'ROLLBACK;' && cl[diff[0]!] === 'COMMIT;', 'the COMMIT copy differs from the preview in one line: ROLLBACK; to COMMIT;');
      check(/'schema_v82\.sql', 'schema_v83\.sql'\];/.test(read('src/db/migrate.ts')), 'migrate.ts ends with schema_v83.sql, after schema_v82.sql');
    }

    section('M  mutation controls (each must fail its part)');
    {
      const route = read(ROUTE);
      const service = read(SERVICE);
      const mutants: Array<[string, Record<string, string>, (origin: string) => Promise<string[]>]> = [
        ["BASE's route (the password replaced at once)", { [ROUTE]: base(ROUTE) }, partR],
        ['no pacing', { [SERVICE]: once(once(service, '  return r.rowCount === 0;', '  return true;'),
          'WHERE pending_password_resets.created_at <= NOW() - make_interval(mins => $5)', 'WHERE $5::int IS NOT NULL') }, partP],
        ['no expiry', { [SERVICE]: once(service, ' AND account_id = $2 AND expires_at > NOW()', ' AND account_id = $2') }, partE],
        ['the current password does not end a reset', { [ROUTE]: once(route, '  } else {\n    await cancelReset(role, accountId);\n  }\n', '  }\n') }, partC],
        ['the answer after the work', { [ROUTE]: once(once(once(route,
          '  res.json(safeResponse);\n  if (!userId || !table) return;\n', '  if (!userId || !table) return res.json(safeResponse);\n'),
          '  void emailReset(', '  await emailReset('),
          "    Sentry.captureException(err, { tags: { flow: 'forgot_password', role } });\n  });\n});",
          "    Sentry.captureException(err, { tags: { flow: 'forgot_password', role } });\n  });\n  res.json(safeResponse);\n});") }, partR],
        ['the emailed password stored plain', { [ROUTE]: once(route, 'if (!(await claimReset(role, accountId, hash))) {', 'if (!(await claimReset(role, accountId, tempPassword))) {') }, partR],
        ['no way past a lock', { [ROUTE]: once(route, '  if (!resetHash && lockRow?.locked_at', '  if (lockRow?.locked_at') }, partL],
      ];
      for (const [label, overrides, part] of mutants) {
        const origin = await serve(authRouter(overrides));
        const f = await part(origin);
        delayMs = 0;
        failNext = 0;
        check(f.length > 0, `${label}: caught${show(f.slice(0, 3))}`);
      }
      authRouter();
    }
  } finally {
    for (const s of servers) s.close();
    let left = 0;
    for (const sql of sweep) await q(sql);
    for (const sql of [
      "SELECT count(*)::int AS n FROM company_admins WHERE email LIKE 'lhn207-%'",
      "SELECT count(*)::int AS n FROM clients WHERE email LIKE 'lhn207-%'",
      "SELECT count(*)::int AS n FROM guards WHERE email LIKE 'lhn207-%'",
      "SELECT count(*)::int AS n FROM sites WHERE name LIKE 'lhn207-%'",
    ]) left += (await q(sql)).rows[0].n;
    if (!priorStarGuard) await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]).catch(() => undefined);
    console.log(`\ncleanup: ${left} seeded rows left`);
    await pool.end();
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { finished = true; console.error(e); process.exitCode = 1; });
