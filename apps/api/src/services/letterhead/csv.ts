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
 * leading apostrophe (OWASP CSV-injection guidance). The phone leads the
 * contact line and is often "+1 …", which would show that apostrophe, so that
 * line is labelled "Tel" when it starts with the phone. The data cells below
 * the preamble are not guarded here: that is N171.
 */
import type { Letterhead } from './types';
import { contactLines } from './text';

const cell = (s: string): string => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;

/** The preamble's lines, each one quoted cell, without line endings. */
export function csvPreamble(lh: Letterhead): string[] {
  const lines = contactLines(lh).map((line) => (lh.phone && line.startsWith(lh.phone) ? `Tel ${line}` : line));
  return [lh.companyName, ...lines, 'Powered by NetraOps'].map(cell);
}

export function withCsvPreamble(lh: Letterhead | null, body: string): string {
  if (!lh) return body;
  return `${csvPreamble(lh).join('\n')}\n${body.startsWith('\n') ? '' : '\n'}${body}`;
}
