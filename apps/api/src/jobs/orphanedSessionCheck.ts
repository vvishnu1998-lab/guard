/**
 * Orphaned-session detector — hourly, DETECT ONLY.
 *
 * ── THE INVARIANT ────────────────────────────────────────────────────────
 *
 * jobs/autoCompleteShifts.ts is the only thing that closes a session the
 * guard never clocked out of, and it sweeps
 * `shifts.status IN ('active','scheduled')`. A shift_sessions row with
 * clocked_out_at IS NULL whose shift has left that set can therefore never
 * be closed by anything except a manual write.
 *
 * That is not a cosmetic leak. idx_shift_sessions_one_open_per_guard is
 * UNIQUE on guard_id WHERE clocked_out_at IS NULL, so one orphaned row locks
 * that guard out of clocking in AT ANY SITE, permanently. The guard shows up
 * for their next shift and the app refuses. Hourly is chosen for that
 * reason: the symptom is a guard who cannot start work.
 *
 * ── WHY IT IS KEYED ON THE INVARIANT, NOT ON CANCEL ──────────────────────
 *
 * The known way to produce one was PATCH /:id/cancel, and the open-session
 * gate added alongside this closes it. Keying the detector on
 * `status = 'cancelled'` would make it dead the moment that fix landed, and
 * blind to the next route that moves a shift out of the sweep set. The
 * predicate below is the invariant itself — `NOT IN ('active','scheduled')`
 * — so it keeps working against statuses and routes that do not exist yet.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────
 *
 * It mutates nothing. It does not close sessions, does not compute
 * total_hours, and writes no clock_out_reason — closing a session decides a
 * guard's paid hours and that decision belongs to a human, not to a
 * detector. A found row is a page, not a repair.
 *
 * NOT covered, on purpose: an open session whose shift is still
 * 'active'/'scheduled' but long past scheduled_end. Same user-visible
 * symptom, different cause — that means autoCompleteShifts itself is wedged,
 * which its own every-tick heartbeat (`[auto_complete_shifts.tick]`) already
 * makes detectable. Folding it in here would blur two causes into one alert.
 *
 * ── ALERTING MECHANISM ───────────────────────────────────────────────────
 *
 * Sentry captureMessage at warning level, matching nightlyPurge.ts
 * haltStep(): stable message string + explicit fingerprint, low-cardinality
 * tags, counts in `extra`. Stable-message-plus-fingerprint is load-bearing,
 * not style — see the note at nightlyPurge.ts:408. Interpolating the row
 * count into the message would mint a fresh Sentry issue on every run and
 * recreate, louder, the noise problem the alert exists to avoid.
 *
 * SendGrid was considered and rejected: no job emails an OPERATIONAL
 * anomaly. Email in this codebase is customer-facing only (daily report,
 * missed shift, breach, incident), and nightlyPurge.ts:13 records the
 * explicit decision "Sentry-only alert, no SendGrid" for exactly this class.
 *
 * The console.info heartbeat fires on EVERY run including the healthy
 * zero-row one, copying the rationale at autoCompleteShifts.ts:146: without
 * it, a silently wedged cron is indistinguishable from a clean bill of
 * health. Sentry stays silent unless the count is non-zero, so a healthy
 * system produces no events at all.
 */
import { runJob } from './_run';
import { pool } from '../db/pool';
import { Sentry } from '../services/sentry';

interface OrphanRow {
  session_id:    string;
  guard_id:      string;
  shift_id:      string;
  shift_status:  string;
  clocked_in_at: Date;
}

/** Stable message + matching fingerprint — never interpolate the count. */
const ORPHAN_MSG = 'orphaned_open_shift_session';

/** Cap the rows carried into Sentry `extra`; the count is always exact. */
const SAMPLE_CAP = 20;

/**
 * One scan. Exported so a local harness can run it against a throwaway DB;
 * the cron registration below is the only production caller.
 */
export async function runOrphanedSessionCheck(): Promise<number> {
  const started = Date.now();
  try {
    const { rows } = await pool.query<OrphanRow>(
      `SELECT ss.id       AS session_id,
              ss.guard_id,
              ss.shift_id,
              sh.status    AS shift_status,
              ss.clocked_in_at
         FROM shift_sessions ss
         JOIN shifts sh ON sh.id = ss.shift_id
        WHERE ss.clocked_out_at IS NULL
          AND sh.status NOT IN ('active', 'scheduled')
        ORDER BY ss.clocked_in_at`,
    );

    console.info('[orphaned_session_check.tick]', {
      orphaned:    rows.length,
      duration_ms: Date.now() - started,
    });

    if (rows.length > 0) {
      // Distinct statuses only — low cardinality, and it names the mechanism
      // (which status the shift landed on) without leaking ids into tags.
      const statuses = [...new Set(rows.map((r) => r.shift_status))].sort();
      console.warn(
        `[orphaned_session_check] ${rows.length} open session(s) on shifts outside ` +
        `('active','scheduled') — statuses=${statuses.join(',')}`,
      );
      Sentry.captureMessage(ORPHAN_MSG, {
        level:       'warning',
        fingerprint: [ORPHAN_MSG],
        tags: {
          flow:           'orphaned_session',
          shift_statuses: statuses.join(','),
        },
        extra: {
          orphaned_count: rows.length,
          shift_statuses: statuses,
          guards_blocked: [...new Set(rows.map((r) => r.guard_id))].length,
          sample:         rows.slice(0, SAMPLE_CAP).map((r) => ({
            session_id:    r.session_id,
            guard_id:      r.guard_id,
            shift_id:      r.shift_id,
            shift_status:  r.shift_status,
            clocked_in_at: r.clocked_in_at,
          })),
          sample_truncated: rows.length > SAMPLE_CAP,
        },
      } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
    }

    return rows.length;
  } catch (err) {
    // Detector. Never let it take the process down, and surface the failure
    // rather than swallowing it — a detector that dies quietly is worse than
    // no detector, because its silence reads as "all clear".
    console.error('[orphaned_session_check] FAILED:', err);
    Sentry.captureException(err, {
      tags:        { flow: 'orphaned_session' },
      fingerprint: ['orphaned_session', 'scan_error'],
    } as unknown as Parameters<typeof Sentry.captureException>[1]);
    return -1;
  }
}

// :10 past the hour — chatRetention already holds '0 * * * *', and
// locationIntegrityCron set the precedent of offsetting so two jobs never
// contend. :10 is also clear of nightlyPurge (00:00) and its 00:20 scan.
runJob('orphanedSessionCheck', '10 * * * *', runOrphanedSessionCheck, { sentryMonitor: true });
