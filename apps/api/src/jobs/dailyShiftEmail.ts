/**
 * Daily Shift Report Email — 9:00 AM Pacific every day (Email Type 2, Section 4).
 *
 * Cron is wall-clock-anchored to America/Los_Angeles so DST flips are handled
 * by the runtime — 9 AM PDT in summer, 9 AM PST in winter, no edits needed.
 * When/if other regions come online we'll move to per-site scheduling instead
 * of one global wall clock.
 *
 * Picks up all completed shifts that ended in the last 36 hours and haven't
 * had a daily report email sent yet. The 36-hour window (not just 24 hours)
 * gives a safety margin for shifts that ran past midnight.
 */

import { runJob } from './_run';
import { pool } from '../db/pool';
import { sendDailyShiftReport, DailyReportDeliveryError } from '../services/email';
import { Sentry } from '../services/sentry';

runJob(
  'dailyShiftEmail',
  '0 9 * * *',
  async () => {
    console.log('[daily-email] Starting at', new Date().toISOString());

    const result = await pool.query(
      `SELECT id FROM shifts
       WHERE status = 'completed'
         AND daily_report_email_sent = false
         AND scheduled_end >= NOW() - INTERVAL '36 hours'
         AND scheduled_end  < NOW() - INTERVAL '1 hour'`,
    );

    // Shifts, then emails. "sent" used to count every shift the loop touched,
    // skips included (N161); now each outcome is counted for what it is.
    let sent = 0;
    let partial = 0;
    let failed = 0;
    let skippedTotal = 0;
    const skipped: Record<string, number> = {};
    let emailsDelivered = 0;
    let emailsFailed = 0;
    for (const shift of result.rows) {
      try {
        const outcome = await sendDailyShiftReport(shift.id);
        if (outcome.status === 'sent') {
          sent++;
          emailsDelivered += outcome.delivered;
          emailsFailed += outcome.failed;
          if (outcome.failed > 0) partial++;
        } else {
          skippedTotal++;
          skipped[outcome.reason] = (skipped[outcome.reason] ?? 0) + 1;
        }
      } catch (err) {
        console.error('[daily-email] Failed for shift', shift.id, err);
        const delivery = err instanceof DailyReportDeliveryError ? err : null;
        if (delivery) emailsFailed += delivery.attempted;
        // One event per failed shift, carrying the ORIGINAL error (render or
        // SendGrid), so it keeps its stack and SendGrid status. service:sendgrid
        // only when SendGrid is what failed; render and query errors used to
        // carry it too, which sent triage to the wrong place.
        Sentry.captureException(delivery?.original ?? err, {
          tags: {
            flow: 'daily_shift_report',
            stage: delivery?.stage ?? 'other',
            ...(delivery?.stage === 'send' ? { service: 'sendgrid' } : {}),
          },
          extra: { shift_id: shift.id, ...(delivery ? { recipients_attempted: delivery.attempted } : {}) },
        });
        failed++;
      }
    }

    const reasons = Object.entries(skipped).map(([reason, n]) => `${reason} ${n}`).join(', ');
    console.log(
      `[daily-email] Done — sent: ${sent} (partial: ${partial}), ` +
      `skipped: ${skippedTotal}${reasons ? ` (${reasons})` : ''}, failed: ${failed}; ` +
      `emails delivered: ${emailsDelivered}, failed: ${emailsFailed}`,
    );
  },
  { timezone: 'America/Los_Angeles', sentryMonitor: false },
);
