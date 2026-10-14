/**
 * test-d2-password-changed-email.ts — a change of password is told to the account's own address (N197; Phase D, D2).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-d2-password-changed-email.ts     (from apps/api)
 *
 * Vishnu's decisions 3a and 4a (2026-10-14). Over HTTP, with the real auth router and the real email module,
 * SendGrid stubbed to record each message (or to fail):
 *
 *   E  each role (admin, client, guard): a change sends one email to the account's own address, from the
 *      alerts sender with support as Reply-To, "Your NetraOps password was changed", naming the portal,
 *      the address, the Pacific time with the weekday of the Pacific date, the device from the request,
 *      and the role's own last line; never the request's address or its raw user agent
 *   R  a refused change (a wrong, missing or short password) sends nothing
 *   F  the first change from a temporary password sends one too (3a), an admin's and a guard's
 *   X  SendGrid failing: the change still stands and answers 200; the failure reaches Sentry
 *      (sendgrid_failing, flow password_changed)
 *   U  each route answers as it did at BASE (main before D2) and leaves the same rows; BASE sends nothing
 *   S  the notice is called three times, once per route, right after its password_changed event, with that
 *      route's portal; the UPDATEs are BASE's
 *   M  mutation controls: the guard route without the notice, the notice before the password check, the
 *      send awaited without its guard, and the client told in the admin's words
 *
 * LOCAL DATABASES ONLY; fake rows on Star Guard's id, passwords generated here and never printed. Sentry
 * and S3 are stubbed, and SendGrid is a recorder.
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
/** main before D2 (PR #121's merge). */
const BASE = '69f97dd26488cfdf17aa7fcb30f7ac718ffdd503';
const AUTH_ROUTES = 'src/routes/auth.ts';
const FROM = 'alerts@example.invalid';

process.env.JWT_SECRET = 'test-only-d2';
process.env.JWT_REFRESH_SECRET = 'test-only-d2-refresh';
process.env.VISHNU_JWT_SECRET = 'test-only-d2-vishnu';
process.env.SENDGRID_API_KEY = 'SG.test-only-d2';
process.env.SENDGRID_FROM_EMAIL = FROM;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const UA = {
  admin: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  client: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  guard: 'NetraOps/48 CFNetwork/1568.100.1 Darwin/24.0.0',
};
const WORDS = {
  admin: { seg: 'admin', label: 'Admin Dashboard', device: 'Chrome on macOS', last: 'If it wasn\'t, reset it now with "Forgot password?" on the sign-in page, and contact support@netraops.com.' },
  client: { seg: 'client', label: 'Client Portal', device: 'Safari on iPhone', last: 'If it wasn\'t, contact your security provider right away.' },
  guard: { seg: 'guard', label: 'Guard App', device: 'the NetraOps app on iPhone', last: 'If it wasn\'t, contact your supervisor right away.' },
} as const;
type Portal = keyof typeof WORDS;

async function main(): Promise<void> {
  refuseUnlessLocal();
  // SendGrid: a recorder that can be told to fail the next sends.
  const sent: Array<{ to: string; from: string; replyTo: string; subject: string; html: string }> = [];
  let failNext = 0;
  inject('@sendgrid/mail', {
    __esModule: true,
    default: {
      setApiKey: () => undefined,
      send: async (msg: any) => {
        if (failNext > 0) { failNext -= 1; const e: any = new Error('Forbidden'); e.code = 403; throw e; }
        sent.push(msg);
        return [{ statusCode: 202 }];
      },
    },
  });
  const captures: Array<{ message: string; flow?: string }> = [];
  inject('../src/services/sentry', {
    Sentry: {
      captureMessage: (message: string, opts?: any) => { captures.push({ message, flow: opts?.tags?.flow }); return 'evt'; },
      captureException: () => 'evt',
      addBreadcrumb: () => undefined,
    },
    tagRequest: () => undefined,
  });
  inject('../src/services/s3', { __esModule: true, urlOrPresign: async (url: string | null) => url });

  const bcrypt = (await import('bcrypt')).default;
  const jwt = (await import('jsonwebtoken')).default;
  const { pacificLongDateTime } = await import('../src/services/pacificDate');
  const pool = ((await import('../src/db/pool')) as any).pool;
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  await import('express-async-errors');
  const express = (await import('express')).default;

  const marker = `lhd2-${Date.now().toString(36)}`;
  const made: Record<string, string[]> = { company_admins: [], clients: [], guards: [], sites: [] };
  let swept = 0;
  for (const sql of [
    "DELETE FROM auth_events WHERE actor_id IN (SELECT id FROM company_admins WHERE email LIKE 'lhd2-%' UNION ALL SELECT id FROM clients WHERE email LIKE 'lhd2-%' UNION ALL SELECT id FROM guards WHERE email LIKE 'lhd2-%')",
    "DELETE FROM guard_devices WHERE guard_id IN (SELECT id FROM guards WHERE email LIKE 'lhd2-%')",
    "DELETE FROM company_admins WHERE email LIKE 'lhd2-%'",
    "DELETE FROM clients WHERE email LIKE 'lhd2-%'",
    "DELETE FROM guards WHERE email LIKE 'lhd2-%'",
    "DELETE FROM sites WHERE name LIKE 'lhd2-%'",
  ]) swept += (await q(sql)).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  const priorStarGuard = (await q('SELECT 1 FROM companies WHERE id = $1', [STAR_GUARD])).rows[0] ?? null;
  let server: Server | null = null;
  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const site = (await q(`INSERT INTO sites (company_id, name, address, contract_start) VALUES ($1, $2, '1 Example Way', '2026-01-01') RETURNING id`,
      [STAR_GUARD, `${marker} North Gate`])).rows[0].id as string;
    made.sites.push(site);
    let n = 0;
    async function person(portal: Portal, temporary = false) {
      n += 1;
      const password = pw();
      const email = `${marker}-${portal}-${n}@test.invalid`;
      const hash = await bcrypt.hash(password, 4);
      const id = portal === 'admin'
        ? (await q(`INSERT INTO company_admins (company_id, name, email, password_hash, is_primary, must_change_password) VALUES ($1, $2, $3, $4, false, $5) RETURNING id`, [STAR_GUARD, `${marker} ${n}`, email, hash, temporary])).rows[0].id as string
        : portal === 'client'
          ? (await q(`INSERT INTO clients (site_id, company_id, name, email, password_hash, must_change_password) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [site, STAR_GUARD, `${marker} ${n}`, email, hash, temporary])).rows[0].id as string
          : (await q(`INSERT INTO guards (company_id, name, email, password_hash, badge_number, must_change_password) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [STAR_GUARD, `${marker} ${n}`, email, hash, `LHD2-${marker.slice(-6)}-${n}`, temporary])).rows[0].id as string;
      made[portal === 'admin' ? 'company_admins' : portal === 'client' ? 'clients' : 'guards'].push(id);
      const role = portal === 'admin' ? 'company_admin' : portal;
      const claims = role === 'company_admin' ? { sub: id, role, company_id: STAR_GUARD, is_primary: false } : role === 'client' ? { sub: id, role, site_id: site } : { sub: id, role, company_id: STAR_GUARD };
      const token = jwt.sign({ ...claims, iat: Math.floor(Date.now() / 1000) - 5 }, process.env.JWT_SECRET!, { expiresIn: '1h' });
      return { id, email, password, token, portal };
    }
    type Who = Awaited<ReturnType<typeof person>>;
    const table = (p: Portal) => (p === 'admin' ? 'company_admins' : p === 'client' ? 'clients' : 'guards');
    const rowOf = async (w: Who) => (await q(`SELECT password_hash, must_change_password, tokens_not_before IS NOT NULL AS stamped FROM ${table(w.portal)} WHERE id = $1`, [w.id])).rows[0];

    // ══ the router as it is, as it was at BASE, and mutants ══
    const nowSrc = fs.readFileSync(path.join(__dirname, '..', AUTH_ROUTES), 'utf8');
    const baseSrc = execFileSync('git', ['show', `${BASE}:apps/api/${AUTH_ROUTES}`], { cwd: path.join(__dirname, '..'), encoding: 'utf8' });
    const app = express();
    app.set('env', 'test');
    app.use(express.json());
    app.use('/api/auth', (await import('../src/routes/auth')).default);
    app.use('/api/auth-base', compileAt(AUTH_ROUTES, baseSrc).default);
    app.use('/api/auth-m1', compileAt(AUTH_ROUTES, once(nowSrc, "  notifyPasswordChanged(guardResult.rows[0].email, 'guard', req);\n", '')).default);
    app.use('/api/auth-m2', compileAt(AUTH_ROUTES, once(once(nowSrc, "  notifyPasswordChanged(adminResult.rows[0].email, 'admin', req);\n", ''),
      "  if (!adminResult.rows[0]) return res.status(404).json({ error: 'Admin not found' });\n",
      "  if (!adminResult.rows[0]) return res.status(404).json({ error: 'Admin not found' });\n  notifyPasswordChanged(adminResult.rows[0].email, 'admin', req);\n")).default);
    app.use('/api/auth-m3', compileAt(AUTH_ROUTES, once(nowSrc, "  notifyPasswordChanged(adminResult.rows[0].email, 'admin', req);\n",
      "  await sendPasswordChangedEmail({ portal: 'admin', email: adminResult.rows[0].email, changedAt: new Date(), device: deviceLabel(req.headers['user-agent']) });\n")).default);
    app.use('/api/auth-m4', compileAt(AUTH_ROUTES, once(nowSrc, "  notifyPasswordChanged(clientResult.rows[0].email, 'client', req);\n", "  notifyPasswordChanged(clientResult.rows[0].email, 'admin', req);\n")).default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    async function change(prefix: string, w: Who, body: Record<string, unknown>) {
      const t0 = new Date();
      const r = await fetch(`${origin}${prefix}/${WORDS[w.portal].seg}/change-password`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${w.token}`, 'user-agent': UA[w.portal] }, body: JSON.stringify(body),
      });
      const t1 = new Date();
      return { status: r.status, body: await r.json().catch(() => null) as any, t0, t1 };
    }
    /** The messages for this address, after giving a send that is not awaited time to land. */
    async function mailFor(email: string, wait = 1500) {
      const until = Date.now() + wait;
      while (Date.now() < until && !sent.some((m) => m.to === email)) await sleep(25);
      await sleep(150);
      return sent.filter((m) => m.to === email);
    }
    /** What the notice for this change must say, with either clock minute the change could have landed in. */
    function noticeProblems(w: Who, mails: typeof sent, t0: Date, t1: Date, words: (typeof WORDS)[Portal] = WORDS[w.portal]): string[] {
      const problems: string[] = [];
      if (mails.length !== 1) return [`${mails.length} messages`];
      const m = mails[0];
      if (m.from !== FROM || m.replyTo !== 'support@netraops.com' || m.subject !== 'Your NetraOps password was changed') problems.push(`envelope ${show({ from: m.from, replyTo: m.replyTo, subject: m.subject })}`);
      const whens = [pacificLongDateTime(t0), pacificLongDateTime(t1)];
      for (const want of [`<strong>${words.label}</strong>`, `account (${w.email}) was changed on`, `, from ${words.device}.`, words.last.replace(/"/g, '"'), 'Every session that was signed in has been signed out.', "If this was you, there's nothing to do."]) {
        if (!m.html.includes(want)) problems.push(`missing ${JSON.stringify(want.slice(0, 50))}`);
      }
      if (!whens.some((x) => m.html.includes(`<strong>${x}</strong>`))) problems.push(`no time ${whens[0]}`);
      if (m.html.includes('127.0.0.1') || m.html.includes(UA[w.portal])) problems.push('the request address or raw user agent is in it');
      return problems;
    }

    // ══════════════════════════════════════════════════════════════════════════
    section('E  each role: one notice to the account\'s own address');
    for (const portal of ['admin', 'client', 'guard'] as Portal[]) {
      const w = await person(portal);
      const r = await change('/api/auth', w, { current_password: w.password, new_password: pw() });
      const mails = await mailFor(w.email);
      const p = noticeProblems(w, mails, r.t0, r.t1);
      check(r.status === 200 && show(r.body) === '{"success":true}' && p.length === 0,
        `E ${portal}: ${r.status} ${show(r.body)}; one email to its own address naming ${WORDS[portal].label}, the Pacific time, "${WORDS[portal].device}" and its own last line (${p.join('; ') || 'all right'})`);
    }
    {
      const w = await person('admin');
      const r = await change('/api/auth', w, { current_password: w.password, new_password: pw() });
      const html = (await mailFor(w.email))[0]?.html ?? '';
      const when = html.match(/<strong>([A-Z][a-z]+day), ([A-Z][a-z]+) (\d{1,2}), (\d{4}) at (\d{1,2}):(\d{2}) (AM|PM) PT<\/strong>/);
      const intlDay = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'long' }).format(r.t1);
      check(!!when && when[1] === intlDay, `E the weekday is the Pacific date's: ${when?.[0].replace(/<\/?strong>/g, '') ?? 'none'} (Intl in Los Angeles: ${intlDay})`);
    }

    section('R  a refused change sends nothing');
    {
      const quiet: string[] = [];
      for (const portal of ['admin', 'client', 'guard'] as Portal[]) {
        const w = await person(portal);
        const wrong = await change('/api/auth', w, { current_password: `${w.password}x`, new_password: pw() });
        const short = await change('/api/auth', w, { current_password: w.password, new_password: 'Ab3$xyz' });
        const none = await change('/api/auth', w, { new_password: pw() });
        const mails = await mailFor(w.email, 800);
        if (!(wrong.status === 401 && short.status === 400 && none.status === 400 && mails.length === 0)) quiet.push(`${portal}: ${wrong.status} ${short.status} ${none.status}, ${mails.length} mails`);
      }
      check(quiet.length === 0, `a wrong current password (401), a 7-character new one (400) and none at all (400), for each role: no email (${quiet.join('; ') || 'all quiet'})`);
    }

    section('F  the first change from a temporary password sends one too (3a)');
    for (const portal of ['admin', 'guard'] as Portal[]) {
      const w = await person(portal, true);
      const r = await change('/api/auth', w, { current_password: w.password, new_password: pw() });
      const p = noticeProblems(w, await mailFor(w.email), r.t0, r.t1);
      check(r.status === 200 && (await rowOf(w)).must_change_password === false && p.length === 0, `F ${portal} on a temporary password: ${r.status}, the flag clears, one email (${p.join('; ') || 'all right'})`);
    }

    section('X  SendGrid failing: the change stands, the failure reaches Sentry');
    {
      const w = await person('admin');
      const before = (await rowOf(w)).password_hash;
      const next = pw();
      const capturesBefore = captures.length;
      failNext = 1;
      const r = await change('/api/auth', w, { current_password: w.password, new_password: next });
      const mails = await mailFor(w.email, 800);
      const row = await rowOf(w);
      const reported = captures.slice(capturesBefore).filter((c) => c.message === 'sendgrid_failing' && c.flow === 'password_changed').length;
      check(r.status === 200 && show(r.body) === '{"success":true}' && row.password_hash !== before && await bcrypt.compare(next, row.password_hash) && mails.length === 0 && reported === 1,
        `${r.status} ${show(r.body)}; the new password stored; no email; Sentry told once, flow password_changed (${reported})`);
      failNext = 0;
    }

    section('U  each route answers as at BASE and leaves the same rows; BASE sends nothing');
    {
      const differ: string[] = [];
      for (const portal of ['admin', 'client', 'guard'] as Portal[]) {
        const a = await person(portal);
        const b = await person(portal);
        const nextA = pw();
        const nextB = pw();
        const rb = await change('/api/auth-base', a, { current_password: a.password, new_password: nextA });
        const rn = await change('/api/auth', b, { current_password: b.password, new_password: nextB });
        const ra = await rowOf(a);
        const rr = await rowOf(b);
        const evA = (await q("SELECT count(*)::int AS n FROM auth_events WHERE actor_id = $1 AND event_type = 'password_changed'", [a.id])).rows[0].n;
        const evB = (await q("SELECT count(*)::int AS n FROM auth_events WHERE actor_id = $1 AND event_type = 'password_changed'", [b.id])).rows[0].n;
        const baseMails = await mailFor(a.email, 800);
        if (rb.status !== rn.status || show(rb.body) !== show(rn.body) || !(await bcrypt.compare(nextA, ra.password_hash)) || !(await bcrypt.compare(nextB, rr.password_hash))
          || ra.must_change_password !== rr.must_change_password || ra.stamped !== rr.stamped || evA !== evB || baseMails.length !== 0) {
          differ.push(`${portal}: BASE ${rb.status} ${show(rb.body)} events ${evA} mails ${baseMails.length}; now ${rn.status} ${show(rn.body)} events ${evB}`);
        }
        for (const body of [{ current_password: `${a.password}-no`, new_password: pw() }, { new_password: 'short' }]) {
          const x = await change('/api/auth-base', a, body);
          const y = await change('/api/auth', b, body);
          if (x.status !== y.status || show(x.body) !== show(y.body)) differ.push(`${portal} refused: BASE ${x.status} ${show(x.body)}, now ${y.status} ${show(y.body)}`);
        }
      }
      check(differ.length === 0, `for each role, a change and two refusals answer as BASE answers them, with the same rows and events after; BASE's change sends no email (${differ.join('; ') || 'all equal'})`);
    }

    section('S  the notice\'s place in each route');
    {
      const calls = [...nowSrc.matchAll(/\n  notifyPasswordChanged\((\w+)Result\.rows\[0\]\.email, '(\w+)', req\);\n/g)].map((m) => `${m[1]}:${m[2]}`);
      const after = ['guard', 'company_admin', 'client'].every((role) => nowSrc.includes(`  await logEvent(req.user!.sub, '${role}', 'password_changed', req);\n  notifyPasswordChanged(`));
      const updates = (s: string) => (s.match(/'UPDATE (guards|company_admins|clients) SET password_hash = \$1[^']*'/g) || []).join('|');
      check(show(calls) === '["guard:guard","admin:admin","client:client"]' && after && updates(nowSrc) === updates(baseSrc),
        `three calls, one per route with its own portal (${calls.join(', ')}), each right after its password_changed event; the three UPDATEs are BASE's`);
    }

    section('M  mutation controls');
    {
      const controls: Array<[string, () => Promise<string[]>]> = [
        ['the guard route without the notice: no email, which E refuses', async () => {
          const w = await person('guard');
          const r = await change('/api/auth-m1', w, { current_password: w.password, new_password: pw() });
          return noticeProblems(w, await mailFor(w.email, 800), r.t0, r.t1);
        }],
        ['the notice before the password check: a wrong password is told, which R refuses', async () => {
          const w = await person('admin');
          await change('/api/auth-m2', w, { current_password: `${w.password}x`, new_password: pw() });
          return (await mailFor(w.email, 800)).length ? ['told'] : [];
        }],
        ['the send awaited without its guard: SendGrid failing fails the change, which X refuses', async () => {
          const w = await person('admin');
          failNext = 1;
          const r = await change('/api/auth-m3', w, { current_password: w.password, new_password: pw() });
          failNext = 0;
          return r.status !== 200 ? [`${r.status}`] : [];
        }],
        ['the client told in the admin\'s words, which E refuses', async () => {
          const w = await person('client');
          const r = await change('/api/auth-m4', w, { current_password: w.password, new_password: pw() });
          return noticeProblems(w, await mailFor(w.email, 800), r.t0, r.t1);
        }],
      ];
      let caught = 0;
      for (const [what, run] of controls) {
        const p = await run();
        if (p.length) caught += 1;
        check(p.length > 0, `control — ${what} (${p[0] ?? 'NOT caught'})`);
      }
      check(caught === controls.length, `${caught} of ${controls.length} mutants caught`);
    }
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    await sleep(300);
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

main().catch((err) => { console.error('HARNESS ERROR', err); process.exit(1); });
