#!/usr/bin/env ts-node
/**
 * Prove B7: the checkpoint-scans CSV (admin/sites/[id], exportScansCsv) opens
 * with the company letterhead the API sends, and is otherwise the file it was.
 *
 * 1. THE PREAMBLE IS THE API'S, AND ONLY WHEN IT IS WELL FORMED.
 *    csvPreambleOf() takes GET /api/admin/company's csv_preamble only when
 *    every line is one quoted cell; anything else (no field, an API that
 *    predates it, a bare line) gives null, so a stale or odd API cannot write
 *    unquoted text into the file.
 *
 * 2. WITHOUT ONE, BYTE FOR BYTE THE FILE OF BEFORE. exportScansCsv is lifted
 *    out of the page as it is now and as it was at BASE (main before B7), and
 *    both run over the same rounds: when the profile cannot be fetched, has no
 *    csv_preamble, or a malformed one, the bytes and the filename are BASE's.
 *
 * 3. WITH ONE: the BOM, the preamble's lines, one blank line, then BASE's file,
 *    every line ending CRLF. Mutation controls show each comparison can fail.
 *
 * Run: npm run check:checkpoint-csv (from apps/web). Needs git.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { csvPreambleOf, withCsvPreamble } from '../lib/csvPreamble';

/** main before B7 (PR #117's merge). */
const BASE = '86cc2f0070968f6eeb945594f16f716bebed113a';
const PAGE = 'apps/web/app/admin/sites/[id]/page.tsx';

let passes = 0;
let failures = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
const show = (v: unknown) => JSON.stringify(v);

// ── the page's code, now and at BASE ─────────────────────────────────────────
const current = fs.readFileSync(path.join(__dirname, '..', 'app/admin/sites/[id]/page.tsx'), 'utf8');
const base = execFileSync('git', ['show', `${BASE}:${PAGE}`], { encoding: 'utf8' });
const lift = (src: string, re: RegExp, what: string): string => {
  const m = src.match(re);
  if (!m) throw new Error(`${what} not found`);
  return m[0];
};
const EXPORT = /\n {2}(?:async )?function exportScansCsv\(\) \{[\s\S]*?\n {2}\}\n/;
const CSV_FIELD = /\nfunction csvField\(v: unknown\): string \{[\s\S]*?\n\}\n/;
const SLUGIFY = /\nfunction slugify\(name: string\): string \{[\s\S]*?\n\}\n/;

interface Captured { text: string; filename: string; type: string }
interface World {
  site: { name: string; timezone: string } | null;
  visibleRounds: unknown[];
  scansTruncated: boolean;
  scanRangeError: string | null;
  scanFrom: string;
  scanTo: string;
  profile: () => Promise<unknown>;
}
/** exportScansCsv from `src` (or its mutant), runnable over a World; resolves to what it downloaded, or null. */
function exporter(src: string, edit?: (fn: string) => string) {
  const fnText = lift(src, EXPORT, 'exportScansCsv');
  const fn = edit ? edit(fnText) : fnText;
  if (edit && fn === fnText) throw new Error('the mutant edit changed nothing');
  const helpers = lift(src, CSV_FIELD, 'csvField') + lift(src, SLUGIFY, 'slugify');
  const js = ts.transpileModule(`${helpers}${fn}\nreturn exportScansCsv;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None },
  }).outputText;
  return async (w: World): Promise<{ download: Captured | null; profileCalls: string[] }> => {
    let download: Captured | null = null;
    const profileCalls: string[] = [];
    // The bytes, decoded by Buffer: Blob.text() would drop the BOM, which is part of what is compared.
    const triggerBlobDownload = async (blob: Blob, filename: string) => { download = { text: Buffer.from(await blob.arrayBuffer()).toString('utf8'), filename, type: blob.type }; };
    const pending: Promise<unknown>[] = [];
    const adminGet = (p: string) => { profileCalls.push(p); return w.profile(); };
    // eslint-disable-next-line no-new-func
    const make = new Function('site', 'visibleRounds', 'scansTruncated', 'scanRangeError', 'scanFrom', 'scanTo',
      'triggerBlobDownload', 'adminGet', 'csvPreambleOf', 'withCsvPreamble', js);
    const run = make(w.site, w.visibleRounds, w.scansTruncated, w.scanRangeError, w.scanFrom, w.scanTo,
      (b: Blob, f: string) => { pending.push(triggerBlobDownload(b, f)); }, adminGet, csvPreambleOf, withCsvPreamble);
    await run();
    await Promise.all(pending);
    return { download, profileCalls };
  };
}

// ── a site's rounds, with the awkward values ──────────────────────────────────
const rounds = [
  { label: 'Round 2 — 10:00', scans: [
    { checkpoint_label: 'North Gate', guard_name: 'Fixture Guard A', scanned_at: '2026-11-01T08:55:00Z', distance_m: 3.4 },
    { checkpoint_label: '=HYPERLINK("https://x.example","Open")', guard_name: '+Fixture "Guard" B', scanned_at: '2026-11-01T09:10:30Z', distance_m: 12.6 },
  ] },
  { label: 'Round 1 — 01:30, over the DST change', scans: [
    { checkpoint_label: 'Lobby, east door', guard_name: 'Gate 🚪 東京', scanned_at: '2026-11-01T08:30:00Z', distance_m: 0 },
    { checkpoint_label: '@SUM(A1)', guard_name: '-2+3', scanned_at: '2026-11-01T09:31:00Z', distance_m: 101.49 },
  ] },
];
const world = (profile: () => Promise<unknown>, over: Partial<World> = {}): World => ({
  site: { name: 'North Gate & Dock #2', timezone: 'America/Los_Angeles' }, visibleRounds: rounds, scansTruncated: false,
  scanRangeError: null, scanFrom: '2026-10-31', scanTo: '2026-11-01', profile, ...over,
});
const LINES = ['"Star Guard"', '"1200 Example Avenue, Suite 300, San Jose, CA 95110"', '"Tel (408) 555-0142  ·  dispatch@starguard.example"', '"License No. PPO 120456"', '"Powered by NetraOps"'];

async function main(): Promise<void> {
  console.log('\n── 1  csvPreambleOf / withCsvPreamble');
  check(show(csvPreambleOf({ csv_preamble: LINES })) === show(LINES), '1a five quoted lines are taken as they are');
  check(show(csvPreambleOf({ csv_preamble: ['"He said ""hi"""', '"two\nlines"', '""'] })) === show(['"He said ""hi"""', '"two\nlines"', '""']),
    '1b a doubled quote, a newline inside the quotes and an empty cell are each one quoted cell');
  const refused: Array<[string, unknown]> = [
    ['no field (an API from before B7)', { name: 'Star Guard' }], ['null', null], ['undefined', undefined], ['an empty list', { csv_preamble: [] }],
    ['not a list', { csv_preamble: '"Star Guard"' }], ['a number in the list', { csv_preamble: ['"Star Guard"', 7] }],
    ['a bare line', { csv_preamble: ['Star Guard'] }], ['a formula line', { csv_preamble: ['=HYPERLINK("x")'] }],
    ['an unescaped quote inside', { csv_preamble: ['"a"b"'] }], ['two cells on a line', { csv_preamble: ['"a","b"'] }],
    ['a trailing CR', { csv_preamble: ['"a"\r'] }],
  ];
  for (const [label, p] of refused) check(csvPreambleOf(p) === null, `1c refused, file as before: ${label}`);
  check(withCsvPreamble(null, 'a\r\nb\r\n') === 'a\r\nb\r\n' && withCsvPreamble(null, '') === '', '1d no preamble: the body comes back untouched');
  check(withCsvPreamble(['"X"', '"Powered by NetraOps"'], 'h\r\n') === '"X"\r\n"Powered by NetraOps"\r\n\r\nh\r\n', '1e with one: its lines, one blank line, then the body, CRLF throughout');

  console.log(`\n── 2  exportScansCsv against ${BASE.slice(0, 7)}: no letterhead, the same bytes`);
  check(lift(current, CSV_FIELD, 'csvField') === lift(base, CSV_FIELD, 'csvField') && lift(current, SLUGIFY, 'slugify') === lift(base, SLUGIFY, 'slugify'),
    '2a csvField and slugify are unchanged');
  check(/^\n {2}function exportScansCsv/.test(lift(base, EXPORT, 'x')) && /^\n {2}async function exportScansCsv/.test(lift(current, EXPORT, 'x')),
    '2b the base export is the synchronous one from before B7; the current one awaits the profile');
  const runBase = exporter(base);
  const runNow = exporter(current);
  const before = await runBase(world(async () => ({})));
  const bText = before.download?.text ?? '';
  check(bText.startsWith('﻿"Round","Checkpoint","Guard","Scanned At","Distance (m)"\r\n') && bText.split('\r\n').length === 6
    && before.download?.filename === 'checkpoint-scans_north-gate-dock-2_2026-10-31_to_2026-11-01.csv' && before.profileCalls.length === 0,
    `2c the base file: BOM, header, four scans oldest first, CRLF; no profile asked for (${before.download?.filename})`);
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['the profile cannot be fetched (401, network)', async () => { throw new Error('Request failed: 401'); }],
    ['an API from before B7 (no csv_preamble)', async () => ({ id: 'x', name: 'Star Guard', is_primary: true })],
    ['a malformed preamble (a bare line)', async () => ({ csv_preamble: ['Star Guard', '"Powered by NetraOps"'] })],
    ['an empty preamble', async () => ({ csv_preamble: [] })],
  ];
  for (const [label, profile] of cases) {
    const now = await runNow(world(profile));
    check(now.download !== null && now.download.text === bText && now.download.filename === before.download?.filename
      && now.download.type === before.download?.type && show(now.profileCalls) === '["/api/admin/company"]',
      `2d ${label}: byte for byte the base file (${now.download?.text.length ?? 0} chars), same name and type; the profile asked for once`);
  }
  {
    const quiet = await runNow(world(async () => ({ csv_preamble: LINES }), { visibleRounds: [] }));
    const capped = await runNow(world(async () => ({ csv_preamble: LINES }), { scansTruncated: true }));
    check(quiet.download === null && capped.download === null && quiet.profileCalls.length === 0 && capped.profileCalls.length === 0,
      '2e nothing on screen, or the view capped: no file and no profile request, as before');
  }

  console.log('\n── 3  with the letterhead');
  const lettered = await runNow(world(async () => ({ csv_preamble: LINES })));
  const want = `﻿${LINES.join('\r\n')}\r\n\r\n${bText.slice(1)}`;
  check(lettered.download?.text === want && lettered.download?.filename === before.download?.filename,
    `3a the BOM, the five preamble lines, one blank line, then the base file without its BOM (${lettered.download?.text.length} chars)`);
  {
    const lines = (lettered.download?.text ?? '').replace(/^﻿/, '').split('\r\n');
    check(lines[5] === '' && lines[6] === '"Round","Checkpoint","Guard","Scanned At","Distance (m)"' && lines.filter((l) => l === '').length === 2,
      '3b the header follows the one blank line; the only other empty string is after the last CRLF');
  }
  // Controls: each comparison above can fail.
  const mutants: Array<[string, (fn: string) => string, World]> = [
    ['the preamble used even when malformed', (fn) => fn.replace("preamble = csvPreambleOf(await adminGet<unknown>('/api/admin/company'));",
      "preamble = ((await adminGet<unknown>('/api/admin/company')) as any).csv_preamble ?? null;"), world(cases[2][1])],
    ['the BOM after the preamble', (fn) => fn.replace("const csv = '\\uFEFF' + withCsvPreamble(preamble, [header, ...rows].join('\\r\\n') + '\\r\\n');",
      "const csv = withCsvPreamble(preamble, '\\uFEFF' + [header, ...rows].join('\\r\\n') + '\\r\\n');"), world(async () => ({ csv_preamble: LINES }))],
    ['a failed fetch stopping the export', (fn) => fn.replace('    } catch {\n      // No letterhead: the export goes ahead without one.\n    }',
      '    } catch {\n      return;\n    }'), world(cases[0][1])],
  ];
  let caught = 0;
  for (const [label, edit, w] of mutants) {
    const m = await exporter(current, edit)(w);
    const ok = w === mutants[1][2] ? m.download?.text !== want : m.download?.text !== bText;
    if (ok) caught += 1;
    check(ok, `3c control — ${label}: told apart`);
  }
  check(caught === mutants.length, `3d ${caught} of ${mutants.length} mutants caught`);

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('CHECK ERROR', err); process.exit(1); });
