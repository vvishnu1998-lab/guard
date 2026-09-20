/**
 * Nightly retention purge — runs at 00:00 UTC.
 *
 * TWENTY-NINE independent steps — the original nine plus twenty added
 * 2026-09-19 — each in its own try/catch so one failing doesn't abort the
 * rest. Every step logs a Sentry breadcrumb with a count so a subsequent
 * captureException (or the per-step timing summary) has attached context.
 *
 * THE ORDER LIVES IN ONE PLACE: the STEP_ORDER array. Each entry says
 * whether its position is FORCED by a foreign key, PREFERRED, or ARBITRARY,
 * because those are three different things and only the first cannot be
 * changed. Read that array before adding a step; do not add one here.
 *
 * Guardrail: if a step would delete > STEP_ROW_CAP rows on a single
 * night, the step is halted and a Sentry warning is sent instead.
 * Sized so the first time a bug or misconfigured tier would wipe
 * many rows at once, we get an alert instead of the deletion.
 * D3: Sentry-only alert, no SendGrid — the retention email path is
 * being deleted this ship.
 *
 * ── THE CAP IS A DEADLOCK FOR ONE STEP, AND IT HAS A DATE ───────────────
 *
 * `notifications` is the only high-volume table here: 16,010 rows, of which
 * 1,452 were past 30 days on 2026-09-19. While the step is in dry-run the due
 * set grows every day, so it crosses STEP_ROW_CAP — after which haltStep
 * fires, nothing is deleted, the backlog keeps growing, and it halts every
 * night forever. The guardrail becomes the thing it was meant to guard
 * against.
 *
 * ENABLE THIS STEP BEFORE 2026-10-10.
 *
 * That date is computed, not projected. The due count on any day within 30
 * days is already determined by rows that exist now — due(D) = rows created
 * before D minus 30 days — so it was read straight out of production rather
 * than extrapolated: 8,648 on 10-08, 9,447 on 10-09, 10,149 on 10-10, which
 * is the first run whose candidate exceeds the cap.
 *
 * An earlier draft of this comment said 2026-10-26, sixteen days late and in
 * the unsafe direction, because it divided the table by its whole lifetime
 * and got ~232/day. The due set does not grow at the lifetime average; it
 * grows at the insertion rate of THIRTY DAYS AGO, and notifications have been
 * accelerating — the last seven days average 487/day. Any growth number in a
 * comment here should be a measured recent rate or, better, a date read out
 * of the data like the one above.
 *
 * The other 28 steps are nowhere near the cap: the largest is revoked_tokens
 * at 103 due, and the largest table without an expires_at column is
 * missed_pings at 4,157 rows, none of them due.
 *
 * Dry-run: `RETENTION_DRY_RUN` env var, code-default = TRUE. Only the
 * literal string 'false' flips it off. During the initial 30-day
 * observation window Vishnu keeps it TRUE and inspects the per-run
 * `retention_run_summary` event (see emitRunSummary) — one info-level
 * event per run carrying per-step candidate counts, emitted on dry-run
 * and live alike, so "nothing to purge" reads as a positive signal
 * rather than as silence. Flipping to 'false' in Railway env after that
 * window is a manual toggle (deliberately not a code change).
 *
 * Legal hold: partial indexes (schema_v33) exclude held rows from the
 * purge scan. Every table that HAS a legal_hold column reads it in its
 * predicate, so held rows are skipped even if the index changes.
 *
 * MOST TABLES DO NOT HAVE ONE. Ten of the platform's fifty carry legal_hold;
 * the other nineteen steps added in 2026-09 purge tables that cannot be held
 * at all — notifications, auth_events, the audit trail, the token windows.
 * That is a property of what those tables are, not an oversight, and the one
 * case where it mattered was fixed rather than accepted: schema_v80 gave
 * clock_in_verifications the column precisely because a step there destroys
 * an S3 object. The standing rule is about media, not about tables: no step
 * that destroys an S3 object ships without a hold predicate. The cascade endpoint
 * (PATCH /api/admin/reports/:id/legal-hold) walks parent + child rows
 * so no child of a held report escapes via ON DELETE CASCADE from an
 * expired parent.
 *
 * Ping photos (step 1) are a separate 7-day sweep that's independent
 * of the retention tier — they key on `photo_delete_at`, not `expires_at`.
 * They DO honour `legal_hold` like every other step; until 2026-09-19 they
 * did not, which is the only reason the sentence above could be written
 * while one step ignored the flag. The row that proved it: ping de9aa0b0
 * on a held session, unheld, and in this step's candidate set for 68 days.
 *
 * S3: EVERY STEP IS DATABASE-FIRST, AND THE SWEEP IS ALWAYS THE SECOND PASS.
 * Steps 2, 4 and 5c used to delete objects before the row; steps 3, 5, 6 and 7
 * issued a bare DELETE and swept nothing at all, so a session delete silently
 * orphaned six columns' worth of media through ON DELETE CASCADE. Both are
 * fixed the same way: collect the pointers, delete the rows, then sweepS3().
 * See sweepS3's header for why that order is also what makes the ownership
 * check answerable. Every step now reports s3_deleted / s3_failed / s3_skipped
 * on its StepResult and in the run summary; a step that touches no media
 * reports none at all rather than three zeroes.
 *
 * NOTHING HERE IS ENFORCED YET. RETENTION_DRY_RUN is unset, so DRY_RUN is
 * true and every step returns before its first write. These paths have never
 * executed in production.
 */

import { runJob } from './_run';
import { pool } from '../db/pool';
import { deleteS3Object } from '../services/s3';
import { keysStillReferenced, assertPointerColumnsCurrent } from '../services/mediaOwnership';
import { Sentry } from '../services/sentry';

const DRY_RUN = process.env.RETENTION_DRY_RUN !== 'false';
const STEP_ROW_CAP = 10_000;

/**
 * Day counts for the tables that have NO `expires_at` column.
 *
 * ── WHY THESE ARE NOT IN services/retention.ts ──────────────────────────
 *
 * That file's header states the rule and this is the case it describes:
 * "The locked schedule also covers 18 tables with NO `expires_at` column …
 * Those tiers are computed INLINE at purge time, and their constants land
 * with the purge steps that read them. They are not added here in advance:
 * an authoritative-looking constant with no reader is exactly what
 * PING_PHOTO_DAYS was, and it misled two audits before it was removed."
 *
 * So the constant lives beside its only reader, which is the step list
 * below. RETENTION stays the schedule for tables whose rows carry a stamped
 * `expires_at`; this is the schedule for tables where the purge predicate IS
 * the schedule. chatRetention.ts does the same thing for chat_messages.
 *
 * ── INTERPOLATED, NEVER RETYPED ─────────────────────────────────────────
 *
 * Every predicate below reads its number from here. A literal typed into a
 * WHERE clause is a second copy, and a second copy is what schema_v79 spent
 * a migration undoing — the clock-out writer had said 365 while the backfill
 * said 90, for four months, because the number existed twice.
 *
 * FIVE TABLES ARE DELIBERATELY ABSENT. checkpoint_scans, missed_pings,
 * missed_reports, revoked_tokens and admin_client_previews all carry a real
 * `expires_at`, so their steps read the COLUMN. Adding a day count for them
 * here would be a third copy of a number the writer and schema_v79 already
 * agree on — and for missed_pings/missed_reports it would orphan the writer
 * anchors PR #70 had just fixed.
 */
const PURGE_DAYS = {
  CLOCK_IN_PHOTO:           30,   // the selfie; the ROW lives to CLOCK_IN_ROW
  CLOCK_IN_ROW:             365,  // GPS + accuracy + geofence verdict
  NOTIFICATIONS:            30,
  AUTH_EVENTS:              365,
  BREAK_SESSIONS:           365,
  GUARD_DEVICE_REVOKED:     90,   // from revoked_at; an ACTIVE device never expires
  CHAT_ROOMS:               365,
  LOCATION_INTEGRITY_FLAGS: 365,
  OFFLINE_DEAD_LETTERS:     90,
  MONTHLY_HOURS_REPORTS:    1460,
  AUDIT_TRAIL:              1460, // the three audit tables + shift_swap_requests
} as const;

interface StepResult {
  step:      string;
  candidate: number;   // rows the WHERE clause matched
  deleted:   number;   // rows actually deleted (0 during dry-run / halted)
  /** S3 objects removed. Absent on steps that touch no media. */
  s3_deleted?: number;
  /** Well-formed keys we should have removed and could not. RETRYABLE — the
   *  DB row is already gone, so these are orphaned objects, not lost data. */
  s3_failed?:  number;
  /** Declined, not failed: a malformed value, a foreign host, or a key another
   *  surviving row still references. Retrying changes nothing. */
  s3_skipped?: number;
  halted?:   boolean;
  error?:    string;
}

/** What one S3 sweep did. Folded into StepResult by finishStep(). */
interface S3Sweep { deleted: number; failed: number; skipped: number; }

const NO_SWEEP: S3Sweep = { deleted: 0, failed: 0, skipped: 0 };

/**
 * Delete a batch of S3 objects, AFTER their database rows are gone.
 *
 * ── THE ORDER IS THE FIX ────────────────────────────────────────────────
 *
 * Steps 2, 4 and 5c used to delete every S3 object FIRST and then issue one
 * DELETE. A crash in that window left every row in the batch pointing at a
 * destroyed object, and the bare `catch {}` around each delete meant a report
 * whose photos failed to delete was deleted anyway, silently.
 *
 * DB first inverts which inconsistency a crash produces: an ORPHANED OBJECT
 * (no row points at it) instead of a DANGLING POINTER (a row points at
 * nothing). Orphans are the safer half — an object nobody references is
 * storage cost and a sweep away, while a dangling pointer is a 404 in the
 * app with the evidence already gone. The bucket reinforces it: versioning is
 * Enabled, and an orphan left by this path is a CURRENT version, which the
 * NoncurrentVersionExpiration rule does not touch.
 *
 * ── AND IT IS WHAT MAKES THE OWNERSHIP CHECK CORRECT ────────────────────
 *
 * keysStillReferenced() asks "does a surviving row still point at this key?".
 * Asked before the DELETE, every co-owner is still present and the answer is
 * always yes, so nothing would ever be deleted. Asked here, the survivors are
 * exactly the rows that should keep the object alive. 8 real keys are shared
 * today and 7 of them are shared WITHIN one column, which is why this is a
 * question about rows rather than about columns.
 *
 * ── THE DB WRITE IS NEVER CONDITIONAL ON THE RESULT ─────────────────────
 *
 * Nothing here can fail the step. Every outcome is classified and counted:
 * `deleted`, `failed` (retryable), `skipped` (declined — malformed value,
 * foreign host, or still referenced). A failure is loud in the counters and
 * in the run summary, and it never decides whether a row lives.
 */
async function sweepS3(step: string, rawUrls: Array<string | null | undefined>): Promise<S3Sweep> {
  const urls = rawUrls.filter((u): u is string => typeof u === 'string' && u.length > 0);
  if (urls.length === 0) return { ...NO_SWEEP };

  const out: S3Sweep = { deleted: 0, failed: 0, skipped: 0 };

  // A migration that adds a pointer column this service does not know about
  // gives the ownership check a blind spot, which would show up as deleting an
  // object something still references. Skip the sweep rather than risk it —
  // the objects become orphans, which is recoverable, and the log names the
  // column.
  const unknown = await assertPointerColumnsCurrent();
  if (unknown.length > 0) {
    console.error(
      `[retention.${step}] S3 sweep SKIPPED — unknown media pointer column(s): ${unknown.join(', ')}. ` +
      `Add them to POINTER_COLUMNS in services/mediaOwnership.ts. ` +
      `${urls.length} object(s) left in place.`,
    );
    Sentry.captureMessage('retention_pointer_column_drift', {
      level: 'warning',
      tags:  { flow: 'retention', step },
      extra: { unknown_columns: unknown, objects_skipped: urls.length },
    } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
    out.skipped = urls.length;
    return out;
  }

  const keys  = urls.map((u) => u.replace(/^https?:\/\/[^/]+\//, ''));
  const alive = await keysStillReferenced(keys);

  for (let i = 0; i < urls.length; i++) {
    if (alive.has(keys[i])) { out.skipped++; continue; }
    const r = await deleteS3Object(urls[i]);
    if (r.status === 'deleted') { out.deleted++; continue; }
    if (r.status === 'skipped') {
      out.skipped++;
      console.warn(`[retention.${step}] S3 skip (${r.reason}): ${r.value}`);
      continue;
    }
    out.failed++;
    console.error(`[retention.${step}] S3 delete FAILED, object orphaned: ${r.detail}`);
  }

  if (out.failed > 0 || out.skipped > 0) {
    console.log(
      `[retention.${step}] s3 deleted=${out.deleted} failed=${out.failed} skipped=${out.skipped}`,
    );
  }
  return out;
}

/**
 * One plain row-delete step: no media, no cascade bookkeeping, one predicate.
 *
 * Seventeen of the twenty new steps are this shape, differing only in table
 * and predicate. Writing them as seventeen near-identical functions would
 * bury the one thing that actually matters about them — THE ORDER — in nine
 * hundred lines of boilerplate. As data they sit in STEP_ORDER where a
 * reviewer can see the sequence and the FK reasoning in one screen.
 *
 * `step` IS AN AUDIT-TRAIL KEY, NOT A LABEL. It is the property name under
 * emitRunSummary's `per_step`, so renaming one silently breaks continuity
 * with every Sentry event already emitted. The existing nine keep their
 * original strings verbatim for exactly that reason.
 *
 * `where` is interpolated, never parameterised, and that is safe here and
 * only here: every value comes from PURGE_DAYS or is a literal in this file.
 * No request data reaches it. Do not extend this to accept a caller value.
 */
interface SimpleStep {
  step:  string;
  table: string;
  where: string;
  /** Why this step sits where it does. FORCED means an FK; anything else is
   *  a preference and should say so. */
  why:   string;
}

/**
 * SELECT the ids, then DELETE by id — never COUNT-then-DELETE-by-predicate.
 *
 * Same reasoning as the existing nine after PR #70: NOW() is re-evaluated at
 * DELETE time, so the two statements do not necessarily see the same set, and
 * `candidate` and `deleted` would describe different rows.
 */
async function runSimpleStep(s: SimpleStep): Promise<StepResult> {
  try {
    const rowsQ = await pool.query<{ id: string }>(
      `SELECT id FROM ${s.table} WHERE ${s.where}`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(s.step, candidate);
    if (DRY_RUN)                  return dryRunStep(s.step, candidate);

    const del = await pool.query(
      `DELETE FROM ${s.table} WHERE id = ANY($1::uuid[])`,
      [rowsQ.rows.map((r) => r.id)],
    );
    return finishStep(s.step, candidate, del.rowCount ?? 0);
  } catch (err) {
    return errorStep(s.step, err);
  }
}

// ── NEW ── Clock-in selfie at 30 days, keeping the row to 365 ────────────────
//
// The pointer is nulled and the row survives: the GPS fix, accuracy, geofence
// verdict and mock-location verdict are the evidence, and they outlive the
// photo by eleven months. Same shape as step 1 does for location_pings.
//
// THE legal_hold PREDICATE IS THE POINT OF schema_v80. This table had no such
// column until then, and the one held session's verification is 68 days old
// with a real selfie — so a hold-blind version of this step would have
// deleted the clock-in selfie of the only legal hold on the platform, on its
// first live night. No step that destroys an S3 object ships without one.
//
// ORDERING AGAINST schema_v80: this step both READS legal_hold and WRITES
// NULL into selfie_url, and v80 is what provides each. Against a database
// without it the SELECT raises 42703 on the missing column — so it fails at
// the read, before the write, and the 23502 from the NOT NULL is never
// reached. Both are unreachable while DRY_RUN is true, which it is: the step
// returns at dryRunStep before either statement runs. The hazard is real
// only in the window where the code is deployed, the migration is not
// applied, and the step has been named in the enablement allowlist.
async function stepClockInPhoto30d(): Promise<StepResult> {
  const step = 'clock_in_photo_30d';
  try {
    const rowsQ = await pool.query<{ id: string; selfie_url: string }>(
      `SELECT id, selfie_url FROM clock_in_verifications
        WHERE selfie_url IS NOT NULL
          AND verified_at < NOW() - INTERVAL '${PURGE_DAYS.CLOCK_IN_PHOTO} days'
          AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      'UPDATE clock_in_verifications SET selfie_url = NULL WHERE id = ANY($1::uuid[])',
      [rowsQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, rowsQ.rows.map((r) => r.selfie_url));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── NEW ── Clock-out photo at 90 days, keeping the session to 1500 ──────────
//
// Keys on clock_out_photo_delete_at rather than recomputing 90 days from
// clocked_out_at, for the reason the column exists: the writer
// (routes/shifts.ts) and schema_v79.sql:237 both stamp
// `clocked_out_at + INTERVAL '90 days'`, so reading the column is reading
// their agreement instead of minting a third copy of the number. That is also
// why PURGE_DAYS has no entry for it.
//
// NULLS THE POINTER, NEVER DELETES THE ROW. shift_sessions is a 1500-day
// entity and step 6 is the only thing allowed to remove it; a DELETE here
// would destroy a shift's entire evidence chain to reclaim one photo.
async function stepClockOutPhoto90d(): Promise<StepResult> {
  const step = 'clock_out_photo_90d';
  try {
    const rowsQ = await pool.query<{ id: string; clock_out_photo_url: string }>(
      `SELECT id, clock_out_photo_url FROM shift_sessions
        WHERE clock_out_photo_url IS NOT NULL
          AND clock_out_photo_delete_at < NOW()
          AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      'UPDATE shift_sessions SET clock_out_photo_url = NULL WHERE id = ANY($1::uuid[])',
      [rowsQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, rowsQ.rows.map((r) => r.clock_out_photo_url));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── NEW ── Clock-in verification rows at 365 days (DELETE then S3 sweep) ────
//
// THE ROW HALF OF THE PAIR, AND IT MUST SWEEP. stepClockInPhoto30d above is
// supposed to have nulled selfie_url eleven months earlier, so it is tempting
// to treat this as a plain row delete. It is not, for two reasons:
//
//   1. The 30d step is gated independently. Until it is enabled — and it is
//      dry-run like everything else — it nulls nothing, so every row reaching
//      365 days still holds its pointer. Measured 2026-09-19: 347 of 347 rows
//      have a selfie_url. Not an edge case; currently the whole table.
//   2. A row held at day 30 keeps its photo, and a hold released at day 200
//      leaves the pointer live with no second chance to null it.
//
// clock_in_verifications owns POINTER_COLUMNS entries 1 and 2 (selfie_url and
// site_photo_url), so a bare DELETE here orphans both — the exact defect
// PR #70 existed to remove from the original nine steps. site_photo_url is NULL
// on all 347 rows today and is collected anyway: sweepS3 filters nulls, and a
// column that is unused today is not a column that stays unused.
async function stepClockInVerifications365d(): Promise<StepResult> {
  const step = 'clock_in_verifications';
  try {
    const rowsQ = await pool.query<{
      id: string; selfie_url: string | null; site_photo_url: string | null;
    }>(
      `SELECT id, selfie_url, site_photo_url FROM clock_in_verifications
        WHERE verified_at < NOW() - INTERVAL '${PURGE_DAYS.CLOCK_IN_ROW} days'
          AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      'DELETE FROM clock_in_verifications WHERE id = ANY($1::uuid[])',
      [rowsQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, rowsQ.rows.flatMap((r) => [r.selfie_url, r.site_photo_url]));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── NEW ── Monthly hours reports at 1460 days (DELETE then S3 sweep) ────────
//
// The fourth media step, and the one the brief did not name as one:
// monthly_hours_reports.s3_url is TEXT NOT NULL and is already entry 5 of
// POINTER_COLUMNS in services/mediaOwnership.ts. A plain DELETE here would
// orphan every generated PDF it has ever produced.
async function stepMonthlyHoursReports(): Promise<StepResult> {
  const step = 'monthly_hours_reports';
  try {
    const rowsQ = await pool.query<{ id: string; s3_url: string }>(
      `SELECT id, s3_url FROM monthly_hours_reports
        WHERE generated_at < NOW() - INTERVAL '${PURGE_DAYS.MONTHLY_HOURS_REPORTS} days'`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      'DELETE FROM monthly_hours_reports WHERE id = ANY($1::uuid[])',
      [rowsQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, rowsQ.rows.map((r) => r.s3_url));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

runJob('nightlyPurge', '0 0 * * *', runNightlyPurge, { sentryMonitor: false });

/**
 * One purge run. Exported so a local harness can invoke it directly
 * against a throwaway DB; the cron registration above is the only
 * production caller.
 *
 * Exceptions are deliberately not caught here. Each step already has its
 * own try/catch feeding errorStep(), so anything escaping this function is
 * a genuine failure that must surface as an error rather than be swallowed
 * to force a summary event out.
 *
 * That surfacing is now real. It previously was not: node-cron catches the
 * rejection itself and emits 'task-failed' on an emitter with no listener
 * (src/task.js:25), so an escaping exception was swallowed by the scheduler
 * and produced no log and no Sentry event -- the opposite of what the
 * paragraph above intended. The runJob wrapper registered at the top of this
 * file now catches it, logs [nightlyPurge] tick failed, reports it to Sentry
 * tagged job=nightlyPurge, and records last_result='error' in
 * cron_heartbeats. Purge logic is unchanged.
 */
/**
 * EVERY STEP, IN THE ORDER THEY MUST RUN. This list is the schedule.
 *
 * A thunk is a step with its own function (media, or a cascade blast radius);
 * a SimpleStep object is a plain row delete run by runSimpleStep().
 *
 * ── WHAT "MUST" MEANS HERE ──────────────────────────────────────────────
 *
 * Only some of this order is forced. Each entry's `why` says which, and the
 * distinction is not pedantry: a FORCED position cannot be reordered without
 * a 23503, a PREFERRED one can be reordered safely and a future maintainer
 * needs to know which they are looking at. Positions that are neither say so.
 *
 * The forced ones all come from NO ACTION foreign keys into shift_sessions,
 * which are checked at end-of-statement and abort the WHOLE delete:
 *   checkpoint_scans_shift_session_id_fkey
 *   vehicle_inspections_shift_session_id_fkey
 *   task_completions_shift_session_id_fkey
 *   shift_swap_requests_from_session_id_fkey / _to_session_id_fkey
 *
 * ── THIS IS ALL LATENT UNTIL 2030 ───────────────────────────────────────
 *
 * Measured 2026-09-19: the earliest shift_sessions.expires_at and
 * shifts.expires_at are both 2030-08-21, so steps 6 and 7 match zero rows and
 * cannot raise a 23503 for another four years. The ordering is correct and
 * worth getting right now — it is not an outage waiting on a deploy.
 *
 * ── THE NAMING SCHEME STOPPED SCALING, AND WAS NOT EXTENDED ─────────────
 *
 * step1..step7 with 5b/5c interpolated cannot absorb twenty more without
 * renumbering, and renumbering would rewrite `per_step` keys that Sentry
 * events already carry. So the existing nine keep their strings VERBATIM and
 * new steps are named for their table. Position is expressed by this array
 * and nowhere else.
 */
type OrderedStep = (() => Promise<StepResult>) | SimpleStep;

const STEP_ORDER: readonly OrderedStep[] = [
  // ── A. Pointer nulling. No row is deleted, so nothing here can block or
  //       be blocked. First only because a photo freed early is a photo not
  //       carried through the rest of the run.
  step1_pingPhotos,
  stepClockInPhoto30d,
  stepClockOutPhoto90d,

  // ── B. Children of shift_sessions. Everything here must precede step 6.
  step2_expiredReports,
  step3_expiredPings,
  step4_expiredTaskCompletions,
  step5_expiredGeofenceViolations,
  step5b_expiredOffPostEvents,
  step5c_expiredVehicleInspections,
  {
    step:  'checkpoint_scans',
    table: 'checkpoint_scans',
    where: 'expires_at < NOW() AND legal_hold = false',
    why:   'FORCED before step 6 — NO ACTION FK. Reads expires_at (NOT NULL, '
         + 'DEFAULT now() + 365 days, recomputed by schema_v79) rather than '
         + 'computing 365 inline, which would be a third copy of the number.',
  },
  {
    step:  'shift_swap_requests',
    table: 'shift_swap_requests',
    where: `requested_at < NOW() - INTERVAL '${PURGE_DAYS.AUDIT_TRAIL} days'`,
    why:   'FORCED before step 6 — TWO NO ACTION FKs (from_session_id and '
         + 'to_session_id). Anchors on requested_at: this table has no '
         + 'created_at, and the other five timestamps are all nullable state.',
  },
  {
    step:  'missed_pings',
    table: 'missed_pings',
    where: 'expires_at < NOW()',
    why:   'PREFERRED — CASCADE child, so no FK forces it. Reads expires_at '
         + 'because PR #70 fixed this table\'s writer to anchor it on '
         + 'window_end; computing 90 days inline would orphan that fix. No '
         + 'legal_hold column exists on this table.',
  },
  {
    step:  'missed_reports',
    table: 'missed_reports',
    where: 'expires_at < NOW()',
    why:   'PREFERRED — same as missed_pings, tier 730d, writer anchored on '
         + 'window_end by PR #70. Note resolved_by_report_id -> reports is '
         + 'SET NULL, so the reports step cannot block or be blocked by this.',
  },
  {
    step:  'break_sessions',
    table: 'break_sessions',
    where: `break_start < NOW() - INTERVAL '${PURGE_DAYS.BREAK_SESSIONS} days'`,
    why:   'PREFERRED — CASCADE child. Anchors on break_start, not break_end: '
         + 'break_end is NULL on an open break, and a NULL anchor makes a row '
         + 'immortal under a < predicate. A never-closed break should still '
         + 'age out 365 days after it began.',
  },
  {
    step:  'notifications',
    table: 'notifications',
    where: `created_at < NOW() - INTERVAL '${PURGE_DAYS.NOTIFICATIONS} days'`,
    why:   'PREFERRED — CASCADE child, not FK-forced in either direction. '
         + 'THE ONLY HIGH-VOLUME STEP: 16,010 rows at ~232/day, 1,452 due. '
         + 'See the STEP_ROW_CAP note in the header.',
  },
  stepClockInVerifications365d,

  // ── C/D. The parents. Both match zero rows until 2030-08-21.
  step6_expiredShiftSessions,
  step7_expiredShifts,

  // ── E. Order among these is ARBITRARY: no NO ACTION or RESTRICT FK
  //       connects any of them to another or to the shift chain, verified
  //       against pg_constraint, so none can block or be blocked.
  //
  //       "Independent" would be too strong. THREE ARE CASCADE CHILDREN of
  //       tables that have steps — location_integrity_flags and chat_rooms'
  //       children, plus shift_reassignments and shift_schedule_audit off
  //       shifts — so they can be deleted by a parent before their own step
  //       runs. That costs nothing, because a CASCADE delete needs no
  //       cooperation from this list; it is only the NO ACTION ones that
  //       dictate position.
  //
  //       Roughly alphabetical, so a reader can find one. Not exactly:
  //       stepMonthlyHoursReports is a thunk and sits where its name would
  //       put it, and guard_devices precedes guard_assignment_audit.
  {
    step:  'admin_client_previews',
    table: 'admin_client_previews',
    where: 'expires_at < NOW()',
    why:   'ARBITRARY. NOT A RETENTION TIER — schema_v79:128-131 names this a '
         + 'capability window (a 30-minute admin preview grant). Pruned on its '
         + 'own expires_at; deliberately absent from PURGE_DAYS so nobody '
         + 'attaches a retention number to it.',
  },
  {
    step:  'auth_events',
    table: 'auth_events',
    where: `created_at < NOW() - INTERVAL '${PURGE_DAYS.AUTH_EVENTS} days'`,
    why:   'ARBITRARY. Append-only log; created_at is its only timestamp.',
  },
  {
    step:  'chat_rooms',
    table: 'chat_rooms',
    where: `created_at < NOW() - INTERVAL '${PURGE_DAYS.CHAT_ROOMS} days'`,
    why:   'ARBITRARY. CASCADES to chat_messages and chat_room_reads, which is '
         + 'why neither gets a step of its own. created_at is NULLABLE here '
         + '(0 NULLs today) — a NULL row would be immortal under this '
         + 'predicate, which is the carried NOT NULL item, deferred.',
  },
  {
    step:  'guard_devices',
    table: 'guard_devices',
    where: 'revoked_at IS NOT NULL '
         + `AND revoked_at < NOW() - INTERVAL '${PURGE_DAYS.GUARD_DEVICE_REVOKED} days'`,
    why:   'ARBITRARY. STATE-DRIVEN, not age-driven: an ACTIVE device never '
         + 'expires however old it is, so the IS NOT NULL is the whole rule '
         + 'and not a null-guard. 114 of 138 rows are revoked; 0 are due.',
  },
  {
    step:  'guard_assignment_audit',
    table: 'guard_assignment_audit',
    where: `changed_at < NOW() - INTERVAL '${PURGE_DAYS.AUDIT_TRAIL} days'`,
    why:   'ARBITRARY. Audit trail, 4-year tier.',
  },
  {
    step:  'location_integrity_flags',
    table: 'location_integrity_flags',
    where: `detected_at < NOW() - INTERVAL '${PURGE_DAYS.LOCATION_INTEGRITY_FLAGS} days'`,
    why:   'ARBITRARY for position, but NOT independent: '
         + 'location_integrity_flags_shift_session_id_fkey is CASCADE on a '
         + 'NOT NULL column, so all 29 rows die with their session at step 6 '
         + 'if they have not aged out first. Anchors on detected_at because '
         + 'first_event_at, last_event_at and reviewed_at are nullable state. '
         + 'detected_at and created_at are IDENTICAL on all 29 rows today '
         + '(max gap 0.000000s) — the writer sets both — so this is a choice '
         + 'about which column MEANS the event, not a measurable difference.',
  },
  stepMonthlyHoursReports,
  {
    step:  'offline_dead_letters',
    table: 'offline_dead_letters',
    where: `reported_at < NOW() - INTERVAL '${PURGE_DAYS.OFFLINE_DEAD_LETTERS} days'`,
    why:   'ARBITRARY. Anchors on reported_at, the only NOT NULL timestamp. '
         + 'queued_at and dead_at are CLIENT-SUPPLIED and unbounded '
         + '(services/offlineDeadLetter.ts passes them straight from the '
         + 'request body), so a client could set either far enough in the past '
         + 'to delete its own evidence or far enough ahead to keep it forever.',
  },
  {
    step:  'revoked_tokens',
    table: 'revoked_tokens',
    where: 'expires_at < NOW()',
    why:   'ARBITRARY. NOT A RETENTION TIER — a JWT blocklist window. Once the '
         + 'token it blocks has expired the row cannot deny anything. Same '
         + 'schema_v79:128-131 note as admin_client_previews.',
  },
  {
    step:  'shift_reassignments',
    table: 'shift_reassignments',
    where: `created_at < NOW() - INTERVAL '${PURGE_DAYS.AUDIT_TRAIL} days'`,
    why:   'ARBITRARY. Audit trail. Also a CASCADE child of shifts, so step 7 '
         + 'would take it anyway — this step only matters for rows whose shift '
         + 'outlives them, which at equal tiers is most of them.',
  },
  {
    step:  'shift_schedule_audit',
    table: 'shift_schedule_audit',
    where: `changed_at < NOW() - INTERVAL '${PURGE_DAYS.AUDIT_TRAIL} days'`,
    why:   'ARBITRARY. Audit trail; CASCADE child of shifts, same note as '
         + 'shift_reassignments.',
  },
];

export async function runNightlyPurge(): Promise<StepResult[]> {
  const start = Date.now();
  console.log(`[retention] starting nightly purge (dry_run=${DRY_RUN})`);
  Sentry.addBreadcrumb({
    category: 'retention',
    message:  `nightly purge starting`,
    data:     { dry_run: DRY_RUN, cap: STEP_ROW_CAP },
    level:    'info',
  });

  // Sequential on purpose. The order in STEP_ORDER is the whole point, and
  // Promise.all would run a child and its parent in the same instant.
  const results: StepResult[] = [];
  for (const entry of STEP_ORDER) {
    results.push(typeof entry === 'function' ? await entry() : await runSimpleStep(entry));
  }

  const durationMs = Date.now() - start;
  const dur = (durationMs / 1000).toFixed(1);
  const totalCandidate = results.reduce((s, r) => s + r.candidate, 0);
  const totalDeleted   = results.reduce((s, r) => s + r.deleted,   0);
  console.log(`[retention] complete in ${dur}s — candidate=${totalCandidate} deleted=${totalDeleted}`);
  Sentry.addBreadcrumb({
    category: 'retention',
    message:  `nightly purge complete`,
    data:     { duration_s: dur, results },
    level:    'info',
  });

  emitRunSummary(results, durationMs);
  return results;
}

// ── Step 1 ── Ping photos at 7 days (NULL the pointer, then S3 sweep) ────────
async function step1_pingPhotos(): Promise<StepResult> {
  const step = 'step1_ping_photos';
  try {
    const candidateQ = await pool.query<{ id: string; photo_url: string }>(
      // legal_hold, NOT retain_as_evidence. This step was the only one of the
      // nine that ignored the hold flag, and the clause it used instead is
      // dead: `retain_as_evidence` is written by nothing in the codebase, so
      // it is false on every row and excluded nothing. The admin cascade
      // (admin.ts) sets `legal_hold` on location_pings — that is the flag a
      // hold actually produces, and now the one this step reads.
      //
      // The column retain_as_evidence is deliberately LEFT IN PLACE, inert:
      // schema_v2.sql:40 carries a partial index predicated on it, and
      // dropping the column drops the index with it. Removing both is a
      // contract-phase change with no functional gain.
      `SELECT id, photo_url FROM location_pings
       WHERE photo_url IS NOT NULL
         AND photo_delete_at < NOW()
         AND legal_hold = false`,
    );
    const candidate = candidateQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    // DB FIRST, then the sweep — the same inversion as every other step. The
    // pointer is what makes the photo reachable from the app, so nulling it is
    // the part that must not depend on S3 succeeding. Nulling also REMOVES the
    // reference, which is what lets keysStillReferenced() see the truth.
    const urls = candidateQ.rows.map((r) => r.photo_url);
    const del  = await pool.query(
      'UPDATE location_pings SET photo_url = NULL WHERE id = ANY($1::uuid[])',
      [candidateQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, urls);
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 2 ── Expired reports (cascade DELETE → S3 sweep) ────────────────────
async function step2_expiredReports(): Promise<StepResult> {
  const step = 'step2_reports';
  try {
    const idsQ = await pool.query<{ id: string }>(
      `SELECT id FROM reports
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = idsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    // Collect the URLs while the rows still exist, DELETE, then sweep.
    // report_photos goes with the parent on ON DELETE CASCADE, so after the
    // DELETE nothing references these keys unless another surviving report
    // does — which is exactly what the ownership check asks. 7 keys are shared
    // across 26 report_photos rows today, all within this one column.
    const ids = idsQ.rows.map((r) => r.id);
    const photosQ = await pool.query<{ storage_url: string }>(
      `SELECT rp.storage_url
       FROM report_photos rp
       WHERE rp.report_id = ANY($1::uuid[])`,
      [ids],
    );

    const del = await pool.query(
      `DELETE FROM reports
       WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const s3 = await sweepS3(step, photosQ.rows.map((r) => r.storage_url));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 3 ── Expired ping metadata ──────────────────────────────────────────
async function step3_expiredPings(): Promise<StepResult> {
  const step = 'step3_pings';
  try {
    // SELECT the ids, then DELETE BY ID — not COUNT-then-DELETE-by-predicate.
    // `expires_at < NOW()` is re-evaluated at DELETE time, so the two
    // statements do not necessarily see the same set: a row crossing its
    // expiry between them is deleted without its photo_url ever being
    // collected, which is a silent orphan. Every step below is switched to
    // this shape for the same reason.
    const rowsQ = await pool.query<{ id: string; photo_url: string | null }>(
      `SELECT id, photo_url FROM location_pings
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    // A ping reaching 90 days should already have lost its photo to step 1 at
    // 7, but `photo_delete_at` is nullable and step 1 skips held rows, so the
    // pointer is not guaranteed gone. Sweeping is the only thing that makes
    // this DELETE safe against the cases where it is not.
    const del = await pool.query(
      `DELETE FROM location_pings WHERE id = ANY($1::uuid[])`,
      [rowsQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, rowsQ.rows.map((r) => r.photo_url));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 4 ── Expired task completions (DELETE then S3 sweep) ────────────────
async function step4_expiredTaskCompletions(): Promise<StepResult> {
  const step = 'step4_task_completions';
  try {
    const rowsQ = await pool.query<{ id: string; photo_url: string | null }>(
      `SELECT id, photo_url FROM task_completions
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      `DELETE FROM task_completions
       WHERE id = ANY($1::uuid[])`,
      [rowsQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, rowsQ.rows.map((r) => r.photo_url));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 5 ── Expired geofence violations ────────────────────────────────────
async function step5_expiredGeofenceViolations(): Promise<StepResult> {
  const step = 'step5_geofence_violations';
  try {
    const rowsQ = await pool.query<{ id: string; photo_url: string | null }>(
      `SELECT id, photo_url FROM geofence_violations
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    // This column is the one place where a key is shared ACROSS tables: one
    // key is held by both a geofence_violations row and a location_pings row
    // (the violation is raised from the ping that detected it). Whichever of
    // the two steps runs second is the one that actually deletes the object —
    // which is the behaviour keysStillReferenced() produces for free, and the
    // reason the check is not scoped to this step's own table.
    const del = await pool.query(
      `DELETE FROM geofence_violations WHERE id = ANY($1::uuid[])`,
      [rowsQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, rowsQ.rows.map((r) => r.photo_url));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 5b ── Expired off_post_events (schema_v46) ──────────────────────────
// Runs before the shift_sessions step for the same child-before-parent
// ordering as geofence_violations (the FK cascade would catch them anyway,
// but off_post_events expire at 365d vs the session's 1500d).
//
// Deletes rows and sweeps nothing, which is correct: off_post_events has no
// media pointer column. It was the ONLY such step until 2026-09-19; the
// sixteen runSimpleStep tables are now in the same position, and for the same
// reason — none of them appears in POINTER_COLUMNS. That list in
// services/mediaOwnership.ts is drift-checked against pg_attribute by
// assertPointerColumnsCurrent(), so a photo column added to any of them lands
// there first. THE RULE THAT FOLLOWS: a table in POINTER_COLUMNS may not be
// purged by runSimpleStep, because runSimpleStep cannot sweep. Four tables
// are on the media side of that line and all four have their own function.
async function step5b_expiredOffPostEvents(): Promise<StepResult> {
  const step = 'step5b_off_post_events';
  try {
    const rowsQ = await pool.query<{ id: string }>(
      `SELECT id FROM off_post_events
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    // id-based like the rest, even with no media to collect: it is what makes
    // `candidate` and `deleted` describe the same set of rows instead of two
    // evaluations of NOW() a query apart.
    const del = await pool.query(
      `DELETE FROM off_post_events WHERE id = ANY($1::uuid[])`,
      [rowsQ.rows.map((r) => r.id)],
    );
    return finishStep(step, candidate, del.rowCount ?? 0);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 5c ── Expired vehicle inspections (DELETE then S3 sweep) ────────────
// schema_v48, 'vehicle_inspection' tier (365d). Runs BEFORE the
// shift_sessions step: inspections FK shift_sessions WITHOUT cascade
// (deliberate — a cascade would silently delete a legal_hold inspection
// when its 4-year session purges; a blocked FK errors loudly instead).
async function step5c_expiredVehicleInspections(): Promise<StepResult> {
  const step = 'step5c_vehicle_inspections';
  try {
    const rowsQ = await pool.query<{
      id: string;
      photo_front_url: string | null;
      photo_rear_url: string | null;
      photo_driver_side_url: string | null;
      photo_passenger_side_url: string | null;
      photo_odometer_url: string | null;
    }>(
      `SELECT id, photo_front_url, photo_rear_url, photo_driver_side_url,
              photo_passenger_side_url, photo_odometer_url
       FROM vehicle_inspections
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      `DELETE FROM vehicle_inspections
       WHERE id = ANY($1::uuid[])`,
      [rowsQ.rows.map((r) => r.id)],
    );
    const s3 = await sweepS3(step, rowsQ.rows.flatMap((r) => [
      r.photo_front_url, r.photo_rear_url, r.photo_driver_side_url,
      r.photo_passenger_side_url, r.photo_odometer_url,
    ]));
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

/**
 * Every media pointer that dies when these shift_sessions are deleted.
 *
 * ── WHY A SESSION DELETE IS THE BIGGEST MEDIA EVENT IN THE JOB ──────────
 *
 * Steps 1-5c delete a row that owns its own photo. A shift_sessions DELETE
 * owns one photo (clock_out_photo_url) and destroys five more columns' worth
 * through ON DELETE CASCADE, without a single S3 call in the step. That is
 * the largest source of orphaned objects in the purge, and it was invisible
 * because the step's own SQL names no media at all.
 *
 * ONLY ON DELETE CASCADE PATHS BELONG HERE. Verified against pg_constraint
 * 2026-09-19 — confdeltype 'c' for clock_in_verifications, location_pings,
 * geofence_violations and reports (which cascades on to report_photos).
 * Deliberately NOT included:
 *   task_completions, vehicle_inspections, checkpoint_scans  NO ACTION ('a')
 *   quarantined_uploads.shift_session_id                     SET NULL  ('n')
 * Those rows SURVIVE the delete and keep pointing at their objects. Sweeping
 * them would destroy live media. (keysStillReferenced() would also catch it,
 * but a guard is a backstop, not a licence to hand it the wrong list.)
 *
 * Shared by step 6 and step 7 because step 7 reaches the same rows through
 * shifts → shift_sessions, one cascade level higher.
 */
async function sessionMediaUrls(sessionIds: string[]): Promise<Array<string | null>> {
  if (sessionIds.length === 0) return [];
  const { rows } = await pool.query<{ v: string }>(
    `SELECT clock_out_photo_url AS v FROM shift_sessions
      WHERE id = ANY($1::uuid[]) AND clock_out_photo_url IS NOT NULL
     UNION ALL
     SELECT selfie_url FROM clock_in_verifications
      WHERE shift_session_id = ANY($1::uuid[]) AND selfie_url IS NOT NULL
     UNION ALL
     SELECT site_photo_url FROM clock_in_verifications
      WHERE shift_session_id = ANY($1::uuid[]) AND site_photo_url IS NOT NULL
     UNION ALL
     SELECT photo_url FROM location_pings
      WHERE shift_session_id = ANY($1::uuid[]) AND photo_url IS NOT NULL
     UNION ALL
     SELECT photo_url FROM geofence_violations
      WHERE shift_session_id = ANY($1::uuid[]) AND photo_url IS NOT NULL
     UNION ALL
     SELECT rp.storage_url FROM report_photos rp
       JOIN reports r ON r.id = rp.report_id
      WHERE r.shift_session_id = ANY($1::uuid[]) AND rp.storage_url IS NOT NULL`,
    [sessionIds],
  );
  return rows.map((r) => r.v);
}

// ── Step 6 ── Expired shift_sessions ─────────────────────────────────────────
//
// FK NOTE — STEP 6 AND STEP 7 CAN BOTH RAISE 23503, AND NEITHER HANDLES IT.
// Five NO ACTION FKs point at shift_sessions: checkpoint_scans,
// shift_swap_requests (twice), task_completions and vehicle_inspections. A
// session with a surviving child of any of those blocks the DELETE, and one
// blocked session aborts the whole statement — every session in the batch.
//
// STEP 7 IS EXPOSED THE SAME WAY, which is easy to miss because its own
// header talks only about task_completions. shifts -> shift_sessions is
// CASCADE, so deleting a shift tries to delete its sessions and hits the
// identical end-of-statement check. task_completions escapes it via the
// task_instances leg; checkpoint_scans and vehicle_inspections have no leg
// reaching shifts and so block step 7 exactly as they block step 6.
//
// All four child tables now have steps ahead of both parents in STEP_ORDER,
// which is what clears the block — checkpoint_scans got its step in this
// commit. It does not clear immediately: scans expire from 2027-08-05 while
// sessions expire from 2030-08-21, so by the time either parent matches a
// row the children are three years gone. Until 2030 both parents match zero
// rows and no 23503 is reachable at all.
//
// What is still deliberate is leaving the error LOUD if one ever does fire
// (see the step 5c header). What this PR changed is the consequence: with
// the sweep AFTER the DELETE, a 23503 throws before any S3 call, so a
// blocked session keeps its media instead of losing it to a rolled-back
// delete.
async function step6_expiredShiftSessions(): Promise<StepResult> {
  const step = 'step6_shift_sessions';
  try {
    const rowsQ = await pool.query<{ id: string }>(
      `SELECT id FROM shift_sessions
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const ids  = rowsQ.rows.map((r) => r.id);
    const urls = await sessionMediaUrls(ids);

    const del = await pool.query(
      `DELETE FROM shift_sessions WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const s3 = await sweepS3(step, urls);
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 7 ── Expired shifts ─────────────────────────────────────────────────
//
// FIXING STEP 6 ALONE WOULD LOOK COMPLETE AND LEAK ANYWAY.
// shifts and shift_sessions are both 1500 days but anchor on different
// timestamps — scheduled_start vs clocked_in_at — so a session routinely
// outlives its own parent by the clock-in delay. Measured 2026-09-19: the
// shift expires first on 253 of 345 pairs, and on 14 of those the two
// expiries fall on DIFFERENT UTC dates (max gap 15h56m). On those nights
// step 6 does not match the session at all; step 7 cascades it away, taking
// 31 objects today (14 selfies, 10 report photos, 6 ping photos, 1 clock-out
// photo) that a step-6-only sweep never sees.
//
// So this step re-derives the session set from the shifts it is about to
// delete, rather than assuming step 6 already handled them. Sessions that
// step 6 DID delete are simply not found here, and the two sweeps cannot
// double-delete because the first one removed the rows the second would
// have read.
async function step7_expiredShifts(): Promise<StepResult> {
  const step = 'step7_shifts';
  try {
    const rowsQ = await pool.query<{ id: string }>(
      `SELECT id FROM shifts
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = rowsQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const ids = rowsQ.rows.map((r) => r.id);

    // shifts → shift_sessions is CASCADE, so every session of an expiring
    // shift dies with it whether or not it has expired on its own tier.
    const sessionsQ = await pool.query<{ id: string }>(
      `SELECT id FROM shift_sessions WHERE shift_id = ANY($1::uuid[])`,
      [ids],
    );

    // The one pointer step 6 cannot reach. task_completions.shift_session_id
    // is NO ACTION, but task_completions.task_instance_id is CASCADE and
    // task_instances.shift_id is CASCADE — so a shift delete DOES destroy
    // task completions, by the other leg of the same table. (It is also why
    // step 7 does not hit the NO ACTION block step 6 hits on this table: the
    // check is deferred to end-of-statement and the cascade has removed the
    // rows by then.)
    const taskQ = await pool.query<{ v: string }>(
      `SELECT tc.photo_url AS v FROM task_completions tc
         JOIN task_instances ti ON ti.id = tc.task_instance_id
        WHERE ti.shift_id = ANY($1::uuid[]) AND tc.photo_url IS NOT NULL`,
      [ids],
    );

    const urls = [
      ...(await sessionMediaUrls(sessionsQ.rows.map((r) => r.id))),
      ...taskQ.rows.map((r) => r.v),
    ];

    const del = await pool.query(
      `DELETE FROM shifts WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    const s3 = await sweepS3(step, urls);
    return finishStep(step, candidate, del.rowCount ?? 0, s3);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function haltStep(step: string, candidate: number): StepResult {
  const msg = `retention.${step}.halted count=${candidate}`;
  console.warn(`[retention.${step}] HALT: ${candidate} rows > ${STEP_ROW_CAP} row cap`);
  Sentry.captureMessage(msg, {
    level: 'warning',
    tags:  { flow: 'retention', step },
    extra: { candidate, cap: STEP_ROW_CAP, dry_run: DRY_RUN },
  } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
  return { step, candidate, deleted: 0, halted: true };
}

function dryRunStep(step: string, candidate: number): StepResult {
  console.log(`[retention.${step}] DRY_RUN would delete ${candidate}`);
  Sentry.addBreadcrumb({
    category: 'retention',
    message:  `${step}: DRY_RUN would delete ${candidate}`,
    data:     { candidate },
    level:    'info',
  });
  return { step, candidate, deleted: 0 };
}

function finishStep(step: string, candidate: number, deleted: number, s3: S3Sweep = NO_SWEEP): StepResult {
  console.log(`[retention.${step}] deleted ${deleted} rows`);
  Sentry.addBreadcrumb({
    category: 'retention',
    message:  `${step}: deleted ${deleted}`,
    data:     { candidate, deleted, s3 },
    level:    'info',
  });
  return {
    step, candidate, deleted,
    s3_deleted: s3.deleted, s3_failed: s3.failed, s3_skipped: s3.skipped,
  };
}

function errorStep(step: string, err: unknown): StepResult {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[retention.${step}] error:`, err);
  Sentry.captureException(err, {
    tags: { flow: 'retention', step },
  } as unknown as Parameters<typeof Sentry.captureException>[1]);
  return { step, candidate: 0, deleted: 0, error: msg };
}

/**
 * Stable message string + matching fingerprint. Sentry groups captureMessage
 * events by message text, so every varying number MUST stay out of it —
 * interpolating a row count here would mint a fresh issue nightly and
 * recreate, in a louder shape, the noise problem this event exists to avoid.
 * The explicit fingerprint pins grouping even if the string is ever reworded.
 */
const RUN_SUMMARY_MSG = 'retention_run_summary';

/**
 * The single event every run emits — dry-run or live, rows or no rows.
 *
 * Before this, a healthy dry-run night produced only breadcrumbs, and
 * breadcrumbs are discarded unless some later capture attaches them. That
 * made a clean run indistinguishable from the job never firing, which is not
 * a signal RETENTION_DRY_RUN=false can be flipped on. One event per run, not
 * one per step: seven nightly events would get muted, and a muted issue is
 * the same silence with extra steps.
 */
function emitRunSummary(results: StepResult[], durationMs: number): void {
  const haltedSteps  = results.filter((r) => r.halted).map((r) => r.step);
  const erroredSteps = results.filter((r) => r.error).map((r) => r.step);

  // Per-step counts as structured data, keyed by step name — never
  // concatenated into the message.
  const perStep: Record<string, Omit<StepResult, 'step'>> = {};
  for (const r of results) {
    perStep[r.step] = {
      candidate: r.candidate,
      deleted:   r.deleted,
      halted:    r.halted === true,
      // Only on steps that swept. An absent trio means "touches no media",
      // which is a different fact from "swept nothing", and the summary is
      // the only durable record of either.
      ...(r.s3_deleted !== undefined
        ? { s3_deleted: r.s3_deleted, s3_failed: r.s3_failed, s3_skipped: r.s3_skipped }
        : {}),
      ...(r.error ? { error: r.error } : {}),
    };
  }

  const totalCandidate = results.reduce((s, r) => s + r.candidate, 0);
  const totalDeleted   = results.reduce((s, r) => s + r.deleted,   0);
  const s3Deleted = results.reduce((s, r) => s + (r.s3_deleted ?? 0), 0);
  const s3Failed  = results.reduce((s, r) => s + (r.s3_failed  ?? 0), 0);
  const s3Skipped = results.reduce((s, r) => s + (r.s3_skipped ?? 0), 0);

  Sentry.captureMessage(RUN_SUMMARY_MSG, {
    level:       'info',
    fingerprint: [RUN_SUMMARY_MSG],
    // Low-cardinality only, so the issue stays searchable by shape
    // (`flow:retention dry_run:true any_halted:true`) without exploding tags.
    tags: {
      flow:       'retention',
      dry_run:    String(DRY_RUN),
      any_halted: String(haltedSteps.length > 0),
      any_error:  String(erroredSteps.length > 0),
      // Boolean, not a count — a tag with a row count in it mints a new issue
      // per value, which is the grouping mistake RUN_SUMMARY_MSG avoids above.
      any_s3_failed: String(s3Failed > 0),
    },
    extra: {
      dry_run:         DRY_RUN,
      cap:             STEP_ROW_CAP,
      duration_s:      Number((durationMs / 1000).toFixed(1)),
      steps_total:     results.length,
      steps_executed:  results.length - erroredSteps.length,
      steps_halted:    haltedSteps.length,
      steps_errored:   erroredSteps.length,
      halted_steps:    haltedSteps,
      errored_steps:   erroredSteps,
      total_candidate: totalCandidate,
      total_deleted:   totalDeleted,
      s3_deleted:      s3Deleted,
      s3_failed:       s3Failed,
      s3_skipped:      s3Skipped,
      per_step:        perStep,
    },
  } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
}
