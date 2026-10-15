/**
 * The company letterhead in an exceljs workbook (Phase B, B1; Vishnu's
 * decision 1a, 2026-10-07: a block on the sheet, plus print chrome).
 *
 * writeLetterheadBlock(): rows 1-4 of a sheet, always four rows whatever the
 * profile holds, so no cell below them moves with the profile. The logo sits
 * in column A, in the PDF letterhead's 110 x 46 pt box at 96 dpi
 * (147 x 61 px), aspect kept; the company name and up to three contact lines
 * (letterhead/text.ts, the lines the PDF prints) sit beside it in column B,
 * or in `textColumnWithLogo` where column A is too narrow to hold the logo
 * (the analytics workbook keeps its default widths and uses D). With no logo
 * the text starts in column A.
 *
 * Every line is written through neutralizeFormula() (N171), so the block is
 * safe in any workbook. A contact line that starts with a phone a spreadsheet
 * would read as a formula ("+1 …") is labelled "Tel" instead, so a phone number
 * never shows the apostrophe; "(408) …" and other lines are written as they are.
 *
 * The logo is checked again here (N167). services/letterhead only hands over
 * bytes that checkImageDecodes() accepted, but exceljs embeds whatever it is
 * given verbatim, and Excel would open a broken picture; one decode per
 * workbook makes this renderer safe on its own.
 *
 * stampPrintChrome(): every sheet prints with the company at the top left and
 * the title at the top right, and "Confidential — <company>", the page number
 * and "Powered by NetraOps" along the bottom. Header and footer codes start
 * with &, so a literal & is written &&. In the footer a long company name is
 * cut with an ellipsis (N193, footerCompany below).
 */
import type ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Letterhead } from './types';
import { contactLines } from './text';
import { checkImageDecodes } from '../imageDecode';
import { neutralizeFormula, readsAsFormula } from '../spreadsheetSafe';

const NAVY = 'FF0B1526';

/** The image id each workbook holds the logo under, so a workbook that letters several sheets embeds it once. */
const logoIds = new WeakMap<ExcelJS.Workbook, Map<Buffer, number>>();
function logoId(wb: ExcelJS.Workbook, logo: Buffer, extension: 'png' | 'jpeg'): number {
  let ids = logoIds.get(wb);
  if (!ids) logoIds.set(wb, (ids = new Map()));
  let id = ids.get(logo);
  if (id === undefined) ids.set(logo, (id = wb.addImage({ buffer: logo as unknown as ExcelJS.Buffer, extension })));
  return id;
}
const MUTED = 'FF64748B';
const LOGO_BOX_PX = { w: 147, h: 61 };

/** Rows the block always occupies; a sheet's own content starts below them. */
export const LETTERHEAD_ROWS = 4;

export function writeLetterheadBlock(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, lh: Letterhead,
  { textColumnWithLogo = 2 }: { textColumnWithLogo?: number } = {}): void {
  let textCol = 1;
  const decoded = lh.logo ? checkImageDecodes(lh.logo) : null;
  if (lh.logo && decoded?.ok) {
    const scale = Math.min(LOGO_BOX_PX.w / decoded.width, LOGO_BOX_PX.h / decoded.height);
    const image = logoId(wb, lh.logo, decoded.kind);
    ws.addImage(image, {
      tl: { col: 0.08, row: 0.15 },
      ext: { width: Math.round(decoded.width * scale), height: Math.round(decoded.height * scale) },
      editAs: 'oneCell',
    });
    textCol = textColumnWithLogo;
  }
  ws.getRow(1).height = 24;
  for (let r = 2; r <= LETTERHEAD_ROWS; r++) ws.getRow(r).height = 15;
  const name = ws.getRow(1).getCell(textCol);
  name.value = neutralizeFormula(lh.companyName);
  name.font = { bold: true, size: 16, color: { argb: NAVY } };
  name.alignment = { vertical: 'middle' };
  contactLines(lh).forEach((line, i) => {
    const cell = ws.getRow(2 + i).getCell(textCol);
    const labelled = lh.phone && line.startsWith(lh.phone) && readsAsFormula(line) ? `Tel ${line}` : line;
    cell.value = neutralizeFormula(labelled);
    cell.font = { size: 9, color: { argb: MUTED } };
  });
}

/** Excel header/footer codes start with &; a literal one is &&. */
const hf = (s: string): string => s.replace(/&/g, '&&');

/**
 * N193. Excel draws a footer's three sections independently, so a long company
 * name in "Confidential — <company>" (left) ran into "Page n of N" (centre):
 * from about 50 characters, measured through Excel's PDF export on 2026-10-13
 * with B1's 75-character fixture. The name is cut with an ellipsis, the way the
 * PDF letterhead cuts it (pdf.ts, fitText), so that the whole left section is
 * at most FOOTER_LEFT_MAX_PT wide. Measured in Helvetica at the footer's 8 pt,
 * which is wider than the Calibri Excel prints it in, so the budget holds with
 * room to spare on Excel's default portrait page, which these workbooks use.
 */
export const FOOTER_LEFT_MAX_PT = 230;
const FOOTER_LEAD = 'Confidential — ';
let footerWidth: ((s: string) => number) | null = null;

/** The company name as the footer prints it: whole when it fits, otherwise cut with an ellipsis. */
export function footerCompany(name: string): string {
  if (!footerWidth) {
    const doc = new PDFDocument({ autoFirstPage: false });
    doc.font('Helvetica').fontSize(8);
    footerWidth = (s) => doc.widthOfString(s);
  }
  const width = footerWidth;
  if (width(`${FOOTER_LEAD}${name}`) <= FOOTER_LEFT_MAX_PT) return name;
  let lo = 0;
  let hi = name.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (width(`${FOOTER_LEAD}${name.slice(0, mid).trimEnd()}…`) <= FOOTER_LEFT_MAX_PT) lo = mid;
    else hi = mid - 1;
  }
  return `${name.slice(0, lo).trimEnd()}…`;
}

export function stampPrintChrome(wb: ExcelJS.Workbook, lh: Letterhead, title: string): void {
  const company = hf(lh.companyName);
  wb.eachSheet((ws) => {
    ws.headerFooter.oddHeader = `&L&B${company}&R${hf(title)}`;
    ws.headerFooter.oddFooter = `&L&8${FOOTER_LEAD}${hf(footerCompany(lh.companyName))}&C&8Page &P of &N&R&8Powered by NetraOps`;
  });
}
