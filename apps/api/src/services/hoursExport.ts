/**
 * Hours export data contract — ONE dataset behind every hours surface.
 *
 * routes/billing.ts and jobs/monthlyHoursReport.ts each carried a verbatim
 * copy of the same 11-expression query, and their workbooks had drifted:
 * different clock-in/out header labels, and the monthly file had neither the
 * SUMMARY block nor the column widths. A monthly file and an on-demand file
 * for the same range were not the same document. Both now call in here and
 * the sheet does no arithmetic — it renders what this returns.
 *
 * ── DETERMINISM ──────────────────────────────────────────────────────────
 *
 * No NOW() reaches the output. SHIFT_HOURS_SQL_FIELDS does contain NOW(),
 * and this deliberately still uses it rather than growing a ninth copy of
 * the hours arithmetic — the copy-per-caller pattern is what produced the
 * 405 h defect. Every NOW() branch is unreachable here because the query
 * filters `clocked_out_at IS NOT NULL`:
 *
 *   actual   COALESCE(clocked_out_at, NOW())            -> clocked_out_at
 *   break    LEAST(COALESCE(break_end, NOW()),  cout)   -> cout when break_end
 *                                                          is null, since a
 *                                                          closed session has
 *                                                          cout <= NOW()
 *   offpost  LEAST(COALESCE(resolved_at, NOW()), cout)  -> same
 *
 * For any closed session clocked_out_at <= NOW(), so LEAST always selects
 * clocked_out_at and the result cannot move between two runs. The snapshot
 * script asserts this by building the dataset twice and diffing.
 *
 * ── SCHEDULED HOURS AND THE HANDOFF SPLIT ────────────────────────────────
 *
 * scheduled_hours belongs to the SHIFT, not the session. Summing it per
 * session double-counts a mid-shift handoff — services/shiftHours.ts warns
 * about exactly this, and prod has one such shift today
 * (d9ac9565, 7.50 h scheduled, reddy -> kartikeya, summed as 15.00 h).
 *
 * Every aggregate therefore uses a per-session SHARE of the shift's
 * scheduled hours, split in proportion to actual hours worked:
 *
 *     share(session) = shift.scheduled * (session.actual / shift.actual)
 *
 * Properties that make this the rule rather than a fudge:
 *   * For a single-session shift the share IS the full scheduled value —
 *     exact for 75 of prod's 76 shifts, no approximation introduced.
 *   * Shares sum to the shift's scheduled exactly, so
 *     Σ by_guard == Σ by_site == overall, always. The snapshot asserts it.
 *   * It survives filtering. Counting DISTINCT shift_id instead would
 *     over-count when a guard_id filter puts only one side of a handoff in
 *     scope — the site total would claim scheduled hours for work outside
 *     the result set.
 *   * A shift whose sessions total zero actual hours splits equally, since
 *     proportion is undefined there.
 *
 * The per-ROW scheduled_hours field is the shift's FULL scheduled value, not
 * the share — a reader looking at one line wants that shift's scheduled
 * window. Only aggregation uses the share. That asymmetry is why the row
 * count and the aggregate cannot be reconciled by naive addition, and why
 * the workbook must not add anything up itself.
 *
 * ── OTHER RULES ──────────────────────────────────────────────────────────
 *
 *   * Test tenants are excluded via companies.is_test (schema_v60).
 *   * Aggregates are keyed on IDS. The old SUMMARY block keyed on
 *     `${guard_name} @ ${site_name}`, so two same-named guards at one site
 *     merged into one line — and STARNET has had colliding badges across
 *     tenants before.
 *   * Every date and time is rendered site-local from sites.timezone, and
 *     labels are preformatted here so no consumer re-derives them.
 *   * Dropped from the old sheet: Total Hours (legacy), Break (mins),
 *     Status. The first contradicts actual_hours by design, the second
 *     duplicates break_hours in different units, the third describes the
 *     shift rather than the hours.
 */

import { pool } from '../db/pool';
import { SHIFT_HOURS_SQL_FIELDS } from './shiftHours';

export type HoursFlag =
  | 'SHORT'            // coverage < 80%
  | 'OVER'             // coverage > 110%
  | 'NO_SCHEDULE'      // shift carries no scheduled window
  | 'AUTO_CLOSED'      // clock_out_reason = 'auto' — guard never clocked out
  | 'OFFPOST_ANOMALY'; // off-post exceeds actual: impossible, means bad data

export interface HoursExportRow {
  guard_id:         string;
  guard_name:       string;
  badge_number:     string | null;
  site_id:          string;
  site_name:        string;   // '[INACTIVE] ' prefixed when the site is retired
  site_timezone:    string;
  shift_id:         string;
  session_id:       string;
  shift_date:       string;   // YYYY-MM-DD, site-local
  shift_date_label: string;   // DD/MM/YYYY, site-local
  day_of_week:      string;   // Mon..Sun, site-local
  clock_in_iso:     string;
  clock_in_label:   string;   // DD/MM/YYYY, HH:MM:SS site-local
  clock_out_iso:    string;
  clock_out_label:  string;
  scheduled_hours:  number;   // the SHIFT's full window — see header
  actual_hours:     number;
  break_hours:      number;
  offpost_hours:    number;
  variance_hours:   number;        // actual − scheduled
  coverage_pct:     number | null; // null when there is no schedule to cover
  flags:            HoursFlag[];
}

export interface HoursAggregate {
  guard_id:        string | null;
  guard_name:      string | null;
  badge_number:    string | null;
  site_id:         string | null;
  site_name:       string | null;
  label:           string;   // display only — never a key
  sessions:        number;
  shifts:          number;
  scheduled_hours: number;   // sum of per-session SHARES — see header
  actual_hours:    number;
  break_hours:     number;
  offpost_hours:   number;
  variance_hours:  number;
  coverage_pct:    number | null;
  auto_closed_sessions: number;
  flags:           HoursFlag[];
}

export interface HoursExportDataset {
  company_id:    string;
  company_name:  string;
  /** Filename-safe tenant identity — see slugify(). */
  company_slug:  string;
  start_date:  string | null;
  end_date:    string | null;
  rows:        HoursExportRow[];
  by_guard:      HoursAggregate[];
  by_site:       HoursAggregate[];
  by_guard_site: HoursAggregate[];
  overall:       HoursAggregate;
}

export interface HoursExportParams {
  company_id:  string;
  start_date?: string;
  end_date?:   string;
  site_id?:    string;
  guard_id?:   string;
}

/**
 * Filename-safe tenant slug: lowercase, every non-alphanumeric run collapsed
 * to a single '-', trimmed. Exists because the monthly S3 archive writes
 * netraops-hours-{slug}-{YYYY-MM}.xlsx — before that every tenant's monthly
 * file was named 2026-07.xlsx and the tenant lived only in the S3 key path,
 * so four tenants' downloads collided on one local filename.
 */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round1 = (n: number): number => Math.round(n * 10) / 10;

function coverage(actual: number, scheduled: number): number | null {
  if (scheduled <= 0) return null;
  return round1((actual / scheduled) * 100);
}

function flagsFor(
  actual: number, scheduled: number, offpost: number, autoClosed: boolean,
): HoursFlag[] {
  const out: HoursFlag[] = [];
  const cov = coverage(actual, scheduled);
  if (scheduled <= 0)                out.push('NO_SCHEDULE');
  if (cov !== null && cov < 80)      out.push('SHORT');
  if (cov !== null && cov > 110)     out.push('OVER');
  if (autoClosed)                    out.push('AUTO_CLOSED');
  if (offpost > actual)              out.push('OFFPOST_ANOMALY');
  return out;
}

interface RawRow {
  guard_id: string; guard_name: string; badge_number: string | null;
  site_id: string; site_name: string; site_timezone: string;
  shift_id: string; session_id: string;
  shift_date: string; shift_date_label: string; day_of_week: string;
  clock_in_iso: Date; clock_in_label: string;
  clock_out_iso: Date; clock_out_label: string;
  clock_out_reason: string | null;
  scheduled_hours: string; actual_hours: string;
  break_hours: string; violation_hours: string;
}

export async function buildHoursExport(
  params: HoursExportParams,
): Promise<HoursExportDataset> {
  const { company_id, start_date, end_date, site_id, guard_id } = params;
  const args: unknown[] = [company_id];
  const clauses: string[] = [];

  // Bounds anchored per-row in the site's own timezone (8b08e62): a
  // start_date of '2026-07-01' means midnight AT THAT SITE.
  if (start_date) { args.push(start_date); clauses.push(`AND ss.clocked_in_at >= (($${args.length}::date)::timestamp AT TIME ZONE s.timezone)`); }
  if (end_date)   { args.push(end_date);   clauses.push(`AND ss.clocked_in_at <  (($${args.length}::date + INTERVAL '1 day') AT TIME ZONE s.timezone)`); }
  if (site_id)    { args.push(site_id);    clauses.push(`AND s.id = $${args.length}`); }
  if (guard_id)   { args.push(guard_id);   clauses.push(`AND g.id = $${args.length}`); }

  // Looked up independently of the rows: a real tenant with no sessions in
  // the month still needs a correctly-named file, and an empty row set
  // carries no company name to derive one from.
  const companyRow = await pool.query<{ name: string }>(
    'SELECT name FROM companies WHERE id = $1', [company_id],
  );
  const company_name = companyRow.rows[0]?.name ?? 'unknown';

  const result = await pool.query<RawRow>(`
    SELECT
      g.id                                             AS guard_id,
      g.name                                           AS guard_name,
      g.badge_number,
      s.id                                             AS site_id,
      -- Payroll must include hours at now-retired sites; the prefix is the
      -- only badge Excel can show.
      CASE WHEN s.is_active THEN s.name ELSE '[INACTIVE] ' || s.name END AS site_name,
      s.timezone                                       AS site_timezone,
      sh.id                                            AS shift_id,
      ss.id                                            AS session_id,
      TO_CHAR((ss.clocked_in_at AT TIME ZONE s.timezone)::date, 'YYYY-MM-DD') AS shift_date,
      TO_CHAR((ss.clocked_in_at AT TIME ZONE s.timezone)::date, 'DD/MM/YYYY') AS shift_date_label,
      TO_CHAR( ss.clocked_in_at AT TIME ZONE s.timezone,          'Dy')       AS day_of_week,
      ss.clocked_in_at                                 AS clock_in_iso,
      TO_CHAR(ss.clocked_in_at  AT TIME ZONE s.timezone, 'DD/MM/YYYY, HH24:MI:SS') AS clock_in_label,
      ss.clocked_out_at                                AS clock_out_iso,
      TO_CHAR(ss.clocked_out_at AT TIME ZONE s.timezone, 'DD/MM/YYYY, HH24:MI:SS') AS clock_out_label,
      ss.clock_out_reason,
      ${SHIFT_HOURS_SQL_FIELDS('ss', 'sh')}
    FROM shift_sessions ss
    JOIN shifts    sh ON sh.id = ss.shift_id
    JOIN sites     s  ON s.id  = ss.site_id
    JOIN guards    g  ON g.id  = ss.guard_id
    JOIN companies c  ON c.id  = s.company_id
    WHERE s.company_id = $1
      AND c.is_test = false            -- schema_v60
      AND ss.clocked_out_at IS NOT NULL -- also what makes this deterministic
      ${clauses.join(' ')}
    ORDER BY ss.clocked_in_at DESC
    LIMIT 10000
  `, args);

  const rows: HoursExportRow[] = result.rows.map((r) => {
    const scheduled = Number(r.scheduled_hours) || 0;
    const actual    = Number(r.actual_hours)    || 0;
    const brk       = Number(r.break_hours)     || 0;
    const offpost   = Number(r.violation_hours) || 0;
    return {
      guard_id: r.guard_id, guard_name: r.guard_name, badge_number: r.badge_number,
      site_id: r.site_id, site_name: r.site_name, site_timezone: r.site_timezone,
      shift_id: r.shift_id, session_id: r.session_id,
      shift_date: r.shift_date, shift_date_label: r.shift_date_label,
      day_of_week: r.day_of_week,
      clock_in_iso:  new Date(r.clock_in_iso).toISOString(),
      clock_in_label: r.clock_in_label,
      clock_out_iso: new Date(r.clock_out_iso).toISOString(),
      clock_out_label: r.clock_out_label,
      scheduled_hours: scheduled,
      actual_hours: actual, break_hours: brk, offpost_hours: offpost,
      variance_hours: round2(actual - scheduled),
      coverage_pct: coverage(actual, scheduled),
      flags: flagsFor(actual, scheduled, offpost, r.clock_out_reason === 'auto'),
    };
  });

  // ── the handoff split (see header) ──────────────────────────────────────
  const shiftScheduled = new Map<string, number>();
  const shiftActual    = new Map<string, number>();
  const shiftSessions  = new Map<string, number>();
  for (const r of rows) {
    shiftScheduled.set(r.shift_id, r.scheduled_hours);
    shiftActual.set(r.shift_id, (shiftActual.get(r.shift_id) ?? 0) + r.actual_hours);
    shiftSessions.set(r.shift_id, (shiftSessions.get(r.shift_id) ?? 0) + 1);
  }
  const scheduledShare = (r: HoursExportRow): number => {
    const total    = shiftScheduled.get(r.shift_id) ?? 0;
    const siblings = shiftSessions.get(r.shift_id) ?? 1;
    if (siblings === 1) return total;
    const actualAll = shiftActual.get(r.shift_id) ?? 0;
    return actualAll > 0 ? total * (r.actual_hours / actualAll) : total / siblings;
  };

  const agg = (
    keyOf: (r: HoursExportRow) => string,
    shape: (r: HoursExportRow) => Pick<HoursAggregate,
      'guard_id' | 'guard_name' | 'badge_number' | 'site_id' | 'site_name' | 'label'>,
  ): HoursAggregate[] => {
    const acc = new Map<string, HoursAggregate & { _shifts: Set<string> }>();
    for (const r of rows) {
      const k = keyOf(r);
      let a = acc.get(k);
      if (!a) {
        a = { ...shape(r), sessions: 0, shifts: 0, scheduled_hours: 0, actual_hours: 0,
              break_hours: 0, offpost_hours: 0, variance_hours: 0, coverage_pct: null,
              auto_closed_sessions: 0, flags: [], _shifts: new Set<string>() };
        acc.set(k, a);
      }
      a.sessions        += 1;
      a.scheduled_hours += scheduledShare(r);
      a.actual_hours    += r.actual_hours;
      a.break_hours     += r.break_hours;
      a.offpost_hours   += r.offpost_hours;
      if (r.flags.includes('AUTO_CLOSED')) a.auto_closed_sessions += 1;
      a._shifts.add(r.shift_id);
    }
    return [...acc.values()].map(({ _shifts, ...a }) => {
      a.shifts          = _shifts.size;
      a.scheduled_hours = round2(a.scheduled_hours);
      a.actual_hours    = round2(a.actual_hours);
      a.break_hours     = round2(a.break_hours);
      a.offpost_hours   = round2(a.offpost_hours);
      a.variance_hours  = round2(a.actual_hours - a.scheduled_hours);
      a.coverage_pct    = coverage(a.actual_hours, a.scheduled_hours);
      a.flags           = flagsFor(a.actual_hours, a.scheduled_hours, a.offpost_hours, false);
      return a;
    }).sort((x, y) => x.label.localeCompare(y.label));
  };

  const by_guard = agg(
    (r) => r.guard_id,
    (r) => ({ guard_id: r.guard_id, guard_name: r.guard_name, badge_number: r.badge_number,
              site_id: null, site_name: null, label: r.guard_name }),
  );
  const by_site = agg(
    (r) => r.site_id,
    (r) => ({ guard_id: null, guard_name: null, badge_number: null,
              site_id: r.site_id, site_name: r.site_name, label: r.site_name }),
  );
  const by_guard_site = agg(
    (r) => `${r.guard_id}|${r.site_id}`,
    (r) => ({ guard_id: r.guard_id, guard_name: r.guard_name, badge_number: r.badge_number,
              site_id: r.site_id, site_name: r.site_name,
              label: `${r.guard_name} @ ${r.site_name}` }),
  );
  const overall = agg(
    () => 'ALL',
    () => ({ guard_id: null, guard_name: null, badge_number: null,
             site_id: null, site_name: null, label: 'ALL' }),
  )[0] ?? {
    guard_id: null, guard_name: null, badge_number: null, site_id: null, site_name: null,
    label: 'ALL', sessions: 0, shifts: 0, scheduled_hours: 0, actual_hours: 0,
    break_hours: 0, offpost_hours: 0, variance_hours: 0, coverage_pct: null,
    auto_closed_sessions: 0, flags: [],
  };

  return {
    company_id,
    company_name,
    company_slug: slugify(company_name),
    start_date: start_date ?? null,
    end_date:   end_date   ?? null,
    rows, by_guard, by_site, by_guard_site, overall,
  };
}
