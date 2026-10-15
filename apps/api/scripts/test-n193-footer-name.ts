/**
 * test-n193-footer-name.ts — a long company name no longer runs into the page number in the XLSX print footer (N193).
 *
 *   npx ts-node -P tsconfig.scripts.json scripts/test-n193-footer-name.ts     (from apps/api)
 *
 * No database. services/letterhead/xlsx.ts, as the hours and analytics workbooks use it:
 *   C  footerCompany: a name whose "Confidential — <name>" fits FOOTER_LEFT_MAX_PT in Helvetica 8 pt prints whole;
 *      a longer one is the longest prefix that fits with "…" (one more character would not), with no space before
 *      the "…"; the cut follows the measured width, not a character count (40 "W" are cut, 81 "i" are not)
 *   F  stampPrintChrome: every sheet's footer prints the cut name with & written &&, the header keeps the whole
 *      name, and a short name prints exactly as before
 *   M  mutation controls: BASE's footer (the whole name); a cut by character count; && written before the cut
 *
 * The Excel side was measured once, through Excel's own PDF export on Letter, and is recorded in OPEN-ITEMS N193:
 * "Page" starts at x 288.0; before N193 the footer reached it between 55 characters (4.3 pt clear) and 75 (words
 * interleaved); with the cut, the 75-character fixture and 40 "W" end 27.5 pt clear, and a 41-character name prints
 * whole, 50.8 pt clear.
 */
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const API = path.join(__dirname, '..');
const XLSX = 'src/services/letterhead/xlsx.ts';
/** main before N193 (PR #127's merge). */
const BASE = '25bce4bedece1ad77a8e6c58590151a73cad17aa';
const LONG = 'Star Guard Protective Services & Event Security of Northern California, LLC';
const LEAD = 'Confidential — ';

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); } else { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
function once(s: string, from: string, to: string): string {
  if (s.split(from).length !== 2) throw new Error(`expected one ${JSON.stringify(from.slice(0, 60))}`);
  return s.replace(from, to);
}
/** `src` compiled as the module at `rel`, beside the one the tree loads there. */
function compileAs(rel: string, src: string): any {
  const file = path.join(API, rel);
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const m = new Module(file, module) as Module & { _compile(code: string, f: string): void; paths: string[] };
  m.filename = file;
  m.paths = (Module as unknown as { _nodeModulePaths(dir: string): string[] })._nodeModulePaths(path.dirname(file));
  m._compile(js, file);
  m.loaded = true;
  return m.exports;
}
const hf = (s: string) => s.replace(/&/g, '&&');
const profile = (name: string) => ({ companyName: name, contactEmail: null, phone: null, address: null, licenceNumber: null, website: null, logo: null });

async function main(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const X = require(path.join(API, XLSX)) as typeof import('../src/services/letterhead/xlsx');
  const doc = new PDFDocument({ autoFirstPage: false });
  doc.font('Helvetica').fontSize(8);
  const width = (s: string) => doc.widthOfString(s);
  const MAX = X.FOOTER_LEFT_MAX_PT;

  /** Every way a printed name can be wrong for `name`; [] when right. */
  function cutFaults(name: string, printed: string): string[] {
    const f: string[] = [];
    if (width(`${LEAD}${name}`) <= MAX) {
      if (printed !== name) f.push(`"${name}" fits but printed "${printed}"`);
      return f;
    }
    if (!printed.endsWith('…')) f.push(`"${printed}" has no ellipsis`);
    const kept = printed.slice(0, -1);
    if (!name.startsWith(kept)) f.push(`"${kept}" is not a prefix of the name`);
    if (/\s$/.test(kept)) f.push('a space before the ellipsis');
    if (width(`${LEAD}${printed}`) > MAX) f.push(`${width(`${LEAD}${printed}`).toFixed(1)} pt, over ${MAX}`);
    const next = name.slice(0, kept.length + 1).trimEnd();
    if (next.length > kept.length && width(`${LEAD}${next}…`) <= MAX) f.push('one more character would still fit');
    return f;
  }

  section('C  footerCompany');
  const names: Array<[string, string]> = [
    ['Star Guard', 'short'],
    ['Northern California Patrol Services Group', '41 characters'],
    ['i'.repeat(81), '81 narrow "i"'],
    [LONG, "B1's 75-character fixture"],
    ['W'.repeat(40), '40 wide "W"'],
    ['Northern California Patrol and Guard Services of the Bay Area', 'a cut that lands on a space'],
  ];
  for (const [name, label] of names) {
    const printed = X.footerCompany(name);
    const f = cutFaults(name, printed);
    check(f.length === 0, `${label}: "${printed}" (${width(`${LEAD}${printed}`).toFixed(1)} of ${MAX} pt)${f.length ? ` [${f.join('; ')}]` : ''}`);
  }
  check(X.footerCompany('i'.repeat(81)).length === 81 && X.footerCompany('W'.repeat(40)).length < 40,
    'the cut follows the measured width, not a character count: 81 "i" print whole, 40 "W" are cut');

  section('F  stampPrintChrome');
  async function stamped(stamp: (wb: ExcelJS.Workbook, lh: any, title: string) => void, name: string) {
    const wb = new ExcelJS.Workbook();
    for (const n of ['One', 'Two']) wb.addWorksheet(n).addRow(['x']);
    stamp(wb, profile(name), 'Hours Report');
    const out: Array<{ head?: string; foot?: string }> = [];
    wb.eachSheet((ws) => out.push({ head: ws.headerFooter.oddHeader, foot: ws.headerFooter.oddFooter }));
    return out;
  }
  const footFor = (name: string) => `&L&8${LEAD}${hf(X.footerCompany(name))}&C&8Page &P of &N&R&8Powered by NetraOps`;
  /** The footer's company as printed, && read back as &; null if a lone & is left (a broken code). */
  const footName = (foot: string | undefined) => {
    const m = /^&L&8Confidential — (.*)&C&8Page &P of &N&R&8Powered by NetraOps$/.exec(foot ?? '');
    if (!m || m[1].replace(/&&/g, '').includes('&')) return null;
    return m[1].replace(/&&/g, '&');
  };
  const long = await stamped(X.stampPrintChrome, LONG);
  check(long.length === 2 && long.every((s) => s.foot === footFor(LONG) && footName(s.foot) === X.footerCompany(LONG) && s.head === `&L&B${hf(LONG)}&RHours Report`),
    `both sheets: the footer prints "${LEAD}${X.footerCompany(LONG)}", & written &&; the header keeps the whole name`);
  const short = await stamped(X.stampPrintChrome, 'Star Guard');
  check(short.every((s) => s.foot === '&L&8Confidential — Star Guard&C&8Page &P of &N&R&8Powered by NetraOps' && s.head === '&L&BStar Guard&RHours Report'),
    'a short name prints exactly as before N193');

  section('M  mutation controls (each must fail)');
  {
    const base = compileAs(XLSX, execFileSync('git', ['show', `${BASE}:apps/api/${XLSX}`], { cwd: API, encoding: 'utf8' }));
    const b = await stamped(base.stampPrintChrome, LONG);
    check(b[0].foot !== footFor(LONG) && footName(b[0].foot) === LONG,
      `BASE's footer: caught (it prints the whole ${LONG.length}-character name)`);

    const src = fs.readFileSync(path.join(API, XLSX), 'utf8');
    const byCount = compileAs(XLSX, once(src, "  const width = footerWidth;\n", "  const width = (s: string) => s.length * 4.4;\n"));
    const w = byCount.footerCompany('W'.repeat(40)) as string;
    check(cutFaults('W'.repeat(40), w).length > 0, `a cut by character count: caught (40 "W" print as ${w.length} characters, ${width(`${LEAD}${w}`).toFixed(1)} pt)`);

    // A name whose cut, made AFTER && is written, lands between the two & of one &&.
    const escapedFirst = compileAs(XLSX, once(src, '${hf(footerCompany(lh.companyName))}', '${footerCompany(hf(lh.companyName))}'));
    let trap: string | null = null;
    for (let k = 1; k <= 60 && !trap; k += 1) {
      const name = `${'A'.repeat(k)} & ${'B'.repeat(60)}`;
      const c = X.footerCompany(hf(name));
      if (/(^|[^&])&…$/.test(c)) trap = name;
    }
    const e = trap ? await stamped(escapedFirst.stampPrintChrome, trap) : [];
    check(trap !== null && footName(e[0]?.foot) === null && footName((await stamped(X.stampPrintChrome, trap))[0].foot) !== null,
      `&& written before the cut: caught (a name ${trap?.length ?? '?'} characters long leaves a lone & before the "…"; the real order does not)`);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
