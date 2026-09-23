/**
 * Activity-log PDF renderer.
 *
 * Extracted verbatim from the body of POST /api/admin/activity-log/pdf
 * (routes/admin.ts) so the document can be rendered — and therefore
 * asserted on — without an Express request. The route keeps auth, params,
 * the fetch and the response headers; everything below is layout.
 *
 * This is a pure move. The body between `const STATUS_COLOR` and
 * `doc.end()` is byte-identical to what shipped at 00e2298; the only
 * changes are the wrapper: the document is collected into a Buffer instead
 * of being piped at `res`, because a caller that cannot hold the bytes
 * cannot compare them.
 *
 * Media policy is unchanged: counts only, no embedded images and no
 * filenames, so a 5-photo incident weighs the same as a bare ping.
 */
import PDFDocument from 'pdfkit';
import {
  NAVY, WHITE, BLUE, RED, AMBER, GRAY1, GRAY2, TEXT, MUTED,
  PAGE_W, PAGE_H, ML, MR, CW,
  drawHeader, drawFooter, badge,
} from './theme';
import { ACTIVITY_PDF_ROW_CAP, type ActivityRow } from '../../routes/activityLog';

/**
 * The zone every date in this document is rendered in.
 *
 * Hardcoded, matching the three Intl formatters below that already were —
 * all 23 production sites read `America/Los_Angeles`. It is named rather
 * than repeated so that the day a site exists in another zone, `grep SITE_TZ`
 * finds every place that has to change. Tracked in OPEN-ITEMS.
 */
const SITE_TZ = 'America/Los_Angeles';

export interface ActivityPdfMeta {
  /** Site name, or 'All sites' when the export is not site-filtered. */
  siteLabel:  string;
  /** Guard name, or 'All guards'. */
  guardLabel: string;
  /** Range as the caller received it on the wire. */
  fromIso:    string;
  toIso:      string;
}

/**
 * Render the feed to a PDF buffer.
 *
 * `rows` is sorted in place (newest first) and capped at
 * ACTIVITY_PDF_ROW_CAP; the TOTAL EVENTS tile reports the uncapped length,
 * which is why the full array is taken rather than a pre-sliced one.
 */
export function renderActivityLogPdf(
  rows: ActivityRow[],
  meta: ActivityPdfMeta,
): Promise<Buffer> {
  const { siteLabel, guardLabel, fromIso, toIso } = meta;
  // Newest first (matches on-screen order)
  rows.sort((a, b) => Date.parse(b.event_time) - Date.parse(a.event_time));
  const truncated = rows.length > ACTIVITY_PDF_ROW_CAP;
  const eventRows = rows.slice(0, ACTIVITY_PDF_ROW_CAP);
  // En dash, not an arrow: WinAnsi has no → and PDFKit's built-in Helvetica
  // rendered it as "!'" on every page of this PDF.
  //
  // THE ZONE IS NOT OPTIONAL. Without it these two calls format in the
  // PROCESS's zone, and Railway sets no TZ, so the API runs in UTC. The web
  // sends an INCLUSIVE end-of-local-day bound — localDayEnd() parses
  // "<date>T23:59:59.999" with no suffix, so a PT browser puts
  // 2026-09-23T06:59:59.999Z on the wire for a picker end of 2026-09-22 —
  // and 06:59Z is the next day in UTC. The header therefore printed 23/09
  // against a filename, built from the same click, reading 09-22.
  //
  // Only the END was ever visibly wrong, which is why this went unnoticed:
  // a start-of-day PT bound is 07:00Z on the SAME date, so the start agreed
  // by luck. It is not an exclusive-end bug — the bound really is inclusive.
  //
  // Every sibling formatter in this file already passes the zone (DAY_KEY,
  // DAY_HEADER, TIME_FMT, and the Generated line below). This call was the
  // only one that did not, so it was an omission, not a choice.
  const periodStr =
    `${new Date(fromIso).toLocaleDateString('en-GB', { timeZone: SITE_TZ })}` +
    ` – ${new Date(toIso).toLocaleDateString('en-GB', { timeZone: SITE_TZ })}`;

  // Group by Pacific-time day for the on-page sections.
  const DAY_KEY = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/Los_Angeles',
  });
  const DAY_HEADER = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long', day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Los_Angeles',
  });
  const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  });

  const byDay = new Map<string, ActivityRow[]>();
  for (const r of eventRows) {
    const key = DAY_KEY.format(new Date(r.event_time));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key)!.push(r);
  }
  const dayKeys = Array.from(byDay.keys()).sort().reverse();
  for (const key of dayKeys) byDay.get(key)!.sort((a, b) => Date.parse(a.event_time) - Date.parse(b.event_time));

  const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data',  (c: Buffer) => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  const STATUS_COLOR: Record<string, string> = {
    on_time:                   NAVY,
    late:                      AMBER,
    missed:                    RED,
    // Missed then answered: RED. The window WAS missed, and a document a
    // client reads must not soften that because the guard caught up.
    missed_answered_late:      RED,
    activity_report:           BLUE,
    incident_report:           RED,
    maintenance_report:        AMBER,
    checkpoint_round_complete: NAVY,
    checkpoint_round_partial:  AMBER,
    task_completed:            NAVY,
  };
  const STATUS_LABEL: Record<string, string> = {
    on_time:                   'PING',
    late:                      'LATE PING',
    missed:                    'MISSED PING',
    // Row's `status` already reads "Missed — answered N minutes late";
    // the badge is the short form.
    missed_answered_late:      'MISSED / ANSWERED LATE',
    activity_report:           'ACTIVITY',
    incident_report:           'INCIDENT',
    maintenance_report:        'MAINTENANCE',
    // Deliberately no "x of y" here. This document is generated by an admin
    // but handed to a client, and the counts are a comparison against the
    // current checkpoint roster, which can change retroactively. Complete
    // vs partial is a standalone fact and is safe to print.
    checkpoint_round_complete: 'ROUND COMPLETE',
    checkpoint_round_partial:  'ROUND PARTIAL',
    task_completed:            'TASK COMPLETED',
  };

  // We don't know the true page total until the stream drains, so
  // estimate: cover + ~20 rows/page. Header shows "n / estimate".
  const estRowsPerPage = 20;
  const estPages       = 1 + Math.max(1, Math.ceil(eventRows.length / estRowsPerPage));
  let pageNum = 1;

  // ── Page 1 — Cover / filter summary ─────────────────────────────────────
  drawHeader(doc, 'ACTIVITY LOGS', pageNum, estPages);
  let y = 90;

  doc.fontSize(22).fillColor(TEXT).font('Helvetica-Bold').text('Activity Logs', ML, y);
  y += 30;

  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text(`Period      ${periodStr}`, ML, y);
  y += 15;
  doc.text(`Site        ${siteLabel}`, ML, y);
  y += 15;
  doc.text(`Guard       ${guardLabel}`, ML, y);
  y += 15;
  doc.text(`Generated   ${new Date().toLocaleString('en-GB', { timeZone: 'America/Los_Angeles' })} PT`, ML, y);
  y += 22;

  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(0.5).stroke();
  y += 18;

  // Summary tile row
  const totalRows        = rows.length;
  // A window that was missed counts as missed even once it was answered
  // late — that is the whole point of keeping the resolved row. It is
  // deliberately NOT also added to pingCount: the merged row is one row,
  // so counting it in both tiles would stop the cover reconciling with
  // the body. Row totals are unchanged by the merge (a resolved window
  // used to emit one ping row; it now emits one missed_answered_late row).
  const missedCount      = eventRows.filter(
    (r) => r.status_kind === 'missed' || r.status_kind === 'missed_answered_late',
  ).length;
  const incidentCount    = eventRows.filter((r) => r.status_kind === 'incident_report').length;
  const activityCount    = eventRows.filter((r) => r.status_kind === 'activity_report').length;
  const maintenanceCount = eventRows.filter((r) => r.status_kind === 'maintenance_report').length;
  const pingCount        = eventRows.filter((r) => r.status_kind === 'on_time' || r.status_kind === 'late').length;
  // Patrol rounds are counted so the cover reconciles with the body. Without
  // this the tiles would report fewer events than the pages actually list.
  //
  // One tile, not two: the tile row divides CW evenly, so an eighth tile
  // narrows every box enough that TOTAL EVENTS / MAINTENANCE wrap onto a
  // second line and overflow their fixed 56pt height. Complete-vs-partial is
  // already legible per row via the ROUND COMPLETE / ROUND PARTIAL badges;
  // splitting it out on the cover is not worth breaking the existing labels.
  const roundCount       = eventRows.filter((r) => r.kind === 'checkpoint_round').length;

  const stats = [
    { label: 'TOTAL EVENTS', value: totalRows,        color: TEXT  },
    { label: 'PINGS',        value: pingCount,        color: NAVY  },
    { label: 'MISSED',       value: missedCount,      color: RED   },
    { label: 'ROUNDS',       value: roundCount,       color: NAVY  },
    { label: 'ACTIVITY',     value: activityCount,    color: BLUE  },
    { label: 'INCIDENT',     value: incidentCount,    color: RED   },
    { label: 'MAINTENANCE',  value: maintenanceCount, color: AMBER },
  ];
  const statW = CW / stats.length;
  for (let i = 0; i < stats.length; i++) {
    const sx = ML + i * statW;
    doc.rect(sx + 2, y, statW - 4, 56).fill(GRAY1).stroke();
    doc.rect(sx + 2, y, 3, 56).fill(stats[i].color);
    doc.fontSize(22).fillColor(stats[i].color).font('Helvetica-Bold')
       .text(String(stats[i].value), sx + 10, y + 8, { width: statW - 16, lineBreak: false });
    doc.fontSize(7).fillColor(MUTED).font('Helvetica')
       .text(stats[i].label, sx + 10, y + 40, { width: statW - 16 });
  }
  y += 70;

  if (truncated) {
    doc.rect(ML, y, CW, 18).fill('#FEF3C7');
    doc.fontSize(8).fillColor('#92400E').font('Helvetica-Bold')
       .text(`Truncated: ${totalRows} total events, showing first ${ACTIVITY_PDF_ROW_CAP}. Narrow the filter to see more.`,
             ML + 8, y + 5, { width: CW - 16, lineBreak: false });
    y += 24;
  }

  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(0.5).stroke();
  y += 14;

  drawFooter(doc, siteLabel, periodStr);

  // ── Timeline: per-day sections ──────────────────────────────────────────
  const COL_TIME_X   = ML + 8;
  const COL_STATUS_X = ML + 60;
  const COL_GUARD_X  = ML + 170;
  const COL_SITE_X   = ML + 300;
  const COL_DESC_X   = ML + 8;
  const ROW_H        = 18;
  const ROW_DESC_H   = 26;

  function ensureRoom(needed: number) {
    if (y + needed > PAGE_H - 40) {
      drawFooter(doc, siteLabel, periodStr);
      doc.addPage();
      pageNum += 1;
      drawHeader(doc, 'ACTIVITY LOGS', pageNum, estPages);
      y = 90;
    }
  }

  if (eventRows.length === 0) {
    doc.fontSize(12).fillColor(MUTED).font('Helvetica')
       .text('No events in this range.', ML, y, { width: CW, align: 'center' });
  }

  for (const key of dayKeys) {
    ensureRoom(30);
    const dayRows = byDay.get(key)!;
    const dayDate = new Date(dayRows[0].event_time);

    // Day header bar
    doc.rect(ML, y, CW, 20).fill(NAVY);
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
       .text(DAY_HEADER.format(dayDate).toUpperCase(), ML + 8, y + 6, { lineBreak: false });
    doc.fontSize(8).fillColor('#94A3B8').font('Helvetica')
       .text(`${dayRows.length} event${dayRows.length !== 1 ? 's' : ''}`,
             0, y + 6, { align: 'right', width: PAGE_W - ML });
    y += 26;

    for (const r of dayRows) {
      const descLen = r.description ? Math.min(r.description.length, 180) : 0;
      const rowHeight = descLen > 0 ? ROW_DESC_H : ROW_H;
      ensureRoom(rowHeight + 4);

      const color   = STATUS_COLOR[r.status_kind] ?? MUTED;
      const label   = STATUS_LABEL[r.status_kind] ?? r.status.toUpperCase();
      const timeStr = r.log_time ? TIME_FMT.format(new Date(r.log_time)) : '—';

      doc.fontSize(8).fillColor(MUTED).font('Helvetica')
         .text(timeStr, COL_TIME_X, y + 3, { lineBreak: false, width: 50 });
      badge(doc, COL_STATUS_X, y + 1, label, color);
      doc.fontSize(8).fillColor(TEXT).font('Helvetica')
         .text(r.guard_name, COL_GUARD_X, y + 3, { lineBreak: false, width: 120 });
      doc.fontSize(8).fillColor(MUTED).font('Helvetica')
         .text(r.site_name, COL_SITE_X, y + 3, { lineBreak: false, width: 200 });

      if (descLen > 0) {
        const snippet = (r.description ?? '').length > 180
          ? (r.description ?? '').slice(0, 180) + '…'
          : (r.description ?? '');
        doc.fontSize(8).fillColor('#374151').font('Helvetica')
           .text(snippet, COL_DESC_X, y + 15, { width: CW - 16, height: 10 });
      }

      const mediaCount = r.log_media_urls?.length ?? 0;
      if (mediaCount > 0) {
        doc.fontSize(7).fillColor(MUTED).font('Helvetica')
           .text(`${mediaCount} photo${mediaCount === 1 ? '' : 's'}`,
                 0, y + 3, { align: 'right', width: PAGE_W - ML - 10 });
      }

      y += rowHeight;
      doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(0.3).stroke();
      y += 2;
    }
    y += 8;
  }

  drawFooter(doc, siteLabel, periodStr);
  doc.end();

  return done;
}
