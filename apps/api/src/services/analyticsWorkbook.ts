/**
 * The analytics workbook (GET /api/exports/analytics/xlsx): one sheet per
 * query in routes/exports.ts, in this order: Guard Hours, Reports, Geofence
 * Violations.
 *
 * ── WRITTEN WITH EXCELJS, CELL FOR CELL AS SHEETJS WROTE IT ───────────────
 * Until B6 this workbook was SheetJS (xlsx 0.18.5): json_to_sheet over each
 * query's rows. SheetJS cannot embed a picture or write a print header, which
 * the letterhead needs, so the whole export moved to exceljs, the library the
 * hours workbooks already use (Vishnu's decision 1b, 2026-10-13). Each sheet
 * holds exactly what json_to_sheet put there (scripts/test-letterhead-b6-b7.ts,
 * section X, against the route as it was at 86cc2f0):
 *   - row 1: every key of the rows, in the order first met, as text; no rows
 *     means no header either, an empty sheet;
 *   - one row per query row: text as text, numbers as numbers, booleans as
 *     booleans, a Date as its day serial in format 14 (m/d/yy), computed in
 *     the process's local time as SheetJS did; null and undefined leave the
 *     cell empty;
 *   - no column widths;
 *   - every value through neutralizeRow() first (N171), as before.
 * Two things SheetJS did below the cell model are kept too:
 *   - text with a control character (U+0000-U+0008, U+000B-U+001F; CR is one)
 *     carries it as _xHHHH_, which every reader decodes. exceljs would drop
 *     the character instead.
 *   - every sheet tells Excel not to flag "number stored as text"
 *     (<ignoredErrors>). The hours columns arrive from Postgres NUMERIC as
 *     text ("8.00"); without it Excel marks each one with a green triangle.
 * What does change: the default font is Calibri 11 (exceljs, as in the hours
 * workbooks) where SheetJS wrote Calibri 12, and text is stored in the shared
 * string table rather than inline. Neither changes a value, a type or a format.
 *
 * ── THE LETTERHEAD (Phase B, B6; Vishnu's decision 2a, 2026-10-13) ────────
 * With a letterhead, every sheet opens with the company's block (rows 1-4,
 * letterhead/xlsx.ts), then "Analytics Export   ·   <period>", then "Powered
 * by NetraOps", a blank row, and the table from row 8, cell for cell as
 * without one, in the same column widths. The logo floats over A1:C4 and the
 * block's text starts in column D: widening column A for the logo, as the
 * hours SUMMARY does, pushed Reports and Violations onto a second printed
 * page. "Powered by" sits under the title, not at the right of its row as on
 * the hours SUMMARY, for the same reason: a cell at the right widened the
 * print range and printed a page holding nothing else. Every sheet prints with
 * the company's header and footer. Without one (null: Vishnu's all-company export, or a
 * lookup that failed) the workbook is the one above.
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { neutralizeRow } from './spreadsheetSafe';
import type { Letterhead } from './letterhead/types';
import { writeLetterheadBlock, stampPrintChrome, LETTERHEAD_ROWS } from './letterhead/xlsx';
import { ddMmmYy } from './hoursWorkbook';

export type AnalyticsRow = Record<string, unknown>;

export interface AnalyticsData {
  hours: AnalyticsRow[];
  reports: AnalyticsRow[];
  violations: AnalyticsRow[];
}

/** The sheets, in order, and the query each one shows. */
export const ANALYTICS_SHEETS: ReadonlyArray<readonly [string, keyof AnalyticsData]> = [
  ['Guard Hours', 'hours'],
  ['Reports', 'reports'],
  ['Geofence Violations', 'violations'],
];

/** Excel's built-in format 14, which exceljs calls 'mm-dd-yy' and SheetJS 'm/d/yy'. */
const DATE_FORMAT_14 = 'mm-dd-yy';

/**
 * A Date as Excel's day serial, the way SheetJS 0.18.5's datenum() computed
 * it: in the process's local time (UTC on Railway).
 */
function excelSerial(d: Date): number {
  const base = new Date(1899, 11, 30, 0, 0, 0);
  const threshold = base.getTime() + (d.getTimezoneOffset() - base.getTimezoneOffset()) * 60000;
  return (d.getTime() - threshold) / 86400000;
}

/** Control characters XML cannot carry, written as _xHHHH_ the way SheetJS's escapexml() did. */
function encodeControlCharacters(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b-\u001f]/g, (c) => `_x${c.charCodeAt(0).toString(16).padStart(4, '0')}_`);
}

/** One query's rows from `firstRow` down, as json_to_sheet laid them out. */
export function writeAnalyticsTable(ws: ExcelJS.Worksheet, rows: AnalyticsRow[], firstRow = 1): void {
  const keys: string[] = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!keys.includes(k)) keys.push(k);
  if (keys.length === 0) return;
  keys.forEach((k, c) => { ws.getCell(firstRow, c + 1).value = encodeControlCharacters(k); });
  rows.forEach((row, r) => {
    for (const [k, v] of Object.entries(neutralizeRow(row))) {
      const cell = ws.getCell(firstRow + 1 + r, keys.indexOf(k) + 1);
      if (typeof v === 'string') cell.value = encodeControlCharacters(v);
      else if (typeof v === 'number' || typeof v === 'boolean') cell.value = v;
      else if (v instanceof Date) { cell.value = excelSerial(v); cell.numFmt = DATE_FORMAT_14; }
    }
  });
}

/** Elements CT_Worksheet allows after <ignoredErrors>; it goes before the first one present. */
const AFTER_IGNORED_ERRORS = /<(smartTags|drawing|legacyDrawing|legacyDrawingHF|drawingHF|picture|oleObjects|controls|webPublishItems|tableParts|extLst)[\s>/]|<\/worksheet>/;

/**
 * Every worksheet of `xlsx` told not to flag numbers stored as text over its
 * used range, as SheetJS wrote it. exceljs has no setting for this.
 */
export async function ignoreNumberStoredAsText(xlsx: Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(xlsx);
  for (const name of Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f))) {
    const xml = await zip.file(name)!.async('string');
    const ref = xml.match(/<dimension ref="([^"]+)"\/>/)?.[1];
    const at = xml.search(AFTER_IGNORED_ERRORS);
    if (!ref || at < 0 || xml.includes('<ignoredErrors>')) continue;
    zip.file(name, `${xml.slice(0, at)}<ignoredErrors><ignoredError numberStoredAsText="1" sqref="${ref}"/></ignoredErrors>${xml.slice(at)}`);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

/** What the export covers: the request's date_from and date_to, as given. */
export interface AnalyticsPeriod {
  dateFrom?: string;
  dateTo?: string;
}

export const ANALYTICS_TITLE = 'Analytics Export';
/** With a letterhead, the table's header row: below the block, the title, "Powered by" and a blank row. */
export const LETTERED_TABLE_ROW = LETTERHEAD_ROWS + 4;
/** With a logo, the block's text column: the logo's box (147 px) spans default-width A and B and part of C. */
const TEXT_COLUMN_WITH_LOGO = 4;
const NAVY = 'FF0B1526';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "Period 01-Sep-26 to 30-Sep-26", "From …", "Through …" or "All records"; dates as the hours workbook prints them. */
export function analyticsPeriodText({ dateFrom, dateTo }: AnalyticsPeriod): string {
  const day = (s: string) => (ISO_DATE.test(s) ? ddMmmYy(s) : s);
  if (dateFrom && dateTo) return `Period ${day(dateFrom)} to ${day(dateTo)}`;
  if (dateFrom) return `From ${day(dateFrom)}`;
  if (dateTo) return `Through ${day(dateTo)}`;
  return 'All records';
}

function writeLetteredSheet(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, rows: AnalyticsRow[], lh: Letterhead, period: AnalyticsPeriod): void {
  writeLetterheadBlock(wb, ws, lh, { textColumnWithLogo: TEXT_COLUMN_WITH_LOGO });
  const title = ws.getRow(LETTERHEAD_ROWS + 1);
  title.getCell(1).value = `${ANALYTICS_TITLE}   ·   ${analyticsPeriodText(period)}`;
  title.getCell(1).font = { bold: true, size: 12, color: { argb: NAVY } };
  const powered = ws.getRow(LETTERHEAD_ROWS + 2).getCell(1);
  powered.value = 'Powered by NetraOps';
  powered.font = { size: 8, color: { argb: 'FF94A3B8' } };
  writeAnalyticsTable(ws, rows, LETTERED_TABLE_ROW);
}

export async function analyticsWorkbook(data: AnalyticsData, lh: Letterhead | null = null, period: AnalyticsPeriod = {}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, key] of ANALYTICS_SHEETS) {
    const ws = wb.addWorksheet(name);
    if (lh) writeLetteredSheet(wb, ws, data[key], lh, period);
    else writeAnalyticsTable(ws, data[key]);
  }
  if (lh) {
    wb.company = lh.companyName;
    stampPrintChrome(wb, lh, ANALYTICS_TITLE);
  }
  return ignoreNumberStoredAsText(Buffer.from(await wb.xlsx.writeBuffer()));
}
