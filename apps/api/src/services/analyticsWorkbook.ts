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
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { neutralizeRow } from './spreadsheetSafe';

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

export async function analyticsWorkbook(data: AnalyticsData): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, key] of ANALYTICS_SHEETS) writeAnalyticsTable(wb.addWorksheet(name), data[key]);
  return ignoreNumberStoredAsText(Buffer.from(await wb.xlsx.writeBuffer()));
}
