#!/usr/bin/env ts-node
/**
 * Prove N202 on the web (Vishnu's decisions 1a, 2a and 4a, 2026-10-14): SIGN OUT
 * ends the session on the server in all three portals, the browser keeps no
 * refresh token, and the history names a sign-out.
 *
 * lib/signOut.ts runs against a fake cookie jar and a fake fetch:
 * 1. For each portal: one POST /api/auth/logout with the portal's own session
 *    token and the refresh token when one is stored (only from before N202),
 *    not keepalive (see lib/signOut.ts); then both of the portal's cookies are
 *    gone and no other portal's cookie is touched.
 * 2. The cookies go whatever the API does: a refusal, a network error, and an
 *    API that never answers (the call is abandoned at the 3-second cap); with
 *    no session cookie there is no call at all; two clicks make one call.
 * 3. The sources: each portal's SIGN OUT goes through endSession and then its
 *    sign-in page, and clears no cookie itself; no page stores a refresh token
 *    (2a); every touched file is BASE's with exactly the N202 edits.
 * 4. The history names a sign-out "Signed out" (4a).
 * 5. Mutation controls: each check above can fail.
 *
 * Run: npm run check:sign-out (from apps/web). Needs git.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import Module from 'module';
import * as path from 'path';
import ts from 'typescript';
import { applyN203Stage2 } from './n203Stage2Edits';

/** main before N202 (PR #122's merge). */
const BASE = '26d38ae526e3f478053a30967dabd4b44f5b2150';
const WEB = path.join(__dirname, '..');
const LIB = 'lib/signOut.ts';
type Portal = 'admin' | 'client' | 'vishnu';
const PORTALS: Portal[] = ['admin', 'client', 'vishnu'];
/** Set before lib/signOut.ts loads, so the request's address proves the module reads it. */
const API_URL = 'https://api.check.test';

let passes = 0;
let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function once(s: string, find: string, replace: string, what: string): string {
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`${what}: found ${n} times`);
  return s.replace(find, () => replace);
}
const now = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const base = (rel: string) => execFileSync('git', ['show', `${BASE}:apps/web/${rel}`], { encoding: 'utf8' });
function load(src: string): { endSession(p: Portal): Promise<void>; SIGN_IN_PATH: Record<Portal, string> } {
  const file = path.join(WEB, LIB);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  return m.exports as any;
}

// ── the browser, faked: a cookie jar and a fetch that does what each case says ──
type Call = { url: string; method?: string; keepalive?: boolean; auth?: string; body?: string; signal?: AbortSignal };
const g = globalThis as unknown as { document?: unknown; fetch?: unknown };
function browser(cookies: Record<string, string>, api: 'ok' | 'refuse' | 'throw' | 'hang') {
  const jar: Record<string, string> = { ...cookies };
  const calls: Call[] = [];
  g.document = {
    get cookie() { return Object.keys(jar).map((k) => `${k}=${jar[k]}`).join('; '); },
    set cookie(v: string) {
      const parts = v.split(';').map((x) => x.trim());
      const eq = parts[0].indexOf('=');
      const name = parts[0].slice(0, eq);
      if (parts.some((x) => /^max-age=0$/i.test(x))) delete jar[name]; else jar[name] = parts[0].slice(eq + 1);
    },
  };
  g.fetch = (url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({ url, method: init.method, keepalive: init.keepalive, auth: headers.Authorization, body: init.body as string, signal: init.signal ?? undefined });
    if (api === 'ok') return Promise.resolve(new Response('{"success":true}', { status: 200 }));
    if (api === 'refuse') return Promise.resolve(new Response('{"error":"Token has been revoked"}', { status: 401 }));
    if (api === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
    return new Promise((_, reject) => { init.signal?.addEventListener('abort', () => reject(new Error('aborted'))); });
  };
  return { jar, calls };
}
const FULL = (p: Portal) => ({ [`guard_${p}_access`]: `A-${p}`, [`guard_${p}_refresh`]: `R-${p}` });
const OTHERS = (p: Portal) => PORTALS.filter((x) => x !== p).reduce((o, x) => ({ ...o, [`guard_${x}_access`]: `A-${x}` }), {} as Record<string, string>);

/** 1: the request, and the jar after. */
async function requestProblems(lib: ReturnType<typeof load>): Promise<string[]> {
  const problems: string[] = [];
  for (const p of PORTALS) {
    const b = browser({ ...FULL(p), ...OTHERS(p) }, 'ok');
    await lib.endSession(p);
    const c = b.calls[0];
    if (b.calls.length !== 1) problems.push(`${p}: ${b.calls.length} calls`);
    else if (c.url !== `${API_URL}/api/auth/logout` || c.method !== 'POST' || c.keepalive !== undefined || c.auth !== `Bearer A-${p}` || c.body !== `{"refresh_token":"R-${p}"}` || !c.signal) {
      problems.push(`${p}: ${JSON.stringify({ url: c.url, method: c.method, keepalive: c.keepalive, auth: c.auth, body: c.body })}`);
    }
    if (`guard_${p}_access` in b.jar || `guard_${p}_refresh` in b.jar) problems.push(`${p}: its cookies remain`);
    if (Object.keys(OTHERS(p)).some((k) => !(k in b.jar))) problems.push(`${p}: another portal's cookie was cleared`);
    const only = browser({ [`guard_${p}_access`]: `A-${p}` }, 'ok');
    await lib.endSession(p);
    if (only.calls[0]?.body !== '{}') problems.push(`${p} with no refresh token: body ${only.calls[0]?.body}`);
  }
  return problems;
}
/** 2: the cookies go whatever happens, within the cap; no session, no call; two clicks, one call. */
async function robustnessProblems(lib: ReturnType<typeof load>): Promise<string[]> {
  const problems: string[] = [];
  for (const api of ['refuse', 'throw'] as const) {
    const b = browser(FULL('admin'), api);
    await lib.endSession('admin');
    if (Object.keys(b.jar).length) problems.push(`${api}: cookies remain`);
  }
  {
    const b = browser(FULL('client'), 'hang');
    const t0 = Date.now();
    const done = await Promise.race([lib.endSession('client').then(() => 'done'), new Promise((r) => setTimeout(() => r('stuck'), 5000))]);
    const ms = Date.now() - t0;
    if (done !== 'done' || ms < 2900 || ms > 3800 || Object.keys(b.jar).length || !b.calls[0]?.signal?.aborted) problems.push(`an API that never answers: ${done} after ${ms} ms, cookies ${Object.keys(b.jar).length}, aborted ${b.calls[0]?.signal?.aborted}`);
  }
  {
    const b = browser({ guard_vishnu_refresh: 'R-old' }, 'ok');
    await lib.endSession('vishnu');
    if (b.calls.length !== 0 || Object.keys(b.jar).length) problems.push(`no session cookie: ${b.calls.length} calls, cookies ${Object.keys(b.jar).length}`);
  }
  {
    const b = browser(FULL('admin'), 'ok');
    await Promise.all([lib.endSession('admin'), lib.endSession('admin')]);
    if (b.calls.length !== 1) problems.push(`two clicks: ${b.calls.length} calls`);
  }
  return problems;
}

// ── 3: the sources ──
const SITES: Array<{ rel: string; portal: Portal; importLine: [string, string] }> = [
  { rel: 'components/admin/AdminNav.tsx', portal: 'admin', importLine: ["import { adminGet } from '../../lib/adminApi';\n", "import { adminGet } from '../../lib/adminApi';\nimport { endSession, SIGN_IN_PATH } from '../../lib/signOut';\n"] },
  { rel: 'components/client/ClientNav.tsx', portal: 'client', importLine: ["import { clientGet } from '../../lib/clientApi';\n", "import { clientGet } from '../../lib/clientApi';\nimport { endSession, SIGN_IN_PATH } from '../../lib/signOut';\n"] },
  { rel: 'app/vishnu/layout.tsx', portal: 'vishnu', importLine: ["import { useState, useEffect } from 'react';\n", "import { useState, useEffect } from 'react';\nimport { endSession, SIGN_IN_PATH } from '../../lib/signOut';\n"] },
];
const signOutOld = (p: Portal) => `  function logout() {\n    document.cookie = 'guard_${p}_access=; path=/; max-age=0';\n    document.cookie = 'guard_${p}_refresh=; path=/; max-age=0';\n    router.push('/${p}/login');\n  }`;
const signOutNew = (p: Portal) => `  async function logout() {\n    // N202: ends the session on the server too (lib/signOut.ts), then opens the sign-in page.\n    await endSession('${p}');\n    router.push(SIGN_IN_PATH.${p});\n  }`;
const LOGINS: Array<{ rel: string; portal: Portal }> = [
  { rel: 'app/admin/login/page.tsx', portal: 'admin' }, { rel: 'app/client/login/page.tsx', portal: 'client' },
  { rel: 'app/client/select-site/page.tsx', portal: 'client' }, { rel: 'app/vishnu/login/page.tsx', portal: 'vishnu' },
];
const NOTE = "      // N202 (2a): no refresh token is kept. Nothing in the web reads one, and SIGN OUT revokes the session.\n";
const keepLine = (p: Portal) => `      document.cookie = \`guard_${p}_refresh=\${data.refresh}; path=/; max-age=2592000; SameSite=Strict\`;\n`;
/**
 * Later changes to the same lines, layered on so the comparison stays exact: N203 stage 1 (2026-10-15) lets
 * each sign-in request keep the API's HttpOnly session cookie, and stage 2 (scripts/n203Stage2Edits.ts) moves
 * the pages onto lib/session.ts. scripts/check-session-cookie.ts proves stage 2's edits exact.
 */
const N203_COOKIE = "        // N203 stage 1: so the browser keeps the HttpOnly session cookie the API sets.\n        credentials: 'include',\n";
const n203Anchor = (rel: string, p: Portal) => (rel === 'app/client/select-site/page.tsx'
  ? "      const res = await clientFetch('/api/client/switch-site', {\n        method: 'POST',\n"
  : `      const res = await fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/api/auth/${p}/login\`, {\n        method: 'POST',\n`);
const withN203 = (rel: string, p: Portal, src: string) => once(src, n203Anchor(rel, p), n203Anchor(rel, p) + N203_COOKIE, `${rel} N203 anchor`);
const HISTORY: Array<{ rel: string; edits: Array<[string, string]> }> = [
  { rel: 'lib/signInHistory.ts', edits: [
    ['/** 1b: the five events the history lists. A type this page does not know is shown as sent. */', "/** 1b's five events, and sign-outs (N202, 4a). A type this page does not know is shown as sent. */"],
    ["  password_reset_emailed: 'Password reset email sent',\n};", "  password_reset_emailed: 'Password reset email sent',\n  logout: 'Signed out',\n};"]] },
  { rel: 'app/admin/settings/sign-ins/page.tsx', edits: [
    ['          Your own sign-ins, failed sign-ins and password changes from the last 365 days, newest first. Times are Pacific.',
      '          Your own sign-ins, sign-outs, failed sign-ins and password changes from the last 365 days, newest first. Times are Pacific.']] },
];
function sourceProblems(read: (rel: string) => string): string[] {
  const problems: string[] = [];
  for (const s of SITES) {
    const src = read(s.rel);
    if (!src.includes(signOutNew(s.portal))) problems.push(`${s.rel}: SIGN OUT does not go through endSession('${s.portal}') then its sign-in page`);
    if (/document\.cookie\s*=/.test(src)) problems.push(`${s.rel}: still writes a cookie itself`);
  }
  const all = execFileSync('git', ['ls-files', 'app', 'components', 'lib'], { cwd: WEB, encoding: 'utf8' }).trim().split('\n').filter((f) => /\.tsx?$/.test(f));
  const keeping = all.filter((f) => /_refresh=\$\{/.test(read(f)));
  if (keeping.length) problems.push(`a refresh token is still stored by ${keeping.join(', ')}`);
  for (const l of LOGINS) if (!read(l.rel).includes(NOTE)) problems.push(`${l.rel}: the 2a note is missing`);
  return problems;
}
function baseProblems(read: (rel: string) => string): string[] {
  const problems: string[] = [];
  const same = (rel: string, want: string) => { if (want !== read(rel)) problems.push(`${rel}: not BASE plus the N202 edits`); };
  try {
    for (const s of SITES) same(s.rel, once(once(base(s.rel), s.importLine[0], s.importLine[1], `${s.rel} import`), signOutOld(s.portal), signOutNew(s.portal), `${s.rel} sign-out`));
    for (const l of LOGINS) same(l.rel, applyN203Stage2(l.rel, withN203(l.rel, l.portal, once(base(l.rel), keepLine(l.portal), NOTE, `${l.rel} refresh line`))));
    for (const h of HISTORY) same(h.rel, h.edits.reduce((x, [a, b]) => once(x, a, b, h.rel), base(h.rel)));
  } catch (e) { problems.push((e as Error).message); }
  return problems;
}

async function main(): Promise<void> {
  process.env.NEXT_PUBLIC_API_URL = API_URL;
  const src = now(LIB);
  const lib = load(src);

  console.log('\n── 1  the request, per portal, and the cookies after');
  const r = await requestProblems(lib);
  check(r.length === 0, `admin, client and Vishnu: one POST /api/auth/logout with the portal's session token, the old refresh token when stored, an abort signal and no keepalive; both cookies gone; no other portal's touched (${r.join('; ') || 'all right'})`);

  console.log('\n── 2  the cookies go whatever happens');
  const b = await robustnessProblems(lib);
  check(b.length === 0, `a refusal, a network error, and an API that never answers (abandoned at 3 s): signed out each time; no session cookie, no call; two clicks, one call (${b.join('; ') || 'all right'})`);
  check(JSON.stringify(lib.SIGN_IN_PATH) === '{"admin":"/admin/login","client":"/client/login","vishnu":"/vishnu/login"}', `each portal's sign-in page: ${JSON.stringify(lib.SIGN_IN_PATH)}`);

  console.log('\n── 3  the sources');
  const s = sourceProblems(now);
  check(s.length === 0, `each SIGN OUT goes through endSession then its sign-in page and writes no cookie itself; no page stores a refresh token; the 2a note on the 4 sign-in pages (${s.join('; ') || 'all right'})`);
  const bp = baseProblems(now);
  check(bp.length === 0, `the ${SITES.length + LOGINS.length + HISTORY.length} touched files are BASE's (${BASE.slice(0, 7)}) with exactly the N202 edits, then N203 stage 1's and stage 2's (${bp.join('; ') || 'all equal'})`);

  console.log('\n── 4  the history names a sign-out');
  const labels = now('lib/signInHistory.ts');
  check(labels.includes("  logout: 'Signed out',\n"), 'lib/signInHistory.ts names logout "Signed out" (4a)');

  console.log('\n── 5  mutation controls');
  const editRead = (rel: string, a: string, b2: string) => (x: string) => (x === rel ? once(now(rel), a, b2, `mutant ${rel}`) : now(x));
  const mutants: Array<[string, () => Promise<string[]>]> = [
    ['no call to the API: the session lives on, which 1 refuses', async () => requestProblems(load(once(src, '        await fetch(`${API}/api/auth/logout`, {', '        await (async (..._a: unknown[]) => undefined)(`${API}/api/auth/logout`, {', 'm1')))],
    ['keepalive, which a browser can refuse when the request needs a CORS preflight, which 1 refuses', async () => requestProblems(load(once(src, "          method: 'POST',\n", "          method: 'POST',\n          keepalive: true,\n", 'm1b')))],
    ['the cookies cleared before they are read: no session token sent, which 1 refuses', async () => requestProblems(load(once(src, "    const access = readCookie(`guard_${portal}_access`);\n", "    forgetSession(portal);\n    const access = readCookie(`guard_${portal}_access`);\n", 'm2')))],
    ['no cap on the wait: an API that never answers keeps the browser signed in, which 2 refuses', async () => robustnessProblems(load(once(src, '      const timer = setTimeout(() => controller.abort(), SIGN_OUT_TIMEOUT_MS);\n', '      const timer = setTimeout(() => undefined, SIGN_OUT_TIMEOUT_MS);\n', 'm3')))],
    ['no single flight: two clicks make two calls, which 2 refuses', async () => robustnessProblems(load(once(src, '  if (inFlight) return inFlight;\n', '', 'm4')))],
    ['a sign-in page still storing the refresh token, which 3 refuses', async () => sourceProblems(editRead('app/client/select-site/page.tsx', NOTE, keepLine('client')))],
    ['the admin nav clearing its cookies itself instead, which 3 refuses', async () => sourceProblems(editRead('components/admin/AdminNav.tsx', signOutNew('admin'), signOutOld('admin')))],
    ['one more line changed in a touched file, which 3 refuses', async () => baseProblems(editRead('app/vishnu/login/page.tsx', 'SameSite=Strict', 'SameSite=Lax'))],
  ];
  let caught = 0;
  for (const [what, run] of mutants) {
    const p = await run();
    if (p.length) caught += 1;
    check(p.length > 0, `control — ${what} (${p.length}: ${(p[0] || 'NOT caught').slice(0, 100)})`);
  }
  check(caught === mutants.length, `${caught} of ${mutants.length} mutants caught`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// A promise that never settles would drain the event loop and exit 0 without a verdict.
process.on('beforeExit', () => { console.error('CHECK ERROR: exited before a verdict'); process.exit(1); });
main().catch((e) => { console.error('CHECK ERROR', e); process.exit(1); });
