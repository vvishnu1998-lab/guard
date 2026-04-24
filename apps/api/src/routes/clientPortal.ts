/**
 * Client Portal API routes — read-only, strictly scoped to client's site_id.
 * CRITICAL: every query must filter by site_id from the JWT (Section 11.5).
 *
 * GET  /api/client/site                 — site info + retention dates
 * GET  /api/client/guards-on-duty       — guards currently clocked in at this site
 * GET  /api/client/reports              — reports list
 * POST /api/client/reports/pdf-link     — mint a short-lived (60s) handoff URL
 *                                         carrying `?dl=<purpose-scoped JWT>`.
 *                                         Requires Bearer auth. (CB5 fix — audit/WEEK1.md C4)
 * GET  /api/client/reports/pdf          — PDF report download. Accepts:
 *                                           * `Authorization: Bearer <client JWT>`, OR
 *                                           * `?dl=<handoff token from pdf-link>`.
 *                                         Legacy `?token=` param returns 410 Gone.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import jwt from 'jsonwebtoken';
import type { AuthPayload } from '../middleware/auth';
import PDFDocument from 'pdfkit';

const router = Router();

// ── Site info ─────────────────────────────────────────────────────────────────

router.get('/site', requireAuth('client'), async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, name, address, contract_end,
            (contract_end + INTERVAL '150 days') AS data_delete_at,
            EXTRACT(DAY FROM ((contract_end + INTERVAL '150 days') - NOW()))::int AS days_until_deletion
     FROM sites WHERE id = $1`,
    [req.user!.site_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Site not found' });
  res.json(result.rows[0]);
});

// ── Guards on duty at this site ───────────────────────────────────────────────

router.get('/guards-on-duty', requireAuth('client'), async (req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT
       g.name,
       ss.clocked_in_at,
       EXTRACT(EPOCH FROM (NOW() - ss.clocked_in_at))::int / 3600 AS hours_on_duty,
       lp.latitude  AS last_lat,
       lp.longitude AS last_lng,
       lp.pinged_at AS last_ping_at
     FROM shift_sessions ss
     JOIN guards g ON g.id = ss.guard_id
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, pinged_at
       FROM location_pings
       WHERE shift_session_id = ss.id
       ORDER BY pinged_at DESC LIMIT 1
     ) lp ON true
     WHERE ss.site_id = $1 AND ss.clocked_out_at IS NULL
     ORDER BY ss.clocked_in_at ASC`,
    [req.user!.site_id]
  );
  res.json(result.rows);
});

// ── Reports list (used by client portal page) ─────────────────────────────────
// The main /api/reports endpoint already handles 'client' role; this is an alias.

router.get('/reports', requireAuth('client'), async (req: Request, res: Response) => {
  const { type, date_from, date_to } = req.query;
  let query = `
    SELECT r.id, r.report_type, r.severity, r.description, r.reported_at,
           g.name AS guard_name,
           array_agg(rp.storage_url ORDER BY rp.photo_index) FILTER (WHERE rp.id IS NOT NULL) AS photos
    FROM reports r
    JOIN shift_sessions ss ON ss.id = r.shift_session_id
    JOIN guards g ON g.id = ss.guard_id
    LEFT JOIN report_photos rp ON rp.report_id = r.id
    WHERE r.site_id = $1`;
  const params: unknown[] = [req.user!.site_id];

  if (type)      { query += ` AND r.report_type = $${params.length + 1}`; params.push(type); }
  if (date_from) { query += ` AND r.reported_at >= $${params.length + 1}`; params.push(date_from); }
  if (date_to)   { query += ` AND r.reported_at <= $${params.length + 1}`; params.push((date_to as string).includes('T') ? date_to : date_to + 'T23:59:59'); }

  query += ' GROUP BY r.id, g.name ORDER BY r.reported_at DESC LIMIT 200';

  const result = await pool.query(query, params);
  res.json(result.rows);
});

// ── PDF download handoff (CB5 — audit/WEEK1.md C4) ────────────────────────────
// Browser downloads can't carry Authorization headers (window.open/anchor
// navigation can only set query params).  Putting the long-lived access JWT
// in the query string leaks it to server logs, proxy caches, browser history
// and the Referer header.
//
// This endpoint, protected by the normal Bearer flow, mints a purpose-scoped
// token that:
//   * is valid for 60 seconds,
//   * carries `purpose: 'pdf_download'` so it can't be used for anything else,
//   * pins the `from`/`to` window into the token claims so the URL can't be
//     tampered with by the browser.
//
// The client then `window.open`s the returned URL.  Even if the URL leaks it
// is useless 60 seconds later and only ever reads PDFs — not the full API.

const PDF_DL_TTL_SECONDS = 60;

router.post('/reports/pdf-link', requireAuth('client'), async (req: Request, res: Response) => {
  const { from, to } = req.body ?? {};
  if (typeof from !== 'string' || typeof to !== 'string') {
    return res.status(400).json({ error: 'from and to are required (ISO date strings)' });
  }

  const dl = jwt.sign(
    {
      sub: req.user!.sub,
      role: 'client',
      site_id: req.user!.site_id,
      purpose: 'pdf_download',
      from,
      to,
    },
    process.env.JWT_SECRET!,
    { expiresIn: PDF_DL_TTL_SECONDS }
  );
  res.json({
    url: `/api/client/reports/pdf?dl=${encodeURIComponent(dl)}`,
    expires_in: PDF_DL_TTL_SECONDS,
  });
});

// ── PDF export ────────────────────────────────────────────────────────────────

// ── PDF constants ─────────────────────────────────────────────────────────────
const NAVY   = '#0B1526';
const WHITE  = '#FFFFFF';
const BLUE   = '#2563EB';
const RED    = '#DC2626';
const AMBER  = '#D97706';
const GRAY1  = '#F8FAFC';
const GRAY2  = '#E2E8F0';
const TEXT   = '#1E293B';
const MUTED  = '#64748B';

const PAGE_W = 595;
const PAGE_H = 842;
const ML = 50;
const MR = 545;
const CW = MR - ML;

// ── PDF helper functions ──────────────────────────────────────────────────────

function drawHeader(doc: InstanceType<typeof PDFDocument>, title: string, pageNum: number, totalPages: number) {
  doc.rect(0, 0, PAGE_W, 72).fill(NAVY);
  doc.fontSize(18).fillColor(WHITE).font('Helvetica-Bold').text('V-WING', ML, 18, { lineBreak: false });
  doc.fontSize(9).fillColor('#94A3B8').font('Helvetica').text('SECURITY MANAGEMENT', ML, 40);
  doc.fontSize(13).fillColor(WHITE).font('Helvetica-Bold').text(title, 0, 26, { align: 'right', width: PAGE_W - ML });
  doc.fontSize(8).fillColor('#64748B').font('Helvetica').text(`${pageNum} / ${totalPages}`, 0, 44, { align: 'right', width: PAGE_W - ML });
}

function drawFooter(doc: InstanceType<typeof PDFDocument>, siteName: string, period: string) {
  doc.rect(0, PAGE_H - 30, PAGE_W, 30).fill('#F1F5F9');
  doc.moveTo(ML, PAGE_H - 30).lineTo(MR, PAGE_H - 30).strokeColor(GRAY2).lineWidth(0.5).stroke();
  doc.fontSize(7).fillColor(MUTED).font('Helvetica')
     .text(`${siteName}  |  ${period}  |  Confidential — V-Wing Security Management Platform`,
           ML, PAGE_H - 20, { width: CW, align: 'center' });
}

function badge(doc: InstanceType<typeof PDFDocument>, x: number, y: number, label: string, color: string, textColor = WHITE) {
  const w = label.length * 6 + 12;
  doc.rect(x, y, w, 14).fill(color);
  doc.fontSize(7).fillColor(textColor).font('Helvetica-Bold').text(label, x + 6, y + 3.5, { lineBreak: false });
  return w;
}

function proportionBar(
  doc: InstanceType<typeof PDFDocument>,
  x: number, y: number, w: number, h: number,
  segments: Array<{ value: number; color: string }>
) {
  const total = segments.reduce((s, seg) => s + seg.value, 0);
  if (total === 0) { doc.rect(x, y, w, h).fill(GRAY2); return; }
  let cx = x;
  for (const seg of segments) {
    const sw = (seg.value / total) * w;
    if (sw > 0) { doc.rect(cx, y, sw, h).fill(seg.color); cx += sw; }
  }
}

interface PdfDownloadPayload extends AuthPayload {
  purpose?: string;
  from?: string;
  to?: string;
}

router.get('/reports/pdf', async (req: Request, res: Response) => {
  // CB5 (audit/WEEK1.md C4): the old ?token=<access-JWT> query param leaked
  // long-lived credentials to server logs, Referer, and browser history.
  // Reject it loudly so any unpatched client forces a frontend refresh.
  if (typeof req.query.token === 'string') {
    return res.status(410).json({
      error:
        'The ?token= query auth is retired. Call POST /api/client/reports/pdf-link first ' +
        'to obtain a short-lived ?dl= URL, or send Authorization: Bearer.',
    });
  }

  let payload: PdfDownloadPayload | null = null;

  // Preferred path: handoff token from POST /reports/pdf-link
  if (typeof req.query.dl === 'string') {
    try {
      payload = jwt.verify(req.query.dl, process.env.JWT_SECRET!) as PdfDownloadPayload;
    } catch {
      return res.status(401).json({ error: 'Invalid or expired download link' });
    }
    if (payload.purpose !== 'pdf_download') {
      return res.status(403).json({ error: 'Download link is not scoped for PDF export' });
    }
  } else {
    // Fallback: direct Authorization: Bearer (useful for server-to-server
    // consumers and for future in-page <iframe> or fetch-to-blob use-cases).
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization' });
    }
    try {
      payload = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as PdfDownloadPayload;
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
  }

  if (!payload || payload.role !== 'client' || !payload.site_id) {
    return res.status(403).json({ error: 'Client access required' });
  }

  // When using a handoff token the from/to come from the token claims, so
  // the download window can't be widened by tampering with the URL. For the
  // Bearer fallback the caller may pass them on the query string.
  const from = payload.purpose === 'pdf_download'
    ? (payload.from ?? '')
    : ((req.query.from as string | undefined) ?? '');
  const to = payload.purpose === 'pdf_download'
    ? (payload.to ?? '')
    : ((req.query.to as string | undefined) ?? '');

  // ── 1. Site info ─────────────────────────────────────────────────────────────
  const siteResult = await pool.query('SELECT name, address FROM sites WHERE id = $1', [payload.site_id]);
  const siteName   = siteResult.rows[0]?.name    ?? 'Unknown Site';
  const siteAddress = siteResult.rows[0]?.address ?? '';

  // ── 2. Reports with full data ─────────────────────────────────────────────────
  let reportQuery = `
    SELECT r.id, r.report_type, r.severity, r.description, r.reported_at,
           g.name AS guard_name, g.id AS guard_id,
           ss.id AS session_id
    FROM reports r
    JOIN shift_sessions ss ON ss.id = r.shift_session_id
    JOIN guards g ON g.id = ss.guard_id
    WHERE r.site_id = $1`;
  const params: unknown[] = [payload.site_id];
  if (from) { reportQuery += ` AND r.reported_at >= $${params.length + 1}`; params.push(from); }
  if (to)   { reportQuery += ` AND r.reported_at <= $${params.length + 1}`; params.push((to as string).includes('T') ? to : to + 'T23:59:59'); }
  reportQuery += ' ORDER BY r.reported_at ASC LIMIT 500';
  const reports = (await pool.query(reportQuery, params)).rows;

  // ── 3. Shift sessions (for guard hours) ───────────────────────────────────────
  let shiftQuery = `
    SELECT ss.guard_id, g.name AS guard_name,
           ss.clocked_in_at, ss.clocked_out_at,
           COALESCE(EXTRACT(EPOCH FROM (COALESCE(ss.clocked_out_at, NOW()) - ss.clocked_in_at))/3600, 0) AS hours
    FROM shift_sessions ss
    JOIN guards g ON g.id = ss.guard_id
    WHERE ss.site_id = $1`;
  const shiftParams: unknown[] = [payload.site_id];
  if (from) { shiftQuery += ` AND ss.clocked_in_at >= $${shiftParams.length + 1}`; shiftParams.push(from); }
  if (to)   { shiftQuery += ` AND ss.clocked_in_at <= $${shiftParams.length + 1}`; shiftParams.push((to as string).includes('T') ? to : to + 'T23:59:59'); }
  const shifts = (await pool.query(shiftQuery, shiftParams)).rows;

  // ── 4. Monthly incident counts (last 3 months) ────────────────────────────────
  const monthlyIncidents = (await pool.query(`
    SELECT
      TO_CHAR(DATE_TRUNC('month', r.reported_at), 'Mon YYYY') AS month,
      DATE_TRUNC('month', r.reported_at) AS month_date,
      r.severity,
      COUNT(*) AS count
    FROM reports r
    WHERE r.site_id = $1 AND r.report_type = 'incident'
      AND r.reported_at >= NOW() - INTERVAL '3 months'
    GROUP BY DATE_TRUNC('month', r.reported_at), r.severity
    ORDER BY month_date ASC
  `, [payload.site_id])).rows;

  // ── Computed aggregates ───────────────────────────────────────────────────────
  const activityReports    = reports.filter(r => r.report_type === 'activity');
  const incidentReports    = reports.filter(r => r.report_type === 'incident');
  const maintenanceReports = reports.filter(r => r.report_type === 'maintenance');

  const totalHours = shifts.reduce((sum, s) => sum + parseFloat(s.hours), 0);

  const guardMap = new Map<string, { name: string; shifts: number; hours: number; reports: number; incidents: number }>();
  for (const s of shifts) {
    const g = guardMap.get(s.guard_id) ?? { name: s.guard_name, shifts: 0, hours: 0, reports: 0, incidents: 0 };
    g.shifts++;
    g.hours += parseFloat(s.hours);
    guardMap.set(s.guard_id, g);
  }
  for (const r of reports) {
    for (const [, g] of guardMap) {
      if (g.name === r.guard_name) { g.reports++; if (r.report_type === 'incident') g.incidents++; }
    }
  }
  const guardStats = Array.from(guardMap.values()).sort((a, b) => b.reports - a.reports);

  const byDate = new Map<string, typeof reports>();
  for (const r of reports) {
    const d = new Date(r.reported_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d)!.push(r);
  }

  // ── Build PDF ─────────────────────────────────────────────────────────────────
  const doc = new PDFDocument({ margin: 0, size: 'A4', autoFirstPage: true });
  const filename = `v-wing-report-${siteName.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  const periodStr = `${from ? new Date(from).toLocaleDateString('en-GB') : 'All time'} \u2192 ${to ? new Date(to).toLocaleDateString('en-GB') : 'Today'}`;

  const TYPE_DOT_COLOR: Record<string, string> = { activity: BLUE, incident: RED, maintenance: AMBER };
  const TYPE_LABEL: Record<string, string>     = { activity: 'ACTIVITY', incident: 'INCIDENT', maintenance: 'MAINTENANCE' };

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 1 — Cover & Summary
  // ══════════════════════════════════════════════════════════════════════════════
  drawHeader(doc, 'SITE SECURITY REPORT', 1, 5);
  let y = 90;

  doc.fontSize(26).fillColor(TEXT).font('Helvetica-Bold').text(siteName, ML, y);
  y += 34;
  doc.fontSize(11).fillColor(MUTED).font('Helvetica').text(siteAddress, ML, y);
  y += 20;

  doc.fontSize(10).fillColor(MUTED).font('Helvetica')
     .text(`Report Period: ${periodStr}  |  Generated: ${new Date().toLocaleDateString('en-GB')}`, ML, y);
  y += 30;

  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(1).stroke();
  y += 20;

  // Stats cards
  const statsW = CW / 4;
  const statsData = [
    { label: 'TOTAL REPORTS', value: reports.length,             color: TEXT },
    { label: 'ACTIVITY',      value: activityReports.length,    color: BLUE },
    { label: 'INCIDENTS',     value: incidentReports.length,    color: RED  },
    { label: 'MAINTENANCE',   value: maintenanceReports.length, color: AMBER },
  ];
  for (let i = 0; i < statsData.length; i++) {
    const sx = ML + i * statsW;
    doc.rect(sx + 4, y, statsW - 8, 68).fill(i % 2 === 0 ? GRAY1 : WHITE).stroke();
    doc.rect(sx + 4, y, 4, 68).fill(statsData[i].color);
    doc.fontSize(32).fillColor(statsData[i].color).font('Helvetica-Bold')
       .text(String(statsData[i].value), sx + 14, y + 10, { width: statsW - 22, lineBreak: false });
    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
       .text(statsData[i].label, sx + 14, y + 48, { width: statsW - 22 });
  }
  y += 82;

  doc.fontSize(10).fillColor(TEXT).font('Helvetica-Bold').text('Report Type Breakdown', ML, y);
  y += 16;
  proportionBar(doc, ML, y, CW, 20, [
    { value: activityReports.length,    color: BLUE  },
    { value: incidentReports.length,    color: RED   },
    { value: maintenanceReports.length, color: AMBER },
  ]);
  y += 24;
  const legendItems = [
    { label: 'Activity',    color: BLUE,  count: activityReports.length },
    { label: 'Incidents',   color: RED,   count: incidentReports.length },
    { label: 'Maintenance', color: AMBER, count: maintenanceReports.length },
  ];
  let lx = ML;
  for (const li of legendItems) {
    doc.rect(lx, y + 2, 10, 10).fill(li.color);
    doc.fontSize(9).fillColor(TEXT).font('Helvetica')
       .text(`${li.label} (${li.count})`, lx + 14, y, { lineBreak: false });
    lx += 120;
  }
  y += 30;

  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(0.5).stroke();
  y += 20;

  // Guard coverage summary
  doc.fontSize(10).fillColor(TEXT).font('Helvetica-Bold').text('Guard Coverage Summary', ML, y);
  y += 16;
  doc.rect(ML, y, CW, 50).fill(GRAY1);
  doc.fontSize(28).fillColor(NAVY).font('Helvetica-Bold')
     .text(totalHours.toFixed(1), ML + 20, y + 10, { lineBreak: false });
  doc.fontSize(11).fillColor(MUTED).font('Helvetica')
     .text(' hours total coverage', ML + 80, y + 18, { lineBreak: false });
  doc.fontSize(9).fillColor(MUTED).font('Helvetica')
     .text(`${shifts.length} shifts  |  ${guardStats.length} guards deployed`, ML + 20, y + 36);
  y += 64;

  if (guardStats.length > 0) {
    doc.fontSize(10).fillColor(TEXT).font('Helvetica-Bold').text('Top Guards This Period', ML, y);
    y += 14;
    const topGuards = guardStats.slice(0, 3);
    for (const g of topGuards) {
      doc.fontSize(9).fillColor(TEXT).font('Helvetica')
         .text(`\u2022 ${g.name}`, ML + 10, y, { lineBreak: false, width: 200 });
      doc.fontSize(9).fillColor(MUTED).font('Helvetica')
         .text(`${g.hours.toFixed(1)}h  |  ${g.reports} reports`, ML + 220, y, { lineBreak: false });
      y += 14;
    }
  }

  drawFooter(doc, siteName, periodStr);

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 2 — Activity Timeline
  // ══════════════════════════════════════════════════════════════════════════════
  doc.addPage();
  drawHeader(doc, 'ACTIVITY TIMELINE', 2, 5);
  y = 90;

  doc.fontSize(14).fillColor(BLUE).font('Helvetica-Bold').text('Activity Timeline', ML, y);
  y = doc.y + 2;
  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(BLUE).lineWidth(2).stroke();
  y += 16;

  for (const [dateStr, dayReports] of byDate) {
    if (y > 750) {
      drawFooter(doc, siteName, periodStr);
      doc.addPage();
      drawHeader(doc, 'ACTIVITY TIMELINE (cont.)', 2, 5);
      y = 90;
    }

    doc.rect(ML, y, CW, 22).fill(NAVY);
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold').text(dateStr, ML + 10, y + 6);
    doc.fontSize(9).fillColor('#94A3B8').font('Helvetica')
       .text(`${dayReports.length} report${dayReports.length !== 1 ? 's' : ''}`, 0, y + 6, { align: 'right', width: PAGE_W - ML });
    y += 28;

    const timelineX = ML + 20;
    doc.moveTo(timelineX, y).lineTo(timelineX, y + dayReports.length * 46)
       .strokeColor(GRAY2).lineWidth(1.5).stroke();

    for (const r of dayReports) {
      if (y > 750) {
        drawFooter(doc, siteName, periodStr);
        doc.addPage();
        drawHeader(doc, 'ACTIVITY TIMELINE (cont.)', 2, 5);
        y = 90;
      }
      const dotColor = TYPE_DOT_COLOR[r.report_type] ?? MUTED;
      const timeStr  = new Date(r.reported_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

      doc.circle(timelineX, y + 8, 5).fill(dotColor);
      doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(timeStr, timelineX + 12, y + 4, { lineBreak: false });
      badge(doc, timelineX + 48, y + 2, TYPE_LABEL[r.report_type] ?? r.report_type.toUpperCase(), dotColor);
      doc.fontSize(8).fillColor(MUTED).font('Helvetica')
         .text(`  ${r.guard_name}`, timelineX + 120, y + 4, { lineBreak: false });
      const snippet = (r.description?.length ?? 0) > 100
        ? r.description.slice(0, 100) + '\u2026'
        : (r.description ?? '');
      doc.fontSize(9).fillColor(TEXT).font('Helvetica')
         .text(snippet, timelineX + 12, y + 18, { width: CW - 30 });
      y += 46;
    }
    y += 8;
  }

  if (byDate.size === 0) {
    doc.fontSize(12).fillColor(MUTED).font('Helvetica')
       .text('No reports for this period.', ML, y, { align: 'center', width: CW });
  }

  drawFooter(doc, siteName, periodStr);

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 3 — Incident Deep Dive
  // ══════════════════════════════════════════════════════════════════════════════
  doc.addPage();
  drawHeader(doc, 'INCIDENT DEEP DIVE', 3, 5);
  y = 90;

  doc.fontSize(14).fillColor(RED).font('Helvetica-Bold').text('Incident Reports', ML, y);
  y = doc.y + 2;
  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(RED).lineWidth(2).stroke();
  y += 16;

  if (incidentReports.length === 0) {
    doc.rect(ML, y, CW, 50).fill(GRAY1);
    doc.fontSize(12).fillColor(MUTED).font('Helvetica')
       .text('No incidents in this period.', ML, y + 16, { align: 'center', width: CW });
    y += 66;
  } else {
    // Severity breakdown bar
    const low  = incidentReports.filter(r => r.severity === 'low').length;
    const med  = incidentReports.filter(r => r.severity === 'medium').length;
    const high = incidentReports.filter(r => r.severity === 'high').length;
    doc.fontSize(10).fillColor(TEXT).font('Helvetica-Bold').text('Severity Breakdown', ML, y);
    y += 14;
    proportionBar(doc, ML, y, CW, 16, [
      { value: low,  color: '#16A34A' },
      { value: med,  color: AMBER },
      { value: high, color: RED },
    ]);
    y += 20;
    let lx2 = ML;
    for (const [rowLbl, count, color] of [['LOW', low, '#16A34A'], ['MEDIUM', med, AMBER], ['HIGH', high, RED]] as [string, number, string][]) {
      doc.rect(lx2, y + 2, 10, 10).fill(color);
      doc.fontSize(9).fillColor(TEXT).font('Helvetica')
         .text(`${rowLbl} (${count})`, lx2 + 14, y, { lineBreak: false });
      lx2 += 100;
    }
    y += 30;

    // Monthly trend table
    doc.fontSize(10).fillColor(TEXT).font('Helvetica-Bold').text('Monthly Trend (Last 3 Months)', ML, y);
    y += 14;
    const months = new Map<string, { low: number; medium: number; high: number }>();
    for (const row of monthlyIncidents) {
      if (!months.has(row.month)) months.set(row.month, { low: 0, medium: 0, high: 0 });
      const m = months.get(row.month)!;
      if (row.severity === 'low')         m.low    += parseInt(row.count);
      else if (row.severity === 'medium') m.medium += parseInt(row.count);
      else if (row.severity === 'high')   m.high   += parseInt(row.count);
    }
    const monthKeys = Array.from(months.keys());
    const colW      = CW / (monthKeys.length + 1);

    doc.rect(ML, y, CW, 20).fill(NAVY);
    doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold')
       .text('Severity', ML + 4, y + 6, { width: colW, lineBreak: false });
    for (let mi = 0; mi < monthKeys.length; mi++) {
      doc.text(monthKeys[mi], ML + (mi + 1) * colW, y + 6, { width: colW, lineBreak: false });
    }
    y += 20;

    for (const [rowLabel, key, rowColor] of [
      ['LOW', 'low', '#16A34A'], ['MEDIUM', 'medium', AMBER], ['HIGH', 'high', RED], ['TOTAL', 'total', NAVY]
    ] as [string, string, string][]) {
      const isEven = ['LOW', 'HIGH'].includes(rowLabel);
      doc.rect(ML, y, CW, 18).fill(isEven ? GRAY1 : WHITE);
      doc.rect(ML, y, 4, 18).fill(rowColor);
      doc.fontSize(8).fillColor(TEXT).font('Helvetica-Bold')
         .text(rowLabel, ML + 8, y + 5, { width: colW, lineBreak: false });
      for (let mi = 0; mi < monthKeys.length; mi++) {
        const m   = months.get(monthKeys[mi])!;
        const val = key === 'total' ? m.low + m.medium + m.high : (m as Record<string, number>)[key];
        doc.fontSize(8).fillColor(TEXT).font('Helvetica')
           .text(String(val), ML + (mi + 1) * colW, y + 5, { width: colW, lineBreak: false });
      }
      y += 18;
    }
    y += 20;

    // Individual incident cards
    doc.fontSize(10).fillColor(TEXT).font('Helvetica-Bold').text('Incident Details', ML, y);
    y += 8;
    doc.moveTo(ML, y).lineTo(MR, y).strokeColor(GRAY2).lineWidth(0.5).stroke();
    y += 10;

    for (const r of incidentReports) {
      if (y > 730) {
        drawFooter(doc, siteName, periodStr);
        doc.addPage();
        drawHeader(doc, 'INCIDENT DEEP DIVE (cont.)', 3, 5);
        y = 90;
      }
      const sev      = (r.severity ?? 'low').toLowerCase();
      const sevColor = sev === 'high' ? RED : sev === 'medium' ? AMBER : '#16A34A';
      const dt       = new Date(r.reported_at).toLocaleString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
      });

      doc.rect(ML, y, CW, 4).fill(sevColor);
      doc.rect(ML, y + 4, CW, 44).fill(GRAY1);
      badge(doc, ML + 8, y + 10, sev.toUpperCase(), sevColor);
      doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(dt, ML + 80, y + 12, { lineBreak: false });
      doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(`Guard: ${r.guard_name}`, ML + 260, y + 12, { lineBreak: false });
      const desc = r.description ?? '';
      doc.fontSize(9).fillColor(TEXT).font('Helvetica')
         .text(desc, ML + 8, y + 28, { width: CW - 16, lineBreak: false, ellipsis: true });
      y += 58;
    }
  }

  drawFooter(doc, siteName, periodStr);

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 4 — Maintenance Summary
  // ══════════════════════════════════════════════════════════════════════════════
  doc.addPage();
  drawHeader(doc, 'MAINTENANCE SUMMARY', 4, 5);
  y = 90;

  doc.fontSize(14).fillColor(AMBER).font('Helvetica-Bold').text('Maintenance Reports', ML, y);
  y = doc.y + 2;
  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(AMBER).lineWidth(2).stroke();
  y += 16;

  if (maintenanceReports.length === 0) {
    doc.rect(ML, y, CW, 50).fill(GRAY1);
    doc.fontSize(12).fillColor(MUTED).font('Helvetica')
       .text('No maintenance reports in this period.', ML, y + 16, { align: 'center', width: CW });
    y += 66;
  } else {
    doc.rect(ML, y, CW / 2 - 10, 50).fill(GRAY1);
    doc.rect(ML, y, 4, 50).fill(AMBER);
    doc.fontSize(28).fillColor(AMBER).font('Helvetica-Bold')
       .text(String(maintenanceReports.length), ML + 14, y + 8, { lineBreak: false });
    doc.fontSize(9).fillColor(MUTED).font('Helvetica').text('Maintenance Items', ML + 14, y + 36);
    y += 64;

    const colWidths = [160, 80, 80, CW - 320];
    const colLabels = ['GUARD', 'DATE', 'TIME', 'DESCRIPTION'];
    doc.rect(ML, y, CW, 22).fill(NAVY);
    let cx2 = ML;
    for (let i = 0; i < colLabels.length; i++) {
      doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold')
         .text(colLabels[i], cx2 + 6, y + 7, { width: colWidths[i], lineBreak: false });
      cx2 += colWidths[i];
    }
    y += 22;

    for (let ri = 0; ri < maintenanceReports.length; ri++) {
      if (y > 750) {
        drawFooter(doc, siteName, periodStr);
        doc.addPage();
        drawHeader(doc, 'MAINTENANCE SUMMARY (cont.)', 4, 5);
        y = 90;
      }
      const r    = maintenanceReports[ri];
      const dt   = new Date(r.reported_at);
      const rowH = 20;
      doc.rect(ML, y, CW, rowH).fill(ri % 2 === 0 ? GRAY1 : WHITE);
      doc.rect(ML, y, 4, rowH).fill(AMBER);

      const cells = [
        r.guard_name,
        dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
        dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
        (r.description ?? '').slice(0, 55),
      ];
      let cx3 = ML;
      for (let i = 0; i < cells.length; i++) {
        doc.fontSize(8).fillColor(TEXT).font('Helvetica')
           .text(cells[i], cx3 + 6, y + 6, { width: colWidths[i] - 8, lineBreak: false, ellipsis: true });
        cx3 += colWidths[i];
      }
      y += rowH;
    }
  }

  drawFooter(doc, siteName, periodStr);

  // ══════════════════════════════════════════════════════════════════════════════
  // PAGE 5 — Guard Activity Summary
  // ══════════════════════════════════════════════════════════════════════════════
  doc.addPage();
  drawHeader(doc, 'GUARD ACTIVITY SUMMARY', 5, 5);
  y = 90;

  doc.fontSize(14).fillColor(NAVY).font('Helvetica-Bold').text('Guard Performance', ML, y);
  y = doc.y + 2;
  doc.moveTo(ML, y).lineTo(MR, y).strokeColor(NAVY).lineWidth(2).stroke();
  y += 20;

  const gColW      = [160, 60, 80, 90, 105];
  const gColLabels = ['GUARD NAME', 'SHIFTS', 'HOURS', 'REPORTS', 'INCIDENTS'];
  doc.rect(ML, y, CW, 24).fill(NAVY);
  let gx = ML;
  for (let i = 0; i < gColLabels.length; i++) {
    doc.fontSize(8).fillColor(WHITE).font('Helvetica-Bold')
       .text(gColLabels[i], gx + 6, y + 8, { width: gColW[i], lineBreak: false });
    gx += gColW[i];
  }
  y += 24;

  const topGuardName = guardStats[0]?.name;
  for (let gi = 0; gi < guardStats.length; gi++) {
    if (y > 750) {
      drawFooter(doc, siteName, periodStr);
      doc.addPage();
      drawHeader(doc, 'GUARD ACTIVITY SUMMARY (cont.)', 5, 5);
      y = 90;
    }
    const g     = guardStats[gi];
    const isTop = g.name === topGuardName;
    const rowH  = 24;

    doc.rect(ML, y, CW, rowH).fill(isTop ? '#FEF3C7' : (gi % 2 === 0 ? GRAY1 : WHITE));
    if (isTop) doc.rect(ML, y, 4, rowH).fill(AMBER);

    const cells = [
      isTop ? `\u2605 ${g.name}` : g.name,
      String(g.shifts),
      `${g.hours.toFixed(1)}h`,
      String(g.reports),
      String(g.incidents),
    ];
    let gx2 = ML;
    for (let i = 0; i < cells.length; i++) {
      doc.fontSize(9)
         .fillColor(isTop ? '#92400E' : TEXT)
         .font(isTop ? 'Helvetica-Bold' : 'Helvetica')
         .text(cells[i], gx2 + 6, y + 7, { width: gColW[i] - 8, lineBreak: false });
      gx2 += gColW[i];
    }
    y += rowH;
  }

  // Totals row
  doc.rect(ML, y, CW, 24).fill(NAVY);
  const totalCells = [
    'TOTAL',
    String(shifts.length),
    `${totalHours.toFixed(1)}h`,
    String(reports.length),
    String(incidentReports.length),
  ];
  let tx = ML;
  for (let i = 0; i < totalCells.length; i++) {
    doc.fontSize(9).fillColor(WHITE).font('Helvetica-Bold')
       .text(totalCells[i], tx + 6, y + 7, { width: gColW[i] - 8, lineBreak: false });
    tx += gColW[i];
  }
  y += 36;

  drawFooter(doc, siteName, periodStr);
  doc.end();
});

export default router;
