/**
 * test-letterhead-b6-b7.ts — the analytics workbook moves from SheetJS to exceljs and takes the
 * company letterhead (Phase B, B6); the checkpoint-scans CSV takes the letterhead preamble (B7).
 *
 *   TZ=UTC PGOPTIONS='-c TimeZone=UTC' PGHOST=127.0.0.1 PGPORT=55482 PGUSER=tester PGDATABASE=lh_test \
 *     npx ts-node -P tsconfig.scripts.json scripts/test-letterhead-b6-b7.ts     (from apps/api)
 *
 * Needs git and SheetJS (xlsx, still a dependency of this package): the "before" side of every
 * identity check is the route as it was at BASE (main before B6), read from git and compiled beside
 * the current one, writing with SheetJS exactly as production did. LOCAL DATABASES ONLY; fake data
 * on Star Guard's id and on a second, invented company. Sentry, email and S3 are stubbed.
 *
 * ── CELL FOR CELL ──────────────────────────────────────────────────────────
 * Vishnu's decision 1b (2026-10-13): the whole export moves to exceljs, and the workbook with no
 * letterhead must be cell-identical to main's SheetJS output: values, types, number formats and
 * column widths. Every workbook is read two ways, and both must agree cell for cell:
 *   - SheetJS's reader: each cell's type, value and number format; the sheet's column widths;
 *   - the XML as the spec defines it: each cell's kind, decoded value and number format (built-in
 *     id or custom code); the sheet names in order; each sheet's <cols>, <dimension> and
 *     <ignoredErrors> (SheetJS told Excel not to flag numbers stored as text).
 * exceljs's own reader is not one of them: it misreads SheetJS's files (see viewOf).
 *
 *   X  the writer against SheetJS's json_to_sheet: every value type, the awkward strings, empty
 *      sheets, keys first met in a later row, in UTC and in Pacific time; and mutation controls
 *   R  the route over HTTP against the BASE route: Vishnu's all-company export, which carries no
 *      letterhead, by five queries
 *   L  with a letterhead (decision 2a): every sheet opens with the company's block, the title,
 *      "Powered by NetraOps" and a blank row; the table below is the BASE route's, cell for cell,
 *      seven rows down; the logo once per sheet; the print header and footer; the tenant's own
 *      letterhead only; the null path; and mutation controls
 *   P  B7's API half (decision 3a): GET /api/admin/company carries csv_preamble, the very lines the
 *      analytics CSV opens with, for any admin of the company
 */
import Module from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import ts from 'typescript';
import { pngImage, pngCorruptAfterHeader } from './image-fixtures';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);
/** main before B6 (PR #117's merge). Every "before" is read from here. */
const BASE = '86cc2f0070968f6eeb945594f16f716bebed113a';
const STAR_GUARD = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const JWT_SECRET = 'test-only-letterhead-b6';
const VISHNU_SECRET = 'test-only-letterhead-b6-vishnu';
const S3_HOST = 'test-bucket.s3.us-east-1.amazonaws.com';
/** A well-formed company id that no row has: its letterhead lookup returns null. */
const NO_SUCH_COMPANY = '00000000-0000-4000-8000-00000000b6b6';
const LOGO = pngImage(400, 160);
const FULL = {
  companyName: 'Star Guard', contactEmail: 'dispatch@starguard.example', phone: '(408) 555-0142',
  address: '1200 Example Avenue, Suite 300\nSan Jose, CA 95110', licenceNumber: 'PPO 120456',
  website: 'https://www.starguard.example/', logo: LOGO,
};

process.env.JWT_SECRET = JWT_SECRET;
process.env.VISHNU_JWT_SECRET = VISHNU_SECRET;
process.env.S3_BUCKET = 'test-bucket';
process.env.AWS_REGION = 'us-east-1';

function refuseUnlessLocal(): void {
  const host = process.env.PGHOST;
  if (!host || !LOCAL_HOSTS.has(host)) { console.error(`REFUSING: PGHOST must be 127.0.0.1 or localhost (got ${host ?? 'unset'}).`); process.exit(2); }
  if (!(process.env.PGDATABASE ?? '').endsWith('test')) { console.error('REFUSING: PGDATABASE must end in "test".'); process.exit(2); }
  const url = process.env.DATABASE_URL;
  if (url) {
    let h = '';
    try { h = new URL(url).hostname; } catch { h = '(unparseable)'; }
    if (!LOCAL_HOSTS.has(h)) { console.error(`REFUSING: DATABASE_URL points at ${h}.`); process.exit(2); }
  }
  if (process.env.TZ !== 'UTC') { console.error('REFUSING: run with TZ=UTC, as production does.'); process.exit(2); }
}
function stubModule(name: string, overrides: Record<string, unknown> = {}): unknown {
  return new Proxy({ __esModule: true, ...overrides }, {
    get: (target, prop) => (prop in target ? (target as Record<string | symbol, unknown>)[prop]
      : () => { throw new Error(`${name}.${String(prop)} called in the B6/B7 letterhead test`); }),
  });
}
function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}

let failures = 0;
let passes = 0;

// A harness that stops before its last check must not pass: an await that never
// settles drains the event loop, and Node would then exit 0 having printed nothing.
let finished = false;
process.on('beforeExit', () => {
  if (!finished) {
    console.log('  ✗ FAIL: the harness stopped before its last check (a promise never settled)');
    process.exitCode = 1;
  }
});
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const show = (v: unknown) => JSON.stringify(v);

// ── the "before" side ──────────────────────────────────────────────────────
/**
 * `apps/api/<rel>` as it was at `ref` (null: the working tree), optionally run through `edit`,
 * compiled as a fresh module under the CURRENT file's path, so its relative imports resolve
 * exactly as the current file's do. Not put in require.cache.
 */
function loadAt(ref: string | null, rel: string, edit?: (src: string) => string): any {
  const file = path.join(__dirname, '..', rel);
  const src = ref === null ? fs.readFileSync(file, 'utf8')
    : execFileSync('git', ['show', `${ref}:apps/api/${rel}`], { encoding: 'utf8' });
  const edited = edit ? edit(src) : src;
  if (edit && edited === src) throw new Error(`loadAt(${ref ?? 'working tree'}, ${rel}): the edit changed nothing`);
  const js = ts.transpileModule(edited, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}

// ── reading a workbook two ways, and its XML ──────────────────────────────
/**
 * A cell as the spec defines it, read from the XML: its kind (shared, inline and str strings are all
 * text), its value (XML entities, then _xHHHH_ escapes, decoded in either case as SheetJS and the
 * spec allow) and its number format (built-in id, or the custom format's code). exceljs's own reader
 * is not used to compare: it decodes _xHHHH_ only in upper case and only in the shared strings, and
 * it decodes the entities of a str cell twice, so it misreads SheetJS's files.
 */
type SpecCell = [kind: string, value: unknown, format: string];
const unescapeXml = (t: string) => t
  .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[\da-fA-F]+);/g, (m, e: string) => (
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&'
      : String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))))
  .replace(/_x([\da-fA-F]{4})_/g, (m, h: string) => String.fromCharCode(parseInt(h, 16)));
const textOf = (xml: string) => [...xml.matchAll(/<t(?: [^>]*)?>([\s\S]*?)<\/t>|<t(?: [^>]*)?\/>/g)].map((m) => unescapeXml(m[1] ?? '')).join('');
/** "A1:A1" and "A1" are the same range. */
const range = (r: string | null) => (r && /^([A-Z]+\d+):\1$/.test(r) ? r.split(':')[0] : r);

interface SheetView {
  name: string;
  /** SheetJS's reader: address → [type, value, number format]. */
  sj: Record<string, [string, unknown, string]>;
  sjCols: unknown;
  /** The spec, read from the XML: address → [kind, value, number format]. */
  spec: Record<string, SpecCell>;
  /** <cols>: each <col>'s min, max and width, or null when the sheet has none. */
  cols: string[] | null;
  dimension: string | null;
  ignoredErrors: string | null;
}
async function viewOf(buf: Buffer): Promise<SheetView[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx');
  const JSZip = (await import('jszip')).default;
  const sj = XLSX.read(buf, { type: 'buffer', cellNF: true, cellStyles: true });
  const zip = await JSZip.loadAsync(buf);
  const read = async (part: string) => (zip.file(part) ? zip.file(part)!.async('string') : '');
  const sst = [...(await read('xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));
  const styles = await read('xl/styles.xml');
  const custom = new Map([...styles.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\/>/g)].map((m) => [m[1], unescapeXml(m[2])]));
  const xfs = [...(styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? '').matchAll(/<xf [^>]*?numFmtId="(\d+)"/g)].map((m) => m[1]);
  const format = (s: string | undefined) => { const id = xfs[Number(s ?? 0)] ?? '0'; return custom.has(id) ? `custom ${custom.get(id)}` : `built-in ${id}`; };
  // The sheet order and each sheet's XML part, from the workbook and its relationships.
  const wbXml = await read('xl/workbook.xml');
  const rels = await read('xl/_rels/workbook.xml.rels');
  const target = (rid: string) => [...rels.matchAll(/<Relationship [^>]*>/g)].map((m) => m[0])
    .find((r) => r.includes(`Id="${rid}"`))?.match(/Target="([^"]+)"/)?.[1];
  const sheets = [...wbXml.matchAll(/<sheet [^>]*>/g)].map((m) => ({
    name: unescapeXml(m[0].match(/name="([^"]*)"/)![1]),
    part: `xl/${String(target(m[0].match(/r:id="([^"]*)"/)![1])).replace(/^\/?xl\//, '')}`,
  }));
  const out: SheetView[] = [];
  for (const { name, part } of sheets) {
    const xml = await read(part);
    const s = sj.Sheets[name];
    const sjCells: SheetView['sj'] = {};
    for (const k of Object.keys(s ?? {})) if (k[0] !== '!') sjCells[k] = [s[k].t, s[k].v, s[k].z ?? 'General'];
    const spec: SheetView['spec'] = {};
    for (const m of xml.matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attr = (k: string) => m[1].match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`))?.[1];
      const body = m[2] ?? '';
      const v = body.match(/<v(?: [^>]*)?>([\s\S]*?)<\/v>/)?.[1];
      const t = attr('t') ?? 'n';
      let cell: SpecCell;
      if (t === 's') cell = ['text', sst[Number(v)], format(attr('s'))];
      else if (t === 'str') cell = ['text', unescapeXml(v ?? ''), format(attr('s'))];
      else if (t === 'inlineStr') cell = ['text', textOf(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? ''), format(attr('s'))];
      else if (t === 'b') cell = ['boolean', v === '1', format(attr('s'))];
      else if (t === 'n') { if (v === undefined) continue; cell = ['number', Number(v), format(attr('s'))]; }
      else cell = [t, v, format(attr('s'))];
      spec[attr('r')!] = cell;
    }
    const colsXml = xml.match(/<cols>([\s\S]*?)<\/cols>/)?.[1];
    out.push({
      name, sj: sjCells, sjCols: s?.['!cols'] ?? null, spec,
      cols: colsXml === undefined ? null : [...colsXml.matchAll(/<col [^>]*>/g)].map((c) => ['min', 'max', 'width'].map((k) => c[0].match(new RegExp(`${k}="([^"]*)"`))?.[1]).join(' ')),
      dimension: range(xml.match(/<dimension ref="([^"]+)"\/>/)?.[1] ?? null),
      ignoredErrors: (xml.match(/<ignoredErrors>(.*?)<\/ignoredErrors>/)?.[1] ?? null)?.replace(/sqref="([^"]+)"/, (m, r: string) => `sqref="${range(r)}"`) ?? null,
    });
  }
  return out;
}
/** Every difference between two workbooks' views, as readable lines; none means cell-identical. */
function differences(a: SheetView[], b: SheetView[]): string[] {
  const out: string[] = [];
  if (show(a.map((s) => s.name)) !== show(b.map((s) => s.name))) out.push(`sheets ${show(a.map((s) => s.name))} vs ${show(b.map((s) => s.name))}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i]; const y = b[i];
    const cells = (p: Record<string, unknown>, q: Record<string, unknown>, reader: string) => {
      for (const k of new Set([...Object.keys(p), ...Object.keys(q)])) {
        if (show(p[k]) !== show(q[k])) out.push(`${x.name}!${k} (${reader}) ${show(p[k])} vs ${show(q[k])}`);
      }
    };
    cells(x.sj, y.sj, 'SheetJS reader');
    cells(x.spec, y.spec, 'spec');
    if (show(x.sjCols) !== show(y.sjCols)) out.push(`${x.name} column widths (SheetJS reader) ${show(x.sjCols)} vs ${show(y.sjCols)}`);
    for (const k of ['cols', 'dimension', 'ignoredErrors'] as const) {
      if (show(x[k]) !== show(y[k])) out.push(`${x.name} ${k} ${show(x[k])} vs ${show(y[k])}`);
    }
  }
  return out;
}
const cellCount = (v: SheetView[]) => v.reduce((n, s) => n + Object.keys(s.sj).length, 0);
const brief = (d: string[]) => (d.length === 0 ? 'no differences' : `${d.length} differences: ${d.slice(0, 4).join('; ')}${d.length > 4 ? ' …' : ''}`);

/** A sheet's cells below row `rows`, moved up by `rows`: the table of a lettered sheet, where a plain one has it. */
function tableOf(v: SheetView, rows: number): SheetView {
  const move = <T>(cells: Record<string, T>) => {
    const out: Record<string, T> = {};
    for (const [k, c] of Object.entries(cells)) {
      const m = k.match(/^([A-Z]+)(\d+)$/)!;
      if (Number(m[2]) > rows) out[`${m[1]}${Number(m[2]) - rows}`] = c;
    }
    return out;
  };
  return { ...v, sj: move(v.sj), spec: move(v.spec), dimension: null, ignoredErrors: null };
}
/** The cells of rows 1..`rows`, as address → value (spec reader). */
function blockOf(v: SheetView, rows: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, c] of Object.entries(v.spec)) if (Number(k.match(/\d+$/)![0]) <= rows) out[k] = c[1];
  return out;
}

/** The analytics workbook as main wrote it: json_to_sheet over each query's neutralized rows. */
function sheetjsWorkbook(data: { hours: object[]; reports: object[]; violations: object[] }, neutralizeRow: (r: any) => any): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.hours.map(neutralizeRow)), 'Guard Hours');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.reports.map(neutralizeRow)), 'Reports');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data.violations.map(neutralizeRow)), 'Geofence Violations');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** Rows shaped like the three queries' rows, with every value type and the awkward strings. */
function sweepData(): { hours: object[]; reports: object[]; violations: object[] } {
  const awkward = ['', '  lead and trail  ', 'a\nb\r\nc', 'bell\u0007 vt\u000b nul\u0000 us\u001f end', '\rstarts with CR', '\tstarts with tab',
    '=HYPERLINK("https://x.example","Open")', '+1 (408) 555-0142', '-2+3', '@SUM(A1)', '-2.5', "'=already escaped", '_x0041_ literal',
    'Gate 🚪 東京 مرحبا', '<b>&amp; "quoted" \'apos\'</b>', 'x'.repeat(200), '8.00', '0012', 'TRUE', '1e5'];
  const hours = awkward.map((s, i) => ({
    site_name: i === 3 ? '[INACTIVE] North Gate' : `Site ${s}`, guard_name: s, badge_number: i % 2 ? `GRD98${String(i).padStart(2, '0')}` : null,
    shift_date: new Date(2026, 8, 1 + i), total_hours: i % 3 ? `${(i * 1.25).toFixed(2)}` : null, scheduled_hours: '8.00',
    actual_hours: `${(7 + i / 10).toFixed(2)}`, payable_hours: '7.50', break_hours: '0.50', violation_hours: '0.00',
    clocked_in_at: `0${(i % 9) + 1}/09/2026, 08:0${i % 10}:00`, clocked_out_at: i % 4 ? `0${(i % 9) + 1}/09/2026, 16:00:00` : null,
  }));
  const reports = awkward.map((s, i) => ({
    site_name: 'North Gate', guard_name: 'Fixture Guard A', report_type: ['activity', 'incident', 'maintenance'][i % 3],
    severity: i % 2 ? null : 'high', reported_at: `15/09/2026, 10:${String(i).padStart(2, '0')}:00`, description_preview: s,
  }));
  const violations = awkward.slice(0, 8).map((s, i) => ({
    site_name: s, guard_name: 'Fixture Guard B', occurred_at: `15/09/2026, 11:0${i}:00`, resolved_at: i % 2 ? null : `15/09/2026, 11:3${i}:00`,
    duration_minutes: i % 3 ? i * 7 : null, supervisor_override: i % 2 === 0, notification_sent: i % 3 === 0,
  }));
  return { hours, reports, violations };
}

async function main(): Promise<void> {
  refuseUnlessLocal();
  inject('../src/services/sentry', {
    Sentry: { captureMessage: () => 'evt', captureException: () => 'evt', addBreadcrumb: () => undefined },
    tagRequest: () => undefined,
  });
  inject('../src/services/email', stubModule('email'));
  class S3ObjectTooLargeError extends Error {}
  const s3Objects = new Map<string, Buffer>();
  inject('../src/services/s3', stubModule('s3', {
    S3ObjectTooLargeError,
    s3KeyFromPublicUrl: (url: string): string | null => {
      try { const u = new URL(url); return u.hostname === S3_HOST ? u.pathname.replace(/^\//, '') || null : null; } catch { return null; }
    },
    // GET /api/admin/company presigns the logo's URL; here it comes back as stored.
    urlOrPresign: async (url: string | null) => url,
    getS3ObjectBuffer: async (key: string) => {
      const b = s3Objects.get(key);
      if (!b) throw Object.assign(new Error('NoSuchKey'), { code: 'NoSuchKey', statusCode: 404 });
      return b;
    },
  }));
  const { neutralizeRow } = await import('../src/services/spreadsheetSafe');
  const AW = await import('../src/services/analyticsWorkbook');

  // ══════════════════════════════════════════════════════════════════════════
  section('X  the exceljs writer against SheetJS json_to_sheet, cell for cell');
  {
    const sweep = sweepData();
    const empty = { hours: [], reports: [], violations: [] };
    const late = { hours: [{ a: 'first' }, { a: 'second', b: 2 }, { c: true, a: null }], reports: [{ only: 'one' }], violations: [] };
    const cases: Array<[string, typeof sweep]> = [['every value type and the awkward strings', sweep], ['no rows at all', empty], ['keys first met in a later row', late]];
    for (const [label, data] of cases) {
      const before = await viewOf(sheetjsWorkbook(data, neutralizeRow));
      const after = await viewOf(await AW.analyticsWorkbook(data as never));
      const d = differences(before, after);
      check(d.length === 0, `X1 ${label}: ${cellCount(after)} cells on ${after.length} sheets, ${brief(d)}`);
    }
    {
      const v = await viewOf(await AW.analyticsWorkbook(sweep as never));
      const hours = v[0];
      check(show(hours.sj.D2) === show(['n', 46266, 'm/d/yy']) && show(hours.spec.D2) === show(['number', 46266, 'built-in 14']),
        `X2 a date is its day serial in built-in format 14 (SheetJS reader ${show(hours.sj.D2)}, spec ${show(hours.spec.D2)})`);
      const desc = v[1].sj.F5?.[1];
      check(desc === 'bell\u0007 vt\u000b nul\u0000 us\u001f end' && v[1].sj.F7?.[1] === "'\tstarts with tab" && v[1].sj.F6?.[1] === "'\rstarts with CR",
        `X3 control characters survive (${show(desc)}); a value starting with tab or CR keeps its apostrophe (N171)`);
      check(v.every((s) => s.cols === null && s.sjCols === null),
        'X4 no sheet carries a column width, as json_to_sheet wrote none');
      check(v.every((s) => s.ignoredErrors === `<ignoredError numberStoredAsText="1" sqref="${s.dimension}"/>`),
        `X5 every sheet tells Excel not to flag numbers stored as text over its used range (${v.map((s) => s.dimension).join(', ')})`);
      check(v[2].sj.F2?.[0] === 'b' && v[2].sj.E2 === undefined && v[2].sj.E3?.[0] === 'n' && v[0].sj.C2 === undefined && v[0].sj.E3?.[0] === 's',
        'X6 booleans are booleans, an integer is a number, null leaves no cell, NUMERIC text stays text');
    }
    // Pacific time: SheetJS fixes its 1899 epoch when it loads, so the zone must be the process's from the
    // start, as in production. A child process that starts in Pacific writes both workbooks.
    {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'lhb6-tz-'));
      const script = `
        process.env.TZ = 'America/Los_Angeles';
        const XLSX = require('xlsx');
        const { neutralizeRow } = require('./src/services/spreadsheetSafe');
        const AW = require('./src/services/analyticsWorkbook');
        const rows = [new Date(2026, 2, 8), new Date(2026, 2, 8, 2, 30), new Date(2026, 10, 1), new Date(2026, 10, 1, 1, 30), new Date(2026, 8, 15, 23, 30), new Date(1900, 1, 28)]
          .map((d, i) => ({ guard_name: 'G' + i, shift_date: d }));
        const wb = XLSX.utils.book_new();
        for (const name of ['Guard Hours', 'Reports', 'Geofence Violations']) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(name === 'Guard Hours' ? rows.map(neutralizeRow) : []), name);
        require('fs').writeFileSync(process.argv[1] + '/sheetjs.xlsx', XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
        // The control: the writer with a Date handed to exceljs, which converts it in UTC.
        const Module = require('module'); const path = require('path');
        const file = path.resolve('src/services/analyticsWorkbook.ts');
        const mutant = new Module(file, module); mutant.filename = file; mutant.paths = Module._nodeModulePaths(path.dirname(file));
        mutant._compile(require('fs').readFileSync(process.argv[1] + '/mutant.js', 'utf8'), file);
        Promise.all([AW.analyticsWorkbook({ hours: rows, reports: [], violations: [] }), mutant.exports.analyticsWorkbook({ hours: rows, reports: [], violations: [] })]).then(([b, m]) => {
          require('fs').writeFileSync(process.argv[1] + '/exceljs.xlsx', b);
          require('fs').writeFileSync(process.argv[1] + '/mutant.xlsx', m);
          console.log(String(new Date(2026, 0, 1).getTimezoneOffset()));
        });`;
      const mutantSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/analyticsWorkbook.ts'), 'utf8').replace('cell.value = excelSerial(v);', 'cell.value = v;');
      fs.writeFileSync(path.join(dir, 'mutant.js'), ts.transpileModule(mutantSrc, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
      }).outputText);
      const r = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', script, dir],
        { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: 'America/Los_Angeles' }, encoding: 'utf8' });
      const ok = r.status === 0 && r.stdout.trim() === '480';
      const a = ok ? await viewOf(fs.readFileSync(path.join(dir, 'sheetjs.xlsx'))) : [];
      const b = ok ? await viewOf(fs.readFileSync(path.join(dir, 'exceljs.xlsx'))) : [];
      const d = differences(a, b);
      check(ok && d.length === 0 && Object.keys(a[0]?.spec ?? {}).length === 14,
        `X7 a process in Pacific time (offset ${r.stdout.trim() || r.stderr.slice(0, 200)}): both DST changes, 02:30 on the spring-forward day, 23:30, and 1900-02-28; the two writers agree, ${brief(d)}`);
      const dm = ok ? differences(a, await viewOf(fs.readFileSync(path.join(dir, 'mutant.xlsx')))) : [];
      check(ok && dm.length > 0, `X7b control — in that process, a Date handed to exceljs (converted in UTC) is told apart: ${brief(dm)}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // Mutation controls: each mutant of the writer must be told apart from SheetJS by the comparison.
    const sweep2 = sweepData();
    const before = await viewOf(sheetjsWorkbook(sweep2, neutralizeRow));
    const mutants: Array<[string, (s: string) => string]> = [
      ['a date written in another format', (s) => s.replace("const DATE_FORMAT_14 = 'mm-dd-yy';", "const DATE_FORMAT_14 = 'dd/mm/yyyy';")],
      ['control characters not encoded', (s) => s.replace("if (typeof v === 'string') cell.value = encodeControlCharacters(v);", "if (typeof v === 'string') cell.value = v;")],
      ['null written as an empty string', (s) => s.replace('else if (v instanceof Date) {', "else if (v === null) cell.value = '';\n      else if (v instanceof Date) {")],
      ['no header row', (s) => s.replace('keys.forEach((k, c) => { ws.getCell(firstRow, c + 1).value = encodeControlCharacters(k); });', '')],
      ['N171 dropped', (s) => s.replace('Object.entries(neutralizeRow(row))', 'Object.entries(row)')],
      ['a column width set', (s) => s.replace('if (keys.length === 0) return;', 'if (keys.length === 0) return;\n  ws.getColumn(1).width = 20;')],
      ['<ignoredErrors> left out', (s) => s.replace('return ignoreNumberStoredAsText(Buffer.from(await wb.xlsx.writeBuffer()));', 'return Buffer.from(await wb.xlsx.writeBuffer());')],
      ['a boolean written as text', (s) => s.replace("else if (typeof v === 'number' || typeof v === 'boolean') cell.value = v;", "else if (typeof v === 'number') cell.value = v;\n      else if (typeof v === 'boolean') cell.value = String(v);")],
      ['the sheets in another order', (s) => s.replace("  ['Reports', 'reports'],\n  ['Geofence Violations', 'violations'],", "  ['Geofence Violations', 'violations'],\n  ['Reports', 'reports'],")],
    ];
    let caught = 0;
    for (const [label, edit] of mutants) {
      const mutant = loadAt(null, 'src/services/analyticsWorkbook.ts', edit);
      const d = differences(before, await viewOf(await mutant.analyticsWorkbook(sweep2)));
      if (d.length > 0) caught += 1;
      check(d.length > 0, `X8 control — ${label}: told apart (${brief(d)})`);
    }
    check(caught === mutants.length, `X9 ${caught} of ${mutants.length} mutants caught`);
  }

  // ══ the database: Star Guard and an invented second company, fake data, local only ══
  const jwt = (await import('jsonwebtoken')).default;
  const poolMod: any = await import('../src/db/pool');
  const pool = poolMod.pool;
  if (pool.options?.connectionString) { console.error('REFUSING: the app pool carries a connection string.'); process.exit(2); }
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  if ((await q('SHOW TimeZone')).rows[0].TimeZone !== 'UTC') { console.error('REFUSING: the session time zone is not UTC (set PGOPTIONS).'); process.exit(2); }
  await import('express-async-errors');
  const express = (await import('express')).default;
  const marker = `lhb6-${Date.now().toString(36)}`;
  const seeded: Record<string, string[]> = {
    geofence_violations: [], reports: [], shift_sessions: [], shifts: [], guards: [], sites: [], company_admins: [], companies: [],
  };
  const ins = async (table: string, sql: string, params: unknown[]) => {
    const id = (await q(sql, params)).rows[0].id as string;
    seeded[table].push(id);
    return id;
  };
  let swept = 0;
  for (const sql of [
    "DELETE FROM geofence_violations WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb6-%')",
    "DELETE FROM reports WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb6-%')",
    "DELETE FROM shift_sessions WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb6-%')",
    "DELETE FROM shifts WHERE site_id IN (SELECT id FROM sites WHERE name LIKE 'lhb6-%')",
    "DELETE FROM guards WHERE email LIKE 'lhb6-%'",
    "DELETE FROM sites WHERE name LIKE 'lhb6-%'",
    "DELETE FROM company_admins WHERE email LIKE 'lhb6-%'",
    "DELETE FROM companies WHERE name LIKE 'Fixture Patrol lhb6-%'",
  ]) swept += (await q(sql)).rowCount ?? 0;
  if (swept > 0) console.log(`(swept ${swept} rows an earlier run left behind)`);
  // Star Guard's row is created when this database has none, and its profile is put back either way.
  const PROFILE = ['contact_email', 'phone', 'address', 'licence_number', 'website', 'logo_url', 'logo_updated_at'];
  const priorStarGuard = (await q(`SELECT ${PROFILE.join(', ')} FROM companies WHERE id = $1`, [STAR_GUARD])).rows[0] ?? null;
  let server: Server | null = null;

  try {
    if (!priorStarGuard) await q(`INSERT INTO companies (id, name) VALUES ($1, 'Star Guard')`, [STAR_GUARD]);
    const OTHER_NAME = `Fixture Patrol ${marker}`;
    const other = await ins('companies', 'INSERT INTO companies (name) VALUES ($1) RETURNING id', [OTHER_NAME]);
    const mkAdmin = (companyId: string, tag: string) => ins('company_admins',
      `INSERT INTO company_admins (company_id, name, email, password_hash, is_primary) VALUES ($1, $2, $3, 'x', true) RETURNING id`,
      [companyId, `${marker} ${tag}`, `${marker}-${tag}@test.invalid`]);
    const adminA = await mkAdmin(STAR_GUARD, 'admin-a');
    const adminB = await mkAdmin(other, 'admin-b');
    const mkSite = (companyId: string, name: string, tz: string, active = true) => ins('sites',
      `INSERT INTO sites (company_id, name, address, contract_start, timezone, is_active) VALUES ($1, $2, '1 Example Way', '2026-01-01', $3, $4) RETURNING id`,
      [companyId, `${marker} ${name}`, tz, active]);
    const north = await mkSite(STAR_GUARD, 'North Gate', 'America/Los_Angeles');
    const east = await mkSite(STAR_GUARD, '=East "Lot" & Dock', 'America/New_York', false);
    const south = await mkSite(other, 'South Lot', 'America/Chicago');
    const mkGuard = (companyId: string, name: string, badge: string, tag: string) => ins('guards',
      `INSERT INTO guards (company_id, name, email, password_hash, badge_number) VALUES ($1, $2, $3, 'x', $4) RETURNING id`,
      [companyId, name, `${marker}-${tag}@test.invalid`, badge]);
    const gA = await mkGuard(STAR_GUARD, 'Fixture Guard A', 'GRD9801', 'ga');
    const gB = await mkGuard(STAR_GUARD, '+Fixture "Guard" B\u0007', '0042', 'gb');
    const gC = await mkGuard(other, 'Fixture Guard C', 'GRD9803', 'gc');
    // Closed sessions only: actual_hours of an open one is computed against NOW(), which moves between calls.
    const descs = ['Perimeter checked, gate secured.', '=HYPERLINK("https://x.example","Open")', 'line one\nline two\r\nline three',
      'bell\u0007 and a vertical tab\u000b', '', '@SUM(A1:A9)', 'Gate 🚪 東京 مرحبا', 'x'.repeat(260), '-2+3', '  spaced  '];
    let n = 0;
    for (const [site, guard] of [[north, gA], [north, gB], [east, gB], [south, gC]] as const) {
      for (let day = 0; day < 6; day++) {
        // 18:30 site-local and later: in UTC that is often the next day, which shift_date must not follow.
        const startUtc = new Date(Date.parse(`2026-09-${String(10 + day).padStart(2, '0')}T${String(14 + (n % 5) * 2).padStart(2, '0')}:30:00Z`));
        const at = (min: number) => new Date(startUtc.getTime() + min * 60e3);
        const shift = await ins('shifts', `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
          VALUES ($1, $2, $3, $4, 'completed') RETURNING id`, [site, guard, startUtc, at(480)]);
        const sess = await ins('shift_sessions', `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clocked_out_at, clock_in_coords, total_hours)
          VALUES ($1, $2, $3, $4, $5, '37.33,-121.89', $6) RETURNING id`, [shift, guard, site, at(3 + day), at(470 - day * 11), day % 3 ? (467 - day * 12) / 60 : null]);
        await ins('reports', `INSERT INTO reports (shift_session_id, site_id, report_type, description, severity, reported_at)
          VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`, [sess, site, ['activity', 'incident', 'maintenance'][n % 3], descs[n % descs.length], n % 4 ? 'medium' : null, at(90 + n)]);
        if (day % 2 === 0) {
          await ins('geofence_violations', `INSERT INTO geofence_violations (shift_session_id, guard_id, site_id, violation_lat, violation_lng, occurred_at,
              resolved_at, duration_minutes, notification_sent, supervisor_override, position_source)
            VALUES ($1, $2, $3, 37.3, -121.8, $4, $5, $6, $7, $8, 'background') RETURNING id`,
            [sess, guard, site, at(200), day === 4 ? null : at(214), day === 4 ? null : 14, day === 2, n % 2 === 0]);
        }
        n += 1;
      }
    }

    // ══ the real routers over HTTP ══
    const app = express();
    app.use(express.json());
    app.use('/api/exports', (await import('../src/routes/exports')).default);
    app.use('/api/admin/company', (await import('../src/routes/companyProfile')).default);
    app.use('/api/exports-base', loadAt(BASE, 'src/routes/exports.ts').default);
    const listening: Server = await new Promise((resolve) => { const sv = app.listen(0, '127.0.0.1', () => resolve(sv)); });
    server = listening;
    const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
    const adminToken = (sub: string, companyId: string) =>
      jwt.sign({ sub, role: 'company_admin', company_id: companyId, is_primary: true }, JWT_SECRET, { expiresIn: '1h' });
    const vishnuToken = jwt.sign({ sub: 'vishnu-fixture', role: 'vishnu' }, VISHNU_SECRET, { expiresIn: '1h' });
    async function get(pathname: string, token: string) {
      const r = await fetch(`${origin}${pathname}`, { headers: { authorization: `Bearer ${token}` } });
      return { status: r.status, type: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition') ?? '', body: Buffer.from(await r.arrayBuffer()) };
    }

    // ══════════════════════════════════════════════════════════════════════════
    section(`R  GET /api/exports/analytics/xlsx against the ${BASE.slice(0, 7)} route (SheetJS), over HTTP`);
    {
      // Vishnu's export spans every company and carries no letterhead: the workbook with none, against
      // main's. A company admin's carries one since B6; section L holds its table to the same comparison.
      const callers: Array<[string, string]> = [['Vishnu (every company, no letterhead)', vishnuToken]];
      const queries: Array<[string, string]> = [
        ['no filter', ''],
        ['one site', `site_id=${north}`],
        ['one guard', `guard_id=${gB}`],
        ['a date range', 'date_from=2026-09-11&date_to=2026-09-13'],
        ['a range with no rows', 'date_from=2025-01-01&date_to=2025-01-02'],
      ];
      for (const [who, token] of callers) {
        for (const [what, qs] of queries) {
          const b = await get(`/api/exports-base/analytics/xlsx?${qs}`, token);
          const c = await get(`/api/exports/analytics/xlsx?${qs}`, token);
          const vb = await viewOf(b.body);
          const d = differences(vb, await viewOf(c.body));
          check(b.status === 200 && c.status === 200 && c.type === b.type && c.disposition === b.disposition && d.length === 0,
            `R1 ${who}, ${what}: ${cellCount(vb)} cells, ${brief(d)} (${c.status}, ${c.disposition.replace(/^attachment; /, '')})`);
        }
      }
      // Control: the comparison sees the data — two companies' exports differ.
      const a = await viewOf((await get('/api/exports-base/analytics/xlsx', adminToken(adminA, STAR_GUARD))).body);
      const b = await viewOf((await get('/api/exports-base/analytics/xlsx', adminToken(adminB, other))).body);
      check(differences(a, b).length > 0 && cellCount(a) > 300, `R2 control: Star Guard's export and the other company's are told apart (${cellCount(a)} vs ${cellCount(b)} cells)`);
      const src = fs.readFileSync(path.join(__dirname, '..', 'src/routes/exports.ts'), 'utf8');
      check(!/require\(['"]xlsx['"]\)|from ['"]xlsx['"]/.test(src) && /require\(['"]xlsx['"]\)/.test(execFileSync('git', ['show', `${BASE}:apps/api/src/routes/exports.ts`], { encoding: 'utf8' })),
        'R3 the route no longer loads SheetJS; the base one did');
    }

    // ══════════════════════════════════════════════════════════════════════════
    section('L  with a letterhead: the block, the title, "Powered by NetraOps", then the table cell for cell seven rows down; the print chrome; the logo once');
    {
      const JSZip = (await import('jszip')).default;
      const { contactLines } = await import('../src/services/letterhead/text');
      const { neutralizeFormula, readsAsFormula } = await import('../src/services/spreadsheetSafe');
      const hf = (t: string) => t.replace(/&/g, '&&');
      type Profile = { companyName: string; contactEmail: string | null; phone: string | null; address: string | null; licenceNumber: string | null; website: string | null; logo: Buffer | null };
      /** Everything wrong with a lettered workbook, against the plain workbook of the same data. */
      async function letteredProblems(buf: Buffer, plain: Buffer, lh: Profile, title: string, logoDrawn: boolean): Promise<string[]> {
        const problems: string[] = [];
        const v = await viewOf(buf);
        const p = await viewOf(plain);
        if (show(v.map((x) => x.name)) !== show(p.map((x) => x.name))) problems.push(`sheets ${show(v.map((x) => x.name))}`);
        const col = logoDrawn ? 'D' : 'A';
        const want: Record<string, unknown> = { [`${col}1`]: neutralizeFormula(lh.companyName) };
        contactLines(lh as never).forEach((line, i) => {
          want[`${col}${2 + i}`] = neutralizeFormula(lh.phone && line.startsWith(lh.phone) && readsAsFormula(line) ? `Tel ${line}` : line);
        });
        want.A5 = title;
        want.A6 = 'Powered by NetraOps';
        const sorted = (o: Record<string, unknown>) => show(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
        for (let i = 0; i < Math.min(v.length, p.length); i++) {
          const got = blockOf(v[i], 7);
          if (sorted(got) !== sorted(want)) problems.push(`${v[i].name} rows 1-7 ${sorted(got)}`);
          problems.push(...differences([tableOf(v[i], 7)], [{ ...p[i], dimension: null, ignoredErrors: null }]).map((d) => `${v[i].name} table: ${d}`));
          if (v[i].ignoredErrors !== `<ignoredError numberStoredAsText="1" sqref="${v[i].dimension}"/>`) problems.push(`${v[i].name} ignoredErrors ${v[i].ignoredErrors}`);
        }
        const zip = await JSZip.loadAsync(buf);
        const parts = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort();
        for (const part of parts) {
          const xml = await zip.file(part)!.async('string');
          const head = unescapeXml(xml.match(/<oddHeader>([\s\S]*?)<\/oddHeader>/)?.[1] ?? '');
          const foot = unescapeXml(xml.match(/<oddFooter>([\s\S]*?)<\/oddFooter>/)?.[1] ?? '');
          if (head !== `&L&B${hf(lh.companyName)}&R${hf('Analytics Export')}`) problems.push(`${part} header ${show(head)}`);
          if (foot !== `&L&8Confidential — ${hf(lh.companyName)}&C&8Page &P of &N&R&8Powered by NetraOps`) problems.push(`${part} footer ${show(foot)}`);
          const at = (tag: string) => xml.indexOf(`<${tag}`);
          if (!(at('headerFooter') > 0 && at('ignoredErrors') > at('headerFooter') && (logoDrawn ? at('drawing') > at('ignoredErrors') : at('drawing') < 0))) {
            problems.push(`${part} element order headerFooter ${at('headerFooter')} ignoredErrors ${at('ignoredErrors')} drawing ${at('drawing')}`);
          }
        }
        const media = Object.keys(zip.files).filter((f) => f.startsWith('xl/media/') && !zip.files[f].dir);
        if (logoDrawn) {
          if (media.length !== 1 || !(await zip.file(media[0])!.async('nodebuffer')).equals(lh.logo!)) problems.push(`media ${show(media)} (want the logo, once)`);
          const drawings = Object.keys(zip.files).filter((f) => /^xl\/drawings\/drawing\d+\.xml$/.test(f));
          if (drawings.length !== parts.length) problems.push(`${drawings.length} drawings for ${parts.length} sheets`);
          for (const d of drawings) {
            const x = await zip.file(d)!.async('string');
            const from = x.match(/<xdr:from><xdr:col>(\d+)<\/xdr:col><xdr:colOff>\d+<\/xdr:colOff><xdr:row>(\d+)<\/xdr:row>/);
            const ext = x.match(/<xdr:ext cx="(\d+)" cy="(\d+)"\/>/);
            const px = ext ? [Number(ext[1]) / 9525, Number(ext[2]) / 9525] : [];
            if (!from || from[1] !== '0' || from[2] !== '0' || !ext || px[0] > 147 || px[1] > 61) problems.push(`${d} anchor ${from?.slice(1).join(',')} size ${px.join('x')}`);
          }
        } else if (media.length !== 0) problems.push(`media ${show(media)} (want none)`);
        return problems;
      }

      // Star Guard's full profile and logo, behind the stubbed S3.
      const logoKey = `company-logos/${STAR_GUARD}/${marker}.png`;
      s3Objects.set(logoKey, LOGO);
      await q(`UPDATE companies SET contact_email = $2, phone = $3, address = $4, licence_number = $5, website = $6, logo_url = $7, logo_updated_at = $8 WHERE id = $1`,
        [STAR_GUARD, FULL.contactEmail, FULL.phone, FULL.address, FULL.licenceNumber, FULL.website, `https://${S3_HOST}/${logoKey}`, new Date('2026-10-13T18:00:00Z')]);
      const A = adminToken(adminA, STAR_GUARD);
      for (const [what, qs, title] of [
        ['no filter', '', 'Analytics Export   ·   All records'],
        ['a date range', 'date_from=2026-09-11&date_to=2026-09-13', 'Analytics Export   ·   Period 11-Sep-26 to 13-Sep-26'],
        ['from a date', 'date_from=2026-09-12', 'Analytics Export   ·   From 12-Sep-26'],
        ['one site', `site_id=${north}`, 'Analytics Export   ·   All records'],
        ['one guard', `guard_id=${gB}`, 'Analytics Export   ·   All records'],
        ['a range with no rows', 'date_from=2025-01-01&date_to=2025-01-02', 'Analytics Export   ·   Period 01-Jan-25 to 02-Jan-25'],
      ] as const) {
        const c = await get(`/api/exports/analytics/xlsx?${qs}`, A);
        const b = await get(`/api/exports-base/analytics/xlsx?${qs}`, A);
        const pr = await letteredProblems(c.body, b.body, FULL, title, true);
        check(c.status === 200 && pr.length === 0,
          `L1 Star Guard's admin, ${what}: on all three sheets, the block in D1:D4 beside the logo, "${title.replace(/ {3}/g, ' ')}", "Powered by NetraOps"; the table from row 8 is the base route's cell for cell; header and footer; one logo (${pr.length ? pr.slice(0, 3).join('; ') : 'nothing wrong'})`);
      }
      {
        const c = await get('/api/exports/analytics/xlsx', adminToken(adminB, other));
        const b = await get('/api/exports-base/analytics/xlsx', adminToken(adminB, other));
        const empty = { companyName: OTHER_NAME, contactEmail: null, phone: null, address: null, licenceNumber: null, website: null, logo: null };
        const pr = await letteredProblems(c.body, b.body, empty, 'Analytics Export   ·   All records', false);
        const all = (await viewOf(c.body)).flatMap((x) => Object.values(x.spec).map((cell) => String(cell[1])));
        const zip = await (await import('jszip')).default.loadAsync(c.body);
        const xml = (await Promise.all(Object.keys(zip.files).filter((f) => f.endsWith('.xml')).map((f) => zip.file(f)!.async('string')))).join('');
        check(c.status === 200 && pr.length === 0 && all.length > 100 && !all.some((t) => t.includes('Star Guard')) && !xml.includes('Star Guard') && !xml.includes('starguard'),
          `L2 the other company's admin: its own name in A1, no contact lines and no logo (an empty profile), its own header and footer; nothing of Star Guard's anywhere in the file (${pr.length ? pr.slice(0, 3).join('; ') : 'nothing wrong'})`);
      }
      {
        // requireAuth re-reads the ADMIN row, not the company, so a token naming a company with no row
        // reaches the handler: no rows, and a letterhead lookup that returns null.
        const t = adminToken(adminA, NO_SUCH_COMPANY);
        const c = await get('/api/exports/analytics/xlsx', t);
        const b = await get('/api/exports-base/analytics/xlsx', t);
        const zip = await (await import('jszip')).default.loadAsync(c.body);
        const sheetXml = (await Promise.all(Object.keys(zip.files).filter((f) => /worksheets\/sheet/.test(f)).map((f) => zip.file(f)!.async('string')))).join('');
        const d = differences(await viewOf(b.body), await viewOf(c.body));
        check(c.status === 200 && d.length === 0 && !sheetXml.includes('headerFooter') && !sheetXml.includes('<drawing'),
          `L3 a lookup that returns null: the workbook without a letterhead, the base route's cell for cell, no header, footer or drawing (${brief(d)})`);
      }
      // Straight through the module: the profile's edge cases.
      const sweep3 = sweepData();
      const plain3 = sheetjsWorkbook(sweep3, neutralizeRow);
      {
        const corrupt = { ...FULL, logo: pngCorruptAfterHeader(400, 160) };
        const pr = await letteredProblems(await AW.analyticsWorkbook(sweep3 as never, corrupt, {}), plain3, corrupt, 'Analytics Export   ·   All records', false);
        check(pr.length === 0, `L4 a logo that does not decode (N167): no picture, the block's text from column A (${pr.slice(0, 3).join('; ') || 'nothing wrong'})`);
      }
      {
        const hostile = { companyName: '=HYPERLINK("https://x.example","Star Guard") & Co', contactEmail: '@ops.example', phone: '+1 (408) 555-0142',
          address: '-1 Example Way\n=San Jose', licenceNumber: '+PPO 1', website: 'https://www.starguard.example/', logo: LOGO };
        const buf = await AW.analyticsWorkbook(sweep3 as never, hostile, { dateFrom: '2026-09-01', dateTo: '2026-09-30' });
        const pr = await letteredProblems(buf, plain3, hostile, 'Analytics Export   ·   Period 01-Sep-26 to 30-Sep-26', true);
        const v = await viewOf(buf);
        check(pr.length === 0 && v[0].spec.D1?.[1] === "'=HYPERLINK(\"https://x.example\",\"Star Guard\") & Co"
          && String(v[0].spec.D2?.[1]).startsWith("'-1 Example Way") && String(v[0].spec.D3?.[1]).startsWith('Tel +1 (408) 555-0142'),
          `L5 a hostile profile: every block line that would run as a formula gets its apostrophe, the "+1" phone line reads "Tel +1 …", and & is && in the header and footer (${pr.slice(0, 3).join('; ') || 'nothing wrong'})`);
      }
      {
        const P = AW.analyticsPeriodText;
        const cases: Array<[object, string]> = [
          [{}, 'All records'], [{ dateFrom: '2026-09-01' }, 'From 01-Sep-26'], [{ dateTo: '2026-09-30' }, 'Through 30-Sep-26'],
          [{ dateFrom: '2026-09-01', dateTo: '2026-09-30' }, 'Period 01-Sep-26 to 30-Sep-26'], [{ dateFrom: '20260901', dateTo: '2026-9-30' }, 'Period 20260901 to 2026-9-30'],
        ];
        const bad = cases.filter(([a, w]) => P(a as never) !== w).map(([a, w]) => `${show(a)} → ${show(P(a as never))}, want ${show(w)}`);
        check(bad.length === 0, `L6 the period line: none, from, through, both, and a date Postgres takes but that is not YYYY-MM-DD (printed as given) (${bad.join('; ') || 'all five'})`);
      }
      // Mutation controls: each mutant of the lettered layout must be caught by letteredProblems.
      const mutants: Array<[string, (s: string) => string]> = [
        ['the block text in column B, under the logo', (s) => s.replace('const TEXT_COLUMN_WITH_LOGO = 4;', 'const TEXT_COLUMN_WITH_LOGO = 2;')],
        ['the table one row higher', (s) => s.replace('export const LETTERED_TABLE_ROW = LETTERHEAD_ROWS + 4;', 'export const LETTERED_TABLE_ROW = LETTERHEAD_ROWS + 3;')],
        ['no print header or footer', (s) => s.replace('    stampPrintChrome(wb, lh, ANALYTICS_TITLE);\n', '')],
        ['no "Powered by NetraOps"', (s) => s.replace("  powered.value = 'Powered by NetraOps';\n", '')],
        ['the block on the first sheet only', (s) => s.replace('    if (lh) writeLetteredSheet(wb, ws, data[key], lh, period);', "    if (lh && name === 'Guard Hours') writeLetteredSheet(wb, ws, data[key], lh, period);")],
        ['the period left out of the title', (s) => s.replace('`${ANALYTICS_TITLE}   ·   ${analyticsPeriodText(period)}`', 'ANALYTICS_TITLE')],
        ['<ignoredErrors> left out', (s) => s.replace('return ignoreNumberStoredAsText(Buffer.from(await wb.xlsx.writeBuffer()));', 'return Buffer.from(await wb.xlsx.writeBuffer());')],
      ];
      let caught = 0;
      for (const [label, edit] of mutants) {
        const mutant = loadAt(null, 'src/services/analyticsWorkbook.ts', edit);
        const pr = await letteredProblems(await mutant.analyticsWorkbook(sweep3, FULL, {}), plain3, FULL, 'Analytics Export   ·   All records', true);
        if (pr.length > 0) caught += 1;
        check(pr.length > 0, `L7 control — ${label}: caught (${pr.slice(0, 2).join('; ')})`);
      }
      {
        // The block writer itself (B1's), with the logo embedded per sheet again.
        (globalThis as any).__lhb6MutantXlsx = loadAt(null, 'src/services/letterhead/xlsx.ts', (s) => s.replace('const image = logoId(wb, lh.logo, decoded.kind);',
          'const image = wb.addImage({ buffer: lh.logo as unknown as ExcelJS.Buffer, extension: decoded.kind });'));
        const again = loadAt(null, 'src/services/analyticsWorkbook.ts', (s) => s.replace("import { writeLetterheadBlock, stampPrintChrome, LETTERHEAD_ROWS } from './letterhead/xlsx';",
          'const { writeLetterheadBlock, stampPrintChrome, LETTERHEAD_ROWS } = (globalThis as any).__lhb6MutantXlsx;'));
        const pr = await letteredProblems(await again.analyticsWorkbook(sweep3, FULL, {}), plain3, FULL, 'Analytics Export   ·   All records', true);
        if (pr.length > 0) caught += 1;
        check(pr.some((x) => x.startsWith('media')), `L7 control — the logo embedded once per sheet: caught (${pr.slice(0, 2).join('; ')})`);
      }
      check(caught === mutants.length + 1, `L8 ${caught} of ${mutants.length + 1} mutants caught`);
    }

    // ══════════════════════════════════════════════════════════════════════════
    section('P  GET /api/admin/company: csv_preamble, the lines the analytics CSV opens with');
    {
      const { csvPreamble } = await import('../src/services/letterhead/csv');
      const { letterheadText } = await import('../src/services/letterhead');
      /** The lines a CSV body opens with before its first blank line (the BOM dropped). */
      const csvHead = (body: Buffer) => { const lines = body.toString('utf8').replace(/^﻿/, '').split('\n'); return lines.slice(0, lines.indexOf('')); };
      const secondA = await ins('company_admins',
        `INSERT INTO company_admins (company_id, name, email, password_hash, is_primary) VALUES ($1, $2, $3, 'x', false) RETURNING id`,
        [STAR_GUARD, `${marker} second-a`, `${marker}-second-a@test.invalid`]);
      const profile = async (token: string) => { const r = await fetch(`${origin}/api/admin/company`, { headers: { authorization: `Bearer ${token}` } }); return { status: r.status, body: await r.json() as any }; };
      {
        const r = await profile(adminToken(adminA, STAR_GUARD));
        const csv = csvHead((await get('/api/exports/analytics/csv', adminToken(adminA, STAR_GUARD))).body);
        const want = csvPreamble(FULL as never);
        check(r.status === 200 && show(r.body.csv_preamble) === show(want) && show(csv) === show(want),
          `P1 Star Guard's primary admin: csv_preamble is the analytics CSV's opening lines, quoted and guarded (${show(r.body.csv_preamble)})`);
        check(show(letterheadText({ name: ' Star Guard ', contact_email: ' ', phone: null, address: '', licence_number: ' PPO 1 ', website: null }))
          === show({ companyName: ' Star Guard ', contactEmail: null, phone: null, address: null, licenceNumber: 'PPO 1', website: null, logo: null }),
          'P1b letterheadText: fields trimmed and an empty one null, as the lookups always did; the name as stored; no logo');
      }
      {
        const r = await profile(adminToken(secondA, STAR_GUARD));
        check(r.status === 200 && r.body.is_primary === false && show(r.body.csv_preamble) === show(csvPreamble(FULL as never)),
          `P2 a secondary admin of the same company gets the same lines (${r.status}, is_primary ${r.body.is_primary})`);
      }
      {
        const r = await profile(adminToken(adminB, other));
        const csv = csvHead((await get('/api/exports/analytics/csv', adminToken(adminB, other))).body);
        check(r.status === 200 && show(r.body.csv_preamble) === show([`"${OTHER_NAME}"`, '"Powered by NetraOps"']) && show(csv) === show(r.body.csv_preamble),
          `P3 the other company (an empty profile): its own name and "Powered by NetraOps", as its analytics CSV opens (${show(r.body.csv_preamble)})`);
      }
      {
        const hostile = ['=HYPERLINK("https://x.example","Star Guard")', '@ops.example', '+1 (408) 555-0142', '-1 Example Way\n=San Jose', '+PPO 1', 'https://www.starguard.example/'];
        await q('UPDATE companies SET contact_email = $2, phone = $3, address = $4, licence_number = $5, website = $6 WHERE id = $1', [STAR_GUARD, hostile[1], hostile[2], hostile[3], hostile[4], hostile[5]]);
        const r = await profile(adminToken(adminA, STAR_GUARD));
        const csv = csvHead((await get('/api/exports/analytics/csv', adminToken(adminA, STAR_GUARD))).body);
        const lines: string[] = r.body.csv_preamble ?? [];
        check(r.status === 200 && show(lines) === show(csv) && lines.length === 5
          && lines[1] === `"'-1 Example Way, =San Jose"` && lines[2].startsWith('"Tel +1 (408) 555-0142') && lines[3] === `"License No. +PPO 1"` && lines[4] === '"Powered by NetraOps"',
          `P4 a hostile profile: the same escaping as the analytics CSV, the address line guarded, the phone line labelled "Tel" (${show(lines)})`);
        await q('UPDATE companies SET contact_email = $2, phone = $3, address = $4, licence_number = $5, website = $6 WHERE id = $1',
          [STAR_GUARD, FULL.contactEmail, FULL.phone, FULL.address, FULL.licenceNumber, FULL.website]);
      }
    }

    // ── (next section) ──
  } finally {
    if (server) { const sv = server; await new Promise<void>((resolve) => sv.close(() => resolve())); }
    for (const table of ['geofence_violations', 'reports', 'shift_sessions', 'shifts', 'guards', 'sites', 'company_admins', 'companies']) {
      if (seeded[table].length) await q(`DELETE FROM ${table} WHERE id = ANY($1::uuid[])`, [seeded[table]]);
    }
    if (priorStarGuard) {
      await q(`UPDATE companies SET ${PROFILE.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
        [STAR_GUARD, ...PROFILE.map((c) => priorStarGuard[c])]);
    } else {
      await q('DELETE FROM companies WHERE id = $1', [STAR_GUARD]);
    }
    const left = (await q(`SELECT (SELECT count(*) FROM sites WHERE name LIKE $1)::int + (SELECT count(*) FROM company_admins WHERE email LIKE $1)::int
                                + (SELECT count(*) FROM guards WHERE email LIKE $1)::int + (SELECT count(*) FROM companies WHERE name LIKE $2)::int AS n`,
      [`${marker}%`, `%${marker}`])).rows[0].n;
    console.log(`\ncleanup: ${left} seeded rows left`);
    if (left !== 0) failures += 1;
    await pool.end();
  }

  finished = true;
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('HARNESS ERROR', err);
  process.exit(1);
});
