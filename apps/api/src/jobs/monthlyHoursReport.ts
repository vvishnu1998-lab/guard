/**
 * Monthly Hours Report — 1st of every month at 12:00 UTC
 * Generates an XLSX hours report for the previous month for every company,
 * uploads to S3, and stores the URL in monthly_hours_reports.
 *
 * The build, the key, the upload and the row write are
 * services/monthlyReport.ts's generateMonthlyReport — the SAME function the
 * regenerate route calls, so a regeneration overwrites this job's object
 * instead of writing a second one (N123) — while the company's name, and so
 * its slug, is unchanged. The service's header has the exceptions.
 */

import { runJob } from './_run';
import { pool } from '../db/pool';
import { generateMonthlyReport, previousMonth } from '../services/monthlyReport';

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

  // The month before this one, in UTC. The job fires at 12:00 on the 1st
  // (process clock, UTC on Railway), which is after that month has closed at
  // every site — see the schedule note above.
  const { year, month } = previousMonth(new Date());

  // is_test (schema_v60) excludes the stale duplicate tenant and the scratch
  // tenant. is_active alone was the filter, and it means "not decommissioned",
  // not "is a customer" — so this job uploaded an empty XLSX to
  // guard-media-prod for both of them every month. The bucket has versioning
  // on with no NoncurrentVersionExpiration, so those never went away.
  // generateMonthlyReport refuses is_test itself as well, for the route.
  const companies = await pool.query(
    'SELECT id FROM companies WHERE is_active = true AND is_test = false',
  );

  for (const { id: companyId } of companies.rows) {
    try {
      // The key is monthly-reports/{companyId}/netraops-hours-{slug}-{YYYY-MM}.xlsx
      // (services/monthlyReport.ts monthlyReportKey). The BASENAME carries the
      // tenant slug because every tenant's file used to be named
      // {YYYY-MM}.xlsx, so four tenants' downloads collided on one local
      // filename and the tenant lived only in the key path.
      await generateMonthlyReport(companyId, year, month);
      console.log(`[monthly-hours] Generated for company ${companyId} ${year}-${month}`);
    } catch (err) {
      // generateMonthlyReport has already sent it to Sentry (company id and
      // month as tags); the heartbeat is unchanged and still reads ok.
      console.error(`[monthly-hours] Failed for company ${companyId}:`, err);
    }
  }

  console.log('[monthly-hours] Done at', new Date().toISOString());
}, { sentryMonitor: false });
