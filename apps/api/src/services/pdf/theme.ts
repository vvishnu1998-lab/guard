/**
 * Shared pdfkit palette + primitives for admin/client PDF exports.
 *
 * Extracted verbatim from clientPortal.ts (the "site security report"
 * generator that shipped first). The activity-logs export uses the same
 * NetraOps header/footer and the same colored badges, so pulling these
 * into one module means the two exports can't drift.
 *
 * If a future export needs a different accent, pass a color in — do not
 * fork these helpers.
 *
 * COMPANY LETTERHEAD (Phase B). drawHeader, drawFooter, drawGuardFooter and
 * stampPages take an optional last argument `lh` (services/letterhead). Given
 * one, they draw the company's letterhead in the same bands
 * (letterhead/pdf.ts). Without one (undefined OR null) they draw exactly what
 * they drew before the argument existed: the null path is held byte-identical
 * by scripts/test-letterhead-pdf.ts. B0 adds the argument; no caller passes it.
 */
import PDFDocument from 'pdfkit';
import { NAVY, WHITE, GRAY2, MUTED, PAGE_W, PAGE_H, ML, MR, CW } from './palette';
import { drawLetterheadFooter, drawLetterheadHeader } from '../letterhead/pdf';
import type { Letterhead } from '../letterhead/types';

// Colours and page geometry live in ./palette, shared with the letterhead.
// Re-exported, so every existing import from this module keeps working.
export { NAVY, WHITE, BLUE, RED, AMBER, GRAY1, GRAY2, TEXT, MUTED, PAGE_W, PAGE_H, ML, MR, CW } from './palette';

// ── Helpers ───────────────────────────────────────────────────────────────────
export function drawHeader(
  doc: InstanceType<typeof PDFDocument>,
  title: string,
  pageNum: number,
  totalPages: number,
  lh?: Letterhead | null,
) {
  if (lh) { drawLetterheadHeader(doc, title, pageNum, totalPages, lh); return; }
  doc.rect(0, 0, PAGE_W, 72).fill(NAVY);
  doc.fontSize(18).fillColor(WHITE).font('Helvetica-Bold').text('NetraOps', ML, 18, { lineBreak: false });
  doc.fontSize(9).fillColor('#94A3B8').font('Helvetica').text('SECURITY MANAGEMENT', ML, 40);
  doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold').text(title, 0, 26, { align: 'right', width: PAGE_W - ML });
  doc.fontSize(8).fillColor('#64748B').font('Helvetica').text(`${pageNum} / ${totalPages}`, 0, 44, { align: 'right', width: PAGE_W - ML });
}

export function drawFooter(
  doc: InstanceType<typeof PDFDocument>,
  siteName: string,
  period: string,
  lh?: Letterhead | null,
) {
  if (lh) { drawLetterheadFooter(doc, `${siteName}  |  ${period}`, lh); return; }
  doc.rect(0, PAGE_H - 30, PAGE_W, 30).fill('#F1F5F9');
  doc.moveTo(ML, PAGE_H - 30).lineTo(MR, PAGE_H - 30).strokeColor(GRAY2).lineWidth(0.5).stroke();
  doc.fontSize(7).fillColor(MUTED).font('Helvetica')
     .text(`${siteName}  |  ${period}  |  Confidential — NetraOps`,
           ML, PAGE_H - 20, { width: CW, align: 'center' });
}

/**
 * Footer for a GUARD-scoped document.
 *
 * drawFooter above is site-scoped — `siteName | period` — which is right for
 * the site security report and the activity log, and wrong for a document
 * that spans every site a guard worked. Added rather than parameterised so
 * the two existing callers keep their exact output; per this module's own
 * rule, extend, do not fork.
 */
export function drawGuardFooter(
  doc: InstanceType<typeof PDFDocument>,
  guardName: string,
  badgeNumber: string | null,
  period: string,
  lh?: Letterhead | null,
) {
  const who = badgeNumber ? `${guardName} (${badgeNumber})` : guardName;
  if (lh) { drawLetterheadFooter(doc, `${who}  |  ${period}`, lh); return; }
  doc.rect(0, PAGE_H - 30, PAGE_W, 30).fill('#F1F5F9');
  doc.moveTo(ML, PAGE_H - 30).lineTo(MR, PAGE_H - 30).strokeColor(GRAY2).lineWidth(0.5).stroke();
  doc.fontSize(7).fillColor(MUTED).font('Helvetica')
     .text(`${who}  |  ${period}  |  Confidential — NetraOps`,
           ML, PAGE_H - 20, { width: CW, align: 'center' });
}

/**
 * Stamp the header and footer onto every buffered page, once the real page
 * count is known.
 *
 * WHY THIS EXISTS. drawHeader takes `totalPages` as a literal, and the two
 * existing generators pass a hardcoded number because their page count is
 * fixed by design. A document whose length depends on how many rows the
 * query returned cannot know its own total until layout has finished, so it
 * must be built with `bufferPages: true` and have its chrome applied
 * afterwards.
 *
 * Painting the chrome LAST is safe because the header occupies y 0..72 and
 * the footer y PAGE_H-30..PAGE_H; callers must keep body content inside
 * CONTENT_TOP..CONTENT_BOTTOM, and then nothing overlaps.
 *
 * The caller must still call doc.end(); this only flushes the buffered pages.
 *
 * `lh` goes to drawHeader; the footer closure carries its own.
 */
export function stampPages(
  doc: InstanceType<typeof PDFDocument>,
  title: string,
  footer: (doc: InstanceType<typeof PDFDocument>) => void,
  lh?: Letterhead | null,
) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    drawHeader(doc, title, i + 1, range.count, lh);
    footer(doc);
  }
  doc.flushPages();
}

/** First y a page's body may use — clear of the 72pt navy header band. */
export const CONTENT_TOP = 90;
/** Last y a page's body may use — clear of the 30pt footer band. */
export const CONTENT_BOTTOM = PAGE_H - 46;

export function badge(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number,
  label: string,
  color: string,
  textColor = WHITE,
) {
  // MEASURED, not estimated. This was `label.length * 6 + 12`, which bills
  // every glyph the same 6pt: 'PING' got a 36pt box for 17.1pt of ink, and
  // 'MISSED / ANSWERED LATE' got 144pt for ~94pt. In the activity log that
  // badge starts at x=110 with the guard column at x=220, so the box ended
  // at 254 and painted 34pt of navy over the guard's name — a filled rect
  // carries no text, so pdftotext extracted the page as though nothing were
  // wrong. The precedent for measuring is at clientPortal.ts:869.
  //
  // The font must be set BEFORE widthOfString: it measures in the CURRENT
  // font, so measuring first would have returned Helvetica-at-12 widths.
  doc.fontSize(7).font('Helvetica-Bold');
  const w = doc.widthOfString(label) + 12;
  doc.rect(x, y, w, 14).fill(color);
  doc.fillColor(textColor).text(label, x + 6, y + 3.5, { lineBreak: false });
  return w;
}

export function proportionBar(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number,
  w: number,
  h: number,
  segments: Array<{ value: number; color: string }>,
) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) { doc.rect(x, y, w, h).fill(GRAY2); return; }
  let cx = x;
  for (const seg of segments) {
    const sw = (seg.value / total) * w;
    if (sw > 0) { doc.rect(cx, y, sw, h).fill(seg.color); cx += sw; }
  }
}
