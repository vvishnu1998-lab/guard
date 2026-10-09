/**
 * The company letterhead in an exceljs workbook (Phase B, B1; Vishnu's
 * decision 1a, 2026-10-07: a block on the sheet, plus print chrome).
 *
 * writeLetterheadBlock(): rows 1-4 of a sheet, always four rows whatever the
 * profile holds, so no cell below them moves with the profile. The logo sits
 * in column A, in the PDF letterhead's 110 x 46 pt box at 96 dpi
 * (147 x 61 px), aspect kept; the company name and up to three contact lines
 * (letterhead/text.ts, the lines the PDF prints) sit beside it in column B.
 * With no logo the text starts in column A.
 *
 * The logo is checked again here (N167). services/letterhead only hands over
 * bytes that checkImageDecodes() accepted, but exceljs embeds whatever it is
 * given verbatim, and Excel would open a broken picture; one decode per
 * workbook makes this renderer safe on its own.
 *
 * stampPrintChrome(): every sheet prints with the company at the top left and
 * the title at the top right, and "Confidential — <company>", the page number
 * and "Powered by NetraOps" along the bottom. Header and footer codes start
 * with &, so a literal & is written &&.
 */
import type ExcelJS from 'exceljs';
import type { Letterhead } from './types';
import { contactLines } from './text';
import { checkImageDecodes } from '../imageDecode';

const NAVY = 'FF0B1526';
const MUTED = 'FF64748B';
const LOGO_BOX_PX = { w: 147, h: 61 };

/** Rows the block always occupies; a sheet's own content starts below them. */
export const LETTERHEAD_ROWS = 4;

export function writeLetterheadBlock(wb: ExcelJS.Workbook, ws: ExcelJS.Worksheet, lh: Letterhead): void {
  let textCol = 1;
  const decoded = lh.logo ? checkImageDecodes(lh.logo) : null;
  if (lh.logo && decoded?.ok) {
    const scale = Math.min(LOGO_BOX_PX.w / decoded.width, LOGO_BOX_PX.h / decoded.height);
    const image = wb.addImage({ buffer: lh.logo as unknown as ExcelJS.Buffer, extension: decoded.kind });
    ws.addImage(image, {
      tl: { col: 0.08, row: 0.15 },
      ext: { width: Math.round(decoded.width * scale), height: Math.round(decoded.height * scale) },
      editAs: 'oneCell',
    });
    textCol = 2;
  }
  ws.getRow(1).height = 24;
  for (let r = 2; r <= LETTERHEAD_ROWS; r++) ws.getRow(r).height = 15;
  const name = ws.getRow(1).getCell(textCol);
  name.value = lh.companyName;
  name.font = { bold: true, size: 16, color: { argb: NAVY } };
  name.alignment = { vertical: 'middle' };
  contactLines(lh).forEach((line, i) => {
    const cell = ws.getRow(2 + i).getCell(textCol);
    cell.value = line;
    cell.font = { size: 9, color: { argb: MUTED } };
  });
}

/** Excel header/footer codes start with &; a literal one is &&. */
const hf = (s: string): string => s.replace(/&/g, '&&');

export function stampPrintChrome(wb: ExcelJS.Workbook, lh: Letterhead, title: string): void {
  const company = hf(lh.companyName);
  wb.eachSheet((ws) => {
    ws.headerFooter.oddHeader = `&L&B${company}&R${hf(title)}`;
    ws.headerFooter.oddFooter = `&L&8Confidential — ${company}&C&8Page &P of &N&R&8Powered by NetraOps`;
  });
}
