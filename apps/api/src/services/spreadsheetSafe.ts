/**
 * Spreadsheet formula-injection guard (N171; OWASP "CSV Injection").
 *
 * A spreadsheet runs a cell whose text starts with = + - @ (or a tab or a CR) as
 * a formula. In a CSV that happens on open, quoted or not; in an XLSX a text
 * cell is stored as text, but editing it re-reads the text as typed input. So
 * every text cell built from user-typed data — guard and site names, report
 * descriptions, badge numbers, company and letterhead lines — goes through
 * neutralizeFormula(): such text gets a leading apostrophe and reads back as
 * text, everything else is returned untouched.
 *
 * A plain number ("-2.5", "+3") is not a formula, and escaping it would turn a
 * figure into text, so it is left alone. So is any value that is not a string.
 *
 * The browser-built checkpoint-scans CSV (apps/web, admin/sites/[id]) has
 * carried the same guard since C5.
 */
import type ExcelJS from 'exceljs';

const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** True when a spreadsheet would read `s` as a formula. */
export function readsAsFormula(s: string): boolean {
  return FORMULA_START.test(s) && !PLAIN_NUMBER.test(s);
}

/** `v` with a leading apostrophe when it is text a spreadsheet would run; otherwise `v`. */
export function neutralizeFormula<T>(v: T): T | string {
  return typeof v === 'string' && readsAsFormula(v) ? `'${v}` : v;
}

/** A row object with every value passed through neutralizeFormula(); keys and order kept. */
export function neutralizeRow<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = neutralizeFormula(v);
  return out as T;
}

/**
 * Every plain-text cell of every sheet passed through neutralizeFormula().
 * Numbers, dates, booleans, formulas and rich text are left alone, and a cell
 * is only written when its value changes, so a workbook with nothing to escape
 * comes out byte for byte as it went in.
 */
export function neutralizeWorkbook(wb: ExcelJS.Workbook): void {
  wb.eachSheet((ws) => {
    ws.eachRow((row) => {
      row.eachCell((cell) => {
        if (typeof cell.value === 'string' && readsAsFormula(cell.value)) cell.value = `'${cell.value}`;
      });
    });
  });
}
