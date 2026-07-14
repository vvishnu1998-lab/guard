import { pool } from '../db/pool';

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
  const dayOfWeek = clockInAt.getDay(); // 0 = Sunday
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

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

  for (const tpl of templates.rows) {
    const matches =
      tpl.recurrence === 'daily' ||
      (tpl.recurrence === 'weekdays' && isWeekday) ||
      (tpl.recurrence === 'weekends' && isWeekend) ||
      (tpl.recurrence === 'custom' && tpl.recurrence_days?.includes(DAY_NAMES[dayOfWeek]));

    if (!matches) continue;

    await pool.query(
      `INSERT INTO task_instances (template_id, shift_id, site_id, title, due_at)
       VALUES (
         $1, $2, $3, $4,
         (( ($5::TIMESTAMPTZ AT TIME ZONE $6)::DATE + $7::TIME )::TIMESTAMP AT TIME ZONE $6)
       )
       ON CONFLICT DO NOTHING`,
      [tpl.id, shiftId, siteId, tpl.title, clockInAt, tpl.timezone, tpl.scheduled_time]
    );
  }
}
