#!/usr/bin/env ts-node
/**
 * Prove Phase C on the web (Vishnu's decisions 1a and 2a, 2026-10-13): Settings
 * gives every admin a way to change their own password, through the page a
 * temporary password already uses, and nothing else changes.
 *
 * Both pages are rendered with react-dom/server, as they are now and as they
 * were at BASE (main before Phase C, read from git), with next/navigation and
 * next/link stubbed so the query string can be set.
 *
 * 1. /admin/change-password, the temporary-password way in, is the page of
 *    before: without ?from=settings, and with every near miss of it, the
 *    markup is BASE's byte for byte.
 * 2. With ?from=settings it reads as a change the admin chose, and has a
 *    Cancel whose target is fixed (/admin/settings), never taken from the URL.
 *    Its form is BASE's form: the voluntary text swapped back and Cancel taken
 *    out leave BASE's markup, and handleSubmit (the POST, the length rule, the
 *    cookies cleared, the sign-in again of decision 2a) is BASE's to the byte.
 * 3. /admin/settings shows YOUR ACCOUNT → CHANGE PASSWORD to every admin:
 *    the section sits outside every condition (the profile's load, its error,
 *    is_primary), so it renders before the profile has loaded.
 * 4. Each source, with the Phase C lines taken back out, is BASE's exactly:
 *    nothing else in either page moved.
 * 5. Mutation controls: each check above can fail.
 *
 * Run: npm run check:change-password (from apps/web). Needs git.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import Module from 'module';
import * as path from 'path';
import ts from 'typescript';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { undoN203Stage2 } from './n203Stage2Edits';

/** main before Phase C (PR #118's merge). */
const BASE = '814a0dbb0e13318f538396eff332b9d1a21bf60f';
const WEB = path.join(__dirname, '..');
const CHANGE = 'app/admin/change-password/page.tsx';
const SETTINGS = 'app/admin/settings/page.tsx';

let passes = 0;
let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}

// ── next/navigation and next/link, stubbed so a page renders outside Next ─────
let params = new URLSearchParams();
function stub(request: string, exports: unknown): void {
  const resolved = require.resolve(request, { paths: [WEB] });
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}
stub('next/navigation', { useSearchParams: () => params, usePathname: () => '/admin', useRouter: () => ({ push() {}, replace() {} }) });
stub('next/link', {
  __esModule: true,
  default: ({ href, className, children }: { href: string; className?: string; children?: React.ReactNode }) =>
    React.createElement('a', { href, className }, children),
});

/** The page as it was before N203 stage 2 (scripts/n203Stage2Edits.ts, proven exact by check-session-cookie), so this check still compares only its own change. */
const now = (rel: string) => undoN203Stage2(rel, fs.readFileSync(path.join(WEB, rel), 'utf8'));
const base = (rel: string) => execFileSync('git', ['show', `${BASE}:apps/web/${rel}`], { encoding: 'utf8' });
/** The page component from `src`, compiled under the page's own path so its imports resolve as they do in the app. */
function page(src: string, rel: string): React.ComponentType {
  const file = path.join(WEB, rel);
  const js = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  return (m.exports as { default: React.ComponentType }).default;
}
const render = (P: React.ComponentType, query = '') => { params = new URLSearchParams(query); return renderToStaticMarkup(React.createElement(P)); };
function once(s: string, find: string, replace: string, what: string): string {
  const n = s.split(find).length - 1;
  if (n !== 1) throw new Error(`${what}: found ${n} times`);
  return s.replace(find, () => replace);
}
const VOLUNTARY = { eyebrow: 'YOUR ACCOUNT', title: 'Change your password', currentLabel: 'CURRENT PASSWORD', submit: 'CHANGE PASSWORD' };
const TEMPORARY = { eyebrow: 'SET PASSWORD', title: 'Choose a new password', currentLabel: 'CURRENT / TEMPORARY PASSWORD', submit: 'SET PASSWORD &amp; CONTINUE' };
const NEAR_MISSES = ['from=SETTINGS', 'from=Settings', 'from=%20settings', 'from=settings%20', 'from=settings/', 'from=/admin/settings',
  'from=https://evil.example', 'from=', 'from=x&from=settings', 'back=settings', 'From=settings'];
const CANCEL = /<a href="([^"]*)"[^>]*>CANCEL<\/a>/g;

// ── the checks, each a function of the page's source, so a mutant runs through the same one ───
const changeBase = render(page(base(CHANGE), CHANGE));
const settingsBase = render(page(base(SETTINGS), SETTINGS));

/** 1: the temporary-password way in, and every near miss, render BASE's page. */
function temporaryUnchanged(src: string): string[] {
  const P = page(src, CHANGE);
  return ['', ...NEAR_MISSES].filter((qs) => render(P, qs) !== changeBase).map((qs) => qs || '(no query)');
}
/** 2: ?from=settings reads as a voluntary change, Cancel goes to Settings whatever else the URL says, and the form is BASE's. */
function voluntaryRight(src: string): string[] {
  const P = page(src, CHANGE);
  const problems: string[] = [];
  for (const qs of ['from=settings', 'from=settings&back=https://evil.example', 'back=/admin/guards&from=settings&next=//evil.example']) {
    const html = render(P, qs);
    // Array.from, not a spread: the app's tsconfig (ES5, no downlevelIteration) compiles scripts/ too.
    const cancels = Array.from(html.matchAll(CANCEL), (m) => m[1]);
    if (!Object.values(VOLUNTARY).every((t) => html.includes(`>${t}<`))) problems.push(`${qs}: voluntary text missing`);
    if (/TEMPORARY|SET PASSWORD/.test(html)) problems.push(`${qs}: temporary-password text shown`);
    if (cancels.length !== 1 || cancels[0] !== '/admin/settings') problems.push(`${qs}: Cancel ${JSON.stringify(cancels)}`);
    let back = html.replace(CANCEL, '');
    for (const k of Object.keys(VOLUNTARY) as Array<keyof typeof VOLUNTARY>) back = back.replace(`>${VOLUNTARY[k]}<`, `>${TEMPORARY[k]}<`);
    back = back.replace(/Enter your current password, then choose a new one of at least 8 characters\. Changing it signs you out everywhere, this browser included; sign in again with the new password\./,
      'Enter your current (or temporary) password, then choose a new password of at least 8 characters.');
    if (back !== changeBase) problems.push(`${qs}: with the voluntary text swapped back and Cancel out, not BASE's markup`);
  }
  return problems;
}
const HANDLER = /\n {2}async function handleSubmit\(e: FormEvent\) \{[\s\S]*?\n {2}\}\n/;
/** 2b: the submit handler is BASE's to the byte. */
const handlerSame = (src: string) => (src.match(HANDLER)?.[0] ?? 'missing') === (base(CHANGE).match(HANDLER)?.[0] ?? 'base missing');

/** 3: YOUR ACCOUNT renders before the profile loads, and sits under no condition. */
function accountForEveryone(src: string): string[] {
  const problems: string[] = [];
  const html = render(page(src, SETTINGS));
  const at = html.indexOf('>YOUR ACCOUNT<');
  const link = html.match(/<a href="([^"]*)"[^>]*>CHANGE PASSWORD<\/a>/);
  if (at < 0 || !link || link[1] !== '/admin/change-password?from=settings') problems.push(`not in the first render (link ${JSON.stringify(link?.[1])})`);
  if (!(at >= 0 && at < html.indexOf('Loading…'))) problems.push('not ahead of the profile\'s "Loading…"');
  // The source tree: walk up from the YOUR ACCOUNT text to the component's return; no condition on the way.
  const sf = ts.createSourceFile('page.tsx', src, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
  let text: ts.Node | undefined;
  const find = (n: ts.Node): void => { if (!text && ts.isJsxText(n) && n.text.trim() === 'YOUR ACCOUNT') text = n; else ts.forEachChild(n, find); };
  find(sf);
  if (!text) problems.push('no YOUR ACCOUNT in the source');
  for (let n = text?.parent; n && !ts.isReturnStatement(n); n = n.parent) {
    if (ts.isConditionalExpression(n) || (ts.isBinaryExpression(n) && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(n.operatorToken.kind))) {
      problems.push(`under a condition: ${n.getText().slice(0, 60).replace(/\s+/g, ' ')}…`);
    }
  }
  return problems;
}

/** 4: the source with the Phase C lines taken back out. */
function changeBackToBase(src: string): string {
  let s = src;
  s = once(s, "import Link from 'next/link';\nimport { useSearchParams } from 'next/navigation';\n", '', 'the two imports');
  const start = s.indexOf('\n/**\n * /admin/change-password — one page, two ways in:');
  const end = s.indexOf('} as const;\n', start);
  if (start < 0 || end < 0) throw new Error('the COPY block');
  s = s.slice(0, start) + s.slice(end + '} as const;\n'.length);
  s = once(s, "  const fromSettings = useSearchParams()?.get('from') === 'settings';\n  const copy = fromSettings ? COPY.settings : COPY.temporary;\n", '', 'the two component lines');
  s = once(s, '>{copy.eyebrow}<', '>SET PASSWORD<', 'eyebrow');
  s = once(s, '>{copy.title}<', '>Choose a new password<', 'title');
  s = once(s, '            {copy.intro}\n', '            Enter your current (or temporary) password, then choose a new password of at least 8 characters.\n', 'intro');
  s = once(s, '>{copy.currentLabel}<', '>CURRENT / TEMPORARY PASSWORD<', 'label');
  s = once(s, "{loading ? 'SAVING…' : copy.submit}", "{loading ? 'SAVING…' : 'SET PASSWORD & CONTINUE'}", 'submit');
  const c0 = s.indexOf('          {fromSettings && (\n');
  const c1 = s.indexOf('          )}\n', c0);
  if (c0 < 0 || c1 < 0) throw new Error('the Cancel block');
  return s.slice(0, c0) + s.slice(c1 + '          )}\n'.length);
}
function settingsBackToBase(src: string): string {
  let s = once(src, "import Link from 'next/link';\n", '', 'the Link import');
  const doc = (x: string) => x.slice(x.indexOf('/**'), x.indexOf('*/') + 2);
  s = once(s, doc(s), doc(base(SETTINGS)), 'the header comment');
  const a = s.indexOf('      {/* ── Your account');
  const b = s.indexOf('      </section>\n\n', a);
  if (a < 0 || b < 0) throw new Error('the YOUR ACCOUNT section');
  return s.slice(0, a) + s.slice(b + '      </section>\n\n'.length);
}
const backToBase = (fn: (s: string) => string, src: string, rel: string) => { try { return fn(src) === base(rel); } catch (e) { return false; } };

function main(): void {
  const change = now(CHANGE);
  const settings = now(SETTINGS);

  console.log(`\n── 1  /admin/change-password, the temporary-password way in: BASE's page (${BASE.slice(0, 7)})`);
  const t = temporaryUnchanged(change);
  check(t.length === 0, `1a no query and ${NEAR_MISSES.length} near misses of from=settings (case, spaces, a path, a URL, a second value, another key) render BASE's markup byte for byte (${t.join(', ') || 'all equal'})`);

  console.log('\n── 2  /admin/change-password?from=settings: a change the admin chose');
  const v = voluntaryRight(change);
  check(v.length === 0, `2a YOUR ACCOUNT, "Change your password", CURRENT PASSWORD, CHANGE PASSWORD; no temporary-password text; one Cancel to /admin/settings even with back= and next= in the URL; and swapped back, BASE's markup (${v.join('; ') || 'all right'})`);
  check(handlerSame(change), '2b handleSubmit is BASE\'s to the byte: the same POST /api/auth/admin/change-password, the same 8-128 rule, the cookies cleared and /admin/login?notice=password-changed after (decision 2a)');

  console.log('\n── 3  /admin/settings: YOUR ACCOUNT for every admin');
  const a = accountForEveryone(settings);
  check(a.length === 0, `3a the section and its link to /admin/change-password?from=settings render before the profile loads, and the source puts them under no condition (not loading, error or is_primary) (${a.join('; ') || 'all right'})`);
  check(!render(page(base(SETTINGS), SETTINGS)).includes('YOUR ACCOUNT') && settingsBase.includes('Loading…'), '3b control: BASE\'s Settings has no YOUR ACCOUNT, and renders "Loading…" first');

  console.log('\n── 4  nothing else moved');
  check(backToBase(changeBackToBase, change, CHANGE), '4a the change-password page with the Phase C lines taken out is BASE\'s source exactly');
  check(backToBase(settingsBackToBase, settings, SETTINGS), '4b the Settings page with the Phase C lines taken out is BASE\'s source exactly');

  console.log('\n── 5  mutation controls');
  // Each mutant's edit must apply exactly once (once() throws otherwise), so a control that stopped
  // applying fails loudly instead of passing for the wrong reason.
  // The section's end is found, not matched by its last lines: Phase D (D1) put a second link beside CHANGE PASSWORD.
  const accountUnder = (cond: string) => (s: string) => {
    const t = once(s, '      {/* ── Your account', `      {${cond} && (<>{/* ── Your account`, 'section start');
    const end = t.indexOf('      </section>\n', t.indexOf('{/* ── Your account'));
    if (end < 0) throw new Error('section end: not found');
    return t.slice(0, end) + '      </section></>)}\n' + t.slice(end + '      </section>\n'.length);
  };
  const mutants: Array<[string, () => boolean]> = [
    ['the voluntary wording on any case of "settings"', () => temporaryUnchanged(once(change, "useSearchParams()?.get('from') === 'settings'", "useSearchParams()?.get('from')?.toLowerCase() === 'settings'", 'm1')).length > 0],
    ['Cancel sent where the URL says', () => voluntaryRight(once(change, '              href="/admin/settings"\n', "              href={useSearchParams()?.get('back') ?? '/admin/settings'}\n", 'm2')).length > 0],
    ['the temporary-password wording changed by one word', () => temporaryUnchanged(once(change, "eyebrow: 'SET PASSWORD',", "eyebrow: 'SET A PASSWORD',", 'm3')).length > 0],
    ['the redirect after a change sent to Settings', () => !handlerSame(once(change, "window.location.href = '/admin/login?notice=password-changed';", "window.location.href = '/admin/settings';", 'm4'))],
    ['YOUR ACCOUNT moved under the profile\'s condition', () => accountForEveryone(accountUnder('profile')(settings)).length > 0],
    ['YOUR ACCOUNT for the primary admin only', () => accountForEveryone(accountUnder('profile?.is_primary === true')(settings)).length > 0],
    ['one more line changed elsewhere in Settings', () => !backToBase(settingsBackToBase, once(settings, 'Only the primary admin can change the logo.', 'Only the primary admin may change the logo.', 'm7'), SETTINGS)],
    ['one more line changed elsewhere in the change-password page', () => !backToBase(changeBackToBase, once(change, "setError('New passwords do not match')", "setError('The new passwords do not match')", 'm8'), CHANGE)],
  ];
  let caught = 0;
  for (const [label, run] of mutants) {
    const told = run();
    if (told) caught += 1;
    check(told, `5 control — ${label}: caught`);
  }
  check(caught === mutants.length, `5 ${caught} of ${mutants.length} mutants caught`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
