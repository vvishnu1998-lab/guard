/**
 * Chat retention — delete chat_messages older than 365 days, once a day.
 *
 * ── THIS IS THE ONLY RETENTION JOB WITH NO DRY-RUN GATE ─────────────────
 *
 * nightlyPurge is gated behind RETENTION_DRY_RUN, which is unset, so every
 * one of its nine steps returns before its first write and always has. This
 * job has no such gate: a change to the number below takes effect on the
 * next tick after deploy, not after a flag flip. Treat edits here as
 * production writes.
 *
 * It has not actually destroyed anything lately, and the distinction
 * matters: over the 28.4 days of statistics available (postmaster start
 * 2026-08-22), chat_messages shows 2 inserts and ZERO deletes. The hazard
 * is the absent gate, not observed volume.
 *
 * ── 48 HOURS → 365 DAYS ─────────────────────────────────────────────────
 *
 * Strictly subtractive in what it destroys: a longer window matches fewer
 * rows, so the first run after deploy cannot delete anything the old code
 * would have kept. No migration and no backfill — the tier is not stored,
 * it is computed here against created_at at delete time.
 *
 * 48 hours was never a recorded decision: it arrived with the chat feature
 * (518c936) and no commit message, comment or doc ever justified it. 365 is
 * not recorded anywhere either — it is not in the locked 2026-09-19 schedule
 * in services/retention.ts, nor in docs/OPS. If it is ever questioned, this
 * comment is the whole provenance.
 *
 * ── WHY THE NUMBER IS A LOCAL CONSTANT AND NOT IN services/retention.ts ──
 *
 * That file's header states the rule and this case sits squarely inside it:
 * tiers for tables with no `expires_at` column are computed inline and their
 * constants land with the code that reads them, because "an
 * authoritative-looking constant with no reader is exactly what
 * PING_PHOTO_DAYS was, and it misled two audits before it was removed."
 * chat_messages has no expires_at and exactly one reader — the statement
 * below. A RETENTION entry would have zero.
 *
 * chat_messages also has no legal_hold column, and unlike every other table
 * in the retention system it is reachable from no shift_session and no
 * report, so the admin cascade has no path to it. A message is therefore
 * unholdable: it dies at 365 days whatever an e-discovery request says.
 * That is a gap, not a design, and it is out of scope here.
 *
 * ── WHY HOURLY BECAME DAILY, AND WHY 04:37 ──────────────────────────────
 *
 * An hourly sweep for a boundary that moves one day per day is 8,760
 * statements a year to do the work of 365. Daily also matches nightlyPurge.
 *
 * The minute is 37 because 37 is not a multiple of 5. Eleven jobs run on a
 * five-minute schedule and three run every minute, so every multiple of 5 —
 * including :00,
 * :10, :20 and :30 — puts a fourteen-job pile-up on one 20-connection pool.
 * At :37 only the three per-minute jobs are co-firing, which is the floor:
 * no minute in the hour is free of them. 04:37 UTC (the container clock is
 * UTC — nightlyPurge passes no timezone and ticks at 00:00:01Z) is also
 * clear of nightlyPurge 00:00, orphanedSessionCheck :10 hourly,
 * locationIntegrityCron 07:20Z/08:20Z, dailyShiftEmail 16:00Z/17:00Z and
 * monthlyHoursReport 12:00 on the 1st.
 *
 * ── THE CATCH THAT USED TO BE HERE IS DELETED, DELIBERATELY ─────────────
 *
 * The body was wrapped in `catch (err) { console.error(...) }`, which caught
 * the error BEFORE runJob's wrapper could see it. The wrapper is what
 * reports: it logs `[chatRetention] tick failed`, calls
 * Sentry.captureException tagged job=chatRetention, and writes
 * cron_heartbeats.last_result = 'error' with last_error. Swallowing it meant
 * a permanently broken job reached Sentry never and left a console line as
 * its only trace — in a system whose own _run.ts header records that 13 of
 * 19 jobs log nothing on a quiet tick, so "no output" is the steady state
 * and cannot be a signal.
 *
 * SENTRY IS THE DETECTION CHANNEL, NOT /health/crons. computeStaleJobs
 * (_run.ts) branches on ROW AGE only; it reads last_result into its output
 * but never triggers on it. A job that ticks and throws writes a FRESH
 * heartbeat row, so the probe stays 200 no matter how many nights in a row
 * it fails. The cadence change moves staleness detection from 2h to 48h,
 * but that window only ever covered "stopped ticking entirely", which is
 * not how this job fails.
 *
 * Measured 2026-09-19: all 19 cron_heartbeats rows read last_result = 'ok',
 * which is exactly as consistent with a healthy fleet as with a swallowed
 * failure. Letting this one throw is what makes its 'ok' mean something.
 */
import { runJob } from './_run';
import { pool } from '../db/pool';

/** Days a chat message is kept. The only reader is the DELETE below. */
const CHAT_RETENTION_DAYS = 365;

runJob('chatRetention', '37 4 * * *', async () => {
  const result = await pool.query(
    `DELETE FROM chat_messages
      WHERE created_at < NOW() - INTERVAL '${CHAT_RETENTION_DAYS} days'`,
  );
  if (result.rowCount && result.rowCount > 0) {
    console.log(
      `[chat-retention] deleted ${result.rowCount} messages older than ${CHAT_RETENTION_DAYS}d`,
    );
  }
}, { sentryMonitor: false });
