/**
 * Colours and A4 geometry for every pdfkit export.
 *
 * Moved verbatim from theme.ts, which re-exports all of them, so the company
 * letterhead (services/letterhead/pdf.ts) can share them without importing
 * theme.ts, which imports the letterhead.
 */

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
