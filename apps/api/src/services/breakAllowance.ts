/**
 * Break allowance + eligibility — the single definition of whether a guard
 * may start a break right now, and when they next can.
 *
 * TWO CALLERS, ONE ANSWER. routes/shifts.ts calls this at POST /break-start
 * to decide accept-or-422, and again at GET /active-session to tell the app
 * what to render. Two implementations would be two answers the moment either
 * drifted, and the guard would see "Available at 7:30 PM" on a screen whose
 * button 422s at 7:30 PM. Same reasoning as services/pingWindows.ts holding
 * the one copy of breakOverlapsWindow.
 *
 * ── EVERYTHING HERE IS SHIFT-SCOPED, NOT SESSION-SCOPED ─────────────────
 *
 * Design locked 2026-08-29. Allowance and both timers belong to the SHIFT,
 * so after a handoff guard B inherits guard A's consumed allowance and A's
 * clock-in. Every query below joins through shift_sessions to shifts.shift_id
 * and never filters on a single session id.
 *
 * This is a deliberate change from the schema_v46 behaviour, where quota was
 * keyed on shift_session_id and therefore reset in full at every handoff.
 * A shift with one handoff granted double the intended breaks.
 *
 * ── THE MIS-TAP RULE IS APPLIED CONSISTENTLY ────────────────────────────
 *
 * A break closed within BREAK_MISTAP_SECONDS of starting never counts —
 * not toward `used`, and not as the "previous break" for the gap gate.
 * 15 of 26 prod rows at time of writing are sub-60s mis-taps produced by a
 * known mobile double-tap; charging a guard for those, or making them wait
 * two hours after one, would both be wrong.
 */

import type { Pool, PoolClient } from 'pg';
import {
  BREAK_MISTAP_SECONDS,
  BREAK_FIRST_AFTER_MINUTES,
  BREAK_MIN_GAP_MINUTES,
  BREAK_DURATION_MINUTES,
  breakAllowanceForShift,
} from '../constants/breakDurations';

/** Why a break cannot start right now. Null when it can. These strings are
 *  the SAME values the 422 bodies use as `error`, so the mobile client can
 *  branch on one vocabulary whether it learns the state from active-session
 *  or from a rejected break-start. */
export type BreakBlockReason =
  | 'BREAK_QUOTA_EXCEEDED'
  | 'BREAK_TOO_EARLY'
  | 'BREAK_TOO_SOON'
  /** S6.2 — eligibility lands so late that a break started then could not
   *  finish before scheduled_end. The four-hour rule is UNCHANGED and still
   *  anchors on actual clock-in; this only stops the screen quoting a time
   *  the guard can never use. Walk-test 2026-09-01: reddy clocked in 6:53 PM
   *  on a 3:30 PM – 11:00 PM shift, so eligibility fell at 10:53 PM and the
   *  screen read "AVAILABLE AT 10:53 PM" — seven minutes before the shift
   *  ended. Terminal, like BREAK_QUOTA_EXCEEDED: eligible_at is null. */
  | 'BREAK_SHIFT_ENDS_FIRST';

export interface BreakAllowance {
  /** Breaks already consumed on this SHIFT, mis-taps excluded. */
  used: number;
  /** Breaks this shift earns: 1 at <= 8 scheduled hours, 2 above. */
  limit: number;
  /** True when a break may start right now. */
  can_start: boolean;
  /** ISO timestamp at which a break next becomes startable, or null when it
   *  is startable now OR will never be on this shift. Pair it with `reason` —
   *  null + can_start:false is terminal (BREAK_QUOTA_EXCEEDED, or
   *  BREAK_SHIFT_ENDS_FIRST), never "any moment". */
  eligible_at: string | null;
  /** Null when can_start is true. */
  reason: BreakBlockReason | null;
}

export interface BreakAllowanceInput {
  shiftId: string;
  scheduledStart: Date | string;
  scheduledEnd: Date | string;
  /** Injected so break-start and active-session evaluate the same instant,
   *  and so tests are deterministic. */
  now?: Date;
}

/** Scheduled length in hours. Returns NaN on unparseable input, which
 *  breakAllowanceForShift deliberately floors to the smaller allowance. */
function scheduledHours(start: Date | string, end: Date | string): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  return (e - s) / 3_600_000;
}

export async function getBreakAllowance(
  db: Pool | PoolClient,
  input: BreakAllowanceInput,
): Promise<BreakAllowance> {
  const now = input.now ?? new Date();
  const limit = breakAllowanceForShift(
    scheduledHours(input.scheduledStart, input.scheduledEnd),
  );

  // One round trip for all three shift-scoped facts.
  //
  //   first_clock_in  — MIN over EVERY session on the shift, so a handoff
  //                     inherits the original clock-in instead of restarting
  //                     the four-hour clock. Actual, never scheduled_start.
  //   used            — breaks across EVERY session on the shift. An OPEN
  //                     break counts (break_end IS NULL): it is in progress,
  //                     not free.
  //   last_break_end  — the most recent CLOSED, non-mis-tap break_end on the
  //                     shift, which the gap gate measures from. Open breaks
  //                     are excluded because they have no end to measure
  //                     from; they cannot strand the gate, because both the
  //                     clock-out and handoff paths close an open break, and
  //                     breakExpiryCron auto-closes any break at its plan.
  const { rows } = await db.query<{
    first_clock_in: Date | null;
    used: string;
    last_break_end: Date | null;
  }>(
    `SELECT
       (SELECT MIN(ss.clocked_in_at)
          FROM shift_sessions ss
         WHERE ss.shift_id = $1) AS first_clock_in,
       (SELECT COUNT(*)
          FROM break_sessions bs
          JOIN shift_sessions ss ON ss.id = bs.shift_session_id
         WHERE ss.shift_id = $1
           AND (bs.break_end IS NULL
                OR bs.break_end >= bs.break_start + make_interval(secs => $2))) AS used,
       (SELECT MAX(bs.break_end)
          FROM break_sessions bs
          JOIN shift_sessions ss ON ss.id = bs.shift_session_id
         WHERE ss.shift_id = $1
           AND bs.break_end IS NOT NULL
           AND bs.break_end >= bs.break_start + make_interval(secs => $2)) AS last_break_end`,
    [input.shiftId, BREAK_MISTAP_SECONDS],
  );

  const row = rows[0];
  const used = Number(row?.used ?? 0);
  const firstClockIn = row?.first_clock_in ?? null;
  const lastBreakEnd = row?.last_break_end ?? null;

  const allow = (): BreakAllowance => ({
    used, limit, can_start: true, eligible_at: null, reason: null,
  });
  const block = (reason: BreakBlockReason, at: Date | null): BreakAllowance => ({
    used, limit, can_start: false,
    eligible_at: at ? at.toISOString() : null,
    reason,
  });

  // The last instant a break could START and still finish inside the shift.
  //
  // This does NOT gate anything: a break may still run past scheduled_end and
  // that rule is unchanged. It only decides whether a computed eligibility is
  // worth quoting. An eligible_at after this point is a real answer to the
  // wrong question — the guard cannot act on it before the shift ends, so
  // reporting it as "AVAILABLE AT 10:53 PM" reads as an offer rather than as
  // the refusal it actually is.
  //
  // Deliberately compares the ELIGIBILITY, not `now`. A guard who is already
  // eligible with ten minutes left still gets can_start:true and may start —
  // see the note above about breaks running past scheduled_end.
  const lastUsefulStart = new Date(
    new Date(input.scheduledEnd).getTime() - BREAK_DURATION_MINUTES * 60_000,
  );
  const blockAt = (reason: BreakBlockReason, at: Date): BreakAllowance =>
    (at > lastUsefulStart ? block('BREAK_SHIFT_ENDS_FIRST', null) : block(reason, at));

  // Order is deliberate and is the order the guard should hear it in.
  //
  // 1. Exhausted first. It is the only terminal state, and telling a guard
  //    who has used every break to "come back at 9pm" would be a lie.
  if (used >= limit) return block('BREAK_QUOTA_EXCEEDED', null);

  // 2. Four hours from the shift's FIRST actual clock-in.
  //    A null first_clock_in cannot happen on a live session (the caller
  //    resolved one to get here), but if it ever did, failing OPEN is the
  //    wrong direction on a wage-and-hour gate — so treat it as not yet
  //    eligible rather than silently granting.
  if (!firstClockIn) return block('BREAK_TOO_EARLY', null);
  const firstEligibleAt = new Date(
    firstClockIn.getTime() + BREAK_FIRST_AFTER_MINUTES * 60_000,
  );
  if (now < firstEligibleAt) return blockAt('BREAK_TOO_EARLY', firstEligibleAt);

  // 3. Two hours from the previous break's end. Only reachable for a second
  //    or later break, since `used` is 0 when there is no previous break.
  if (lastBreakEnd) {
    const gapEligibleAt = new Date(
      lastBreakEnd.getTime() + BREAK_MIN_GAP_MINUTES * 60_000,
    );
    if (now < gapEligibleAt) return blockAt('BREAK_TOO_SOON', gapEligibleAt);
  }

  return allow();
}

/** Guard-facing copy for a blocked state. Kept beside the decision so the
 *  message can never describe a different rule than the one that fired. */
export function breakBlockMessage(a: BreakAllowance): string {
  switch (a.reason) {
    case 'BREAK_QUOTA_EXCEEDED':
      return a.limit === 1
        ? 'You have used your break for this shift.'
        : `You have used all ${a.limit} breaks for this shift.`;
    case 'BREAK_TOO_EARLY':
      return 'Your first break becomes available four hours after you clock in.';
    case 'BREAK_TOO_SOON':
      return 'There must be two hours between breaks.';
    case 'BREAK_SHIFT_ENDS_FIRST':
      return `This shift ends before a ${BREAK_DURATION_MINUTES}-minute break could finish, `
           + 'so there is no break on it.';
    default:
      return '';
  }
}
