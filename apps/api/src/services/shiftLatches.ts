/**
 * Schedule-derived reminder latches on the `shifts` row — the single
 * definition of which one-shot stamps must be cleared when a shift's
 * schedule or assignment changes.
 *
 * ─── WHAT A LATCH IS ──────────────────────────────────────────────────
 *
 * Five crons each send exactly one notification per shift and record that
 * they did so in a column on `shifts`. Each computes its eligibility window
 * from `scheduled_start` and guards re-firing with `<column> IS NULL`:
 *
 *                               SELECTed                    STAMPed
 *   missed_alert_sent_at        missedShiftAlert.ts:26-29   email.ts:851-854
 *   pre_shift_reminder_sent_at  preShiftReminder.ts:51-60   preShiftReminder.ts:128
 *   start_reminder_sent_at      shiftStartReminder.ts:45-56 shiftStartReminder.ts:123
 *   late_10_reminder_sent_at    lateClockInReminder.ts:147-163  :178
 *   late_15_reminder_sent_at    lateClockInReminder.ts:147-163  :190
 *   late_admin_email_sent_at    lateClockInReminder.ts:147-163  :208
 *   unstaffed_warning_sent_at   unstaffedPostWarning.ts (claim and stamp are
 *                               the SAME statement - see below)
 *
 * LINE NUMBERS DRIFT AND THESE ONES DID. Every citation above was re-derived
 * at schema_v76; the previous set pointed at a KPI template, two comment
 * bodies, a blank line and a `for` header, having rotted silently while the
 * claims around them stayed true. If you are following one of these and land
 * somewhere that makes no sense, trust the column name and grep for it -
 * `grep -rn '<column>' apps/api/src` finds every reader and writer in one go.
 *
 * FOUR of the five select `status = 'scheduled'`. unstaffedPostWarning is the
 * exception: it selects `status = 'unassigned'`, because it is the one that
 * fires when there is NO guard. It is still a schedule-derived latch and
 * still belongs here - assigning a guard to that shift is exactly a change
 * that should re-arm it.
 *
 * ─── ONE OF THEM CLAIMS RATHER THAN STAMPS ────────────────────────────
 *
 * unstaffed_warning_sent_at is written BEFORE its email is sent, in the same
 * statement that selects the row (`UPDATE ... WHERE ... IS NULL RETURNING
 * id`), and is set back to NULL if every recipient failed. The other five
 * stamp after the fact. Both shapes rely on this helper clearing them, so
 * the distinction does not change anything here - but do not "make it
 * consistent" by moving that stamp after its send: the claim is what stops
 * two overlapping cron ticks both emailing the same admins.
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
 *   schema_v76  adds unstaffed_warning_sent_at. Added to the array below in
 *               the same commit, which is the whole point of the array.
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
  'unstaffed_warning_sent_at',
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
