#!/usr/bin/env ts-node
/**
 * Prove N198: the web fonts are self-hosted with next/font/local, and they are
 * the fonts next/font/google served, face for face.
 *
 * app/fonts/reference.json is the truth. It lists every @font-face next/font/google
 * generated for app/layout.tsx in a production build of main at fe57a5c: each
 * face's CSS variable, weight, style, display and unicode-range, which file it
 * named (committed under app/fonts, with its sha256), and whether it was
 * preloaded. It also lists the three metric-matched Arial fallbacks.
 *
 *   1. Nothing in apps/web imports next/font/google any more.
 *   2. Every localFont call in app/fonts/index.ts, expanded into its faces, is
 *      exactly the reference set, and every file's bytes hash to the reference.
 *   3. Each CSS variable lists its subset families latin first, the reverse of
 *      Google's declaration order (the last face declared wins a shared character).
 *      It ends with that font's fallback.
 *   4. globals.css declares each fallback with next/font/google's overrides.
 *   5. layout.tsx puts the variables on <html> and --font-inter on <body>, as
 *      the variable classes and inter.className did.
 *   6. Each font ships with its OFL.txt.
 *   7. Mutation controls: each check above can fail.
 *
 * Built once, by hand, at the switch: a production build of the branch matched
 * main's build face for face (files by hash, fallbacks, preloads). Built with
 * outbound network blocked, the branch compiled and main's code failed fetching
 * fonts.googleapis.com (docs/OPS/OPEN-ITEMS.md, N198).
 *
 * Run: npm run check:fonts (from apps/web). No network, no build.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';

const WEB = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), 'utf8');

let passes = 0;
let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}

interface RefFace { variable: string; subset: string; weight: string; style: string; display: string; unicodeRange: string; file: string; sha256: string; preload: boolean }
interface RefFallback { family: string; src: string; ascentOverride: string; descentOverride: string; lineGapOverride: string; sizeAdjust: string }
const REF = JSON.parse(read('app/fonts/reference.json')) as { faces: RefFace[]; fallbacks: RefFallback[] };
const key = (f: { variable: string; weight: string; style: string; display: string; unicodeRange: string; file: string; preload: boolean }) =>
  [f.variable, f.weight, f.style, f.display, f.unicodeRange, f.file, String(f.preload)].join(' | ');

// ── app/fonts/index.ts, read as a syntax tree ───────────────────────────────
interface Call { name: string; src: Array<{ path: string; weight: string; style: string }>; display: string; preload: boolean; adjustFontFallback: unknown; unicodeRange: string | null }
function literal(n: ts.Expression): unknown {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (n.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(n)) return n.elements.map((e) => literal(e));
  if (ts.isObjectLiteralExpression(n)) {
    const o: Record<string, unknown> = {};
    n.properties.forEach((p) => { if (ts.isPropertyAssignment(p)) o[p.name.getText()] = literal(p.initializer); });
    return o;
  }
  return `<${ts.SyntaxKind[n.kind]}>`;
}
function readFonts(src: string): { calls: Call[]; stacks: Record<string, { fallback: string; families: string[] }> } {
  const sf = ts.createSourceFile('index.ts', src, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TS);
  const calls: Call[] = [];
  const stacks: Record<string, { fallback: string; families: string[] }> = {};
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer) && n.initializer.expression.getText() === 'localFont') {
      const o = literal(n.initializer.arguments[0]) as Record<string, any>;
      const decl = (o.declarations ?? []) as Array<{ prop: string; value: string }>;
      calls.push({ name: n.name.getText(), src: o.src, display: o.display, preload: o.preload, adjustFontFallback: o.adjustFontFallback,
        unicodeRange: (decl.filter((d) => d.prop === 'unicode-range')[0] ?? { value: null }).value });
    }
    if (ts.isPropertyAssignment(n) && ts.isCallExpression(n.initializer) && n.initializer.expression.getText() === 'stack') {
      const args = n.initializer.arguments;
      stacks[(literal(n.name as unknown as ts.Expression) as string) || n.name.getText().replace(/'/g, '')] =
        { fallback: literal(args[0]) as string, families: args.slice(1).map((a) => a.getText()) };
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { calls, stacks };
}

// ── the checks, each a function of the sources it reads, so a mutant goes through the same one ──
function facesProblems(fontsSrc: string, hashOf: (file: string) => string): string[] {
  const { calls, stacks } = readFonts(fontsSrc);
  const varOf: Record<string, string> = {};
  Object.keys(stacks).forEach((v) => stacks[v].families.forEach((f) => { varOf[f] = v; }));
  const got: string[] = [];
  const problems: string[] = [];
  calls.forEach((c) => {
    if (c.adjustFontFallback !== false) problems.push(`${c.name}: adjustFontFallback is not false (the fallback is globals.css's)`);
    if (!varOf[c.name]) problems.push(`${c.name}: in no CSS variable`);
    (c.src ?? []).forEach((s) => got.push(key({ variable: varOf[c.name], weight: s.weight, style: s.style, display: c.display,
      unicodeRange: c.unicodeRange ?? '', file: s.path.replace(/^\.\//, 'fonts/'), preload: c.preload })));
  });
  const want = REF.faces.map((f) => key(f));
  const missing = want.filter((k) => got.indexOf(k) < 0);
  const extra = got.filter((k) => want.indexOf(k) < 0);
  if (missing.length || extra.length || got.length !== want.length) problems.push(`faces: ${got.length} declared, ${want.length} in the reference; missing ${missing.slice(0, 2).join(' / ')}; extra ${extra.slice(0, 2).join(' / ')}`);
  REF.faces.forEach((f) => { if (hashOf(f.file) !== f.sha256) problems.push(`${f.file}: bytes differ from the reference`); });
  return problems;
}
function orderProblems(fontsSrc: string): string[] {
  const { calls, stacks } = readFonts(fontsSrc);
  const subsetOf: Record<string, string> = {};
  calls.forEach((c) => { const f = REF.faces.filter((r) => 'fonts/' + (c.src[0]?.path ?? '').replace(/^\.\//, '') === r.file)[0]; if (f) subsetOf[c.name] = f.subset; });
  const problems: string[] = [];
  const fallbackFor: Record<string, string> = { '--font-inter': 'netraops-inter-fallback', '--font-display': 'netraops-barlow-condensed-fallback', '--font-dm-sans': 'netraops-dm-sans-fallback' };
  Object.keys(fallbackFor).forEach((v) => {
    const googleOrder: string[] = [];
    REF.faces.filter((f) => f.variable === v).forEach((f) => { if (googleOrder.indexOf(f.subset) < 0) googleOrder.push(f.subset); });
    const want = googleOrder.slice().reverse();
    const got = (stacks[v]?.families ?? []).map((n) => subsetOf[n]);
    if (got.join(',') !== want.join(',')) problems.push(`${v}: subsets ${got.join(',')}, want ${want.join(',')}`);
    if (stacks[v]?.fallback !== fallbackFor[v]) problems.push(`${v}: fallback ${stacks[v]?.fallback}`);
  });
  return problems;
}
function fallbackProblems(css: string): string[] {
  const faces: Record<string, Record<string, string>> = {};
  // Typed, not `?? []`: under the app's tsconfig (strictNullChecks without noImplicitAny) a bare `[]`
  // is never[], and next build's type check then reads every block as never.
  const blocks: string[] = css.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  blocks.forEach((b) => {
    const props: Record<string, string> = {};
    b.replace(/^@font-face\s*\{|\}$/g, '').split(';').forEach((d) => { const i = d.indexOf(':'); if (i > 0) props[d.slice(0, i).trim()] = d.slice(i + 1).trim(); });
    if (props['font-family']) faces[props['font-family'].replace(/['"]/g, '')] = props;
  });
  const problems: string[] = [];
  REF.fallbacks.forEach((f) => {
    const g = faces[f.family];
    if (!g) { problems.push(`${f.family}: missing`); return; }
    const pairs: Array<[string, string]> = [['src', f.src], ['ascent-override', f.ascentOverride], ['descent-override', f.descentOverride], ['line-gap-override', f.lineGapOverride], ['size-adjust', f.sizeAdjust]];
    pairs.forEach(([k, v]) => { if (g[k] !== v) problems.push(`${f.family} ${k}: ${g[k]}, want ${v}`); });
  });
  return problems;
}
function layoutProblems(src: string): string[] {
  const problems: string[] = [];
  if (!/import \{ FONT_VARIABLES \} from '\.\/fonts';/.test(src)) problems.push('FONT_VARIABLES not imported');
  if (!/<html lang="en" style=\{\{ \.\.\.FONT_VARIABLES, scrollBehavior: 'smooth' \} as CSSProperties\}>/.test(src)) problems.push('<html> does not carry the variables');
  if (!/<body style=\{\{ fontFamily: 'var\(--font-inter\)', fontStyle: 'normal' \}\}>/.test(src)) problems.push('<body> does not use --font-inter');
  return problems;
}
const fileHash = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(path.join(WEB, 'app', file))).digest('hex');

function main(): void {
  const fonts = read('app/fonts/index.ts');
  const css = read('app/globals.css');
  const layout = read('app/layout.tsx');

  console.log('\n── 1  no next/font/google');
  const importers = (['app', 'components', 'lib'] as const).reduce<string[]>((acc, dir) => {
    const walk = (d: string): void => fs.readdirSync(path.join(WEB, d)).forEach((n) => {
      const rel = path.join(d, n);
      if (fs.statSync(path.join(WEB, rel)).isDirectory()) walk(rel);
      else if (/\.(ts|tsx|js|jsx)$/.test(n) && /from ['"]next\/font\/google['"]/.test(read(rel))) acc.push(rel);
    });
    walk(dir);
    return acc;
  }, []);
  check(importers.length === 0, `1a no file in app/, components/ or lib/ imports next/font/google (${importers.join(', ') || 'none'})`);

  console.log('\n── 2  the faces are next/font/google\'s, face for face');
  const fp = facesProblems(fonts, fileHash);
  check(fp.length === 0, `2a ${REF.faces.length} faces in 12 next/font/local calls: the same variable, weight, style, display, unicode-range, file and preload as the reference; ${new Set(REF.faces.map((f) => f.file)).size} files, each the reference's bytes (${fp.slice(0, 3).join('; ') || 'all equal'})`);

  console.log('\n── 3  the stacks');
  const op = orderProblems(fonts);
  check(op.length === 0, `3a each variable lists its subsets latin first, the reverse of Google's order, and ends with its fallback (${op.join('; ') || 'all right'})`);

  console.log('\n── 4  the fallbacks');
  const fb = fallbackProblems(css);
  check(fb.length === 0, `4a globals.css: the three Arial fallbacks with next/font/google's overrides (${fb.join('; ') || 'all equal'})`);

  console.log('\n── 5  the layout');
  const lp = layoutProblems(layout);
  check(lp.length === 0, `5a <html> carries the three variables and <body> uses --font-inter (${lp.join('; ') || 'all right'})`);

  console.log('\n── 6  licences');
  const missingOfl = ['inter', 'barlow-condensed', 'dm-sans'].filter((d) => {
    const p = path.join(WEB, 'app/fonts', d, 'OFL.txt');
    if (!fs.existsSync(p)) return true;
    const t = fs.readFileSync(p, 'utf8');
    return !/^Copyright \d{4} The .+ Project Authors/.test(t) || t.indexOf('SIL OPEN FONT LICENSE Version 1.1') < 0;
  });
  check(missingOfl.length === 0, `6a an OFL.txt beside each font, with its copyright line and the OFL 1.1 text (${missingOfl.join(', ') || 'all three'})`);

  console.log('\n── 7  mutation controls');
  const once = (s: string, a: string, b: string) => { if (s.split(a).length !== 2) throw new Error(`mutant target found ${s.split(a).length - 1} times: ${a.slice(0, 50)}`); return s.replace(a, b); };
  const latinRange = REF.faces.filter((f) => f.variable === '--font-inter' && f.subset === 'latin')[0].unicodeRange;
  const mutants: Array<[string, () => boolean]> = [
    ['one Inter weight changed', () => facesProblems(once(fonts, "{ path: './inter/latin.woff2', weight: '800', style: 'normal' }", "{ path: './inter/latin.woff2', weight: '850', style: 'normal' }"), fileHash).length > 0],
    ['Inter latin\'s unicode-range shortened', () => {
      const m = fonts.replace(/(const interLatin = localFont\(\{[\s\S]*?value: ')([^']*)(')/, (_all, a: string, range: string, b: string) => a + range.replace(',u+fffd', '') + b);
      if (m === fonts || latinRange.indexOf(',u+fffd') < 0) throw new Error('mutant did not apply: interLatin unicode-range');
      return facesProblems(m, fileHash).length > 0;
    }],
    ['a non-latin subset preloaded', () => {
      const m = fonts.replace(/(const interGreek = localFont\(\{[\s\S]*?)preload: false/, '$1preload: true');
      if (m === fonts) throw new Error('mutant did not apply: interGreek preload');
      return facesProblems(m, fileHash).length > 0;
    }],
    ['a font file one byte different', () => facesProblems(fonts, (f) => f === 'fonts/inter/latin.woff2' ? crypto.createHash('sha256').update(Buffer.concat([fs.readFileSync(path.join(WEB, 'app', f)), Buffer.from([0])])).digest('hex') : fileHash(f)).length > 0],
    ['the Inter stack in Google\'s order', () => orderProblems(once(fonts, 'interLatin, interLatinExt, interVietnamese, interGreek, interGreekExt, interCyrillic, interCyrillicExt', 'interCyrillicExt, interCyrillic, interGreekExt, interGreek, interVietnamese, interLatinExt, interLatin')).length > 0],
    ['a fallback\'s size-adjust changed', () => fallbackProblems(once(css, 'size-adjust: 107.06%', 'size-adjust: 107.6%')).length > 0],
    ['<body> on DM Sans', () => layoutProblems(once(layout, "fontFamily: 'var(--font-inter)'", "fontFamily: 'var(--font-dm-sans)'")).length > 0],
  ];
  let caught = 0;
  mutants.forEach(([label, run]) => { const told = run(); if (told) caught += 1; check(told, `7 control — ${label}: caught`); });
  check(caught === mutants.length, `7 ${caught} of ${mutants.length} mutants caught`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
