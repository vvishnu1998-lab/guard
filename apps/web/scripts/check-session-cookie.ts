#!/usr/bin/env ts-node
/**
 * Prove the web half of N203 stage 1 (Vishnu's decisions 1a 2a 3a 4a, 2026-10-14).
 *
 * The API now also sets the session as an HttpOnly cookie at sign-in and at a
 * client's site switch, and clears it at sign-out. A browser keeps or clears a
 * cookie from another origin only when the request opts in, so the five requests
 * that set or clear it send `credentials: 'include'`. Nothing else changes in this
 * stage; stage 2 moves the web's own calls to the cookie.
 *
 * 1. The admin, client and Vishnu sign-in requests, the client's site switch and
 *    SIGN OUT opt in. The switch goes through clientFetch, which keeps the option
 *    and still sends the bearer token; SIGN OUT's request, run, carries it.
 * 2. No other request in the web opts in.
 * 3. The five files are BASE's with exactly these edits.
 * 4. Mutation controls: each check above can fail.
 *
 * Run: npm run check:session-cookie (from apps/web). Needs git.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import Module from 'module';
import * as path from 'path';
import ts from 'typescript';

/** main before N203 stage 1 (PR #123's merge, N202). */
const BASE = '541a6e107f23d4d0a5517185f742fa09fc1ee55d';
const WEB = path.join(__dirname, '..');

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
function load(rel: string, src: string): any {
  const file = path.join(WEB, rel);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  return m.exports;
}

const COOKIE_NOTE = "        // N203 stage 1: so the browser keeps the HttpOnly session cookie the API sets.\n        credentials: 'include',\n";
const SIGN_OUT_NOTE = "          // N203 stage 1: so the browser applies the API's clearing of the HttpOnly session cookie.\n          credentials: 'include',\n";
const signIn = (p: string) => `      const res = await fetch(\`\${process.env.NEXT_PUBLIC_API_URL}/api/auth/${p}/login\`, {\n        method: 'POST',\n`;
/** Each request that opts in: the line it follows, and what is inserted. */
const SITES: Array<{ rel: string; anchor: string; insert: string; what: string }> = [
  { rel: 'app/admin/login/page.tsx', anchor: signIn('admin'), insert: COOKIE_NOTE, what: 'the admin sign-in' },
  { rel: 'app/client/login/page.tsx', anchor: signIn('client'), insert: COOKIE_NOTE, what: 'the client sign-in' },
  { rel: 'app/vishnu/login/page.tsx', anchor: signIn('vishnu'), insert: COOKIE_NOTE, what: 'the Vishnu sign-in' },
  { rel: 'app/client/select-site/page.tsx', anchor: "      const res = await clientFetch('/api/client/switch-site', {\n        method: 'POST',\n", insert: COOKIE_NOTE, what: 'the site switch' },
  { rel: 'lib/signOut.ts', anchor: "        await fetch(`${API}/api/auth/logout`, {\n          method: 'POST',\n", insert: SIGN_OUT_NOTE, what: 'SIGN OUT' },
];

/** The options object a request is made with: from its anchor to the line that closes it. */
function initOf(src: string, anchor: string): string | null {
  const i = src.indexOf(anchor);
  if (i < 0) return null;
  const close = src.indexOf('});', i);
  return close < 0 ? null : src.slice(i, close);
}

/** 1: the five requests opt in, through clientFetch too, and SIGN OUT's request carries it. */
async function optInProblems(read: (rel: string) => string): Promise<string[]> {
  const problems: string[] = [];
  for (const s of SITES) {
    const init = initOf(read(s.rel), s.anchor);
    if (!init) problems.push(`${s.what}: request not found`);
    else if (!/^\s*credentials: 'include',$/m.test(init)) problems.push(`${s.what}: no credentials: 'include'`);
  }
  const g = globalThis as unknown as { document?: unknown; fetch?: unknown; window?: unknown };
  const calls: RequestInit[] = [];
  g.fetch = (_url: string, init: RequestInit) => { calls.push(init); return Promise.resolve(new Response('{}', { status: 200 })); };
  g.document = { cookie: 'guard_client_access=A-client' };
  g.window = { location: { search: '' } };
  const api = load('lib/clientApi.ts', read('lib/clientApi.ts'));
  await api.clientFetch('/api/client/switch-site', { method: 'POST', credentials: 'include', body: '{}' });
  const sw = calls.pop();
  const auth = (sw?.headers as Record<string, string> | undefined)?.Authorization;
  if (sw?.credentials !== 'include' || auth !== 'Bearer A-client') problems.push(`clientFetch: credentials ${sw?.credentials}, Authorization ${auth}`);
  let jar = 'guard_admin_access=A-admin';
  g.document = { get cookie() { return jar; }, set cookie(v: string) { if (/max-age=0/.test(v)) jar = jar.split('; ').filter((c) => !c.startsWith(v.split('=')[0] + '=')).join('; '); } };
  await load('lib/signOut.ts', read('lib/signOut.ts')).endSession('admin');
  const out = calls.pop();
  if (out?.credentials !== 'include') problems.push(`SIGN OUT's request: credentials ${out?.credentials}`);
  return problems;
}

/** 2: no other request in the web opts in. */
function elsewhereProblems(read: (rel: string) => string): string[] {
  const files = execFileSync('git', ['ls-files', 'app', 'components', 'lib'], { cwd: WEB, encoding: 'utf8' }).trim().split('\n').filter((f) => /\.tsx?$/.test(f));
  const want: Record<string, number> = {};
  for (const s of SITES) want[s.rel] = 1;
  const got: Record<string, number> = {};
  for (const f of files) {
    const n = (read(f).match(/credentials:\s*'include'/g) || []).length;
    if (n > 0) got[f] = n;
  }
  const names = Object.keys(want).concat(Object.keys(got).filter((f) => !(f in want)));
  return names.filter((f) => (want[f] || 0) !== (got[f] || 0)).map((f) => `${f}: ${got[f] || 0} opt-ins, want ${want[f] || 0}`);
}

/** 3: each file is BASE's with exactly its insertion. */
function baseProblems(read: (rel: string) => string): string[] {
  const problems: string[] = [];
  for (const s of SITES) {
    try {
      if (once(base(s.rel), s.anchor, s.anchor + s.insert, s.rel) !== read(s.rel)) problems.push(`${s.rel}: not BASE plus the opt-in`);
    } catch (e) { problems.push((e as Error).message); }
  }
  return problems;
}

async function main(): Promise<void> {
  console.log('\n── 1  the five requests that set or clear the cookie opt in');
  const o = await optInProblems(now);
  check(o.length === 0, `the three sign-ins, the site switch (through clientFetch, which keeps the option and the bearer token) and SIGN OUT (its request, run) send credentials: 'include' (${o.join('; ') || 'all right'})`);

  console.log('\n── 2  nothing else does');
  const e = elsewhereProblems(now);
  check(e.length === 0, `no other request in app/, components/ or lib/ opts in (${e.join('; ') || 'none'})`);

  console.log('\n── 3  the five files');
  const b = baseProblems(now);
  check(b.length === 0, `each is BASE's (${BASE.slice(0, 7)}) with exactly its opt-in (${b.join('; ') || 'all equal'})`);

  console.log('\n── 4  mutation controls');
  const editRead = (rel: string, a: string, z: string) => (x: string) => (x === rel ? once(now(rel), a, z, `mutant ${rel}`) : now(x));
  const mutants: Array<[string, () => Promise<string[]> | string[]]> = [
    ['the client sign-in without the opt-in: its cookie is never kept, which 1 refuses',
      () => optInProblems(editRead('app/client/login/page.tsx', COOKIE_NOTE, ''))],
    ['clientFetch dropping the caller\'s options: the switch loses the opt-in, which 1 refuses',
      () => optInProblems(editRead('lib/clientApi.ts', '    ...options,\n', ''))],
    ['SIGN OUT without the opt-in: the cookie outlives the sign-out, which 1 refuses',
      () => optInProblems(editRead('lib/signOut.ts', SIGN_OUT_NOTE, ''))],
    ['another request opting in (stage 2\'s work, not this one\'s), which 2 refuses',
      () => elsewhereProblems(editRead('lib/adminApi.ts', '    ...options,\n', "    ...options,\n    credentials: 'include',\n"))],
    ['one more line changed in a touched file, which 3 refuses',
      () => baseProblems(editRead('app/vishnu/login/page.tsx', 'max-age=28800', 'max-age=28801'))],
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
