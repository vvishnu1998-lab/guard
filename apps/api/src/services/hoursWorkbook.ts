/**
 * Hours workbook renderer — turns a HoursExportDataset into the XLSX that both
 * the billing download and the monthly S3 archive ship.
 *
 * Separate from services/hoursExport.ts on purpose: that module owns the
 * numbers and stays free of a spreadsheet dependency, this one owns
 * presentation and owns no arithmetic at all. Before the split, routes/
 * billing.ts and jobs/monthlyHoursReport.ts each carried their own copy and
 * the two had already drifted — different clock-in/out header labels, and the
 * monthly file had neither the summary block nor the column widths, so a
 * monthly file and an on-demand file for the same range were not the same
 * document. There is one copy now.
 */

import * as XLSX from 'xlsx';
import type { HoursExportDataset, HoursAggregate } from './hoursExport';

/**
 * The workbook is a RENDERER. Every number below is computed in
 * services/hoursExport.ts; nothing here adds, divides or rounds. That is the
 * point of the contract — the old SUMMARY block did its own arithmetic on a
 * display-string key, and the monthly cron carried a second copy of the query
 * that had already drifted from this one.
 */
export function buildHoursWorkbook(data: HoursExportDataset): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  const detail: unknown[][] = [
    ['Guard', 'Badge', 'Site', 'Shift Date', 'Day', 'Clock In', 'Clock Out',
     'Scheduled Hours', 'Actual Hours', 'Break Hours', 'Off-post Hours',
     'Variance', 'Coverage %', 'Flags'],
    ...data.rows.map((r) => [
      r.guard_name, r.badge_number ?? '', r.site_name,
      r.shift_date_label, r.day_of_week,
      r.clock_in_label, r.clock_out_label,
      r.scheduled_hours, r.actual_hours, r.break_hours, r.offpost_hours,
      r.variance_hours, r.coverage_pct ?? '', r.flags.join(' '),
    ]),
  ];
  const ws = XLSX.utils.aoa_to_sheet(detail);
  ws['!cols'] = [
    { wch: 22 }, { wch: 10 }, { wch: 26 }, { wch: 12 }, { wch: 6 },
    { wch: 22 }, { wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 13 },
    { wch: 15 }, { wch: 11 }, { wch: 12 }, { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Hours Detail');

  // Aggregates get their own sheet rather than being appended below the
  // detail rows. Stacked in one sheet they were indistinguishable from data
  // to anything that reads the range — an Excel SUM over the Off-post column
  // double-counted every total.
  const aggHeader = ['Scope', 'Guard', 'Badge', 'Site', 'Sessions', 'Shifts',
                     'Scheduled Hours', 'Actual Hours', 'Break Hours',
                     'Off-post Hours', 'Variance', 'Coverage %',
                     'Auto-closed Sessions', 'Flags'];
  const aggRow = (scope: string, a: HoursAggregate): unknown[] => [
    scope, a.guard_name ?? '', a.badge_number ?? '', a.site_name ?? '',
    a.sessions, a.shifts, a.scheduled_hours, a.actual_hours, a.break_hours,
    a.offpost_hours, a.variance_hours, a.coverage_pct ?? '',
    a.auto_closed_sessions, a.flags.join(' '),
  ];
  const summary: unknown[][] = [
    aggHeader,
    aggRow('OVERALL', data.overall),
    ...data.by_guard.map((a)      => aggRow('GUARD', a)),
    ...data.by_site.map((a)       => aggRow('SITE', a)),
    ...data.by_guard_site.map((a) => aggRow('GUARD @ SITE', a)),
  ];
  const sws = XLSX.utils.aoa_to_sheet(summary);
  sws['!cols'] = [
    { wch: 14 }, { wch: 22 }, { wch: 10 }, { wch: 26 }, { wch: 10 }, { wch: 8 },
    { wch: 16 }, { wch: 14 }, { wch: 13 }, { wch: 15 }, { wch: 11 },
    { wch: 12 }, { wch: 20 }, { wch: 24 },
  ];
  XLSX.utils.book_append_sheet(wb, sws, 'Summary');

  return wb;
}

/** One place decides the on-disk encoding for both consumers. */
export function workbookToBuffer(wb: XLSX.WorkBook): Buffer {
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
