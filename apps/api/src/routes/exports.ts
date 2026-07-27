/**
 * Export routes — Star admin analytics CSV and Excel downloads.
 * Company_admin callers are scoped to their own company_id. Vishnu
 * (super-admin) is allowed with the company_id predicate dropped —
 * exports span every company, mirroring the pattern on GET /api/sites
 * and GET /api/admin/violations.
 *
 * GET /api/exports/analytics/csv   → UTF-8 CSV attachment
 * GET /api/exports/analytics/xlsx  → Excel workbook attachment
 *
 * Query params (all optional):
 *   site_id    — filter to a single site
 *   guard_id   — filter to a single guard (applies to all sheets — every query joins `guards g`)
 *   date_from  — ISO date string
 *   date_to    — ISO date string
 *   type       — 'hours' | 'reports' | 'incidents' | 'violations' (default: all sheets)
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { SHIFT_HOURS_SQL_FIELDS } from '../services/shiftHours';

const router = Router();

// ── Shared query builder ─────────────────────────────────────────────────────

async function fetchAnalyticsData(companyId: string | null, params: {
  site_id?:   string;
  guard_id?:  string;
  date_from?: string;
  date_to?:   string;
}) {
  const { site_id, guard_id, date_from, date_to } = params;
  const isVishnu = companyId === null;   // caller passes null for super-admin

  // Build parameterized args + filter clauses for a query.
  // dateFrom/dateTo are column references for that specific query. guard_id
  // filters on `g.id` which every sheet's query already JOINs (hours + reports
  // via shift_sessions.guard_id, violations via geofence_violations.guard_id).
  // cidPredicate is either `s.company_id = $1` or `true` — the caller splices
  // it in as the leading WHERE so Vishnu can pull all-company exports.
  function buildArgs(dateFrom: string, dateTo: string) {
    const args: string[] = [];
    let cidPredicate: string;
    if (isVishnu) {
      cidPredicate = 'true';
    } else {
      args.push(companyId!);
      cidPredicate = `s.company_id = $${args.length}`;
    }
    const clauses: string[] = [];
    if (site_id)   { args.push(site_id);   clauses.push(`AND s.id = $${args.length}`); }
    if (guard_id)  { args.push(guard_id);  clauses.push(`AND g.id = $${args.length}`); }
    if (date_from) { args.push(date_from); clauses.push(`AND ${dateFrom} >= $${args.length}`); }
    if (date_to)   { args.push(date_to);   clauses.push(`AND ${dateTo} <= $${args.length}`); }
    return { args, cidPredicate, filter: clauses.join(' ') };
  }

  // Guard hours by site — Phase 1 adds the 4-field breakdown alongside
  // the legacy `total_hours` scalar. sh JOIN needed for scheduled_hours.
  const hq = buildArgs('ss.clocked_in_at', 'ss.clocked_in_at');
  const hours = await pool.query(`
    SELECT
      CASE WHEN s.is_active THEN s.name ELSE '[INACTIVE] ' || s.name END AS site_name,
      g.name                           AS guard_name,
      g.badge_number,
      DATE(ss.clocked_in_at)           AS shift_date,
      ROUND(CAST(ss.total_hours AS NUMERIC), 2) AS total_hours,
      ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')},
      ss.clocked_in_at,
      ss.clocked_out_at
    FROM shift_sessions ss
    JOIN shifts sh ON sh.id = ss.shift_id
    JOIN sites s   ON s.id = ss.site_id
    JOIN guards g  ON g.id = ss.guard_id
    WHERE ${hq.cidPredicate}
      ${hq.filter}
    ORDER BY ss.clocked_in_at DESC
    LIMIT 5000
  `, hq.args);

  // Reports summary
  const rq = buildArgs('r.reported_at', 'r.reported_at');
  const reports = await pool.query(`
    SELECT
      CASE WHEN s.is_active THEN s.name ELSE '[INACTIVE] ' || s.name END AS site_name,
      g.name          AS guard_name,
      r.report_type,
      r.severity,
      r.reported_at,
      LEFT(r.description, 200) AS description_preview
    FROM reports r
    JOIN sites s         ON s.id = r.site_id
    JOIN shift_sessions ss ON ss.id = r.shift_session_id
    JOIN guards g        ON g.id = ss.guard_id
    WHERE ${rq.cidPredicate}
      ${rq.filter}
    ORDER BY r.reported_at DESC
    LIMIT 5000
  `, rq.args);

  // Geofence violations
  const vq = buildArgs('gv.occurred_at', 'gv.occurred_at');
  const violations = await pool.query(`
    SELECT
      CASE WHEN s.is_active THEN s.name ELSE '[INACTIVE] ' || s.name END AS site_name,
      g.name               AS guard_name,
      gv.occurred_at,
      gv.resolved_at,
      gv.duration_minutes,
      gv.supervisor_override,
      gv.notification_sent
    FROM geofence_violations gv
    JOIN sites s  ON s.id = gv.site_id
    JOIN guards g ON g.id = gv.guard_id
    WHERE ${vq.cidPredicate}
      ${vq.filter}
    ORDER BY gv.occurred_at DESC
    LIMIT 2000
  `, vq.args);

  return { hours: hours.rows, reports: reports.rows, violations: violations.rows };
}

// ── CSV export ───────────────────────────────────────────────────────────────

function rowsToCsv(
  headers: string[],
  rows: Record<string, unknown>[],
  labels?: string[],
): string {
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v).replace(/"/g, '""');
    return `"${s}"`;
  };
  // `labels` is optional; when supplied it becomes the first row of the CSV
  // (friendly column names) while `headers` remains the row-object key list
  // used for value lookup. Length mismatch → falls back to headers so callers
  // can't accidentally desync labels and lookups.
  const headerLabels = labels && labels.length === headers.length ? labels : headers;
  const header = headerLabels.map(escape).join(',');
  const body   = rows.map((row) => headers.map((h) => escape(row[h])).join(',')).join('\n');
  return `${header}\n${body}`;
}

router.get('/analytics/csv', requireAuth('company_admin', 'vishnu'), async (req: Request, res: Response) => {
  const { site_id, guard_id, date_from, date_to, type } = req.query as Record<string, string>;
  const isVishnu = req.user!.role === 'vishnu';
  const data = await fetchAnalyticsData(
    isVishnu ? null : req.user!.company_id!,
    { site_id, guard_id, date_from, date_to },
  );

  const sections: string[] = [];

  if (!type || type === 'hours') {
    sections.push('GUARD HOURS\n' + rowsToCsv(
      [
        'site_name','guard_name','badge_number','shift_date',
        'total_hours','scheduled_hours','actual_hours','break_hours','violation_hours',
        'clocked_in_at','clocked_out_at',
      ],
      data.hours,
      // Phase 2 D3 — Off-post header for label consistency with UI/XLSX.
      [
        'Site','Guard','Badge','Shift Date',
        'Total Hours (legacy)','Scheduled Hours','Actual Hours','Break Hours','Off-post Hours',
        'Clocked In','Clocked Out',
      ],
    ));
  }
  if (!type || type === 'reports') {
    sections.push('\nREPORTS\n' + rowsToCsv(
      ['site_name','guard_name','report_type','severity','reported_at','description_preview'],
      data.reports
    ));
  }
  if (!type || type === 'violations') {
    sections.push('\nGEOFENCE VIOLATIONS\n' + rowsToCsv(
      ['site_name','guard_name','occurred_at','resolved_at','duration_minutes','supervisor_override','notification_sent'],
      data.violations
    ));
  }

  const filename = `guard-analytics-${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + sections.join('\n')); // BOM for Excel UTF-8 compatibility
});

// ── Excel (XLSX) export ──────────────────────────────────────────────────────

router.get('/analytics/xlsx', requireAuth('company_admin', 'vishnu'), async (req: Request, res: Response) => {
  const { site_id, guard_id, date_from, date_to } = req.query as Record<string, string>;
  const isVishnu = req.user!.role === 'vishnu';
  const data = await fetchAnalyticsData(
    isVishnu ? null : req.user!.company_id!,
    { site_id, guard_id, date_from, date_to },
  );

  // Dynamically import xlsx to keep startup fast
  const XLSX = require('xlsx');

  const wb = XLSX.utils.book_new();

  // Sheet 1 — Guard Hours
  const hoursWs = XLSX.utils.json_to_sheet(data.hours);
  XLSX.utils.book_append_sheet(wb, hoursWs, 'Guard Hours');

  // Sheet 2 — Reports
  const reportsWs = XLSX.utils.json_to_sheet(data.reports);
  XLSX.utils.book_append_sheet(wb, reportsWs, 'Reports');

  // Sheet 3 — Geofence Violations
  const violWs = XLSX.utils.json_to_sheet(data.violations);
  XLSX.utils.book_append_sheet(wb, violWs, 'Geofence Violations');

  const buffer: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const filename = `guard-analytics-${new Date().toISOString().slice(0,10)}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

export default router;
