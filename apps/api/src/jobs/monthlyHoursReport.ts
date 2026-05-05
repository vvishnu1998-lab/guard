/**
 * Monthly Hours Report — 1st of every month at 2:00 AM UTC
 * Generates an XLSX hours report for the previous month for every company,
 * uploads to S3, and stores the URL in monthly_hours_reports.
 */

import cron from 'node-cron';
import * as XLSX from 'xlsx';
import { pool } from '../db/pool';
import { uploadBufferToS3 } from '../services/s3';

cron.schedule('0 2 1 * *', async () => {
  console.log('[monthly-hours] Starting at', new Date().toISOString());

  const now   = new Date();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd   = new Date(year, month, 0).toISOString().split('T')[0];

  const companies = await pool.query('SELECT id FROM companies WHERE is_active = true');

  for (const { id: companyId } of companies.rows) {
    try {
      const rows = await pool.query(`
        SELECT
          g.name                                          AS guard_name,
          s.name                                          AS site_name,
          DATE(ss.clocked_in_at)                         AS shift_date,
          ss.clocked_in_at                               AS clock_in_time,
          ss.clocked_out_at                              AS clock_out_time,
          COALESCE(
            (SELECT SUM(bs.duration_minutes) FROM break_sessions bs
             WHERE bs.shift_session_id = ss.id AND bs.break_end IS NOT NULL), 0
          )                                              AS break_duration_mins,
          ROUND(CAST(COALESCE(ss.total_hours, 0) AS NUMERIC), 2) AS total_hours_worked,
          sh.status
        FROM shift_sessions ss
        JOIN shifts sh ON sh.id = ss.shift_id
        JOIN sites  s  ON s.id  = ss.site_id
        JOIN guards g  ON g.id  = ss.guard_id
        WHERE s.company_id = $1
          AND ss.clocked_in_at >= $2::date
          AND ss.clocked_in_at <  ($3::date + INTERVAL '1 day')
          AND ss.clocked_out_at IS NOT NULL
        ORDER BY ss.clocked_in_at DESC
        LIMIT 10000
      `, [companyId, monthStart, monthEnd]);

      const wb = XLSX.utils.book_new();
      const detailData = [
        ['Guard Name', 'Site Name', 'Shift Date', 'Clock In', 'Clock Out', 'Break (mins)', 'Total Hours', 'Status'],
        ...rows.rows.map((r: Record<string, unknown>) => [
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
