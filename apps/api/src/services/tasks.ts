import { pool } from '../db/pool';
import { dowInTimeZone } from './siteTime';

const DAY_NAMES = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];

/**
 * Generate TASK_INSTANCES for a shift when guard clocks in (Section 11.6).
 * Copies template title into instance — editing template later does NOT alter past records.
 */
export async function generateTaskInstancesForShift(
  shiftId: string,
  siteId: string,
  clockInAt: Date
): Promise<void> {
  const templates = await pool.query(
    // v40: JOIN sites for timezone. scheduled_time is stored as site-local
    // wall-clock (naive TIME) post-migration; due_at is computed in Postgres
    // using sites.timezone so day-boundary + DST are correct. Prior version
    // stored scheduled_time as UTC HH:MM and computed due_at with
    // setUTCHours(), which kept the UTC date and produced due_at values up
    // to 24 hours in the past.
    `SELECT tt.id, tt.title, tt.scheduled_time, tt.recurrence, tt.recurrence_days, s.timezone
       FROM task_templates tt
       JOIN sites s ON s.id = tt.site_id
      WHERE tt.site_id = $1 AND tt.is_active = true`,
    [siteId]
  );
  if (templates.rows.length === 0) return;

  // The day-of-week gate below must be the day at the SITE, not at the
  // server. clockInAt is a UTC instant and the API runs UTC on Railway, so
  // the previous `clockInAt.getDay()` returned the UTC day: Bethel AME
  // Church (17:00-23:00 PT) and 23000 Cristo Rey Los Altos (19:00-06:00 PT)
  // both cross UTC midnight mid-shift, so a Saturday-evening clock-in
  // resolved to Sunday and 'weekdays'/'weekends'/'custom' templates fired on
  // the wrong day. Same class of bug v40 fixed for due_at, and resolved the
  // same way v40 established: through sites.timezone.
  //
  // v40's Postgres timezone math is the right tool for computing a
  // TIMESTAMP (due_at, below — unchanged). This gate is a JS-side filter
  // over template rows, so it uses the JS helper routes/shifts.ts already
  // uses to resolve a day-of-week for repeat_days, now shared rather than
  // duplicated.
  //
  // Every row comes from one site (WHERE tt.site_id = $1 JOIN sites), so
  // rows[0].timezone is that site's zone.
  const siteTz    = templates.rows[0].timezone as string;
  const dayOfWeek = dowInTimeZone(clockInAt, siteTz); // 0 = Sunday, site-local
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

  for (const tpl of templates.rows) {
    const matches =
      tpl.recurrence === 'daily' ||
      (tpl.recurrence === 'weekdays' && isWeekday) ||
      (tpl.recurrence === 'weekends' && isWeekend) ||
      (tpl.recurrence === 'custom' && tpl.recurrence_days?.includes(DAY_NAMES[dayOfWeek]));

    if (!matches) continue;

    // Window rule (2026-08-20): only instantiate when the computed due_at
    // falls within the shift being clocked into. Previously every matching
    // template produced an instance regardless of shift window, so a
    // 10:45-12:30 shift got a task due 9:00 PM — shown as pending all
    // shift, un-completable after clock-out (409 SESSION_CLOSED), and
    // nagged by the hourly reminder. The due_at expression is unchanged
    // (site-tz computation in Postgres); the shifts JOIN just gates the
    // INSERT on scheduled_start <= due_at <= scheduled_end.
    await pool.query(
      `INSERT INTO task_instances (template_id, shift_id, site_id, title, due_at)
       SELECT $1, $2, $3, $4, due.due_at
       FROM (
         SELECT (( ($5::TIMESTAMPTZ AT TIME ZONE $6)::DATE + $7::TIME )::TIMESTAMP AT TIME ZONE $6) AS due_at
       ) due
       JOIN shifts sh ON sh.id = $2
       WHERE due.due_at >= sh.scheduled_start
         AND due.due_at <= sh.scheduled_end
       ON CONFLICT DO NOTHING`,
      [tpl.id, shiftId, siteId, tpl.title, clockInAt, tpl.timezone, tpl.scheduled_time]
    );
  }
}
