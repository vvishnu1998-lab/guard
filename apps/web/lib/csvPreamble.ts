/**
 * The company letterhead above a CSV the browser builds (Phase B, B7; Vishnu's
 * decision 3a, 2026-10-13): the checkpoint-scans export on a site's page.
 *
 * The lines come from the API, never from here: GET /api/admin/company
 * carries csv_preamble, the very lines the analytics CSV opens with, each one
 * already quoted and formula-guarded by the server (services/letterhead/csv.ts).
 * So one formatter writes every CSV preamble, and this file only checks and
 * places them.
 *
 * Fails closed. A profile that cannot be fetched, an API that predates the
 * field (Vercel and Railway never deploy together), or a line that is not one
 * quoted cell all give null, and the file is exactly what it was before B7.
 */

/** One CSV cell, quoted, its quotes doubled: what the server sends for each line. */
const QUOTED_CELL = /^"(?:[^"]|"")*"$/;

/** csv_preamble from a GET /api/admin/company body, or null when it is not one quoted cell per line. */
export function csvPreambleOf(profile: unknown): string[] | null {
  const lines = (profile as { csv_preamble?: unknown } | null | undefined)?.csv_preamble;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  return lines.every((l) => typeof l === 'string' && QUOTED_CELL.test(l)) ? (lines as string[]) : null;
}

/**
 * `body` under the preamble: its lines, exactly one blank line, then the body,
 * every line ending CRLF as the checkpoint CSV's do. No preamble: `body` as it is.
 */
export function withCsvPreamble(lines: string[] | null, body: string): string {
  return lines ? `${lines.join('\r\n')}\r\n\r\n${body}` : body;
}
