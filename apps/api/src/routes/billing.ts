/**
 * Billing routes — hours export and monthly report archive. The workbook
 * itself is rendered by services/hoursWorkbook.ts from the data contract in
 * services/hoursExport.ts; this file only wires HTTP and S3.
 *
 * GET  /api/billing/hours-export        → .xlsx file download
 * GET  /api/billing/hours-export/monthly → list of auto-generated monthly reports
 * POST /api/billing/hours-export/schedule → trigger manual monthly report generation
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { uploadBufferToS3, urlOrPresign } from '../services/s3';
import { buildHoursExport, effectiveEndDate } from '../services/hoursExport';
import { buildHoursWorkbook, workbookToBuffer } from '../services/hoursWorkbook';

const router = Router();

// ── Shared query ─────────────────────────────────────────────────────────────

// ── GET /api/billing/hours-export ────────────────────────────────────────────

router.get('/hours-export', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { start_date, end_date, site_id, guard_id } = req.query as Record<string, string>;
  const companyId = req.user!.company_id ?? (req.query.company_id as string);

  if (!companyId) return res.status(400).json({ error: 'company_id required for vishnu role' });

  const data = await buildHoursExport({ company_id: companyId, start_date, end_date, site_id, guard_id });

  // An open range names today's site-local date, not "all" — the same
  // treatment the workbook title and NOTES get. "all" read as "all time".
  const sd = start_date ?? 'start';
  const ed = effectiveEndDate(data);
  const fileName = `netraops-hours-${data.company_slug}-${sd}-to-${ed}.xlsx`;

  const buf = await workbookToBuffer(buildHoursWorkbook(data));

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(buf);
});

// ── GET /api/billing/hours-export/monthly ────────────────────────────────────

router.get('/hours-export/monthly', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const companyId = req.user!.company_id ?? (req.query.company_id as string);
  if (!companyId) return res.status(400).json({ error: 'company_id required' });

  const result = await pool.query(
    `SELECT id, company_id, month, year, s3_url, generated_at
     FROM monthly_hours_reports
     WHERE company_id = $1
     ORDER BY year DESC, month DESC`,
    [companyId]
  );
  // S3 lockdown (PR2): re-sign the monthly-report download URLs.
  for (const row of result.rows) {
    row.s3_url = await urlOrPresign(row.s3_url);
  }
  res.json(result.rows);
});

// ── POST /api/billing/hours-export/schedule ──────────────────────────────────
// Trigger (or re-trigger) monthly report generation for a given month/year.
// Also called by the cron job.

router.post('/hours-export/schedule', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const companyId = req.user!.company_id ?? (req.body.company_id as string);
  if (!companyId) return res.status(400).json({ error: 'company_id required' });

  const now = new Date();
  const month = req.body.month ?? (now.getMonth() === 0 ? 12 : now.getMonth());
  const year  = req.body.year  ?? (now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear());

  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  // Date.UTC, not the local-time Date ctor: new Date(y, m, 0) builds
  // process-local midnight, and .toISOString() on that rolls back a day in
  // any negative-offset TZ. Identical output on Railway (UTC) today; this
  // makes it independent of the process TZ rather than lucky.
  const monthEnd   = new Date(Date.UTC(year, month, 0)).toISOString().split('T')[0]; // last day of month

  const data = await buildHoursExport({ company_id: companyId, start_date: monthStart, end_date: monthEnd });

  const fileName = `netra-hours-${monthStart}-to-${monthEnd}.xlsx`;
  const buf = await workbookToBuffer(buildHoursWorkbook(data));

  const key = `monthly-reports/${companyId}/${year}-${String(month).padStart(2, '0')}.xlsx`;
  const s3Url = await uploadBufferToS3(key, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

  await pool.query(
    `INSERT INTO monthly_hours_reports (company_id, month, year, s3_url)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (company_id, month, year) DO UPDATE SET s3_url = EXCLUDED.s3_url, generated_at = NOW()
     RETURNING *`,
    [companyId, month, year, s3Url]
  );

  res.json({ success: true, s3_url: s3Url, month, year });
});

export default router;
