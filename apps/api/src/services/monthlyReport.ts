/**
 * Monthly hours report — ONE generator and ONE key for both writers (N123).
 *
 * The monthly cron (jobs/monthlyHoursReport.ts) and the regenerate route
 * (POST /api/billing/hours-export/schedule) each used to build, upload and
 * upsert on their own, and they wrote DIFFERENT S3 keys for the same month:
 *
 *   cron   monthly-reports/{companyId}/netraops-hours-{slug}-{YYYY-MM}.xlsx
 *   route  monthly-reports/{companyId}/{YYYY-MM}.xlsx
 *
 * Both upsert the single monthly_hours_reports row per (company, month, year),
 * so whichever ran second re-pointed the row and left the other writer's
 * object referenced by nothing — and nothing ever deletes an unreferenced
 * object (nightlyPurge only sweeps the s3_url of rows it deletes). The cron's
 * slugged key is canonical; both writers now call generateMonthlyReport, so a
 * regeneration OVERWRITES the month's object instead of orphaning it — as long
 * as the stored row already holds this key. It does not when the company has
 * been renamed since (the slug follows the current name), or when the row
 * holds an older key: the route's {YYYY-MM}.xlsx, the cron's before 201fecc
 * (the same), or the cron's empty-slug netraops-hours--{YYYY-MM}.xlsx (now
 * 'company'). Then the row is re-pointed and the old object is left
 * unreferenced, as before.
 *
 * ── WHAT AN OVERWRITE DOES ───────────────────────────────────────────────
 *
 * guard-media-prod has versioning Enabled, so the previous bytes become a
 * NONCURRENT version. The bucket's lifecycle rule "noncurrent-30d" (read live
 * 2026-09-26: NoncurrentVersionExpiration NoncurrentDays 60 — the id says 30,
 * the value is 60) expires it about 60 days later. No app path passes a
 * VersionId, so the app itself only ever serves the current version.
 *
 * ── CHECKS BEFORE ANY UPLOAD ─────────────────────────────────────────────
 *
 * Every write happens upload-then-upsert, so a failure after the upload used
 * to leave an object behind (or, with one fixed key, silently replace the
 * archived file and then 500). Everything that can refuse — the month, the
 * year, the company's existence, is_test — refuses before the first byte goes
 * to S3. The company id used in the key is the one the DATABASE returns
 * (canonical lowercase), never the caller's spelling of it.
 *
 * This module registers no cron (it does not import jobs/_run), so a test or
 * a route can import it without scheduling anything.
 */

import { pool } from '../db/pool';
import { uploadBufferToS3 } from './s3';
import { buildHoursExport } from './hoursExport';
import { buildHoursWorkbook, workbookToBuffer } from './hoursWorkbook';
import { Sentry } from './sentry';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Used in the key when slugify(company name) is empty — a name with no ASCII
 * letters or digits ('!!!', emoji-only, CJK-only) or a blank one. The same
 * shape as the repo's other slug fallbacks ('guard' in pdf/guardHours.ts,
 * 'site' in the web site page). slugify() itself is not changed: the hours
 * export snapshot pins its output.
 */
export const EMPTY_SLUG_FALLBACK = 'company';

/** The month and year as the caller asked for them are not usable. */
export class MonthlyReportInputError extends Error {
  constructor(message: string) { super(message); this.name = 'MonthlyReportInputError'; }
}

/** The company does not exist, or is a test tenant — nothing is written. */
export class MonthlyReportNotEligibleError extends Error {
  constructor(
    message: string,
    readonly reason: 'COMPANY_NOT_FOUND' | 'TEST_COMPANY',
  ) { super(message); this.name = 'MonthlyReportNotEligibleError'; }
}

function assertYearMonth(year: number, month: number): void {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new MonthlyReportInputError(`year must be an integer from 2000 to 9999 (got ${String(year)})`);
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    throw new MonthlyReportInputError(`month must be an integer from 1 to 12 (got ${String(month)})`);
  }
}

const mm = (month: number): string => String(month).padStart(2, '0');

/**
 * THE key of a company's monthly report. Pure. Both writers reach it only
 * through generateMonthlyReport.
 *
 *   monthlyReportKey('27c4d404-…', 'starnet-security', 2026, 8)
 *     -> 'monthly-reports/27c4d404-…/netraops-hours-starnet-security-2026-08.xlsx'
 *
 * companyId must be the canonical lowercase form (the database's); slug must
 * already be slugified ('' falls back to EMPTY_SLUG_FALLBACK). The key stays
 * ASCII: stored URLs are read back through URL.pathname, which percent-encodes
 * anything else and would no longer match the key.
 */
export function monthlyReportKey(companyId: string, slug: string, year: number, month: number): string {
  if (!CANONICAL_UUID.test(companyId)) {
    throw new MonthlyReportInputError(`companyId must be a canonical lowercase uuid (got ${companyId})`);
  }
  assertYearMonth(year, month);
  const s = slug === '' ? EMPTY_SLUG_FALLBACK : slug;
  if (!SAFE_SLUG.test(s)) {
    throw new MonthlyReportInputError(`slug must be lowercase ASCII letters, digits and single hyphens (got ${slug})`);
  }
  return `monthly-reports/${companyId}/netraops-hours-${s}-${year}-${mm(month)}.xlsx`;
}

/**
 * The month before `now`'s month, in UTC — what the 1st-of-the-month cron
 * reports on. January rolls back to December of the previous year.
 */
export function previousMonth(now: Date = new Date()): { year: number; month: number } {
  const m = now.getUTCMonth(); // 0-based: the current month's index is the previous month's number
  return m === 0
    ? { year: now.getUTCFullYear() - 1, month: 12 }
    : { year: now.getUTCFullYear(), month: m };
}

/** First and last calendar day of the month, as 'YYYY-MM-DD' (site-local bounds are applied by the builder). */
export function monthRange(year: number, month: number): { start: string; end: string } {
  assertYearMonth(year, month);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${mm(month)}-01`, end: `${year}-${mm(month)}-${String(lastDay).padStart(2, '0')}` };
}

/**
 * True once the month has closed at every site — the cron's own bound: 12:00
 * UTC on the 1st of the FOLLOWING month (jobs/monthlyHoursReport.ts explains
 * why 12:00 and not 00:00). A report built earlier would be missing the last
 * evening of the month at US sites, and would overwrite the archived file.
 */
export function monthHasEnded(year: number, month: number, now: Date = new Date()): boolean {
  assertYearMonth(year, month);
  return now.getTime() >= Date.UTC(year, month, 1, 12, 0, 0); // Date.UTC month index `month` = the following month
}

export interface MonthlyReportResult {
  key:         string;
  s3Url:       string;
  generatedAt: Date;
  companyId:   string;  // canonical, as the database returned it
}

/**
 * Build one company's monthly hours report and store it at THE key.
 *
 * Order: validate -> look the company up -> build -> key -> upload -> upsert.
 * Everything before the upload refuses with a typed error and writes nothing.
 * A typed refusal (MonthlyReportInputError, MonthlyReportNotEligibleError) is
 * an answer, not a failure, and is not sent to Sentry. Any other error — the
 * lookup, the build, the upload, the upsert — is reported to Sentry with the
 * company id and the month as tags (no names) and rethrown: the cron logs it
 * and moves on to the next company; the route answers 500.
 *
 * On conflict the row keeps its id; s3_url is re-set (to the same key, unless
 * the name changed or the row predates this key — see the header) and
 * generated_at restarts at NOW(), so the billing page's GENERATED date is the
 * date of the file it serves. That also restarts the row's retention clock
 * (nightlyPurge, 1460 days from generated_at) — about a month on a four-year
 * window.
 */
export async function generateMonthlyReport(
  companyId: string, year: number, month: number,
): Promise<MonthlyReportResult> {
  assertYearMonth(year, month);
  const reportMonth = `${year}-${mm(month)}`;
  // The caller's spelling until the database answers; the tag is an id, never a name.
  let id = companyId.toLowerCase();

  try {
    const company = await pool.query<{ id: string; is_test: boolean }>(
      'SELECT id, is_test FROM companies WHERE id = $1', [companyId],
    );
    const row = company.rows[0];
    if (!row) throw new MonthlyReportNotEligibleError('company not found', 'COMPANY_NOT_FOUND');
    if (row.is_test) throw new MonthlyReportNotEligibleError('test companies get no monthly report', 'TEST_COMPANY');
    id = String(row.id).toLowerCase();

    const { start, end } = monthRange(year, month);
    const data = await buildHoursExport({ company_id: id, start_date: start, end_date: end });
    const buf = await workbookToBuffer(buildHoursWorkbook(data));
    const key = monthlyReportKey(id, data.company_slug, year, month);
    const s3Url = await uploadBufferToS3(key, buf, XLSX_MIME);
    const saved = await pool.query<{ s3_url: string; generated_at: Date }>(
      `INSERT INTO monthly_hours_reports (company_id, month, year, s3_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id, month, year) DO UPDATE SET s3_url = EXCLUDED.s3_url, generated_at = NOW()
       RETURNING s3_url, generated_at`,
      [id, month, year, s3Url],
    );
    return { key, s3Url: saved.rows[0]?.s3_url ?? s3Url, generatedAt: saved.rows[0]?.generated_at ?? new Date(), companyId: id };
  } catch (err) {
    if (!(err instanceof MonthlyReportInputError) && !(err instanceof MonthlyReportNotEligibleError)) {
      Sentry.captureException(err, {
        tags: { service: 'monthly_report', flow: 'monthly_report_generate', company_id: id, report_month: reportMonth },
      });
    }
    throw err;
  }
}
