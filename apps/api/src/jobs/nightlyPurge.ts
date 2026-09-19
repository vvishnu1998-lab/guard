/**
 * Nightly retention purge — runs at 00:00 UTC.
 *
 * Seven independent steps, each in its own try/catch so one step
 * failing doesn't abort the rest. Every step logs a Sentry breadcrumb
 * with a count so a subsequent captureException (or the per-step
 * timing summary) has attached context.
 *
 * Guardrail: if a step would delete > STEP_ROW_CAP rows on a single
 * night, the step is halted and a Sentry warning is sent instead.
 * Sized so the first time a bug or misconfigured tier would wipe
 * many rows at once, we get an alert instead of the deletion.
 * D3: Sentry-only alert, no SendGrid — the retention email path is
 * being deleted this ship.
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
 * purge scan. All delete-eligible tables read
 * `WHERE expires_at < NOW() AND legal_hold = false` so held rows are
 * skipped even if the index changes. The cascade endpoint
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
export async function runNightlyPurge(): Promise<StepResult[]> {
  const start = Date.now();
  console.log(`[retention] starting nightly purge (dry_run=${DRY_RUN})`);
  Sentry.addBreadcrumb({
    category: 'retention',
    message:  `nightly purge starting`,
    data:     { dry_run: DRY_RUN, cap: STEP_ROW_CAP },
    level:    'info',
  });

  const results: StepResult[] = [];
  results.push(await step1_pingPhotos());
  results.push(await step2_expiredReports());
  results.push(await step3_expiredPings());
  results.push(await step4_expiredTaskCompletions());
  results.push(await step5_expiredGeofenceViolations());
  results.push(await step5b_expiredOffPostEvents());
  results.push(await step5c_expiredVehicleInspections());
  results.push(await step6_expiredShiftSessions());
  results.push(await step7_expiredShifts());

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
// THE ONLY STEP THAT DELETES ROWS AND SWEEPS NOTHING, and that is correct:
// off_post_events has no media pointer column. Verified against
// POINTER_COLUMNS in services/mediaOwnership.ts, which is itself drift-checked
// against pg_attribute by assertPointerColumnsCurrent(). If a photo column is
// ever added to this table it lands in that list first, and this comment stops
// being true — which is the point of keeping the enumeration in one place.
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
// FK NOTE — THIS STEP CAN RAISE 23503 AND THAT IS NOT HANDLED HERE.
// checkpoint_scans, vehicle_inspections and task_completions reference
// shift_sessions with NO ACTION, so a session whose scans outlive it blocks
// the DELETE, and one blocked session aborts the whole statement — every
// session in the batch, every night. Measured 2026-09-19: 20 of 345 sessions
// carry checkpoint_scans, and checkpoint_scans has no purge step at all yet,
// so that block is permanent rather than a timing window. The step that
// clears it belongs to PR 2; leaving the error loud is deliberate (see the
// step 5c header). What this PR fixes is the consequence: with the sweep
// AFTER the DELETE, a 23503 now throws before any S3 call, so a blocked
// session keeps its media instead of losing it to a delete that rolled back.
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
