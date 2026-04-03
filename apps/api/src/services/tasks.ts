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
    `SELECT id, title, scheduled_time, recurrence
     FROM task_templates
     WHERE site_id = $1 AND is_active = true`,
    [siteId]
  );

  for (const tpl of templates.rows) {
    const matches =
      tpl.recurrence === 'daily' ||
      (tpl.recurrence === 'weekdays' && isWeekday) ||
      (tpl.recurrence === 'weekends' && isWeekend) ||
      (tpl.recurrence === 'custom' && tpl.recurrence_days?.includes(DAY_NAMES[dayOfWeek]));

    if (!matches) continue;

    // due_at = clock-in date + template.scheduled_time
    const [hours, minutes] = (tpl.scheduled_time as string).split(':').map(Number);
    const dueAt = new Date(clockInAt);
    dueAt.setHours(hours, minutes, 0, 0);

    await pool.query(
      `INSERT INTO task_instances (template_id, shift_id, site_id, title, due_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING`,
      [tpl.id, shiftId, siteId, tpl.title, dueAt]
    );
  }
}
