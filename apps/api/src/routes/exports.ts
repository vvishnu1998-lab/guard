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
    // Range bounds. Two defects fixed together (both were in this pair):
    //
    //   1. The upper bound was INCLUSIVE against a bare date string, so
    //      `date_to=2026-08-25` compared against 2026-08-25 00:00:00 and
    //      dropped the entire final day of every range. Measured on prod:
    //      67 rows returned where 72 exist. Silent - the export looked
    //      complete. It is now `< end + 1 day`, matching routes/billing.ts.
    //
    //   2. Neither bound was cast or anchored, so the implicit text ->
    //      timestamptz coercion resolved them at the SESSION timezone (UTC on
    //      Railway). Both are now ::date and anchored per-site on
    //      sites.timezone, consistent with 8b08e62 - `s` is the sites row
    //      every one of the three queries below already joins.
    //
    // This pair is shared by all three sheets via buildArgs, so the fix lands
    // on hours (ss.clocked_in_at), reports (r.reported_at) and violations
    // (gv.occurred_at) alike - all three were dropping their last day.
    if (date_from) { args.push(date_from); clauses.push(`AND ${dateFrom} >= (($${args.length}::date)::timestamp AT TIME ZONE s.timezone)`); }
    if (date_to)   { args.push(date_to);   clauses.push(`AND ${dateTo} <  (($${args.length}::date + INTERVAL '1 day') AT TIME ZONE s.timezone)`); }
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
      -- Site-local, matching routes/billing.ts (8b08e62). The UTC calendar
      -- date used here before filed a 19:54 PT clock-in under the next day,
      -- so the two customer-facing exports disagreed about the same session.
      -- Column type is unchanged - still a date; only the value moves.
      (ss.clocked_in_at AT TIME ZONE s.timezone)::date AS shift_date,
      ROUND(CAST(ss.total_hours AS NUMERIC), 2) AS total_hours,
      ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')},
      -- Rendered site-local, in SQL rather than JS. This file's XLSX path is
      -- json_to_sheet(rows), which emits EVERY key as a column, so carrying a
      -- site_timezone helper the way routes/billing.ts does would silently add
      -- a column to the sheet; TO_CHAR replaces the value in place and leaves
      -- the header row untouched. Shape matches billing's toLocaleString
      -- ('en-GB') output, DD/MM/YYYY, HH:MM:SS. NULL survives as NULL, which
      -- rowsToCsv renders as an empty field and json_to_sheet leaves blank.
      -- ORDER BY below stays on the QUALIFIED column (ss./r./gv.), not this
      -- alias — sorting the formatted string would order lexicographically by
      -- day-of-month.
      TO_CHAR(ss.clocked_in_at  AT TIME ZONE s.timezone, 'DD/MM/YYYY, HH24:MI:SS') AS clocked_in_at,
      TO_CHAR(ss.clocked_out_at AT TIME ZONE s.timezone, 'DD/MM/YYYY, HH24:MI:SS') AS clocked_out_at
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
      -- Site-local render — see the hours sheet above for the rationale.
      TO_CHAR(r.reported_at AT TIME ZONE s.timezone, 'DD/MM/YYYY, HH24:MI:SS') AS reported_at,
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
      -- Site-local render — see the hours sheet above for the rationale.
      TO_CHAR(gv.occurred_at AT TIME ZONE s.timezone, 'DD/MM/YYYY, HH24:MI:SS') AS occurred_at,
      TO_CHAR(gv.resolved_at AT TIME ZONE s.timezone, 'DD/MM/YYYY, HH24:MI:SS') AS resolved_at,
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
        'Total Hours (legacy)','Scheduled Hours','Actual Hours','Break Hours','Geofence Violation Hours',
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
