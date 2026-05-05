/**
 * Billing routes — hours export (XLSX) and monthly report archive.
 *
 * GET  /api/billing/hours-export        → .xlsx file download
 * GET  /api/billing/hours-export/monthly → list of auto-generated monthly reports
 * POST /api/billing/hours-export/schedule → trigger manual monthly report generation
 */

import { Router } from 'express';
import * as XLSX from 'xlsx';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { uploadBufferToS3 } from '../services/s3';

const router = Router();

// ── Shared query ─────────────────────────────────────────────────────────────

async function fetchHoursData(companyId: string, params: {
  start_date?: string;
  end_date?:   string;
  site_id?:    string;
  guard_id?:   string;
}) {
  const { start_date, end_date, site_id, guard_id } = params;
  const args: unknown[] = [companyId];
  const clauses: string[] = [];

  if (start_date) { args.push(start_date); clauses.push(`AND ss.clocked_in_at >= $${args.length}::date`); }
  if (end_date)   { args.push(end_date);   clauses.push(`AND ss.clocked_in_at <  ($${args.length}::date + INTERVAL '1 day')`); }
  if (site_id)    { args.push(site_id);    clauses.push(`AND s.id = $${args.length}`); }
  if (guard_id)   { args.push(guard_id);   clauses.push(`AND g.id = $${args.length}`); }

  const result = await pool.query(`
    SELECT
      g.name                                          AS guard_name,
      s.name                                          AS site_name,
      DATE(ss.clocked_in_at)                          AS shift_date,
      ss.clocked_in_at                                AS clock_in_time,
      ss.clocked_out_at                               AS clock_out_time,
      COALESCE(
        (SELECT SUM(bs.duration_minutes)
         FROM break_sessions bs
         WHERE bs.shift_session_id = ss.id
           AND bs.break_end IS NOT NULL), 0
      )                                               AS break_duration_mins,
      ROUND(CAST(COALESCE(ss.total_hours, 0) AS NUMERIC), 2) AS total_hours_worked,
      sh.status
    FROM shift_sessions ss
    JOIN shifts sh ON sh.id = ss.shift_id
    JOIN sites  s  ON s.id  = ss.site_id
    JOIN guards g  ON g.id  = ss.guard_id
    WHERE s.company_id = $1
      AND ss.clocked_out_at IS NOT NULL
      ${clauses.join(' ')}
    ORDER BY ss.clocked_in_at DESC
    LIMIT 10000
  `, args);

  return result.rows;
}

function buildWorkbook(rows: Record<string, unknown>[], fileName: string): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();

  // ── Detail sheet ─────────────────────────────────────────────────────────
  const detailData = [
    ['Guard Name', 'Site Name', 'Shift Date', 'Clock In Time', 'Clock Out Time', 'Break (mins)', 'Total Hours', 'Status'],
    ...rows.map(r => [
      r.guard_name,
      r.site_name,
      r.shift_date ? new Date(r.shift_date as string).toLocaleDateString('en-GB') : '',
      r.clock_in_time  ? new Date(r.clock_in_time as string).toLocaleString('en-GB') : '',
      r.clock_out_time ? new Date(r.clock_out_time as string).toLocaleString('en-GB') : '',
      r.break_duration_mins,
      r.total_hours_worked,
      r.status,
    ]),
  ];

  // Summary row: total hours per guard per site
  const summaryMap = new Map<string, number>();
  for (const r of rows) {
    const key = `${r.guard_name} @ ${r.site_name}`;
    summaryMap.set(key, (summaryMap.get(key) ?? 0) + Number(r.total_hours_worked));
  }
  detailData.push([]);
  detailData.push(['SUMMARY', '', '', '', '', '', '', '']);
  detailData.push(['Guard @ Site', '', '', '', '', '', 'Total Hours', '']);
  for (const [key, hours] of summaryMap) {
    detailData.push([key, '', '', '', '', '', Math.round(hours * 100) / 100, '']);
  }

  const ws = XLSX.utils.aoa_to_sheet(detailData);
  ws['!cols'] = [{ wch: 24 }, { wch: 24 }, { wch: 14 }, { wch: 22 }, { wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 12 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Hours Detail');

  return wb;
}

// ── GET /api/billing/hours-export ────────────────────────────────────────────

router.get('/hours-export', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { start_date, end_date, site_id, guard_id } = req.query as Record<string, string>;
  const companyId = req.user!.company_id ?? (req.query.company_id as string);

  if (!companyId) return res.status(400).json({ error: 'company_id required for vishnu role' });

  const rows = await fetchHoursData(companyId, { start_date, end_date, site_id, guard_id });

  const sd = start_date ?? 'all';
  const ed = end_date   ?? 'all';
  const fileName = `vwing-hours-${sd}-to-${ed}.xlsx`;

  const wb = buildWorkbook(rows, fileName);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

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
  const monthEnd   = new Date(year, month, 0).toISOString().split('T')[0]; // last day of month

  const rows = await fetchHoursData(companyId, { start_date: monthStart, end_date: monthEnd });

  const fileName = `vwing-hours-${monthStart}-to-${monthEnd}.xlsx`;
  const wb = buildWorkbook(rows, fileName);
  const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

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
