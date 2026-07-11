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
 */
import PDFDocument from 'pdfkit';

// ── Colors ────────────────────────────────────────────────────────────────────
export const NAVY  = '#0B1526';
export const WHITE = '#FFFFFF';
export const BLUE  = '#2563EB';
export const RED   = '#DC2626';
export const AMBER = '#D97706';
export const GRAY1 = '#F8FAFC';
export const GRAY2 = '#E2E8F0';
export const TEXT  = '#1E293B';
export const MUTED = '#64748B';

// ── Page geometry (A4) ────────────────────────────────────────────────────────
export const PAGE_W = 595;
export const PAGE_H = 842;
export const ML = 50;
export const MR = 545;
export const CW = MR - ML;

// ── Helpers ───────────────────────────────────────────────────────────────────
export function drawHeader(
  doc: InstanceType<typeof PDFDocument>,
  title: string,
  pageNum: number,
  totalPages: number,
) {
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
) {
  doc.rect(0, PAGE_H - 30, PAGE_W, 30).fill('#F1F5F9');
  doc.moveTo(ML, PAGE_H - 30).lineTo(MR, PAGE_H - 30).strokeColor(GRAY2).lineWidth(0.5).stroke();
  doc.fontSize(7).fillColor(MUTED).font('Helvetica')
     .text(`${siteName}  |  ${period}  |  Confidential — NetraOps`,
           ML, PAGE_H - 20, { width: CW, align: 'center' });
}

export function badge(
  doc: InstanceType<typeof PDFDocument>,
  x: number,
  y: number,
  label: string,
  color: string,
  textColor = WHITE,
) {
  const w = label.length * 6 + 12;
  doc.rect(x, y, w, 14).fill(color);
  doc.fontSize(7).fillColor(textColor).font('Helvetica-Bold').text(label, x + 6, y + 3.5, { lineBreak: false });
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
