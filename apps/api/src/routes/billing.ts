/**
 * Billing routes — hours export and monthly report archive. The workbook
 * itself is rendered by services/hoursWorkbook.ts from the data contract in
 * services/hoursExport.ts; this file only wires HTTP and S3.
 *
 * GET  /api/billing/hours-export        → .xlsx file download
 * GET  /api/billing/hours-export/monthly → list of auto-generated monthly reports
 * POST /api/billing/hours-export/schedule → regenerate one company's monthly report (vishnu)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { urlOrPresign } from '../services/s3';
import { buildHoursExport, effectiveEndDate } from '../services/hoursExport';
import { buildHoursWorkbook, workbookToBuffer } from '../services/hoursWorkbook';
import {
  generateMonthlyReport,
  monthHasEnded,
  monthRange,
  MonthlyReportInputError,
  MonthlyReportNotEligibleError,
} from '../services/monthlyReport';
import { logEvent } from './auth';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const absent = (v: unknown): boolean => v === undefined || v === null;

/**
 * A month/year from a JSON body: an integer, or a string of digits, -> that
 * number; anything else (an array, an object, "aug", " 8x") -> NaN, which
 * monthRange() then refuses. Strict on purpose: `[8]` used to slip through
 * String()/Date.UTC as August and then fail the INSERT after the upload.
 */
function intField(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return NaN;
}

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
// Regenerate ONE company's monthly report. It calls the same
// generateMonthlyReport as the monthly cron (jobs/monthlyHoursReport.ts), so
// it writes the cron's key and overwrites that month's object; the previous
// bytes become a noncurrent S3 version (N123). Not when the company has been
// renamed since, or the row holds a pre-N123 key: then the row is re-pointed
// and the old object left unreferenced (services/monthlyReport.ts header).
// No screen calls this route.
//
// vishnu only. With one key per month a regeneration REPLACES the archived
// file, so it is not a company_admin action.
//
// Body: { company_id, year, month } — all three required. There is no default
// period: a regeneration overwrites the archived file, so the caller names the
// month it means (the cron computes its own). Refused before anything is
// written: a malformed company_id, a missing year or month, a month or year
// that is not an integer in range, a month that has not yet closed at every
// site (the cron's own 12:00 UTC-on-the-1st bound) or lies in the future, an
// unknown company, a test company.
//
// Error bodies put the enum in `code` and the sentence in `error` — the vishnu
// web client (lib/vishnuApi.ts) renders `error` as the message.

router.post('/hours-export/schedule', requireAuth('vishnu'), async (req, res) => {
  const companyId = req.body?.company_id;
  if (typeof companyId !== 'string' || !UUID_RE.test(companyId)) {
    return res.status(400).json({ code: 'INVALID_COMPANY_ID', error: 'company_id must be a uuid.' });
  }

  if (absent(req.body?.year) || absent(req.body?.month)) {
    return res.status(400).json({ code: 'PERIOD_REQUIRED', error: 'Both year and month are required.' });
  }
  const year  = intField(req.body.year);
  const month = intField(req.body.month);
  try {
    monthRange(year, month); // validates both
  } catch (err) {
    if (err instanceof MonthlyReportInputError) {
      return res.status(400).json({ code: 'INVALID_MONTH', error: 'month must be an integer from 1 to 12 and year from 2000 to 9999.' });
    }
    throw err;
  }
  if (!monthHasEnded(year, month)) {
    return res.status(409).json({
      code: 'MONTH_NOT_ENDED',
      error: 'That month has not closed at every site yet (12:00 UTC on the 1st of the following month).',
    });
  }

  let result;
  try {
    result = await generateMonthlyReport(companyId, year, month);
  } catch (err) {
    if (err instanceof MonthlyReportNotEligibleError) {
      return err.reason === 'COMPANY_NOT_FOUND'
        ? res.status(404).json({ code: 'COMPANY_NOT_FOUND', error: 'No company with that id.' })
        : res.status(409).json({ code: 'TEST_COMPANY', error: 'Test companies get no monthly report.' });
    }
    throw err; // generateMonthlyReport has reported it to Sentry
  }

  const reportMonth = `${year}-${String(month).padStart(2, '0')}`;
  console.log(
    `[monthly-hours.regenerated] company=${result.companyId} month=${reportMonth} ` +
    `key=${result.key} by=vishnu`,
  );
  await logEvent(req.user!.sub, 'vishnu', 'monthly_report_regenerated', req);

  // Presigned like GET /hours-export/monthly (S3 lockdown PR2): the stored URL
  // is never handed out raw.
  res.json({
    success: true,
    s3_url: await urlOrPresign(result.s3Url),
    month,
    year,
    generated_at: result.generatedAt,
  });
});

export default router;
