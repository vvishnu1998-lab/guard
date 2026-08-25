/**
 * Schedule-derived reminder latches on the `shifts` row — the single
 * definition of which one-shot stamps must be cleared when a shift's
 * schedule or assignment changes.
 *
 * ─── WHAT A LATCH IS ──────────────────────────────────────────────────
 *
 * Four crons each send exactly one notification per shift and record that
 * they did so in a column on `shifts`. Every one of them selects on
 * `status = 'scheduled'`, computes its eligibility window from
 * `scheduled_start`, and guards re-firing with `<column> IS NULL`:
 *
 *   missed_alert_sent_at        jobs/missedShiftAlert.ts:27-29
 *                               (written services/email.ts:742)
 *   pre_shift_reminder_sent_at  jobs/preShiftReminder.ts:49-51,  :112
 *   start_reminder_sent_at      jobs/shiftStartReminder.ts:49-52, :112
 *   late_10_reminder_sent_at    jobs/lateClockInReminder.ts:135-139, :154
 *   late_15_reminder_sent_at    jobs/lateClockInReminder.ts:135-139, :166
 *   late_admin_email_sent_at    jobs/lateClockInReminder.ts:135-139, :184
 *
 * Because the stamp is the ONLY thing stopping a re-send, a latch left set
 * across a schedule change is permanent silence: the row no longer matches
 * the cron's time window at the moment it is checked, and by the time the
 * new window comes round the `IS NULL` guard already fails. The guard is
 * simply never reminded, with no error and no log line.
 *
 * ─── WHY THIS IS A SHARED HELPER AND NOT SIX INLINE ASSIGNMENTS ───────
 *
 * This exact clearing has gone stale twice, silently, and both times the
 * code that went stale was correct when it was written:
 *
 *   schema_v4   missed_alert_sent_at exists.
 *   schema_v15  PATCH /:id/reassign ships, clearing missed_alert_sent_at
 *               inline. At that moment it clears 1 of 1 latches — COMPLETE.
 *   schema_v17  adds pre_shift_reminder_sent_at + start_reminder_sent_at.
 *               reassign is not revisited. Now 1 of 3.
 *   schema_v37  adds the three late_* columns. reassign is not revisited.
 *               Now 1 of 6, and had been wrong for two migrations.
 *
 * The failure mode is not carelessness — it is that the set of latches had
 * no home, so "add a latch" and "audit who must clear it" were separate
 * acts that nothing tied together.
 *
 * >>> THEREFORE: any future schedule-derived latch MUST be added to the
 * >>> LATCH_COLUMNS array below, NOT cleared at a call site. A migration
 * >>> that adds a one-shot stamp keyed on scheduled_start is not finished
 * >>> until that column appears here. There is deliberately no way to
 * >>> clear a subset — every caller clears all of them, so a new latch is
 * >>> picked up by every existing caller for free.
 *
 * ─── DELIBERATE EXCLUSIONS ────────────────────────────────────────────
 *
 * `daily_report_email_sent` / `daily_report_email_sent_at` are one-shot
 * stamps on the same row, but they are NOT schedule-derived latches for
 * this purpose: jobs/dailyShiftEmail.ts:26 selects `status = 'completed'`,
 * which no caller of this helper can be looking at (a shift reaches
 * 'completed' only via clock-out or the auto-complete sweep, both of which
 * require a session). Clearing them would re-send a report for a shift
 * that already had one. Excluded on purpose — do not "fix" this.
 *
 * ─── KNOWN SIDE EFFECT ────────────────────────────────────────────────
 *
 * routes/admin.ts:1028-1029 surfaces a no-show alert in the admin feed for
 * shifts with `missed_alert_sent_at IS NOT NULL` within the last 24 hours.
 * Clearing that stamp therefore also removes the alert from that feed.
 * This is intended: the alert describes a no-show against a schedule that
 * no longer applies. Named here so the next person to notice it does not
 * read it as a bug.
 */

import type { PoolClient } from 'pg';
import { pool } from '../db/pool';

/** Matches the idiom in services/guardAssignments.ts:17 — lets a caller
 *  pass its open transaction client so the clear shares the caller's txn
 *  and row lock. Defaults to the pool for non-transactional callers. */
type Querier = Pick<PoolClient, 'query'>;

/**
 * Every schedule-derived one-shot latch on `shifts`. Adding a column here
 * is the whole job — see the docblock above.
 */
const LATCH_COLUMNS = [
  'missed_alert_sent_at',
  'pre_shift_reminder_sent_at',
  'start_reminder_sent_at',
  'late_10_reminder_sent_at',
  'late_15_reminder_sent_at',
  'late_admin_email_sent_at',
] as const;

/**
 * SET-fragment form: `col = NULL, col = NULL, …`, no leading or trailing
 * comma. Deliberately NOT exported — callers use the function below, so
 * there is exactly one way to clear latches and no second idiom to drift.
 *
 * Column names are compile-time constants from LATCH_COLUMNS, never user
 * input — there is nothing here to interpolate unsafely.
 */
function latchClearSqlSet(): string {
  return LATCH_COLUMNS.map((c) => `${c} = NULL`).join(', ');
}

/**
 * Clear every schedule-derived latch on one shift, re-arming the whole
 * reminder chain against the shift's current schedule and assignment.
 *
 * Call this whenever a mutation invalidates the premise a reminder was
 * sent under — the guard changed (reassign) or the hours changed (edit).
 *
 * Pass the caller's transaction client so this shares its txn and the
 * `FOR UPDATE` lock it already holds on the row; otherwise the clear can
 * commit independently of the mutation that motivated it.
 *
 * Idempotent, and a no-op on a shift whose latches are already NULL.
 */
export async function clearScheduleDerivedLatches(
  shiftId: string,
  db: Querier = pool,
): Promise<void> {
  await db.query(
    `UPDATE shifts SET ${latchClearSqlSet()} WHERE id = $1`,
    [shiftId],
  );
}
