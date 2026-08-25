/**
 * Monthly Hours Report — 1st of every month at 12:00 UTC
 * Generates an XLSX hours report for the previous month for every company,
 * uploads to S3, and stores the URL in monthly_hours_reports.
 */

import cron from 'node-cron';
import * as XLSX from 'xlsx';
import { pool } from '../db/pool';
import { uploadBufferToS3 } from '../services/s3';
import { SHIFT_HOURS_SQL_FIELDS } from '../services/shiftHours';

// 12:00 UTC on the 1st, not 02:00. The job must not run until the reported
// month has CLOSED in every site's local timezone, because the range bounds
// below are anchored per-site on sites.timezone (8b08e62) rather than to UTC.
//
// At 02:00 UTC on the 1st, August's window — [Aug 1 00:00, Sep 1 00:00) at
// each site — was still five hours from closing in Pacific time. A shift
// starting 19:00–24:00 PT on the last day of the month would have been
// generated before it existed and silently missing from that month's file.
// That window is exactly STARNET's Cristo Rey post (19:00–06:00 PT). No
// production row has ever landed in it, so this is closing the hole before
// it is hit, not after.
//
// 12:00 UTC clears local midnight for every US timezone with margin —
// Pacific by 5h, Alaska by 4h, Hawaii (UTC-10, no DST) by 2h — and in fact
// for every inhabited zone, since the westernmost in use is UTC-11.
//
// KNOWN OPENNESS: a single global fire time is a blunt instrument. It is
// correct here because it is late enough for every zone, but it is not
// "immediately after close" for any of them, and it does not adapt. The
// general answer, consistent with the per-site decision, is a per-site close
// check — emit a company's file only once month-end has passed at all of its
// sites — which this does not do. Revisit if sites ever span wide longitudes.
cron.schedule('0 12 1 * *', async () => {
  console.log('[monthly-hours] Starting at', new Date().toISOString());

  const now   = new Date();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  // Date.UTC, not the local-time Date ctor — see routes/billing.ts. Same
  // value on Railway today; no longer dependent on the process TZ.
  const monthEnd   = new Date(Date.UTC(year, month, 0)).toISOString().split('T')[0];

  const companies = await pool.query('SELECT id FROM companies WHERE is_active = true');

  for (const { id: companyId } of companies.rows) {
    try {
      // Monthly payroll includes hours at now-deactivated sites —
      // historical completeness. `[INACTIVE] ` prefix matches the
      // hours-export streaming route so both surfaces render identically
      // for a decommissioned site.
      const rows = await pool.query(`
        SELECT
          g.name                                          AS guard_name,
          CASE WHEN s.is_active
            THEN s.name
            ELSE '[INACTIVE] ' || s.name
          END                                             AS site_name,
          (ss.clocked_in_at AT TIME ZONE s.timezone)::date AS shift_date,
          TO_CHAR((ss.clocked_in_at AT TIME ZONE s.timezone)::date, 'DD/MM/YYYY')
                                                         AS shift_date_label,
          s.timezone                                     AS site_timezone,
          ss.clocked_in_at                               AS clock_in_time,
          ss.clocked_out_at                              AS clock_out_time,
          COALESCE(
            (SELECT SUM(bs.duration_minutes) FROM break_sessions bs
             WHERE bs.shift_session_id = ss.id AND bs.break_end IS NOT NULL), 0
          )                                              AS break_duration_mins,
          ROUND(CAST(COALESCE(ss.total_hours, 0) AS NUMERIC), 2) AS total_hours_worked,
          ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')},
          sh.status
        FROM shift_sessions ss
        JOIN shifts sh ON sh.id = ss.shift_id
        JOIN sites  s  ON s.id  = ss.site_id
        JOIN guards g  ON g.id  = ss.guard_id
        WHERE s.company_id = $1
          AND ss.clocked_in_at >= (($2::date)::timestamp AT TIME ZONE s.timezone)
          AND ss.clocked_in_at <  (($3::date + INTERVAL '1 day') AT TIME ZONE s.timezone)
          AND ss.clocked_out_at IS NOT NULL
        ORDER BY ss.clocked_in_at DESC
        LIMIT 10000
      `, [companyId, monthStart, monthEnd]);

      const wb = XLSX.utils.book_new();
      // Phase 1 — 4-field breakdown columns appended (Scheduled/Actual/Break/Violation).
      const detailData = [
        ['Guard Name', 'Site Name', 'Shift Date', 'Clock In', 'Clock Out',
         'Break (mins)', 'Total Hours (legacy)',
         'Scheduled Hours', 'Actual Hours', 'Break Hours', 'Off-post Hours',
         'Status'],
        ...rows.rows.map((r: Record<string, unknown>) => [
          r.guard_name,
          r.site_name,
          r.shift_date_label ?? '',
          r.clock_in_time  ? new Date(r.clock_in_time as string).toLocaleString('en-GB', { timeZone: r.site_timezone as string }) : '',
          r.clock_out_time ? new Date(r.clock_out_time as string).toLocaleString('en-GB', { timeZone: r.site_timezone as string }) : '',
          r.break_duration_mins,
          r.total_hours_worked,
          Number(r.scheduled_hours) || 0,
          Number(r.actual_hours)    || 0,
          Number(r.break_hours)     || 0,
          Number(r.violation_hours) || 0,
          r.status,
        ]),
      ];
      const ws = XLSX.utils.aoa_to_sheet(detailData);
      XLSX.utils.book_append_sheet(wb, ws, 'Hours Detail');

      const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
      const key = `monthly-reports/${companyId}/${year}-${String(month).padStart(2, '0')}.xlsx`;
      const s3Url = await uploadBufferToS3(key, buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

      await pool.query(
        `INSERT INTO monthly_hours_reports (company_id, month, year, s3_url)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (company_id, month, year) DO UPDATE SET s3_url = EXCLUDED.s3_url, generated_at = NOW()`,
        [companyId, month, year, s3Url]
      );
      console.log(`[monthly-hours] Generated for company ${companyId} ${year}-${month}`);
    } catch (err) {
      console.error(`[monthly-hours] Failed for company ${companyId}:`, err);
    }
  }

  console.log('[monthly-hours] Done at', new Date().toISOString());
});
