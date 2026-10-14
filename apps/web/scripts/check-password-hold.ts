#!/usr/bin/env ts-node
/**
 * Prove N194 on the web: an admin on a temporary password, whom the API now refuses everything but
 * changing it (403 {"code":"PASSWORD_CHANGE_REQUIRED"}), is sent to /admin/change-password, and
 * nothing else adminFetch does changes.
 *
 * lib/adminApi.ts is compiled as it is now and as it was at BASE (main before N194, read from git),
 * with fetch, window and document stubbed, and both are given the same responses:
 *
 * 1. The hold's 403, on any admin page, opens /admin/change-password once. The caller still gets the
 *    response, unread, so adminGet throws the API's sentence as BASE's does, and the page shows it
 *    until the browser moves.
 * 2. On /admin/change-password itself nothing moves. The nav polls the chat rooms on every admin page,
 *    that one included, and a redirect there would reload it forever.
 * 3. Every other response (200, 401, any other 403, a 403 whose body is not JSON, the hold's code on a
 *    status other than 403, 500) moves nothing: adminFetch makes BASE's request and returns the
 *    response fetch gave it, and adminGet, adminPost, adminPatch, adminDelete and adminDownload answer
 *    as BASE's do.
 * 4. Outside a browser (a server render: no window, no document) nothing moves and nothing throws.
 * 5. Mutation controls: each check above can fail.
 *
 * Run: npm run check:password-hold (from apps/web). Needs git.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import Module from 'module';
import * as path from 'path';
import ts from 'typescript';

/** main before N194 (PR #119's merge). */
const BASE = 'fe57a5c608d9c7ac4a5740a4e792bd5e4cf07dbb';
const WEB = path.join(__dirname, '..');
const REL = 'lib/adminApi.ts';
const CHANGE = '/admin/change-password';
const SENTENCE = 'Change your temporary password to continue.';

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

type Api = {
  adminFetch(p: string, o?: RequestInit): Promise<Response>;
  adminGet(p: string): Promise<unknown>;
  adminPost(p: string, b: unknown): Promise<unknown>;
  adminPatch(p: string, b: unknown): Promise<unknown>;
  adminDelete(p: string): Promise<void>;
  adminDownload(p: string, f: string): Promise<void>;
};
/** lib/adminApi.ts from `src`, compiled under its own path. */
function load(src: string): Api {
  const file = path.join(WEB, REL);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  return m.exports as Api;
}
const nowSrc = fs.readFileSync(path.join(WEB, REL), 'utf8');
const baseSrc = execFileSync('git', ['show', `${BASE}:apps/web/${REL}`], { encoding: 'utf8' });

// ── the browser, stubbed: what fetch was asked and answered, and where the page was sent ─────────
type Answer = { label: string; status: number; body: string; json: boolean };
type Seen = { requests: string[]; responses: Response[]; moves: string[] };
const g = globalThis as unknown as { fetch: unknown; window?: unknown; document?: unknown };
function browser(answer: Answer, pathname: string | null): Seen {
  const seen: Seen = { requests: [], responses: [], moves: [] };
  g.fetch = async (url: string, init: RequestInit) => {
    seen.requests.push(JSON.stringify({ url, init }));
    const r = new Response(answer.body, { status: answer.status, headers: answer.json ? { 'content-type': 'application/json' } : { 'content-type': 'text/html' } });
    seen.responses.push(r);
    return r;
  };
  if (pathname === null) { delete g.window; delete g.document; } else {
    g.window = { location: { pathname, get href() { return pathname; }, set href(v: string) { seen.moves.push(v); } } };
    g.document = { cookie: 'guard_admin_refresh=r-1; guard_admin_access=a-1' };
  }
  return seen;
}
const json = (status: number, body: unknown, label: string): Answer => ({ label, status, body: JSON.stringify(body), json: true });
const HOLD = json(403, { code: 'PASSWORD_CHANGE_REQUIRED', error: SENTENCE }, 'the hold');
const OTHERS: Answer[] = [
  json(200, { ok: true }, '200'),
  json(401, { error: 'Session revoked by administrator' }, '401 revoked'),
  json(403, { error: 'Insufficient permissions' }, '403 another role'),
  json(403, { error: 'Account deactivated' }, '403 deactivated'),
  json(403, { error: 'PASSWORD_CHANGE_REQUIRED' }, '403 the enum in error, not code'),
  json(403, { code: 'PRIMARY_ONLY', error: 'Only the primary admin can do this.' }, '403 another code'),
  { label: '403 not JSON', status: 403, body: '<html>Forbidden</html>', json: false },
  { label: '403 empty', status: 403, body: '', json: false },
  json(400, { code: 'PASSWORD_CHANGE_REQUIRED', error: SENTENCE }, 'the code on a 400'),
  json(401, { code: 'PASSWORD_CHANGE_REQUIRED', error: SENTENCE }, 'the code on a 401'),
  json(500, { error: 'Internal server error' }, '500'),
];
const PAGES = ['/admin', '/admin/settings', '/admin/guards/7f9c2b1e', '/admin/shifts', CHANGE];

/** What one call of the API answers, settled: the value, or the error's message, status and body. */
async function settle(p: Promise<unknown>): Promise<string> {
  try { return `ok ${JSON.stringify(await p)}`; } catch (e) {
    const err = e as { message?: string; status?: number; body?: unknown };
    return `threw ${JSON.stringify([err.message, err.status, err.body])}`;
  }
}
/** Every helper in turn on one answer and page: what each answered, what was asked of fetch, where the page went. */
async function drive(api: Api, answer: Answer, pathname: string | null) {
  const out: string[] = [];
  const seen: Seen[] = [];
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['adminGet', () => api.adminGet('/api/chat/rooms')],
    ['adminPost', () => api.adminPost('/api/shifts', { a: 1 })],
    ['adminPatch', () => api.adminPatch('/api/admin/company', { b: 2 })],
    ['adminDelete', () => api.adminDelete('/api/admin/company/logo')],
  ];
  if (answer.status >= 400) calls.push(['adminDownload', () => api.adminDownload('/api/exports/x', 'x.csv')]);
  for (const [name, call] of calls) {
    const s = browser(answer, pathname);
    out.push(`${name} ${await settle(call())}`);
    seen.push(s);
  }
  const s = browser(answer, pathname);
  const res = await api.adminFetch('/api/sites', { method: 'PUT', body: '{"name":"x"}' });
  const sameObject = res === s.responses[0];
  const unread = !res.bodyUsed && (await res.text()) === answer.body;
  seen.push(s);
  return { out, requests: seen.map((x) => x.requests.join('|')), moves: seen.map((x) => x.moves), sameObject, unread };
}

// ── the checks, each a function of the source, so a mutant runs through the same one ─────────────
async function holdOpensChangePassword(src: string): Promise<string[]> {
  const api = load(src);
  const base = load(baseSrc);
  const problems: string[] = [];
  for (const page of PAGES.filter((p) => p !== CHANGE)) {
    const d = await drive(api, HOLD, page);
    const b = await drive(base, HOLD, page);
    if (!d.moves.every((m) => JSON.stringify(m) === JSON.stringify([CHANGE]))) problems.push(`${page}: moves ${JSON.stringify(d.moves)}`);
    if (!d.sameObject || !d.unread) problems.push(`${page}: the caller did not get fetch's response, unread`);
    if (JSON.stringify(d.out) !== JSON.stringify(b.out)) problems.push(`${page}: answered ${JSON.stringify(d.out)}, BASE ${JSON.stringify(b.out)}`);
    if (!d.out[0].includes(SENTENCE)) problems.push(`${page}: adminGet did not throw the sentence`);
  }
  return problems;
}
async function changePageStays(src: string): Promise<string[]> {
  const d = await drive(load(src), HOLD, CHANGE);
  const problems: string[] = [];
  if (d.moves.some((m) => m.length)) problems.push(`moves ${JSON.stringify(d.moves)}`);
  if (!d.sameObject || !d.unread) problems.push('the caller did not get fetch\'s response, unread');
  return problems;
}
async function othersAsBase(src: string): Promise<string[]> {
  const api = load(src);
  const base = load(baseSrc);
  const problems: string[] = [];
  for (const answer of OTHERS) {
    for (const page of PAGES) {
      const d = await drive(api, answer, page);
      const b = await drive(base, answer, page);
      if (d.moves.some((m) => m.length)) problems.push(`${answer.label} on ${page}: moves ${JSON.stringify(d.moves)}`);
      if (JSON.stringify(d.out) !== JSON.stringify(b.out)) problems.push(`${answer.label} on ${page}: answered differently from BASE`);
      if (JSON.stringify(d.requests) !== JSON.stringify(b.requests)) problems.push(`${answer.label} on ${page}: asked fetch differently from BASE`);
      if (!d.sameObject || !d.unread) problems.push(`${answer.label} on ${page}: the caller did not get fetch's response, unread`);
    }
  }
  return problems;
}
async function serverRenderQuiet(src: string): Promise<string[]> {
  const problems: string[] = [];
  for (const answer of [HOLD].concat(OTHERS)) {
    try {
      const d = await drive(load(src), answer, null);
      const b = await drive(load(baseSrc), answer, null);
      if (JSON.stringify(d.out) !== JSON.stringify(b.out) || JSON.stringify(d.requests) !== JSON.stringify(b.requests)) problems.push(`${answer.label}: not BASE's`);
    } catch (e) { problems.push(`${answer.label}: threw ${(e as Error).message}`); }
  }
  return problems;
}

async function main(): Promise<void> {
  console.log('\n1. the hold\'s 403 opens /admin/change-password, and the caller still gets the response');
  const p1 = await holdOpensChangePassword(nowSrc);
  check(p1.length === 0, `on ${PAGES.length - 1} admin pages, through adminGet, adminPost, adminPatch, adminDelete, adminDownload and adminFetch: one move each, to ${CHANGE}; the response unread; the answers BASE's${p1.length ? ` — ${p1.join('; ')}` : ''}`);

  console.log('\n2. on /admin/change-password itself nothing moves');
  const p2 = await changePageStays(nowSrc);
  check(p2.length === 0, `the hold's 403 there: no move, the response unread${p2.length ? ` — ${p2.join('; ')}` : ''}`);

  console.log('\n3. every other response is answered as BASE answers it');
  const p3 = await othersAsBase(nowSrc);
  check(p3.length === 0, `${OTHERS.length} responses × ${PAGES.length} pages, through every helper (adminDownload on the refusals): no move; BASE's request, BASE's answer, fetch's response unread${p3.length ? ` — ${p3.slice(0, 4).join('; ')}` : ''}`);

  console.log('\n4. outside a browser nothing moves and nothing throws');
  const p4 = await serverRenderQuiet(nowSrc);
  check(p4.length === 0, `no window, no document: the hold and the ${OTHERS.length} others answered as BASE answers them${p4.length ? ` — ${p4.join('; ')}` : ''}`);

  console.log('\n5. mutation controls: each check above can fail');
  const GUARD = "if (res.status === 403 && typeof window !== 'undefined' && window.location.pathname !== CHANGE_PASSWORD_PATH) {";
  const mutants: Array<[string, string, (s: string) => string, (s: string) => Promise<string[]>]> = [
    ['M1', 'no exception for the change-password page: it reloads itself forever, which 2 refuses',
      (s) => once(s, " && window.location.pathname !== CHANGE_PASSWORD_PATH) {", ') {', 'the pathname test'), changePageStays],
    ['M2', 'the enum read from `error`: the hold moves nothing, which 1 refuses',
      (s) => once(s, 'if (body?.code === PASSWORD_CHANGE_REQUIRED)', 'if ((body as any)?.error === PASSWORD_CHANGE_REQUIRED)', 'the code test'), holdOpensChangePassword],
    ['M3', 'the body read without a clone: the caller gets a spent response, which 1 refuses',
      (s) => once(s, 'await res.clone().json()', 'await res.json()', 'the clone'), holdOpensChangePassword],
    ['M4', 'every 403 sent to change the password, which 3 refuses',
      (s) => once(s, '    if (body?.code === PASSWORD_CHANGE_REQUIRED) window.location.href = CHANGE_PASSWORD_PATH;', '    void body; window.location.href = CHANGE_PASSWORD_PATH;', 'the redirect'), othersAsBase],
    ['M5', 'no test for a browser: a server render throws, which 4 refuses',
      (s) => once(s, GUARD, "if (res.status === 403 && window.location.pathname !== CHANGE_PASSWORD_PATH) {", 'the window test'), serverRenderQuiet],
  ];
  let caught = 0;
  for (const [id, what, edit, run] of mutants) {
    const problems = await run(edit(nowSrc));
    if (problems.length) caught += 1;
    check(problems.length > 0, `${id} control — ${what} (${problems.length} problem${problems.length === 1 ? '' : 's'}: ${(problems[0] ?? 'none').slice(0, 110)})`);
  }
  check(caught === mutants.length, `${caught} of ${mutants.length} mutants caught`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CHECK ERROR', e); process.exit(1); });
