#!/usr/bin/env ts-node
/**
 * Prove Phase D's D1 on the web: the admin's sign-in history page and its link
 * in Settings (Vishnu's decisions 1b and 2a, 2026-10-14; 6a: no address).
 *
 * 1. Times are Pacific with the weekday of the Pacific date, in every browser
 *    zone. Pinned: Wednesday 14 October 2026 (the date of the copy Vishnu
 *    corrected), the evening that is already Thursday in UTC, both midnights
 *    around it, both 2026 DST changes, a leap day, a year end. Swept: every
 *    six hours of 2025-2028 against Intl's own weekday in Los Angeles. Run in
 *    six zones from UTC-11 to UTC+14, each a child process with its own TZ.
 * 2. The five event names of 1b; failures marked; an unknown type shown as sent.
 * 3. The list, rendered: each row's name, device and Pacific time; failures in
 *    amber; LOAD MORE only when there is more and nothing is loading; the
 *    empty, error, loading and last-page states.
 * 4. The page asks GET /api/admin/me/sign-ins, follows the API's cursor
 *    encoded, turns a 404 (an API older than the route) into a sentence, and
 *    names no address field.
 * 5. Settings shows SIGN-IN HISTORY in YOUR ACCOUNT, beside CHANGE PASSWORD, in
 *    the first render (before the profile loads, for every admin), and is
 *    BASE's source with exactly that edit.
 * 6. Mutation controls: each check above can fail.
 *
 * Run: npm run check:sign-in-history (from apps/web). Needs git.
 */
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import Module from 'module';
import * as path from 'path';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/** main before D1 (PR #120's merge). */
const BASE = '7245a0a95a3cfc175e4a775cbbf58471821fa2ee';
const WEB = path.join(__dirname, '..');
const LIB = 'lib/signInHistory.ts';
const LIST = 'components/admin/SignInHistoryList.tsx';
const PAGE = 'app/admin/settings/sign-ins/page.tsx';
const SETTINGS = 'app/admin/settings/page.tsx';
const ZONES = ['Pacific/Midway', 'America/Los_Angeles', 'America/New_York', 'Etc/UTC', 'Asia/Kolkata', 'Pacific/Kiritimati'];
const PINNED: Array<[string, string]> = [
  ['2026-10-14T21:06:10.000Z', 'Wed 14 Oct 2026, 14:06 PT'],
  ['2026-10-15T04:30:00.000Z', 'Wed 14 Oct 2026, 21:30 PT'],
  ['2026-10-15T06:59:00.000Z', 'Wed 14 Oct 2026, 23:59 PT'],
  ['2026-10-15T07:00:00.000Z', 'Thu 15 Oct 2026, 00:00 PT'],
  ['2026-10-14T07:00:00.000Z', 'Wed 14 Oct 2026, 00:00 PT'],
  ['2026-03-08T09:59:00.000Z', 'Sun 08 Mar 2026, 01:59 PT'],
  ['2026-03-08T10:30:00.000Z', 'Sun 08 Mar 2026, 03:30 PT'],
  ['2026-11-01T08:30:00.000Z', 'Sun 01 Nov 2026, 01:30 PT'],
  ['2026-11-01T09:30:00.000Z', 'Sun 01 Nov 2026, 01:30 PT'],
  ['2028-02-29T20:00:00.000Z', 'Tue 29 Feb 2028, 12:00 PT'],
  ['2026-09-10T19:00:00.000Z', 'Thu 10 Sept 2026, 12:00 PT'],
  ['2027-01-01T07:59:00.000Z', 'Thu 31 Dec 2026, 23:59 PT'],
  ['2027-01-01T08:00:00.000Z', 'Fri 01 Jan 2027, 00:00 PT'],
];

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
/** A module from `src`, compiled under `rel` so its imports resolve as they do in the app. */
function load(rel: string, src: string): any {
  const file = path.join(WEB, rel);
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  return m.exports;
}
function stub(request: string, exports: unknown): void {
  const resolved = require.resolve(request, { paths: [WEB] });
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}
stub('next/navigation', { useSearchParams: () => new URLSearchParams(), usePathname: () => '/admin/settings', useRouter: () => ({ push() {}, replace() {} }) });
stub('next/link', {
  __esModule: true,
  default: ({ href, className, children }: { href: string; className?: string; children?: React.ReactNode }) => React.createElement('a', { href, className }, children),
});

// ── 1: the times. A child process runs the formatter in its zone and prints what it got. ──
type Fmt = (iso: string) => string;
const SWEEP_FROM = Date.UTC(2025, 0, 1);
const SWEEP_TO = Date.UTC(2029, 0, 1);
const STEP = 6 * 3_600_000;
const intlWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', weekday: 'short' });
function timeProblems(fmt: Fmt): string[] {
  const problems: string[] = [];
  for (const [iso, want] of PINNED) if (fmt(iso) !== want) problems.push(`${iso} -> ${fmt(iso)}, want ${want}`);
  for (let t = SWEEP_FROM; t < SWEEP_TO && problems.length < 5; t += STEP) {
    const iso = new Date(t).toISOString();
    const got = fmt(iso).slice(0, 3);
    const want = intlWeekday.format(new Date(t));
    if (got !== want) problems.push(`${iso} weekday ${got}, Intl says ${want}`);
  }
  return problems;
}
if (process.env.D1_ZONE) {
  const src = process.env.D1_LIB_SRC ? Buffer.from(process.env.D1_LIB_SRC, 'base64').toString('utf8') : now(LIB);
  const lib = load(LIB, src);
  process.stdout.write(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, problems: timeProblems(lib.fmtPacific) }));
  process.exit(0);
}
/** Problems in every zone, for the library as it is or for a mutant of it. */
function zoneProblems(libSrc?: string): string[] {
  const problems: string[] = [];
  for (const zone of ZONES) {
    const r = spawnSync(process.execPath, ['-r', 'ts-node/register', __filename], {
      env: { ...process.env, TZ: zone, D1_ZONE: zone, D1_LIB_SRC: libSrc ? Buffer.from(libSrc).toString('base64') : '', TS_NODE_TRANSPILE_ONLY: 'true', TS_NODE_PROJECT: `${__dirname}/tsconfig.check.json` },
      encoding: 'utf8',
    });
    if (r.status !== 0) { problems.push(`${zone}: child failed ${r.stderr.slice(0, 200)}`); continue; }
    const out = JSON.parse(r.stdout) as { zone: string; problems: string[] };
    for (const p of out.problems) problems.push(`${zone}: ${p}`);
  }
  return problems;
}

// ── 2, 3: the names and the list ──
type Event = { at: string; type: string; device: string };
const EVENTS: Event[] = [
  { at: '2026-10-15T04:30:00.000Z', type: 'login_success', device: 'Chrome on macOS' },
  { at: '2026-10-14T21:06:10.000Z', type: 'login_failed', device: 'Safari on iPhone' },
  { at: '2026-10-13T16:00:00.000Z', type: 'login_blocked_locked', device: 'Safari on iPhone' },
  { at: '2026-10-12T16:00:00.000Z', type: 'password_changed', device: 'Edge on Windows' },
  { at: '2026-10-11T16:00:00.000Z', type: 'password_reset_emailed', device: 'Unknown device' },
  { at: '2026-10-10T16:00:00.000Z', type: 'something_new', device: 'curl' },
];
function nameProblems(lib: any): string[] {
  const want: Record<string, string> = {
    login_success: 'Signed in', login_failed: 'Failed sign-in', login_blocked_locked: 'Sign-in blocked: too many failed attempts',
    password_changed: 'Password changed', password_reset_emailed: 'Password reset email sent', logout: 'Signed out', something_new: 'something_new',
  };
  const problems: string[] = [];
  for (const [type, label] of Object.entries(want)) if (lib.signInEventLabel(type) !== label) problems.push(`${type} -> ${lib.signInEventLabel(type)}`);
  const failing = Object.keys(want).filter((t) => lib.isSignInFailure(t));
  if (JSON.stringify(failing) !== '["login_failed","login_blocked_locked"]') problems.push(`failures: ${JSON.stringify(failing)}`);
  return problems;
}
function listProblems(List: React.ComponentType<any>, fmt: Fmt): string[] {
  const render = (p: Record<string, unknown>) => renderToStaticMarkup(React.createElement(List, { events: [], hasMore: false, loading: false, error: '', onMore: () => undefined, ...p }));
  const problems: string[] = [];
  const full = render({ events: EVENTS, hasMore: true });
  const rows = full.split('<li ').slice(1);
  if (rows.length !== EVENTS.length) problems.push(`${rows.length} rows`);
  EVENTS.forEach((e, i) => {
    const row = rows[i] || '';
    if (!row.includes(`>${fmt(e.at)}<`) || !row.includes(`>${e.device}<`)) problems.push(`row ${i}: time or device missing`);
    const amber = row.includes('text-amber-400');
    if (amber !== (e.type === 'login_failed' || e.type === 'login_blocked_locked')) problems.push(`row ${i}: amber ${amber}`);
  });
  if (!full.includes('>LOAD MORE<')) problems.push('no LOAD MORE when there is more');
  if (render({ events: EVENTS, hasMore: true, loading: true }).includes('>LOAD MORE<')) problems.push('LOAD MORE while loading');
  const last = render({ events: EVENTS });
  if (last.includes('>LOAD MORE<') || !last.includes('That is everything from the last 365 days.')) problems.push('the last page');
  if (!render({}).includes('No sign-in activity in the last 365 days.')) problems.push('the empty state');
  const err = render({ error: 'Could not load your sign-in history.' });
  if (!err.includes('Could not load your sign-in history.') || err.includes('No sign-in activity')) problems.push('the error state');
  if (!render({ loading: true }).includes('Loading…') || render({ loading: true }).includes('No sign-in activity')) problems.push('the loading state');
  return problems;
}

// ── 4: the page's source ──
function pageProblems(src: string): string[] {
  const problems: string[] = [];
  if (!src.includes("adminFetch(`/api/admin/me/sign-ins${before ? `?before=${encodeURIComponent(before)}` : ''}`)")) problems.push('not the route, or the cursor not encoded');
  if (!/res\.status === 404\) \{\n\s+setError\('Your sign-in history is not available yet\./.test(src)) problems.push('a 404 is not a sentence');
  if (!src.includes("setNext(typeof body.next === 'string' ? body.next : null);")) problems.push('does not follow the API\'s cursor');
  if (/\bip(_address)?\b|user_agent/i.test(src.replace(/\/\*\*[\s\S]*?\*\//, ''))) problems.push('names an address or user-agent field');
  return problems;
}

// ── 5: Settings ──
const SETTINGS_LINK_EDIT: Array<[string, string]> = [
  [` * worded for a change the admin chose (Vishnu's decision 1a, 2026-10-13).\n`,
    ` * worded for a change the admin chose (Vishnu's decision 1a, 2026-10-13).\n * Beside it, SIGN-IN HISTORY opens /admin/settings/sign-ins, the admin's own\n * history (Phase D, D1: decisions 1b and 2a, 2026-10-14).\n`],
  [`        <Link
          href="/admin/change-password?from=settings"
          className="inline-block border border-[#00C8FF] text-[#00C8FF] font-bold tracking-widest text-sm px-5 py-2.5 rounded-lg hover:bg-[#00C8FF]/10 transition-colors"
        >
          CHANGE PASSWORD
        </Link>
      </section>
`, `        <div className="flex flex-wrap gap-3">
          <Link
            href="/admin/change-password?from=settings"
            className="inline-block border border-[#00C8FF] text-[#00C8FF] font-bold tracking-widest text-sm px-5 py-2.5 rounded-lg hover:bg-[#00C8FF]/10 transition-colors"
          >
            CHANGE PASSWORD
          </Link>
          <Link
            href="/admin/settings/sign-ins"
            className="inline-block border border-[#00C8FF] text-[#00C8FF] font-bold tracking-widest text-sm px-5 py-2.5 rounded-lg hover:bg-[#00C8FF]/10 transition-colors"
          >
            SIGN-IN HISTORY
          </Link>
        </div>
      </section>
`],
];
function settingsProblems(src: string): string[] {
  const html = renderToStaticMarkup(React.createElement(load(SETTINGS, src).default));
  const problems: string[] = [];
  const link = html.indexOf('<a href="/admin/settings/sign-ins"');
  const account = html.indexOf('>YOUR ACCOUNT<');
  const change = html.indexOf('>CHANGE PASSWORD</a>');
  if (link < 0 || !html.includes('>SIGN-IN HISTORY</a>')) problems.push('no SIGN-IN HISTORY link to /admin/settings/sign-ins in the first render');
  if (!(account >= 0 && change > account && link > change && link < html.indexOf('Loading…'))) problems.push('not in YOUR ACCOUNT after CHANGE PASSWORD, ahead of the profile\'s "Loading…"');
  return problems;
}
function settingsBaseProblems(src: string): string[] {
  try {
    const want = SETTINGS_LINK_EDIT.reduce((s, [a, b]) => once(s, a, b, 'the Settings edit'), base(SETTINGS));
    return want === src ? [] : ['Settings is not BASE plus the D1 edit'];
  } catch (e) { return [(e as Error).message]; }
}

function main(): void {
  const lib = load(LIB, now(LIB));
  const List = load(LIST, now(LIST)).default;

  console.log('\n── 1  Pacific times, the Pacific weekday, in every zone');
  const t = zoneProblems();
  check(t.length === 0, `${PINNED.length} pinned times (Wed 14 Oct 2026 among them) and every six hours of 2025-2028 against Intl's Los Angeles weekday, in ${ZONES.length} zones UTC-11 to UTC+14 (${t.slice(0, 3).join('; ') || 'all right'})`);

  console.log('\n── 2  the names');
  const n = nameProblems(lib);
  check(n.length === 0, `the history's six events named (1b's five, and N202's sign-out); failed and blocked sign-ins marked; an unknown type shown as sent (${n.join('; ') || 'all right'})`);

  console.log('\n── 3  the list');
  const l = listProblems(List, lib.fmtPacific);
  check(l.length === 0, `rows with name, device and Pacific time; failures amber; LOAD MORE only with more and not loading; the empty, error, loading and last-page states (${l.join('; ') || 'all right'})`);

  console.log('\n── 4  the page');
  const p = pageProblems(now(PAGE));
  check(p.length === 0, `GET /api/admin/me/sign-ins with the cursor encoded and followed; a 404 becomes a sentence; no address field (${p.join('; ') || 'all right'})`);

  console.log('\n── 5  Settings');
  const s = settingsProblems(now(SETTINGS));
  check(s.length === 0, `SIGN-IN HISTORY sits in YOUR ACCOUNT after CHANGE PASSWORD, in the first render, before the profile loads (${s.join('; ') || 'all right'})`);
  const sb = settingsBaseProblems(now(SETTINGS));
  check(sb.length === 0, `Settings is BASE's source (${BASE.slice(0, 7)}) with exactly that edit (${sb.join('; ') || 'equal'})`);

  console.log('\n── 6  mutation controls');
  const libSrc = now(LIB);
  const listSrc = now(LIST);
  const settings = now(SETTINGS);
  const WEEKDAY = '  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];';
  const mutants: Array<[string, () => string[]]> = [
    ['the weekday of the instant in UTC: Wednesday evening reads Thursday', () => zoneProblems(once(libSrc, WEEKDAY, '  const weekday = WEEKDAYS[new Date(iso).getUTCDay()];', 'w1'))],
    ["the weekday in the browser's zone: wrong east and west of Pacific", () => zoneProblems(once(libSrc, WEEKDAY, '  const weekday = WEEKDAYS[new Date(iso).getDay()];', 'w2')).filter((x) => !x.startsWith('America/Los_Angeles'))],
    ['a 12-hour clock: the pinned times fail', () => timeProblems(load(LIB, once(libSrc, "hourCycle: 'h23'", "hourCycle: 'h12'", 'h12')).fmtPacific)],
    ['a failed sign-in not marked: the list check fails', () => listProblems(load(LIST, once(listSrc, "isSignInFailure(e.type) ? 'text-amber-400' : 'text-white'", "'text-white'", 'amber')).default, lib.fmtPacific)],
    ['LOAD MORE while loading: the list check fails', () => listProblems(load(LIST, once(listSrc, '{!loading && hasMore && (', '{hasMore && (', 'more')).default, lib.fmtPacific)],
    ['a 404 shown raw: the page check fails', () => pageProblems(once(now(PAGE), 'if (res.status === 404) {', 'if (res.status === 4040) {', '404'))],
    ['the link for the primary admin only: the Settings check fails', () => settingsProblems(once(settings,
      '          <Link\n            href="/admin/settings/sign-ins"', '          {profile?.is_primary === true && <Link\n            href="/admin/settings/sign-ins"', 'p1').replace('            SIGN-IN HISTORY\n          </Link>\n', '            SIGN-IN HISTORY\n          </Link>}\n'))],
    ['one more line changed in Settings: the back-to-base check fails', () => settingsBaseProblems(once(settings, 'Only the primary admin can change the logo.', 'Only the primary admin may change the logo.', 'm'))],
  ];
  let caught = 0;
  for (const [what, run] of mutants) {
    const problems = run();
    if (problems.length) caught += 1;
    check(problems.length > 0, `control — ${what} (${problems.length}: ${(problems[0] || 'NOT caught').slice(0, 100)})`);
  }
  check(caught === mutants.length, `${caught} of ${mutants.length} mutants caught`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
