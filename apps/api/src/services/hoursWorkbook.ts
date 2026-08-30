/**
 * Hours workbook renderer — turns a HoursExportDataset into the four-sheet
 * XLSX that the billing download and the monthly S3 archive both ship.
 *
 * Separate from services/hoursExport.ts on purpose: that module owns the
 * numbers and stays free of a spreadsheet dependency, this one owns
 * presentation and owns NO arithmetic. Every figure below is read off the
 * contract. Before the split, routes/billing.ts and jobs/monthlyHoursReport.ts
 * each carried their own copy and the two had drifted — different clock-in/out
 * headers, and the monthly file had neither the summary block nor the column
 * widths, so a monthly file and an on-demand file for the same range were not
 * the same document.
 *
 * ── WHY exceljs AND NOT xlsx ─────────────────────────────────────────────
 *
 * apps/api carries both, deliberately and temporarily. xlsx@0.18.5 is the
 * SheetJS COMMUNITY build, and it does not write cell styles: setting `.s` on
 * a cell is accepted and then silently discarded — the file writes without
 * error and opens completely unstyled. Probed before this rewrite: the navy
 * never reached styles.xml, cells carried no `s=` attribute, and neither
 * `!freeze` nor `!views` produced a `<pane>` element. Every fill, font and
 * frozen header in the approved design was unreachable on that library, not
 * merely awkward.
 *
 * exceljs writes all of it, verified the same way. routes/exports.ts still
 * uses xlsx for the analytics export and is the only other consumer;
 * migrating it is a separate follow-up, so the two libraries coexist until
 * then.
 *
 * NEITHER library writes charts. exceljs exposes no addChart on the workbook
 * or the worksheet and emits no chart parts. The approved design's two charts
 * are therefore PENDING, and the mitigation is the CHART DATA block on
 * SUMMARY: a contiguous, labelled range so Insert → Chart is two clicks.
 * Hand-injecting chart XML was considered and rejected — a malformed part
 * makes Excel show a repair prompt rather than fail loudly.
 *
 * ── STATIC FILLS, NOT CONDITIONAL FORMATTING ─────────────────────────────
 *
 * RAG colouring is computed here from values the server already decided and
 * written as static fills. Conditional-formatting rules would re-derive the
 * thresholds inside Excel, which is a second implementation of a rule the
 * contract owns — the same class of drift this whole arc has been closing.
 */

import ExcelJS from 'exceljs';
import { effectiveEndDate } from './hoursExport';
import type { HoursExportDataset, HoursAggregate } from './hoursExport';

// Brand — apps/web and the marketing site use the same navy.
const NAVY  = 'FF0B1526';
const WHITE = 'FFFFFFFF';
const GREY  = 'FFF2F4F7';
const GREEN = 'FFD6F0DC';
const AMBER = 'FFFDEBC8';
const RED   = 'FFF8D2D2';

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

/**
 * 'YYYY-MM-DD' -> 'dd-mmm-yy', as a STRING.
 *
 * Deliberately not an Excel date with a numFmt: shift_date is a site-local
 * calendar date, and turning it back into a Date to format it is exactly the
 * round-trip that made node-postgres shift dates by the UTC offset (see the
 * shift_date_label note in routes/billing.ts before the contract landed).
 * Formatting the string keeps the value the server decided.
 */
function ddMmmYy(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}-${y.slice(2)}`;
}

/** '2026-08-26' -> '26-Aug'. Used only for an overnight clock-out. */
function ddMmm(isoDate: string): string {
  const [, m, d] = isoDate.split('-');
  return `${d}-${MONTHS[Number(m) - 1]}`;
}

/**
 * The contract hands times over as 'DD/MM/YYYY, HH:MM:SS' site-local. These
 * two read the parts back out as strings — no Date is constructed, because
 * reconstructing one is the round-trip that shifted values by the UTC offset
 * before the contract existed.
 */
function hhmm(label: string): string {
  const t = label.split(', ')[1] ?? '';
  return t.slice(0, 5);
}
function datePartIso(label: string): string {
  const [dd, mm, yyyy] = (label.split(', ')[0] ?? '').split('/');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Clock-out is time-only like clock-in, EXCEPT on an overnight, where it
 * carries '26-Aug 07:00' so the reader is not left thinking a 19:00->07:00
 * shift ended twelve hours before it began. Deliberately keyed on the
 * site-local DATE differing from the Date column rather than on the clock
 * appearing to go backwards, which a sub-hour shift could trip.
 */
function clockOutCell(clockOutLabel: string, shiftDateIso: string): string {
  const outDate = datePartIso(clockOutLabel);
  return outDate === shiftDateIso ? hhmm(clockOutLabel)
                                  : `${ddMmm(outDate)} ${hhmm(clockOutLabel)}`;
}

function fill(cell: ExcelJS.Cell, argb: string): void {
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function headerRow(ws: ExcelJS.Worksheet, values: string[], rowNo?: number): ExcelJS.Row {
  const row = rowNo ? ws.getRow(rowNo) : ws.addRow(values);
  if (rowNo) row.values = values;
  row.font = { bold: true, color: { argb: WHITE }, size: 11 };
  row.eachCell((c) => { fill(c, NAVY); c.alignment = { vertical: 'middle' }; });
  return row;
}

function totalRow(row: ExcelJS.Row): void {
  row.font = { bold: true };
  row.eachCell((c) => fill(c, GREY));
}

/**
 * Writes coverage as a REAL percentage: the cell holds pct/100 with an Excel
 * percent format, so it displays '100.6%' and still sorts, filters and charts
 * as a number. A pre-formatted string would display the same and sort
 * lexicographically, which is worse in a spreadsheet. The /100 is unit
 * presentation, not arithmetic on the figure — the server decided 100.6.
 *
 * RAG: green >= 95, amber 80–95, red < 80. Null coverage is left blank and
 * unfilled.
 */
function coverageCell(cell: ExcelJS.Cell, pct: number | null): void {
  if (pct === null) { cell.value = ''; return; }
  cell.value = pct / 100;
  cell.numFmt = '0.0%';
  fill(cell, pct >= 95 ? GREEN : pct >= 80 ? AMBER : RED);
}

/**
 * Aggregate tables come in three widths. They used to share one ten-column
 * shape, so BY GUARD carried an empty Site column and BY SITE an empty Guard
 * column, both rendered as '—' placeholders that read like missing data.
 */
type AggShape = 'guard_site' | 'guard' | 'site';

const AGG_HEADERS: Record<AggShape, string[]> = {
  guard_site: ['Guard', 'Site', 'Shifts', 'Scheduled', 'Actual', 'Variance', 'Coverage %', 'Break', 'Unverified', 'Flagged'],
  guard:      ['Guard',         'Shifts', 'Scheduled', 'Actual', 'Variance', 'Coverage %', 'Break', 'Unverified', 'Flagged'],
  site:       ['Site',          'Shifts', 'Scheduled', 'Actual', 'Variance', 'Coverage %', 'Break', 'Unverified', 'Flagged'],
};

/** Flagged is a COUNT of flagged shifts; zero is blank, not '0'. */
const flaggedCell = (n: number): number | string => (n > 0 ? n : '');

function aggValues(a: HoursAggregate, shape: AggShape): unknown[] {
  const tail = [a.shifts, a.scheduled_hours, a.actual_hours, a.variance_hours,
                null /* coverage — written by coverageCell */,
                a.break_hours, a.offpost_hours, flaggedCell(a.flagged_count)];
  if (shape === 'guard_site') return [a.guard_name ?? '', a.site_name ?? '', ...tail];
  if (shape === 'guard')      return [a.guard_name ?? '', ...tail];
  return [a.site_name ?? '', ...tail];
}

/** 1-based index of the Coverage % column for each shape. */
const COV_COL: Record<AggShape, number> = { guard_site: 7, guard: 6, site: 6 };

function addAggTable(
  ws: ExcelJS.Worksheet, title: string, rows: HoursAggregate[],
  total: HoursAggregate, shape: AggShape,
): void {
  ws.addRow([title]).font = { bold: true, size: 12 };
  headerRow(ws, AGG_HEADERS[shape]);
  for (const a of rows) {
    const r = ws.addRow(aggValues(a, shape));
    coverageCell(r.getCell(COV_COL[shape]), a.coverage_pct);
  }
  // A TOTAL row never carries a flag count: flags are a per-shift judgement
  // and a total is not a shift. Blank, not zero.
  const totalVals = aggValues(total, shape);
  totalVals[0] = 'TOTAL';
  if (shape === 'guard_site') totalVals[1] = '';
  totalVals[totalVals.length - 1] = '';
  const t = ws.addRow(totalVals);
  coverageCell(t.getCell(COV_COL[shape]), total.coverage_pct);
  totalRow(t);
  ws.addRow([]);
}

export function buildHoursWorkbook(data: HoursExportDataset): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NetraOps';
  // An open-ended range prints today's site-local date, never "all" — see
  // effectiveEndDate() in services/hoursExport.ts.
  const endShown = effectiveEndDate(data);
  const period = `${data.start_date ? ddMmmYy(data.start_date) : 'start of records'} to ${ddMmmYy(endShown)}`
               + (data.end_date ? '' : ' (open range — to date)');
  const flagged = data.rows.filter((r) => r.flags.length > 0);

  // ══ Sheet 1 — SUMMARY ═══════════════════════════════════════════════════
  const s = wb.addWorksheet('SUMMARY');
  s.columns = [{ width: 26 }, { width: 26 }, { width: 10 }, { width: 12 }, { width: 12 },
               { width: 11 }, { width: 12 }, { width: 10 }, { width: 11 }, { width: 22 }];
  s.addRow(['NetraOps — Hours Report']).font = { bold: true, size: 16, color: { argb: NAVY } };
  s.addRow([`${data.company_name}   ·   Period ${period}`]).font = { italic: true, size: 11 };
  s.addRow([]);

  headerRow(s, ['Shifts', 'Scheduled h', 'Actual h', 'Coverage %', 'Break h', 'Unverified h', 'Flagged', '', '', '']);
  const kpi = s.addRow([
    data.overall.shifts, data.overall.scheduled_hours, data.overall.actual_hours,
    null, data.overall.break_hours, data.overall.offpost_hours,
    flagged.length, '', '', '',
  ]);
  kpi.font = { bold: true, size: 12 };
  coverageCell(kpi.getCell(4), data.overall.coverage_pct);
  s.addRow([]);

  addAggTable(s, 'BY GUARD & SITE', data.by_guard_site, data.overall, 'guard_site');
  // A breakdown that repeats the one above it row for row is noise. When every
  // guard works exactly one site, BY GUARD is BY GUARD & SITE minus a column;
  // same for BY SITE when every site has exactly one guard.
  if (data.by_guard.length !== data.by_guard_site.length) {
    addAggTable(s, 'BY GUARD', data.by_guard, data.overall, 'guard');
  }
  if (data.by_site.length !== data.by_guard_site.length) {
    addAggTable(s, 'BY SITE', data.by_site, data.overall, 'site');
  }

  // CHART DATA — always emitted, whatever was suppressed above; it is the
  // source range for the charts no export library can write.
  s.addRow(['CHART DATA — select a block and use Insert → Chart']).font = { bold: true, size: 12 };
  s.addRow(['Charts cannot be written by the export library; these blocks are the source ranges.'])
    .font = { italic: true, size: 10 };
  s.addRow([]);
  headerRow(s, ['Guard', 'Scheduled', 'Actual', '', '', '', '', '', '', '']);
  for (const a of data.by_guard) s.addRow([a.guard_name ?? '', a.scheduled_hours, a.actual_hours]);
  s.addRow([]);
  headerRow(s, ['Site', 'Actual', '', '', '', '', '', '', '', '']);
  for (const a of data.by_site) s.addRow([a.site_name ?? '', a.actual_hours]);

  // ══ Sheet 2 — HOURS DETAIL ══════════════════════════════════════════════
  const DETAIL = ['Guard', 'Site', 'Date', 'Day', 'Clock In', 'Clock Out', 'Scheduled',
                  'Actual', 'Break', 'Unverified', 'Variance', 'Coverage %', 'Flag'];
  const d = wb.addWorksheet('HOURS DETAIL');
  d.columns = [{ width: 22 }, { width: 26 }, { width: 11 }, { width: 6 }, { width: 21 },
               { width: 21 }, { width: 11 }, { width: 10 }, { width: 9 }, { width: 10 },
               { width: 10 }, { width: 12 }, { width: 24 }];
  headerRow(d, DETAIL);

  // Grouped guard -> site -> clock-in, ASCENDING throughout. The contract
  // orders by clock-in DESC; sorting only on shift_date left the tertiary
  // order inherited from that, so a guard's rows read forwards by day and
  // backwards within one. clock_in_iso is the tie-break, not shift_date, so
  // two sessions on one date sort by when they actually started.
  const detailRows = [...data.rows].sort((a, b) =>
    a.guard_name.localeCompare(b.guard_name)
    || a.site_name.localeCompare(b.site_name)
    || a.clock_in_iso.localeCompare(b.clock_in_iso));

  for (const r of detailRows) {
    const row = d.addRow([
      r.guard_name, r.site_name, ddMmmYy(r.shift_date), r.day_of_week,
      hhmm(r.clock_in_label), clockOutCell(r.clock_out_label, r.shift_date),
      r.scheduled_hours, r.actual_hours, r.break_hours, r.offpost_hours,
      r.variance_hours, null, r.flags.join(' '),
    ]);
    coverageCell(row.getCell(12), r.coverage_pct);
    if (r.flags.length > 0) fill(row.getCell(13), RED);
  }
  const dTotal = d.addRow(['TOTAL', '', '', '', '', '',
    data.overall.scheduled_hours, data.overall.actual_hours, data.overall.break_hours,
    data.overall.offpost_hours, data.overall.variance_hours,
    null, '' /* never a flag on a total */]);
  coverageCell(dTotal.getCell(12), data.overall.coverage_pct);
  totalRow(dTotal);
  d.views = [{ state: 'frozen', ySplit: 1 }];
  d.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: DETAIL.length } };

  // ══ Sheet 3 — EXCEPTIONS ════════════════════════════════════════════════
  const e = wb.addWorksheet('EXCEPTIONS');
  e.columns = d.columns;
  e.addRow(['Most recent first.  Rules — SHORT: coverage < 80%  ·  OVER: coverage > 110%  ·  NO_SCHEDULE: shift has no scheduled window  ·  AUTO_CLOSED: guard never clocked out, closed by the cron  ·  OFFPOST_ANOMALY: unverified exceeds actual'])
    .font = { italic: true, size: 10 };
  e.addRow([]);
  headerRow(e, DETAIL);
  if (flagged.length === 0) {
    e.addRow(['No flagged rows in this period.']).font = { italic: true };
  } else {
    for (const r of flagged) {
      const row = e.addRow([
        r.guard_name, r.site_name, ddMmmYy(r.shift_date), r.day_of_week,
        hhmm(r.clock_in_label), clockOutCell(r.clock_out_label, r.shift_date),
        r.scheduled_hours, r.actual_hours, r.break_hours, r.offpost_hours,
        r.variance_hours, null, r.flags.join(' '),
      ]);
      coverageCell(row.getCell(12), r.coverage_pct);
      fill(row.getCell(13), RED);
    }
  }
  e.views = [{ state: 'frozen', ySplit: 3 }];

  // ══ Sheet 4 — NOTES ═════════════════════════════════════════════════════
  const n = wb.addWorksheet('NOTES');
  n.columns = [{ width: 24 }, { width: 96 }];
  headerRow(n, ['Field', 'Definition']);
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null;
  const note = (k: string, v: string): void => { n.addRow([k, v]); };
  note('Period', period);
  note('Tenant', `${data.company_name}  (${data.company_id})`);
  note('Generated from commit', sha ?? 'unavailable — no commit SHA in the runtime environment');
  note('', '');
  note('CHARTS PENDING', 'The approved design includes a scheduled-vs-actual column chart by guard and an actual-by-site bar chart. Neither export library can write native charts, so they are not in this file. The CHART DATA block at the bottom of SUMMARY holds both source ranges — select one and use Insert → Chart.');
  note('', '');
  note('Scheduled', 'The shift’s scheduled window. On a DETAIL row this is the whole shift. In aggregates a handoff shift is split across its sessions in proportion to actual hours, so aggregate scheduled totals do not equal the sum of the detail column.');
  note('Actual', 'Clock-out minus clock-in, raw, no truncation.');
  note('Break', 'Total break time bounded to the session window.');
  note('Unverified', 'Time the guard’s presence at the post could not be confirmed: ping windows spanned by an open boundary alert in which no location check-in was received. It is not a measurement of time away from the post — a guard who is present but does not check in accrues unverified time. Bounded to the session window.');
  note('Variance', 'Actual minus scheduled.');
  note('Coverage %', 'Actual as a percentage of scheduled, stored as a real percentage so it sorts and filters as a number. Blank where there is no schedule.');
  note('Clock In / Out', 'Site-local time, 24-hour. Clock Out carries a date prefix (e.g. 26-Aug 07:00) only when the shift ended on a later local day than it started.');
  note('Flagged', 'On an aggregate row, the number of distinct shifts carrying at least one flag. Flag names stay on the detail rows — a flag is a per-shift judgement, so a total never carries one.');
  note('RAG colours', 'Coverage cells: green ≥ 95%, amber 80–95%, red < 80%. Flagged rows carry a red flag cell.');
  note('', '');
  note('SHORT', 'Coverage below 80%.');
  note('OVER', 'Coverage above 110%.');
  note('NO_SCHEDULE', 'The shift carries no scheduled window.');
  note('AUTO_CLOSED', 'The guard never clocked out; the session was closed by the auto-complete cron.');
  note('OFFPOST_ANOMALY', 'Unverified time exceeds actual hours — impossible, and a sign of bad data rather than guard behaviour. Retained under its original name so historical exports remain comparable; the flag key is not a display label.');
  note('', '');
  note('Removed columns', 'Total Hours (legacy), Break (mins) and Status were dropped. The first contradicted Actual by design, the second duplicated Break in different units, the third described the shift rather than its hours.');
  note('Times', 'All dates and times are rendered in each site’s own timezone, not UTC and not the server’s.');

  return wb;
}

/** One place decides the on-disk encoding for both consumers. */
export async function workbookToBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from(await wb.xlsx.writeBuffer());
}
