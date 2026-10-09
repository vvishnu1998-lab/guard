/**
 * The letterhead's text lines, shared by every surface that prints them (the
 * PDF header, the XLSX block, the CSV preamble), so all of them say the same
 * thing in the same order. Moved out of pdf.ts unchanged in B1.
 */
import type { Letterhead } from './types';

/**
 * Up to three lines for under the company name, each skipped when empty:
 * the address on one line; phone · email · website (protocol and trailing
 * slash dropped); "License No. …" (US spelling; the column is licence_number).
 */
export function contactLines(lh: Letterhead): string[] {
  const address = (lh.address ?? '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(', ');
  const website = (lh.website ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const reach = [lh.phone ?? '', lh.contactEmail ?? '', website].filter(Boolean).join('  ·  ');
  const license = lh.licenceNumber ? `License No. ${lh.licenceNumber}` : '';
  return [address, reach, license].filter(Boolean);
}
