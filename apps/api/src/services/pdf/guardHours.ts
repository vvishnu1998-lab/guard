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

/**
 * What the Geofence violation column measures, and — as importantly — what it
 * does not.
 *
 * The heading has now been through three names: "Off-post" until 2026-08-30,
 * then "Unverified", now "Geofence violation" at the customer's request
 * (Nataniel, STARNET). Each rename made the heading assert MORE than the data
 * supports, and this one asserts the most: a boundary crossing. The underlying
 * measurement never changed — it is still "ping windows inside an open
 * boundary alert that received no check-in", which a guard standing on post
 * with a dead phone accrues just as fast as one who walked away.
 *
 * THE SECOND SENTENCE IS LOAD BEARING AND MUST NOT BE SHORTENED. It is the
 * only thing on the page standing between the heading's claim and the reader's
 * conclusion. Wording locked by dispatch V5.4 — change it only on the record.
 */
export const FOOTNOTE_GEOFENCE_VIOLATION =
  'Geofence violation hours count ping windows spanned by an open boundary alert in which no ' +
  'location check-in was received. A guard who is at the post but does not check in accrues time ' +
  'in this column, so it is not a confirmed measure of time away from the post.';

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
  /** null while the session is still open. */
  clocked_out_at: Date | string | null;
  /** The SHIFT's window — rendered as the Scheduled cell's first line. Both
   *  columns are NOT NULL in schema, so neither can be absent. */
  scheduled_start: Date | string;
  scheduled_end: Date | string;
  /** V5.5 — this guard handed the shift to someone else mid-shift. */
  handed_off: boolean;
  /** V5.5 — this guard took the shift over from someone else mid-shift. */
  took_over: boolean;
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
// Widths re-cut for V5: SCHEDULED now carries a time RANGE rather than a
// single duration ("10:00 AM – 10:00 PM" measures 78pt at 8pt Helvetica, so
// 64 could not hold it), and the heading "GEOFENCE VIOLATION" measures 84pt
// at 7.5pt Helvetica-Bold against the 66pt of usable space the old 74-wide
// column had. Both were measured, not estimated. SITE gives up the room; the
// longest production site name is "william pen hotel" at 63pt, and fit()
// still truncates anything longer.
//
// Key stays 'offpost' — see the note on the heading rename below.
const COLS = [
  { key: 'date',      label: 'DATE',      w:  68, align: 'left'  as const },
  { key: 'site',      label: 'SITE',      w: 130, align: 'left'  as const },
  { key: 'scheduled', label: 'SCHEDULED', w:  90, align: 'right' as const },
  { key: 'actual',    label: 'ACTUAL',    w:  54, align: 'right' as const },
  { key: 'break',     label: 'BREAK',     w:  54, align: 'right' as const },
  // V5.3 — DISPLAY STRING ONLY. The key stays 'offpost' and the wire field
  // stays violation_hours / h_violation / offpost_hours, because Build 48 is
  // in TestFlight parsing those names. Renaming the key here would be a
  // silent client break for zero reader benefit.
  { key: 'offpost',   label: 'GEOFENCE VIOLATION', w: 99, align: 'right' as const },
];
// 24, not 18: the Scheduled cell is now two stacked lines (window, then
// duration). Every other column stays single-line and centres against them.
const ROW_H = 24;
const HEADER_ROW_H = 20;
/** Scheduled line 1 / line 2 / every other column, as offsets within a row. */
const SCHED_L1_DY = 4, SCHED_L2_DY = 13.5, CELL_DY = 7.5;

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

/**
 * Clock time in the document's zone — "8:00 AM".
 *
 * en-US, not the en-GB used for dates: en-GB renders the meridiem lowercase
 * ("8:00 am") and the locked mock is uppercase.
 */
function fmtTime(d: Date | string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US',
      { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz }).format(new Date(d));
  } catch {
    return new Intl.DateTimeFormat('en-US',
      { hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(d));
  }
}

/** "26 Aug" — the short form the handover remarks open with. */
function fmtDayShort(d: Date | string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB',
      { day: '2-digit', month: 'short', timeZone: tz }).format(new Date(d));
  } catch {
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short' }).format(new Date(d));
  }
}

/**
 * V5.5 — the handover sentences for one row, in the order they happened.
 *
 * A row can produce TWO sentences. A shift passed A -> B -> C leaves B with a
 * single session that was both taken over and handed off, and B is entitled to
 * both halves of that story; took-over is emitted first because it happened
 * first. The A -> B -> A case is different and needs no special handling here:
 * it gives A two SEPARATE session rows, and each one independently renders its
 * own single correct sentence.
 *
 * Times come from this guard's OWN session record — clocked_in_at for a
 * take-over, clocked_out_at for a hand-off — never from the other guard's
 * session, so a row can always be explained from the row itself.
 */
function handoverRemarks(r: GuardHoursRow, tz: string): string[] {
  const out: string[] = [];
  const day = fmtDayShort(r.clocked_in_at, tz);
  const tail =
    ' Scheduled shows the full shift window; Actual shows only the hours you worked.';
  if (r.took_over) {
    out.push(`${day} — you took over this shift from another guard at ` +
             `${fmtTime(r.clocked_in_at, tz)}.${tail}`);
  }
  if (r.handed_off && r.clocked_out_at) {
    out.push(`${day} — this shift was handed over to another guard at ` +
             `${fmtTime(r.clocked_out_at, tz)}.${tail}`);
  }
  return out;
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

  // ── Measure the tail BEFORE laying out any row ─────────────────────────
  //
  // Everything after the last row — the totals band, the footnotes and the
  // disclaimer — is a single indivisible block whose height does not depend
  // on the rows. Measuring it up front lets the row loop RESERVE space for
  // it, which is what stops the disclaimer being stranded alone on an
  // otherwise blank final page.
  //
  // Tightening row height or padding does NOT solve that. It only moves the
  // threshold: whatever the numbers, some row count lands so that the tail
  // misses the page by a few points. Observed directly — with ROW_H 18 a
  // 26-row report stranded the disclaimer; at ROW_H 17 the 26-row case fit
  // and a 30-row report stranded it instead. The fix has to be structural.
  //
  // V5.5 adds a variable-height block: the handover remarks. They are built
  // in a PRE-PASS rather than accumulated during the row loop, because the
  // reservation has to know their height before the first row is placed.
  const remarks = data.rows.flatMap((r) => handoverRemarks(r, data.timeZone));
  const remarkText = remarks.map((t) => `†  ${t}`).join('\n');
  const noteText = `${FOOTNOTE_SCHEDULED_NOT_TOTALLED}\n${FOOTNOTE_BREAK_PAID}\n${FOOTNOTE_GEOFENCE_VIOLATION}`;
  doc.fontSize(7.5).font('Helvetica');
  const noteH = doc.heightOfString(noteText, { width: CW });
  const remarkH = remarks.length ? doc.heightOfString(remarkText, { width: CW }) + 10 : 0;
  doc.fontSize(9).font('Helvetica-Bold');
  const dTitleH = doc.heightOfString(HOURS_DISCLAIMER.title, { width: CW - 24 });
  doc.fontSize(7.5).font('Helvetica');
  const dBodyH = doc.heightOfString(HOURS_DISCLAIMER.body, { width: CW - 24 });
  const dBoxH = dTitleH + dBodyH + 26;
  //  rule + totals band + gap        footnotes + gap      disclaimer
  const tailH = (4 + ROW_H + 2 + 12) + (noteH + 16) + remarkH + dBoxH;

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
    // The final row reserves the tail as well, so the totals/footnotes/
    // disclaimer block is pulled onto this page with it rather than landing
    // alone on the next one. Guarded: if a page could not hold one row plus
    // the tail at all, fall back to breaking on the row alone rather than
    // looping forever.
    const isLast = idx === data.rows.length - 1;
    const tailFitsOnAPage = CONTENT_TOP + HEADER_ROW_H + ROW_H + tailH <= CONTENT_BOTTOM;
    const need = ROW_H + (isLast && tailFitsOnAPage ? tailH : 0);
    if (y + need > CONTENT_BOTTOM) {
      doc.addPage();
      y = drawTableHeader(doc, CONTENT_TOP);
    }
    if (idx % 2 === 1) doc.rect(ML, y, CW, ROW_H).fill(GRAY1);

    const offPost = num(r.violation_hours);
    totalActual  += num(r.actual_hours);
    totalBreak   += num(r.break_hours);
    totalOffPost += offPost;

    // V5.5 — a dagger on the date ties this row to its remark below. Marked
    // whenever the shift changed hands in EITHER direction; the remark says
    // which, the mark only says "there is something to read about this row".
    const marked = r.took_over || r.handed_off;
    const cells = [
      fmtDate(r.clocked_in_at, data.timeZone) + (marked ? '  †' : ''),
      r.site_name,
      '',                                   // scheduled — drawn separately, two lines
      formatHoursHHMM(r.actual_hours),
      formatHoursHHMM(r.break_hours),
      formatOffPostHours(r.violation_hours),
    ];

    doc.fontSize(8.5).font('Helvetica');
    cells.forEach((text, i) => {
      if (COLS[i].key === 'scheduled') return;
      // Geofence violation is the only column that carries a status colour:
      // muted when "None" so a clean shift does not read as a defect, amber
      // when real.
      const isOffPost = COLS[i].key === 'offpost';
      doc.fillColor(isOffPost ? (offPost > 0 ? AMBER : MUTED) : TEXT);
      if (isOffPost && offPost > 0) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
      doc.text(fit(doc, text, COLS[i].w), colX(i) + 4, y + CELL_DY,
               { width: COLS[i].w - 8, align: COLS[i].align, lineBreak: false });
    });

    // ── V5.1 Scheduled: the window, then the duration beneath it ──────────
    // The duration is the same number the column carried before this change;
    // it moves to a second, smaller, muted line rather than being dropped, so
    // nothing a reader could previously total has gone away.
    const sIdx = COLS.findIndex((c) => c.key === 'scheduled');
    const sX = colX(sIdx) + 4, sW = COLS[sIdx].w - 8;
    const window = `${fmtTime(r.scheduled_start, data.timeZone)} – ${fmtTime(r.scheduled_end, data.timeZone)}`;
    doc.fontSize(8).font('Helvetica').fillColor(TEXT)
       .text(fit(doc, window, COLS[sIdx].w), sX, y + SCHED_L1_DY,
             { width: sW, align: 'right', lineBreak: false });
    doc.fontSize(6.5).font('Helvetica').fillColor(MUTED)
       .text(formatScheduledHours(r.scheduled_hours), sX, y + SCHED_L2_DY,
             { width: sW, align: 'right', lineBreak: false });

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
  // Height already measured above; the row loop reserved room for it.
  doc.fontSize(7.5).font('Helvetica').fillColor(MUTED);
  if (y + noteH > CONTENT_BOTTOM) { doc.addPage(); y = CONTENT_TOP; }
  doc.text(noteText, ML, y, { width: CW });
  y += noteH + 16;

  // ── V5.5 handover remarks ───────────────────────────────────────────────
  // Height reserved above. Rendered after the general footnotes because they
  // are specific to individual rows rather than to the document.
  if (remarks.length) {
    doc.fontSize(7.5).font('Helvetica').fillColor(TEXT);
    doc.text(remarkText, ML, y, { width: CW });
    y += remarkH;
  }

  // ── Disclaimer — KEPT TOGETHER, never split across a page ───────────────
  // Measured in full (title + body + padding) before anything is drawn; if it
  // does not fit in what remains, the whole block moves to a fresh page. A
  // legal notice split mid-sentence across a page boundary is the failure
  // this avoids.
  // dTitleH / dBodyH / dBoxH measured above. The addPage here is now a
  // backstop only — the row loop's reservation should already have made room
  // — but it stays, because the never-split rule must hold even if the
  // reservation is ever bypassed (e.g. a zero-row report).
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
