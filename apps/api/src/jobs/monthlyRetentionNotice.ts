/**
 * Monthly Retention Notice — runs at 08:00 UTC on last day of each month.
 *
 * Three distinct milestone notices (Section 4, Email Type 3):
 *
 *  milestone    trigger                           flag cleared
 *  ──────────── ─────────────────────────────── ────────────────────────
 *  day60        access_until within 30 days       warning_60_sent
 *  day89        access_until within 1 day         warning_89_sent
 *  monthly      still in retention window         no flag — fires monthly
 *
 * The day60 and day89 milestones can fire any day (checked daily inside
 * the monthly job run).  The "monthly" generic notice fires only on the
 * last calendar day of the month as a reminder.
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { sendRetentionNotice } from '../services/email';

// Run on days 28-31 so we catch every month end, but guard with lastDayCheck.
cron.schedule('0 8 28-31 * *', async () => {
  const now = new Date();

  // ── Milestone: day-60 notice (access expires within 30 days) ─────────────
  const day60Sites = await pool.query(
    `SELECT site_id, client_star_access_until
     FROM data_retention_log
     WHERE data_deleted = false
       AND warning_60_sent = false
       AND client_star_access_until < NOW() + INTERVAL '30 days'`,
  );

  for (const row of day60Sites.rows) {
    const daysRemaining = Math.ceil(
      (new Date(row.client_star_access_until).getTime() - Date.now()) / 86_400_000,
    );
    if (daysRemaining <= 0) continue;
    try {
      await sendRetentionNotice(row.site_id, daysRemaining, 'day60');
      await pool.query(
        'UPDATE data_retention_log SET warning_60_sent = true WHERE site_id = $1',
        [row.site_id],
      );
      console.log(`[monthly-retention] day60 notice sent for site ${row.site_id}`);
    } catch (err) {
      console.error('[monthly-retention] day60 failed for', row.site_id, err);
    }
  }

  // ── Milestone: day-89 final warning (access expires within 1 day) ─────────
  const day89Sites = await pool.query(
    `SELECT site_id, client_star_access_until
     FROM data_retention_log
     WHERE data_deleted = false
       AND warning_89_sent = false
       AND client_star_access_until < NOW() + INTERVAL '1 day'`,
  );

  for (const row of day89Sites.rows) {
    const daysRemaining = Math.ceil(
      (new Date(row.client_star_access_until).getTime() - Date.now()) / 86_400_000,
    );
    try {
      await sendRetentionNotice(row.site_id, Math.max(daysRemaining, 1), 'day89');
      await pool.query(
        'UPDATE data_retention_log SET warning_89_sent = true WHERE site_id = $1',
        [row.site_id],
      );
      console.log(`[monthly-retention] day89 notice sent for site ${row.site_id}`);
    } catch (err) {
      console.error('[monthly-retention] day89 failed for', row.site_id, err);
    }
  }

  // ── Monthly general reminder — only fires on the actual last day of month ──
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() !== 1) return; // not last day of this month

  console.log('[monthly-retention] Last day of month — sending general reminders');

  const inWindow = await pool.query(
    `SELECT site_id, client_star_access_until
     FROM data_retention_log
     WHERE data_deleted = false
       AND client_star_access_disabled = false
       AND client_star_access_until < NOW() + INTERVAL '30 days'`,
  );

  for (const row of inWindow.rows) {
    const daysRemaining = Math.ceil(
      (new Date(row.client_star_access_until).getTime() - Date.now()) / 86_400_000,
    );
    if (daysRemaining <= 0) continue;
    try {
      await sendRetentionNotice(row.site_id, daysRemaining, 'monthly');
      console.log(`[monthly-retention] monthly notice sent for site ${row.site_id} (${daysRemaining}d)`);
    } catch (err) {
      console.error('[monthly-retention] monthly failed for', row.site_id, err);
    }
  }

  console.log('[monthly-retention] Done');
});
