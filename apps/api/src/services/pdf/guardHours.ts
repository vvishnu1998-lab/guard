/**
 * Guard Hours PDF — a guard's own per-session hours over a date range.
 *
 * ── WHAT THIS DOCUMENT IS, AND IS NOT ───────────────────────────────────
 *
 * It is an informational summary a guard can retrieve for themselves. It is
 * NOT a wage statement: it carries no rate, no gross/net, no deductions, and
 * it is not generated from payroll. HOURS_DISCLAIMER below says so on every
 * copy, and that wording is PENDING ATTORNEY REVIEW — which is exactly why
 * it is one exported constant and not inlined at the render site.
 *
 * ── NUMBERS COME FROM ONE PLACE ─────────────────────────────────────────
 *
 * Every figure is the 4-field contract from services/shiftHours.ts, read via
 * SHIFT_HOURS_SQL_FIELDS and rendered with that module's own formatters.
 * shift_sessions.total_hours is deliberately NOT read: its formula changed at
 * the 2026-08-29 paid-break cutover, so a 45-day window can straddle two
 * different definitions, and a document that mixed them would be
 * self-inconsistent in a way no reader could detect.
 *
 * BREAK IS PAID AND ALREADY INCLUDED IN ACTUAL. The Break column is shown for
 * transparency, not as something to subtract. FOOTNOTE_BREAK_PAID says so,
 * because four adjacent hour columns otherwise read like an arithmetic
 * problem the reader is meant to solve.
 *
 * ── WHY SCHEDULED IS NOT TOTALLED ───────────────────────────────────────
 *
 * scheduled_hours is a property of the SHIFT; SHIFT_HOURS_SQL_FIELDS emits it
 * per SESSION. A shift handed off mid-shift produces two session rows that
 * each carry the FULL scheduled window, so summing the column over-counts.
 * services/shiftHours.ts:209 documents the same hazard and is why
 * SHIFT_HOURS_AGG_SQL_FIELDS omits scheduled_hours entirely.
 *
 * An earlier draft of this feature suppressed the total on the grounds that
 * some sessions lack a scheduled window. That was wrong and is recorded here
 * so it is not reintroduced: shifts.scheduled_start and scheduled_end are
 * both NOT NULL, and zero rows in prod have a zero-length window, so the
 * absent-window case cannot occur.
 */

import PDFDocument from 'pdfkit';
import type { Writable } from 'stream';
import {
  NAVY, WHITE, AMBER, GRAY1, GRAY2, TEXT, MUTED,
  PAGE_W, ML, MR, CW,
  CONTENT_TOP, CONTENT_BOTTOM,
  drawGuardFooter, stampPages,
} from './theme';
import {
  formatHoursHHMM, formatOffPostHours, formatScheduledHours,
} from '../shiftHours';

/**
 * PENDING ATTORNEY REVIEW — treat this wording as provisional.
 *
 * One constant, exported, referenced once at the render site. When counsel
 * returns comments this is the only thing that changes; nothing else in this
 * file encodes the wording, and no other module reproduces it.
 */
export const HOURS_DISCLAIMER = {
  title: 'Informational summary — not a wage statement.',
  body:
    'This summary is provided for your information only. It is not a wage statement and is not a ' +
    'substitute for the records maintained by your employer. It contains no wage, pay-rate, or ' +
    'deduction information, and the hours shown may differ from those used to calculate your pay. ' +
    'For any question about your pay, contact your employer directly.',
} as const;

/** Break is paid and already inside Actual — say so, or the columns read as a sum to work out. */
export const FOOTNOTE_BREAK_PAID =
  'Breaks are paid and are already included in Actual hours. The Break column is shown separately ' +
  'for transparency; it should not be subtracted.';

/** Why the Scheduled column has an em dash where a total would be. */
export const FOOTNOTE_SCHEDULED_NOT_TOTALLED =
  'Scheduled hours are not totalled. A shift handed off mid-shift appears as two rows sharing one ' +
  'scheduled window, so the column would over-count.';

/** Hard ceiling on the requested range. Enforced by the route, restated here
 *  so the two cannot drift apart silently. */
export const MAX_RANGE_DAYS = 45;

export interface GuardHoursRow {
  /** shift_sessions.id — not rendered, used for stable ordering and tests. */
  session_id: string;
  clocked_in_at: Date | string;
  site_name: string;
  scheduled_hours: number | string;
  actual_hours: number | string;
  break_hours: number | string;
  violation_hours: number | string;
}

export interface GuardHoursDoc {
  guardName: string;
  badgeNumber: string | null;
  /** companies.name — the employer, reached via sites -> companies. */
  employer: string;
  /** Inclusive calendar bounds as the guard chose them, YYYY-MM-DD. */
  from: string;
  to: string;
  /** IANA zone the dates are rendered in. */
  timeZone: string;
  rows: GuardHoursRow[];
  generatedAt: Date;
}

// ── Column geometry ───────────────────────────────────────────────────────
// Widths sum to CW (495) exactly; a mismatch shows up immediately as a
// right edge that does not meet the rule above the totals row.
const COLS = [
  { key: 'date',      label: 'DATE',      w:  72, align: 'left'  as const },
  { key: 'site',      label: 'SITE',      w: 157, align: 'left'  as const },
  { key: 'scheduled', label: 'SCHEDULED', w:  64, align: 'right' as const },
  { key: 'actual',    label: 'ACTUAL',    w:  64, align: 'right' as const },
  { key: 'break',     label: 'BREAK',     w:  64, align: 'right' as const },
  { key: 'offpost',   label: 'OFF-POST',  w:  74, align: 'right' as const },
];
const ROW_H = 18;
const HEADER_ROW_H = 20;

function colX(i: number): number {
  let x = ML;
  for (let k = 0; k < i; k++) x += COLS[k].w;
  return x;
}

function num(v: number | string): number {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
}

function fmtDate(d: Date | string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB',
      { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz }).format(new Date(d));
  } catch {
    return new Intl.DateTimeFormat('en-GB',
      { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(d));
  }
}

/** Truncate to fit a column so a long site name cannot bleed into the next. */
function fit(doc: InstanceType<typeof PDFDocument>, s: string, w: number): string {
  if (doc.widthOfString(s) <= w - 8) return s;
  let out = s;
  while (out.length > 1 && doc.widthOfString(out + '…') > w - 8) out = out.slice(0, -1);
  return out + '…';
}

/** The repeating column-header strip. Drawn on every page. */
function drawTableHeader(doc: InstanceType<typeof PDFDocument>, y: number): number {
  doc.rect(ML, y, CW, HEADER_ROW_H).fill(NAVY);
  doc.fontSize(7.5).font('Helvetica-Bold').fillColor(WHITE);
  COLS.forEach((c, i) => {
    doc.text(c.label, colX(i) + 4, y + 6.5, { width: c.w - 8, align: c.align, lineBreak: false });
  });
  return y + HEADER_ROW_H;
}

/**
 * Render the document into `sink` (an Express response, or a file stream in
 * tests). Returns when the document has been fully written.
 *
 * Streams — never buffers the finished PDF into memory. Matches
 * routes/clientPortal.ts:486. `bufferPages` buffers PAGE OBJECTS so the page
 * count can be known before the chrome is stamped; it is not the same thing
 * as buffering the output.
 */
export function renderGuardHoursPdf(data: GuardHoursDoc, sink: Writable): Promise<void> {
  const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true, bufferPages: true });
  const done = new Promise<void>((resolve, reject) => {
    sink.on('finish', () => resolve());
    sink.on('error', reject);
    doc.on('error', reject);
  });
  doc.pipe(sink);

  const period = `${fmtDate(data.from + 'T12:00:00Z', data.timeZone)} — ${fmtDate(data.to + 'T12:00:00Z', data.timeZone)}`;

  // ── Identity block — PAGE 1 ONLY ────────────────────────────────────────
  let y = CONTENT_TOP;
  doc.fontSize(22).fillColor(TEXT).font('Helvetica-Bold').text(data.guardName, ML, y);
  y += 28;
  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text(
       [data.badgeNumber ? `Badge ${data.badgeNumber}` : null, data.employer]
         .filter(Boolean).join('   |   '),
       ML, y);
  y += 18;
  doc.fontSize(10).fillColor(MUTED)
     .text(`Period: ${period}`, ML, y);
  y += 15;
  doc.fontSize(8).fillColor(MUTED)
     .text(`Generated ${fmtDate(data.generatedAt, data.timeZone)} · ${data.rows.length} shift${data.rows.length === 1 ? '' : 's'}`, ML, y);
  y += 22;
  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(1).stroke();
  y += 14;

  // ── Table ───────────────────────────────────────────────────────────────
  y = drawTableHeader(doc, y);

  if (data.rows.length === 0) {
    doc.rect(ML, y, CW, 40).fill(GRAY1);
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text('No shifts recorded in this period.', ML, y + 15, { width: CW, align: 'center' });
    y += 40;
  }

  let totalActual = 0, totalBreak = 0, totalOffPost = 0;

  data.rows.forEach((r, idx) => {
    // Page break BEFORE drawing, so a row is never clipped, and repeat the
    // column header on the new page. The identity block is page 1 only.
    if (y + ROW_H > CONTENT_BOTTOM) {
      doc.addPage();
      y = drawTableHeader(doc, CONTENT_TOP);
    }
    if (idx % 2 === 1) doc.rect(ML, y, CW, ROW_H).fill(GRAY1);

    const offPost = num(r.violation_hours);
    totalActual  += num(r.actual_hours);
    totalBreak   += num(r.break_hours);
    totalOffPost += offPost;

    const cells = [
      fmtDate(r.clocked_in_at, data.timeZone),
      r.site_name,
      formatScheduledHours(r.scheduled_hours),
      formatHoursHHMM(r.actual_hours),
      formatHoursHHMM(r.break_hours),
      formatOffPostHours(r.violation_hours),
    ];

    doc.fontSize(8.5).font('Helvetica');
    cells.forEach((text, i) => {
      // Off-post is the only column that carries a status colour: muted when
      // "None" so a clean shift does not read as a defect, amber when real.
      const isOffPost = COLS[i].key === 'offpost';
      doc.fillColor(isOffPost ? (offPost > 0 ? AMBER : MUTED) : TEXT);
      if (isOffPost && offPost > 0) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
      doc.text(fit(doc, text, COLS[i].w), colX(i) + 4, y + 5.5,
               { width: COLS[i].w - 8, align: COLS[i].align, lineBreak: false });
    });
    y += ROW_H;
  });

  // ── Totals ──────────────────────────────────────────────────────────────
  if (y + ROW_H + 6 > CONTENT_BOTTOM) { doc.addPage(); y = drawTableHeader(doc, CONTENT_TOP); }
  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(NAVY).lineWidth(1).stroke();
  y += 4;
  doc.rect(ML, y, CW, ROW_H + 2).fill('#EEF2F7');
  const totals = [
    `${data.rows.length} shift${data.rows.length === 1 ? '' : 's'}`,
    'TOTAL',
    '—',                            // Scheduled deliberately suppressed
    formatHoursHHMM(totalActual),
    formatHoursHHMM(totalBreak),
    formatOffPostHours(totalOffPost),
  ];
  doc.fontSize(8.5).font('Helvetica-Bold');
  totals.forEach((text, i) => {
    const isOffPost = COLS[i].key === 'offpost';
    doc.fillColor(isOffPost ? (totalOffPost > 0 ? AMBER : MUTED) : TEXT);
    doc.text(text, colX(i) + 4, y + 6, { width: COLS[i].w - 8, align: COLS[i].align, lineBreak: false });
  });
  y += ROW_H + 12;

  // ── Footnotes ───────────────────────────────────────────────────────────
  const noteW = CW;
  const noteText = `${FOOTNOTE_SCHEDULED_NOT_TOTALLED}\n${FOOTNOTE_BREAK_PAID}`;
  doc.fontSize(7.5).font('Helvetica').fillColor(MUTED);
  const noteH = doc.heightOfString(noteText, { width: noteW });
  if (y + noteH > CONTENT_BOTTOM) { doc.addPage(); y = CONTENT_TOP; }
  doc.text(noteText, ML, y, { width: noteW });
  y += noteH + 16;

  // ── Disclaimer — KEPT TOGETHER, never split across a page ───────────────
  // Measured in full (title + body + padding) before anything is drawn; if it
  // does not fit in what remains, the whole block moves to a fresh page. A
  // legal notice split mid-sentence across a page boundary is the failure
  // this avoids.
  doc.fontSize(9).font('Helvetica-Bold');
  const dTitleH = doc.heightOfString(HOURS_DISCLAIMER.title, { width: CW - 24 });
  doc.fontSize(7.5).font('Helvetica');
  const dBodyH = doc.heightOfString(HOURS_DISCLAIMER.body, { width: CW - 24 });
  const dBoxH = dTitleH + dBodyH + 26;
  if (y + dBoxH > CONTENT_BOTTOM) { doc.addPage(); y = CONTENT_TOP; }

  doc.rect(ML, y, CW, dBoxH).fill(GRAY1);
  doc.rect(ML, y, 3, dBoxH).fill(AMBER);
  doc.fontSize(9).font('Helvetica-Bold').fillColor(TEXT)
     .text(HOURS_DISCLAIMER.title, ML + 14, y + 9, { width: CW - 24 });
  doc.fontSize(7.5).font('Helvetica').fillColor(MUTED)
     .text(HOURS_DISCLAIMER.body, ML + 14, y + 9 + dTitleH + 5, { width: CW - 24 });

  // ── Chrome last, now that the page count is known ───────────────────────
  stampPages(doc, 'GUARD HOURS', (d) =>
    drawGuardFooter(d, data.guardName, data.badgeNumber, period));
  doc.end();
  return done;
}

/** netraops-hours-<guard-name-slug>-<start>-to-<end>.pdf */
export function guardHoursFilename(guardName: string, from: string, to: string): string {
  const slug = guardName
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'guard';
  return `netraops-hours-${slug}-${from}-to-${to}.pdf`;
}
