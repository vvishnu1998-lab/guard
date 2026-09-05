/**
 * Monthly Hours Report — 1st of every month at 12:00 UTC
 * Generates an XLSX hours report for the previous month for every company,
 * uploads to S3, and stores the URL in monthly_hours_reports.
 */

import { runJob } from './_run';
import { pool } from '../db/pool';
import { uploadBufferToS3 } from '../services/s3';
import { buildHoursExport } from '../services/hoursExport';
import { buildHoursWorkbook, workbookToBuffer } from '../services/hoursWorkbook';

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
runJob('monthlyHoursReport', '0 12 1 * *', async () => {
  console.log('[monthly-hours] Starting at', new Date().toISOString());

  const now   = new Date();
  const month = now.getMonth() === 0 ? 12 : now.getMonth();
  const year  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  // Date.UTC, not the local-time Date ctor — see routes/billing.ts. Same
  // value on Railway today; no longer dependent on the process TZ.
  const monthEnd   = new Date(Date.UTC(year, month, 0)).toISOString().split('T')[0];

  // is_test (schema_v60) excludes the stale duplicate tenant and the scratch
  // tenant. is_active alone was the filter, and it means "not decommissioned",
  // not "is a customer" — so this job uploaded an empty XLSX to
  // guard-media-prod for both of them every month. The bucket has versioning
  // on with no NoncurrentVersionExpiration, so those never went away.
  const companies = await pool.query(
    'SELECT id FROM companies WHERE is_active = true AND is_test = false',
  );

  for (const { id: companyId } of companies.rows) {
    try {
      // Same data contract and the same renderer the on-demand billing export
      // uses. This job used to carry its own copy of the query AND its own
      // workbook builder, and both had drifted from routes/billing.ts.
      const data = await buildHoursExport({
        company_id: companyId,
        start_date: monthStart,
        end_date:   monthEnd,
      });

      const buf = await workbookToBuffer(buildHoursWorkbook(data));
      // The KEY PREFIX keeps its shape (monthly-reports/{companyId}/) so the
      // existing rows in monthly_hours_reports stay resolvable. The BASENAME
      // gains the tenant slug: every tenant's file used to be named
      // {YYYY-MM}.xlsx, so four tenants' downloads collided on one local
      // filename and the tenant lived only in the key path, invisible to
      // whoever opened the file.
      const key = `monthly-reports/${companyId}/netraops-hours-${data.company_slug}-${year}-${String(month).padStart(2, '0')}.xlsx`;
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
}, { sentryMonitor: true });
