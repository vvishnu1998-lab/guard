#!/usr/bin/env ts-node
/**
 * Prove the web half of N203 stage 2 (Vishnu's decisions 1a 2a 3b 4a, 2026-10-15): the web stops handling session
 * tokens. Stage 1's opt-ins (5faf492) are part of what stage 2 changes; git and STATE keep their proof.
 *
 * 1. lib/session.ts, both paths. Where the page and the API are one site (www.netraops.com and api.netraops.com)
 *    a request sends the cookie and names its portal, carries no token, and a sign-in names its portal so the
 *    body carries none (3b); the browser keeps only a non-secret hint. Anywhere else (a Vercel preview, 2a) the
 *    bearer token as before, plus the hint. A sign-in whose cookie the browser did not keep is refused, hint gone.
 * 2. The admin, client and Vishnu API helpers send what (1) says and treat the API's 401 as the end of the session:
 *    the browser forgets it and opens the portal's sign-in page. The N194 hold still opens change-password.
 * 3. SIGN OUT on the cookie path asks the API with the portal named and no token, even with no token cookie, and
 *    the hint goes.
 * 4. The page guard (middleware.ts): on the cookie path the hint lets the pages through; a session from before
 *    stage 2 has its token cookie verified and swapped for the hint, once, for the rest of its life (1a); anything
 *    else opens the sign-in page. On a preview the token cookie is checked as before.
 * 5. Nothing else in app/, components/ or lib/ reads a token or builds an Authorization header; no token goes in a
 *    URL (N206: the preview arrives as the client portal's cookie, PreviewBootstrap is gone); each sign-in page,
 *    the site switch and the preview mark the session through lib/session.ts.
 * 6. Every touched file is 51814bc's with exactly the edits in scripts/n203Stage2Edits.ts, and undoing them gives
 *    51814bc's back.
 * 7. Mutation controls: each check above can fail.
 *
 * Run: npm run check:session-cookie (from apps/web). Needs git.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import Module from 'module';
import * as path from 'path';
import ts from 'typescript';
import { applyN203Stage2, N203_STAGE2_BASE, N203_STAGE2_EDITS, undoN203Stage2 } from './n203Stage2Edits';

const WEB = path.join(__dirname, '..');
const API_URL = 'https://api.netraops.com';
const WWW = 'www.netraops.com';
const PREVIEW = 'guard-git-feat-x-vvishnu1998-labs-projects.vercel.app';
const ADMIN_SECRET = 'check-only-jwt-secret';
const VISHNU_SECRET = 'check-only-vishnu-secret';
process.env.NEXT_PUBLIC_API_URL = API_URL;
process.env.JWT_SECRET = ADMIN_SECRET;
process.env.VISHNU_JWT_SECRET = VISHNU_SECRET;
type Portal = 'admin' | 'client' | 'vishnu';
const PORTALS: Portal[] = ['admin', 'client', 'vishnu'];

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
const base = (rel: string) => execFileSync('git', ['show', `${N203_STAGE2_BASE}:apps/web/${rel}`], { encoding: 'utf8' });
const show = (v: unknown) => JSON.stringify(v);
function load(rel: string, src: string): any {
  const file = path.join(WEB, rel);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  return m.exports;
}

// ── a browser, faked: its host, a cookie jar that keeps each cookie's attributes, fetch, and where it was sent ──
type Call = { url: string; init: RequestInit };
const g = globalThis as unknown as { window?: unknown; document?: unknown; fetch?: unknown };
function browser(host: string, cookies: Record<string, string>, answer: (url: string) => number = () => 200, pathname = '/admin') {
  const jar: Record<string, string> = { ...cookies };
  const attrs: Record<string, string> = {};
  const calls: Call[] = [];
  const moves: string[] = [];
  g.window = { location: { hostname: host, protocol: 'https:', pathname, get href() { return pathname; }, set href(v: string) { moves.push(v); } } };
  g.document = {
    get cookie() { return Object.keys(jar).map((k) => `${k}=${jar[k]}`).join('; '); },
    set cookie(v: string) {
      const parts = v.split(';').map((x) => x.trim());
      const eq = parts[0].indexOf('=');
      const name = parts[0].slice(0, eq);
      if (parts.some((x) => /^max-age=0$/i.test(x))) { delete jar[name]; delete attrs[name]; return; }
      jar[name] = parts[0].slice(eq + 1);
      attrs[name] = parts.slice(1).join('; ');
    },
  };
  g.fetch = (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const status = answer(url);
    return Promise.resolve(new Response(status === 200 ? '{"ok":true}' : status === 403 ? '{"code":"PASSWORD_CHANGE_REQUIRED","error":"Change your temporary password to continue."}' : '{"error":"Token has been revoked"}', { status, headers: { 'content-type': 'application/json' } }));
  };
  return { jar, attrs, calls, moves };
}
const headersOf = (c?: Call) => (c?.init.headers ?? {}) as Record<string, string>;

// ── 1: lib/session.ts ──
async function sessionProblems(s: any): Promise<string[]> {
  const p: string[] = [];
  const same: Array<[string, string, boolean]> = [
    [WWW, 'api.netraops.com', true], ['netraops.com', 'api.netraops.com', true], ['app.netraops.com', 'api.netraops.com', true],
    [PREVIEW, 'api.netraops.com', false], ['guard-vvishnu1998-labs-projects.vercel.app', 'api.netraops.com', false],
    ['evil-netraops.com', 'api.netraops.com', false], ['netraops.com.evil.io', 'api.netraops.com', false],
    ['localhost', 'localhost', true], ['127.0.0.1', 'localhost', false], ['127.0.0.1', '127.0.0.1', true], ['10.0.0.1', '10.0.0.2', false], ['', '', false],
  ];
  for (const [a, b, want] of same) if (s.sameSite(a, b) !== want) p.push(`sameSite(${a}, ${b}) = ${!want}`);
  for (const portal of PORTALS) {
    const c = browser(WWW, { [`guard_${portal}_access`]: 'OLD' });
    const init = s.authInit(portal);
    if (show(init) !== show({ credentials: 'include', headers: { 'X-NetraOps-Portal': portal } })) p.push(`cookie path ${portal}: ${show(init)}`);
    if (show(s.signInHeaders(portal)) !== show({ 'X-NetraOps-Portal': portal })) p.push(`cookie path ${portal}: sign-in headers ${show(s.signInHeaders(portal))}`);
    s.markSignedIn(portal, 'TOKEN');
    if (c.jar[`netraops_${portal}_signed_in`] !== '1' || c.attrs[`netraops_${portal}_signed_in`] !== 'path=/; max-age=28800; SameSite=Lax; Secure' || c.jar[`guard_${portal}_access`] !== 'OLD') {
      p.push(`cookie path ${portal}: after the sign-in ${show(c.jar)} ${show(c.attrs)}`);
    }
    s.forgetSession(portal);
    if (Object.keys(c.jar).length) p.push(`cookie path ${portal}: forgetSession left ${Object.keys(c.jar).join(',')}`);
    const b = browser(PREVIEW, { [`guard_${portal}_access`]: 'TOK' });
    const binit = s.authInit(portal);
    if (show(binit) !== show({ headers: { Authorization: 'Bearer TOK' } }) || show(s.signInHeaders(portal)) !== '{}') p.push(`bearer path ${portal}: ${show(binit)} ${show(s.signInHeaders(portal))}`);
    s.markSignedIn(portal, 'NEW', 1800);
    if (b.jar[`guard_${portal}_access`] !== 'NEW' || b.attrs[`guard_${portal}_access`] !== 'path=/; max-age=1800; SameSite=Strict' || b.jar[`netraops_${portal}_signed_in`] !== '1') {
      p.push(`bearer path ${portal}: after the sign-in ${show(b.jar)} ${show(b.attrs)}`);
    }
  }
  const at = browser(WWW, {}, () => 401, '/admin');
  s.markSignedIn('admin');
  s.signedOut('admin');
  if (show(at.moves) !== show(['/admin/login']) || at.jar.netraops_admin_signed_in) p.push(`signedOut: moves ${show(at.moves)}, hint ${at.jar.netraops_admin_signed_in}`);
  const onPage = browser(WWW, {}, () => 401, '/admin/login');
  s.signedOut('admin');
  if (onPage.moves.length) p.push(`signedOut on the sign-in page moved ${show(onPage.moves)}`);
  for (const [status, want] of [[401, false], [200, true], [403, true]] as const) {
    const k = browser(WWW, {}, () => status);
    s.markSignedIn('client');
    const kept = await s.sessionKept('client');
    const probe = k.calls[0];
    if (kept !== want || probe?.url !== `${API_URL}/api/client/site` || probe?.init.credentials !== 'include' || headersOf(probe)['X-NetraOps-Portal'] !== 'client'
      || (want ? k.jar.netraops_client_signed_in !== '1' : k.jar.netraops_client_signed_in !== undefined)) {
      p.push(`sessionKept with ${status}: ${kept}, probe ${probe?.url}, hint ${k.jar.netraops_client_signed_in}`);
    }
  }
  const bk = browser(PREVIEW, {});
  if (!(await s.sessionKept('admin')) || bk.calls.length) p.push('sessionKept on the bearer path asked the API');
  return p;
}

// ── 2: the API helpers ──
const HELPERS: Record<Portal, { rel: string; call: (m: any) => Promise<unknown>; login: string }> = {
  admin: { rel: 'lib/adminApi.ts', call: (m) => m.adminFetch('/api/sites', { method: 'PUT', body: '{}' }), login: '/admin/login' },
  client: { rel: 'lib/clientApi.ts', call: (m) => m.clientFetch('/api/client/site'), login: '/client/login' },
  vishnu: { rel: 'lib/vishnuApi.ts', call: (m) => m.vishnuFetch('/api/admin/companies'), login: '/vishnu/login' },
};
async function helperProblems(read: (rel: string) => string): Promise<string[]> {
  const p: string[] = [];
  for (const portal of PORTALS) {
    const h = HELPERS[portal];
    const m = load(h.rel, read(h.rel));
    const ok = browser(WWW, { [`netraops_${portal}_signed_in`]: '1', [`guard_${portal}_access`]: 'OLD' });
    await h.call(m);
    const c = ok.calls[0];
    if (c?.init.credentials !== 'include' || headersOf(c)['X-NetraOps-Portal'] !== portal || 'Authorization' in headersOf(c) || ok.moves.length) {
      p.push(`${portal} cookie path: credentials ${c?.init.credentials}, headers ${show(headersOf(c))}, moves ${show(ok.moves)}`);
    }
    const gone = browser(WWW, { [`netraops_${portal}_signed_in`]: '1' }, () => 401);
    await h.call(m).catch(() => undefined);
    if (show(gone.moves) !== show([h.login]) || gone.jar[`netraops_${portal}_signed_in`]) p.push(`${portal}: a 401 moved ${show(gone.moves)}, hint ${gone.jar[`netraops_${portal}_signed_in`]}`);
    const pv = browser(PREVIEW, { [`guard_${portal}_access`]: 'TOK' });
    await h.call(m);
    const pc = pv.calls[0];
    if (headersOf(pc).Authorization !== 'Bearer TOK' || pc?.init.credentials !== undefined || 'X-NetraOps-Portal' in headersOf(pc)) p.push(`${portal} bearer path: ${show(pc?.init)}`);
  }
  const hold = browser(WWW, { netraops_admin_signed_in: '1' }, () => 403, '/admin/guards');
  await load('lib/adminApi.ts', read('lib/adminApi.ts')).adminFetch('/api/guards');
  if (show(hold.moves) !== show(['/admin/change-password'])) p.push(`the N194 hold on the cookie path moved ${show(hold.moves)}`);
  return p;
}

// ── 3: SIGN OUT on the cookie path ──
async function signOutProblems(read: (rel: string) => string): Promise<string[]> {
  const p: string[] = [];
  const so = load('lib/signOut.ts', read('lib/signOut.ts'));
  for (const portal of PORTALS) {
    const b = browser(WWW, { [`netraops_${portal}_signed_in`]: '1' });
    await so.endSession(portal);
    const c = b.calls[0];
    if (b.calls.length !== 1 || c.url !== `${API_URL}/api/auth/logout` || c.init.method !== 'POST' || c.init.credentials !== 'include'
      || headersOf(c)['X-NetraOps-Portal'] !== portal || 'Authorization' in headersOf(c) || c.init.body !== '{}' || Object.keys(b.jar).length) {
      p.push(`${portal}: ${b.calls.length} calls ${show(c?.init)}, left ${Object.keys(b.jar).join(',')}`);
    }
    const legacy = browser(WWW, { [`guard_${portal}_access`]: 'OLD', [`guard_${portal}_refresh`]: 'R' });
    await so.endSession(portal);
    const lc = legacy.calls[0];
    if (lc?.init.body !== '{"refresh_token":"R"}' || 'Authorization' in headersOf(lc) || Object.keys(legacy.jar).length) p.push(`${portal} with cookies from before stage 2: ${show(lc?.init)}, left ${Object.keys(legacy.jar).join(',')}`);
  }
  return p;
}

// ── 4: the page guard ──
async function token(secret: string, expInS: number, sub = 'x'): Promise<string> {
  const { SignJWT } = await import('jose');
  const nowS = Math.floor(Date.now() / 1000);
  return new SignJWT({ sub, role: 'company_admin' }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt(nowS - 60).setExpirationTime(nowS + expInS).sign(new TextEncoder().encode(secret));
}
async function guardProblems(read: (rel: string) => string): Promise<string[]> {
  const p: string[] = [];
  const { NextRequest } = await import('next/server');
  const mw = load('middleware.ts', read('middleware.ts'));
  const run = async (url: string, cookies: Record<string, string>) => {
    const res = await mw.middleware(new NextRequest(url, { headers: { cookie: Object.keys(cookies).map((k) => `${k}=${cookies[k]}`).join('; ') } }));
    return { next: res.headers.get('x-middleware-next') === '1', status: res.status, location: res.headers.get('location'), cookies: res.headers.getSetCookie() as string[] };
  };
  const good = await token(ADMIN_SECRET, 7200);
  const vgood = await token(VISHNU_SECRET, 3600);
  const expired = await token(ADMIN_SECRET, -10);
  const r = {
    hint: await run(`https://${WWW}/admin/shifts`, { netraops_admin_signed_in: '1' }),
    none: await run(`https://${WWW}/admin/shifts?report=7`, {}),
    hintNotOne: await run(`https://${WWW}/admin`, { netraops_admin_signed_in: 'yes' }),
    swap: await run(`https://${WWW}/admin`, { guard_admin_access: good, guard_admin_refresh: 'R' }),
    vswap: await run(`https://${WWW}/vishnu`, { guard_vishnu_access: vgood }),
    forged: await run(`https://${WWW}/admin`, { guard_admin_access: await token('not-the-secret', 7200) }),
    old: await run(`https://${WWW}/admin`, { guard_admin_access: expired }),
    signIn: await run(`https://${WWW}/admin/login`, {}),
    pvHint: await run(`https://${PREVIEW}/admin`, { netraops_admin_signed_in: '1' }),
    pvToken: await run(`https://${PREVIEW}/admin`, { guard_admin_access: good }),
    pvForged: await run(`https://${PREVIEW}/admin`, { guard_admin_access: await token('not-the-secret', 7200) }),
  };
  const toSignIn = (x: typeof r.none, from: string) => !x.next && x.status === 307 && x.location === `https://${x.location?.split('/')[2]}/admin/login?from=${encodeURIComponent(from)}`;
  if (!r.hint.next || r.hint.cookies.length) p.push(`the hint: ${show(r.hint)}`);
  if (!toSignIn(r.none, '/admin/shifts?report=7')) p.push(`no session: ${show(r.none)}`);
  if (!toSignIn(r.hintNotOne, '/admin')) p.push(`a hint that is not "1": ${show(r.hintNotOne)}`);
  const hintSet = (x: typeof r.swap, name: string, maxS: number) => x.cookies.some((c) => {
    const m = c.match(new RegExp(`^${name}=1; Path=/; Expires=[^;]+; Max-Age=(\\d+); Secure; SameSite=lax$`));
    return !!m && Number(m[1]) > maxS - 5 && Number(m[1]) <= maxS;
  });
  const deleted = (x: typeof r.swap, name: string) => x.cookies.some((c) => c.startsWith(`${name}=; Path=/; Expires=Thu, 01 Jan 1970`));
  if (!r.swap.next || !hintSet(r.swap, 'netraops_admin_signed_in', 7200) || !deleted(r.swap, 'guard_admin_access') || !deleted(r.swap, 'guard_admin_refresh')) p.push(`the swap: ${show(r.swap)}`);
  if (!r.vswap.next || !hintSet(r.vswap, 'netraops_vishnu_signed_in', 3600) || !deleted(r.vswap, 'guard_vishnu_access')) p.push(`Vishnu's swap: ${show(r.vswap)}`);
  for (const [what, x] of [['a forged token', r.forged], ['an expired token', r.old]] as const) {
    if (!toSignIn(x, '/admin') || !deleted(x, 'guard_admin_access') || x.cookies.some((c) => c.startsWith('netraops_admin_signed_in=1'))) p.push(`${what}: ${show(x)}`);
  }
  if (!r.signIn.next) p.push(`the sign-in page: ${show(r.signIn)}`);
  if (r.pvHint.next || r.pvHint.location !== `https://${PREVIEW}/admin/login?from=%2Fadmin`) p.push(`a preview with only the hint: ${show(r.pvHint)}`);
  if (!r.pvToken.next || r.pvToken.cookies.length) p.push(`a preview with its token: ${show(r.pvToken)}`);
  if (r.pvForged.next || r.pvForged.location !== `https://${PREVIEW}/admin/login?invalid=1`) p.push(`a preview with a forged token: ${show(r.pvForged)}`);
  return p;
}

// ── 5: nothing else handles a token ──
const SIGN_INS: Array<{ rel: string; portal: Portal }> = [
  { rel: 'app/admin/login/page.tsx', portal: 'admin' }, { rel: 'app/client/login/page.tsx', portal: 'client' }, { rel: 'app/vishnu/login/page.tsx', portal: 'vishnu' },
];
function sourceProblems(read: (rel: string) => string): string[] {
  const p: string[] = [];
  const files = execFileSync('git', ['ls-files', 'app', 'components', 'lib'], { cwd: WEB, encoding: 'utf8' }).trim().split('\n').filter((f) => /\.tsx?$/.test(f) && fs.existsSync(path.join(WEB, f)));
  for (const f of files) {
    const s = read(f);
    if (f !== 'lib/session.ts' && /Authorization\s*:/.test(s)) p.push(`${f} builds an Authorization header`);
    if (!['lib/session.ts', 'lib/signOut.ts'].includes(f) && /document\.cookie/.test(s)) p.push(`${f} touches document.cookie`);
    if (/[?&]preview=/.test(s)) p.push(`${f} puts a token in a URL`);
  }
  if (fs.existsSync(path.join(WEB, 'components/client/PreviewBootstrap.tsx'))) p.push('PreviewBootstrap is still there');
  for (const l of SIGN_INS) {
    const s = read(l.rel);
    for (const want of [`...signInHeaders('${l.portal}')`, `markSignedIn('${l.portal}', data.access);`, `if (!(await sessionKept('${l.portal}'))) { setError(COOKIE_REFUSED); return; }`]) {
      if (!s.includes(want)) p.push(`${l.rel}: no ${want}`);
    }
  }
  if (!read('app/client/select-site/page.tsx').includes("markSignedIn('client', data.access);")) p.push('the site switch does not renew the session');
  const preview = read('app/admin/clients/page.tsx');
  if (!preview.includes("markSignedIn('client', r.access_token, r.expires_in);\n      window.open('/client', '_blank', 'noopener');")) p.push('the preview does not arrive as the client portal\'s session');
  return p;
}

// ── 6: the edits are exactly these ──
function editProblems(read: (rel: string) => string): string[] {
  const p: string[] = [];
  for (const rel of Object.keys(N203_STAGE2_EDITS)) {
    try {
      if (applyN203Stage2(rel, base(rel)) !== read(rel)) p.push(`${rel}: not 51814bc's plus the edits`);
      else if (undoN203Stage2(rel, read(rel)) !== base(rel)) p.push(`${rel}: the edits do not undo to 51814bc's`);
    } catch (e) { p.push(`${rel}: ${(e as Error).message}`); }
  }
  return p;
}

async function main(): Promise<void> {
  const session = load('lib/session.ts', now('lib/session.ts'));

  console.log('\n── 1  lib/session.ts: the cookie on the web\'s own site, the bearer token on a preview');
  const s1 = await sessionProblems(session);
  check(s1.length === 0, `12 host pairs; per portal on ${WWW}: the cookie and the portal named, no token, the sign-in names its portal (3b), only the hint kept (Lax, Secure, 8 h); on a Vercel preview the bearer token and the hint (2a); a 401 forgets and opens the sign-in page (not from it); a sign-in whose cookie did not stay is refused and its hint goes (${s1.join('; ') || 'all right'})`);

  console.log('\n── 2  the API helpers');
  const s2 = await helperProblems(now);
  check(s2.length === 0, `admin, client and Vishnu: on ${WWW} the cookie, the portal named and no token, even beside an old token cookie; a 401 forgets the session and opens the portal's sign-in page; on a preview the bearer token as before; the N194 hold still opens change-password (${s2.join('; ') || 'all right'})`);

  console.log('\n── 3  SIGN OUT on the cookie path');
  const s3 = await signOutProblems(now);
  check(s3.length === 0, `each portal: one POST /api/auth/logout with the cookie and the portal named, no token, even with no token cookie; an old refresh token still sent; nothing left behind (${s3.join('; ') || 'all right'})`);

  console.log('\n── 4  the page guard');
  const s4 = await guardProblems(now);
  check(s4.length === 0, `on ${WWW}: the hint lets the pages through; none, or a hint that is not "1", opens the sign-in page with the address kept; a session from before stage 2 has its token verified and swapped for the hint for the token's remaining life, admin and Vishnu (1a); a forged or expired one is deleted and opens the sign-in page; on a preview the token cookie is checked as before and the hint alone is not enough (${s4.join('; ') || 'all right'})`);

  console.log('\n── 5  nothing else handles a token');
  const s5 = sourceProblems(now);
  check(s5.length === 0, `no other file builds an Authorization header or touches document.cookie; no token in a URL; PreviewBootstrap gone; the three sign-ins, the site switch and the preview go through lib/session.ts (${s5.join('; ') || 'all right'})`);

  console.log('\n── 6  the edits');
  const s6 = editProblems(now);
  check(s6.length === 0, `${Object.keys(N203_STAGE2_EDITS).length} files are ${N203_STAGE2_BASE.slice(0, 7)}'s with exactly the edits in scripts/n203Stage2Edits.ts, and undo to it (${s6.join('; ') || 'all equal'})`);

  console.log('\n── 7  mutation controls');
  // The edit is made before the check runs, so a mutant that no longer applies throws instead of reading as caught.
  const editRead = (rel: string, a: string, z: string) => { const mutated = once(now(rel), a, z, `mutant ${rel}`); return (x: string) => (x === rel ? mutated : now(x)); };
  const sessionMutant = (a: string, z: string) => () => sessionProblems(load('lib/session.ts', once(now('lib/session.ts'), a, z, 'mutant session')));
  const mutants: Array<[string, () => Promise<string[]> | string[]]> = [
    ['any two hosts as one site: a preview would expect a cookie it cannot hold, which 1 refuses',
      sessionMutant('  if (a === b) return true;\n', '  return true;\n')],
    ['the bearer token on the cookie path too, which 1 refuses',
      sessionMutant("  if (cookieSession()) return { credentials: 'include', headers: { [PORTAL_HEADER]: portal } };\n", "  if (cookieSession()) return { credentials: 'include', headers: { [PORTAL_HEADER]: portal, Authorization: `Bearer ${readCookie(tokenCookie(portal))}` } };\n")],
    ['the token kept in a script-readable cookie on the cookie path, which 1 refuses',
      sessionMutant('  if (!cookieSession() && access) document.cookie', '  if (access) document.cookie')],
    ['a sign-in whose cookie did not stay, let through, which 1 refuses',
      sessionMutant('    if (r.status !== 401) return true;\n', '    return true;\n')],
    ['the admin helper without the 401 rule, which 2 refuses',
      () => helperProblems(editRead('lib/adminApi.ts', "  if (res.status === 401) signedOut('admin');\n", ''))],
    ['SIGN OUT that asks the API only with a token cookie (N202\'s condition), which 3 refuses',
      () => signOutProblems(editRead('lib/signOut.ts', '    if (cookieSession() || access) {\n', '    if (access) {\n'))],
    ['a page guard that takes any hint value, which 4 refuses',
      () => guardProblems(editRead('middleware.ts', "if (req.cookies.get(route.hintName)?.value === '1') return NextResponse.next();", 'if (req.cookies.get(route.hintName)) return NextResponse.next();'))],
    ['a swap that keeps the old token cookie, which 4 refuses',
      () => guardProblems(editRead('middleware.ts', '          res.cookies.delete(route.cookieName);\n          res.cookies.delete(route.refreshName);\n', ''))],
    ['a swap that does not verify the token, which 4 refuses',
      () => guardProblems(editRead('middleware.ts', "          const { payload } = await jwtVerify(legacy, legacySecret, { algorithms: ['HS256'] });\n", "          const payload = JSON.parse(Buffer.from(legacy.split('.')[1], 'base64url').toString());\n"))],
    ['a page that builds its own Authorization header again, which 5 refuses',
      () => sourceProblems(editRead('app/admin/billing/page.tsx', "authInit('admin'));", "{ headers: { Authorization: 'Bearer x' } });"))],
    ['one more line changed in a touched file, which 6 refuses',
      () => editProblems(editRead('app/vishnu/login/page.tsx', "'Login failed'", "'Sign-in failed'"))],
  ];
  let caught = 0;
  for (const [what, run] of mutants) {
    let p: string[];
    try { p = await run(); } catch (e) { p = [`threw: ${(e as Error).message}`]; }
    const real = p.length > 0 && !p[0].startsWith('threw:');
    if (real) caught += 1;
    check(real, `control — ${what} (${p.length}: ${(p[0] || 'NOT caught').slice(0, 110)})`);
  }
  check(caught === mutants.length, `${caught} of ${mutants.length} mutants caught`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// A promise that never settles would drain the event loop and exit 0 without a verdict.
process.on('beforeExit', () => { console.error('CHECK ERROR: exited before a verdict'); process.exit(1); });
main().catch((e) => { console.error('CHECK ERROR', e); process.exit(1); });
