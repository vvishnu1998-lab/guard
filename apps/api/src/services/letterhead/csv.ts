/**
 * The company letterhead at the top of a CSV export (Phase B, B1; Vishnu's
 * decision 2a, 2026-10-07).
 *
 * withCsvPreamble(lh, body): one quoted cell per line — the company name, the
 * contact lines the PDF prints (letterhead/text.ts), "Powered by NetraOps" —
 * then exactly one blank line, then the export as it was. The analytics CSV
 * already carries bare title lines between its sections, so a reader of that
 * file is not asked to skip anything new in kind. With no letterhead the body
 * comes back unchanged.
 *
 * FORMULA GUARD. A spreadsheet runs a cell that starts with = + - @ (or a tab
 * or a CR) as a formula, quoted or not, so a preamble line that would gets a
 * leading apostrophe: neutralizeFormula(), the one rule every CSV and XLSX cell
 * uses (services/spreadsheetSafe.ts, N171). The phone leads the contact line and
 * is often "+1 …", which would show that apostrophe, so that line is labelled
 * "Tel" when it starts with the phone.
 */
import type { Letterhead } from './types';
import { contactLines } from './text';
import { neutralizeFormula } from '../spreadsheetSafe';

const cell = (s: string): string => `"${String(neutralizeFormula(s)).replace(/"/g, '""')}"`;

/** The preamble's lines, each one quoted cell, without line endings. */
export function csvPreamble(lh: Letterhead): string[] {
  const lines = contactLines(lh).map((line) => (lh.phone && line.startsWith(lh.phone) ? `Tel ${line}` : line));
  return [lh.companyName, ...lines, 'Powered by NetraOps'].map(cell);
}

export function withCsvPreamble(lh: Letterhead | null, body: string): string {
  if (!lh) return body;
  return `${csvPreamble(lh).join('\n')}\n${body.startsWith('\n') ? '' : '\n'}${body}`;
}
