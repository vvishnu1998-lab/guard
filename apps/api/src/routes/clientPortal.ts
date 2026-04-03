/**
 * Client Portal API routes — read-only, strictly scoped to client's site_id.
 * CRITICAL: every query must filter by site_id from the JWT (Section 11.5).
 *
 * GET  /api/client/site            — site info + retention dates
 * GET  /api/client/guards-on-duty  — guards currently clocked in at this site
 * GET  /api/client/reports/pdf     — PDF report download (auth via ?token= query param)
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
            client_star_access_until, data_delete_at,
            EXTRACT(DAY FROM (data_delete_at - NOW()))::int AS days_until_deletion
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
       lp.created_at AS last_ping_at
     FROM shift_sessions ss
     JOIN guards g ON g.id = ss.guard_id
     LEFT JOIN LATERAL (
       SELECT latitude, longitude, created_at
       FROM location_pings
       WHERE shift_session_id = ss.id
       ORDER BY created_at DESC LIMIT 1
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
           array_agg(rp.storage_url ORDER BY rp.photo_index) FILTER (WHERE rp.id IS NOT NULL) AS photos,
           r.email_sent
    FROM reports r
    JOIN shift_sessions ss ON ss.id = r.shift_session_id
    JOIN guards g ON g.id = ss.guard_id
    LEFT JOIN report_photos rp ON rp.report_id = r.id
    WHERE r.site_id = $1`;
  const params: unknown[] = [req.user!.site_id];

  if (type)      { query += ` AND r.report_type = $${params.length + 1}`; params.push(type); }
  if (date_from) { query += ` AND r.reported_at >= $${params.length + 1}`; params.push(date_from); }
  if (date_to)   { query += ` AND r.reported_at <= $${params.length + 1}`; params.push(date_to + 'T23:59:59'); }

  query += ' GROUP BY r.id, g.name ORDER BY r.reported_at DESC LIMIT 200';

  const result = await pool.query(query, params);
  res.json(result.rows);
});

// ── PDF export ────────────────────────────────────────────────────────────────
// Auth via ?token= query param (required for browser download links).

router.get('/reports/pdf', async (req: Request, res: Response) => {
  // Verify token from query param
  const rawToken = req.query.token as string;
  if (!rawToken) return res.status(401).json({ error: 'Missing token' });

  let payload: AuthPayload;
  try {
    payload = jwt.verify(rawToken, process.env.JWT_SECRET!) as AuthPayload;
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  if (payload.role !== 'client' || !payload.site_id) {
    return res.status(403).json({ error: 'Client access required' });
  }

  const { from, to } = req.query as Record<string, string>;

  // Fetch site name
  const siteResult = await pool.query('SELECT name FROM sites WHERE id = $1', [payload.site_id]);
  const siteName = siteResult.rows[0]?.name ?? 'Unknown Site';

  // Fetch reports
  let query = `
    SELECT r.report_type, r.severity, r.description, r.reported_at,
           g.name AS guard_name
    FROM reports r
    JOIN shift_sessions ss ON ss.id = r.shift_session_id
    JOIN guards g ON g.id = ss.guard_id
    WHERE r.site_id = $1`;
  const params: unknown[] = [payload.site_id];

  if (from) { query += ` AND r.reported_at >= $${params.length + 1}`; params.push(from); }
  if (to)   { query += ` AND r.reported_at <= $${params.length + 1}`; params.push(to); }
  query += ' ORDER BY r.reported_at DESC LIMIT 500';

  const result = await pool.query(query, params);
  const reports = result.rows;

  // Build PDF
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const filename = `guard-report-${siteName.toLowerCase().replace(/\s+/g, '-')}-${new Date().toISOString().slice(0, 10)}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  // Header
  doc.fontSize(22).fillColor('#1A1A2E').text('GUARD', { align: 'left' });
  doc.fontSize(10).fillColor('#888').text('SECURITY MANAGEMENT PLATFORM', { align: 'left' });
  doc.moveDown(0.5);
  doc.fontSize(16).fillColor('#333').text(`Site Report — ${siteName}`);
  doc.fontSize(10).fillColor('#888');
  if (from || to) {
    const fromStr = from ? new Date(from).toLocaleDateString('en-GB') : '—';
    const toStr   = to   ? new Date(to).toLocaleDateString('en-GB')   : '—';
    doc.text(`Period: ${fromStr} to ${toStr}`);
  }
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')}`);
  doc.text(`Total reports: ${reports.length}`);
  doc.moveDown();
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#DDDDDD').stroke();
  doc.moveDown(0.5);

  if (reports.length === 0) {
    doc.fontSize(12).fillColor('#888').text('No reports found for this period.', { align: 'center' });
  }

  const TYPE_COLOR: Record<string, string> = {
    activity:    '#D97706',
    incident:    '#DC2626',
    maintenance: '#2563EB',
  };

  for (const r of reports) {
    const color = TYPE_COLOR[r.report_type] ?? '#555';
    const dt = new Date(r.reported_at).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });

    doc.fontSize(9).fillColor(color).text(
      `${r.report_type.toUpperCase()}${r.severity ? ' — ' + r.severity.toUpperCase() : ''}   ${dt}`,
    );
    doc.fontSize(10).fillColor('#111').text(r.description, { indent: 10 });
    doc.fontSize(8).fillColor('#888').text(`Guard: ${r.guard_name}`, { indent: 10 });
    doc.moveDown(0.4);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#EEEEEE').lineWidth(0.5).stroke();
    doc.moveDown(0.3);

    // Page break check
    if (doc.y > 720) doc.addPage();
  }

  // Footer
  doc.fontSize(8).fillColor('#AAAAAA').text(
    'Confidential — generated by Guard Security Management Platform',
    50, 790, { align: 'center', width: 495 }
  );

  doc.end();
});

export default router;
