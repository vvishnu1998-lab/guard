/**
 * The company letterhead in a pdfkit document: header band and footer band.
 * Layout (a), approved 2026-10-06; decision 5a, the company leads and
 * NetraOps appears only as "Powered by NetraOps".
 *
 * Called by pdf/theme.ts when a caller passes a Letterhead (`lh`); with no
 * letterhead, theme.ts draws today's NetraOps chrome and never comes here.
 * B0 ships this unused: no caller passes `lh` yet.
 *
 * HEADER (y 0..72, the same band the NetraOps header uses, so no page body
 * moves): white; logo at the left in a 110 × 46 box, aspect kept; the company
 * name beside it (15 pt, shrinking to 10 pt, then cut with an ellipsis);
 * up to three contact lines under the name — the address on one line;
 * phone · email · website; "License No." — each skipped when empty, each cut
 * with an ellipsis rather than wrapped; the document title and "n / N" at the
 * right; a grey rule at y 70. With no logo (none, or one that would not
 * decode) the name starts at the margin. With no contact lines the name sits
 * mid-band.
 *
 * FOOTER (y PAGE_H-30..PAGE_H, as today): "<lead>  |  Confidential — <company>"
 * and "Powered by NetraOps" under it.
 *
 * Every string is measured and cut to fit its width before it is drawn, so no
 * field, however long, can wrap into the body or push text past the page end.
 */
import PDFDocument from 'pdfkit';
import { NAVY, GRAY2, MUTED, PAGE_W, PAGE_H, ML, MR, CW } from '../pdf/palette';
import type { Letterhead } from './types';

type Doc = InstanceType<typeof PDFDocument>;

const LOGO_BOX = { x: ML, y: 12, w: 110, h: 46 };
const RULE_Y = 70;

// One embedded image per document however many pages draw it: pdfkit writes
// an image once per object it is given, so the opened image is kept per doc.
// openImage() parses synchronously, and any failure there leaves the name
// standing alone (the logo was already proven to decode; this is a backstop).
const openedLogo = new WeakMap<Doc, { src: Buffer; img: { width: number; height: number } | null }>();
function logoImage(doc: Doc, src: Buffer): { width: number; height: number } | null {
  const hit = openedLogo.get(doc);
  if (hit && hit.src === src) return hit.img;
  let img: { width: number; height: number } | null = null;
  try {
    img = (doc as unknown as { openImage(b: Buffer): { width: number; height: number } }).openImage(src);
  } catch {
    img = null;
  }
  openedLogo.set(doc, { src, img });
  return img;
}

/** `s` cut with an ellipsis to fit `maxW` in the doc's current font and size. */
function fitText(doc: Doc, s: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (doc.widthOfString(s) <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (doc.widthOfString(`${s.slice(0, mid).trimEnd()}…`) <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return lo > 0 ? `${s.slice(0, lo).trimEnd()}…` : '';
}

function contactLines(lh: Letterhead): string[] {
  const address = (lh.address ?? '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(', ');
  const website = (lh.website ?? '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const reach = [lh.phone ?? '', lh.contactEmail ?? '', website].filter(Boolean).join('  ·  ');
  const license = lh.licenceNumber ? `License No. ${lh.licenceNumber}` : '';
  return [address, reach, license].filter(Boolean);
}

export function drawLetterheadHeader(doc: Doc, title: string, pageNum: number, totalPages: number, lh: Letterhead): void {
  const right = PAGE_W - ML;
  doc.fontSize(12).font('Helvetica-Bold');
  const titleW = Math.min(doc.widthOfString(title), 240);
  doc.fillColor(NAVY).text(title, 0, 20, { align: 'right', width: right });
  doc.fontSize(8).font('Helvetica');
  const pages = `${pageNum} / ${totalPages}`;
  const pagesW = doc.widthOfString(pages);
  doc.fillColor(MUTED).text(pages, 0, 37, { align: 'right', width: right });

  let x0 = ML;
  const img = lh.logo ? logoImage(doc, lh.logo) : null;
  if (img) {
    const scale = Math.min(LOGO_BOX.w / img.width, LOGO_BOX.h / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    doc.image(img as never, LOGO_BOX.x, LOGO_BOX.y + (LOGO_BOX.h - h) / 2, { width: w, height: h });
    x0 = ML + w + 12;
  }

  const lines = contactLines(lh);
  const nameMaxW = right - 16 - titleW - x0;
  doc.font('Helvetica-Bold');
  let size = 15;
  while (size > 10 && doc.fontSize(size).widthOfString(lh.companyName) > nameMaxW) size -= 1;
  doc.fontSize(size).fillColor(NAVY)
     .text(fitText(doc, lh.companyName, nameMaxW), x0, lines.length ? 14 : 27, { lineBreak: false });

  doc.fontSize(7.5).font('Helvetica').fillColor(MUTED);
  let y = 34;
  for (const line of lines) {
    // Lines beside the page count stop short of it; the third line has the width.
    const maxW = (y < 48 ? right - 16 - pagesW : right) - x0;
    doc.text(fitText(doc, line, maxW), x0, y, { lineBreak: false });
    y += 10;
  }
  doc.moveTo(ML, RULE_Y).lineTo(MR, RULE_Y).strokeColor(GRAY2).lineWidth(0.75).stroke();
}

export function drawLetterheadFooter(doc: Doc, lead: string, lh: Letterhead): void {
  doc.rect(0, PAGE_H - 30, PAGE_W, 30).fill('#F1F5F9');
  doc.moveTo(ML, PAGE_H - 30).lineTo(MR, PAGE_H - 30).strokeColor(GRAY2).lineWidth(0.5).stroke();
  doc.fontSize(7).fillColor(MUTED).font('Helvetica');
  doc.text(fitText(doc, `${lead}  |  Confidential — ${lh.companyName}`, CW), ML, PAGE_H - 23, { width: CW, align: 'center' });
  doc.fontSize(6).fillColor('#94A3B8');
  doc.text('Powered by NetraOps', ML, PAGE_H - 13, { width: CW, align: 'center' });
}
