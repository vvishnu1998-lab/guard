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
 * of the retention tier — they stay unchanged from the old cron.
 */

import cron from 'node-cron';
import { pool } from '../db/pool';
import { deleteS3Object } from '../services/s3';
import { Sentry } from '../services/sentry';

const DRY_RUN = process.env.RETENTION_DRY_RUN !== 'false';
const STEP_ROW_CAP = 10_000;

interface StepResult {
  step:      string;
  candidate: number;   // rows the WHERE clause matched
  deleted:   number;   // rows actually deleted (0 during dry-run / halted)
  halted?:   boolean;
  error?:    string;
}

cron.schedule('0 0 * * *', runNightlyPurge);

/**
 * One purge run. Exported so a local harness can invoke it directly
 * against a throwaway DB; the cron registration above is the only
 * production caller.
 *
 * Exceptions are deliberately not caught here. Each step already has its
 * own try/catch feeding errorStep(), so anything escaping this function is
 * a genuine failure that must surface as an error rather than be swallowed
 * to force a summary event out.
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

// ── Step 1 ── Ping photos at 7 days (unchanged) ──────────────────────────────
async function step1_pingPhotos(): Promise<StepResult> {
  const step = 'step1_ping_photos';
  try {
    const candidateQ = await pool.query<{ id: string; photo_url: string }>(
      `SELECT id, photo_url FROM location_pings
       WHERE photo_url IS NOT NULL
         AND photo_delete_at < NOW()
         AND retain_as_evidence = false`,
    );
    const candidate = candidateQ.rows.length;

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    let deleted = 0;
    for (const row of candidateQ.rows) {
      try {
        await deleteS3Object(row.photo_url);
        await pool.query('UPDATE location_pings SET photo_url = NULL WHERE id = $1', [row.id]);
        deleted++;
      } catch (err) {
        console.error(`[retention.${step}] failed to delete photo for ping ${row.id}:`, err);
      }
    }
    return finishStep(step, candidate, deleted);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 2 ── Expired reports (dependency-safe: S3 photos → cascade DELETE) ──
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

    // Batch-fetch every photo URL up front, delete S3 objects, then
    // one DELETE per report — report_photos cascades on ON DELETE CASCADE.
    const photosQ = await pool.query<{ storage_url: string }>(
      `SELECT rp.storage_url
       FROM report_photos rp
       WHERE rp.report_id = ANY($1::uuid[])`,
      [idsQ.rows.map((r) => r.id)],
    );
    for (const p of photosQ.rows) {
      try { await deleteS3Object(p.storage_url); } catch { /* already gone */ }
    }

    const del = await pool.query(
      `DELETE FROM reports
       WHERE id = ANY($1::uuid[])`,
      [idsQ.rows.map((r) => r.id)],
    );
    return finishStep(step, candidate, del.rowCount ?? 0);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 3 ── Expired ping metadata ──────────────────────────────────────────
async function step3_expiredPings(): Promise<StepResult> {
  const step = 'step3_pings';
  try {
    const countQ = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM location_pings
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = Number(countQ.rows[0].n);

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      `DELETE FROM location_pings
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    return finishStep(step, candidate, del.rowCount ?? 0);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 4 ── Expired task completions (S3 photos then DELETE) ───────────────
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

    for (const row of rowsQ.rows) {
      if (row.photo_url) {
        try { await deleteS3Object(row.photo_url); } catch { /* already gone */ }
      }
    }
    const del = await pool.query(
      `DELETE FROM task_completions
       WHERE id = ANY($1::uuid[])`,
      [rowsQ.rows.map((r) => r.id)],
    );
    return finishStep(step, candidate, del.rowCount ?? 0);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 5 ── Expired geofence violations ────────────────────────────────────
async function step5_expiredGeofenceViolations(): Promise<StepResult> {
  const step = 'step5_geofence_violations';
  try {
    const countQ = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM geofence_violations
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = Number(countQ.rows[0].n);

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      `DELETE FROM geofence_violations
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    return finishStep(step, candidate, del.rowCount ?? 0);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 6 ── Expired shift_sessions ─────────────────────────────────────────
async function step6_expiredShiftSessions(): Promise<StepResult> {
  const step = 'step6_shift_sessions';
  try {
    const countQ = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM shift_sessions
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = Number(countQ.rows[0].n);

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      `DELETE FROM shift_sessions
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    return finishStep(step, candidate, del.rowCount ?? 0);
  } catch (err) {
    return errorStep(step, err);
  }
}

// ── Step 7 ── Expired shifts ─────────────────────────────────────────────────
async function step7_expiredShifts(): Promise<StepResult> {
  const step = 'step7_shifts';
  try {
    const countQ = await pool.query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM shifts
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    const candidate = Number(countQ.rows[0].n);

    if (candidate > STEP_ROW_CAP) return haltStep(step, candidate);
    if (DRY_RUN)                  return dryRunStep(step, candidate);

    const del = await pool.query(
      `DELETE FROM shifts
       WHERE expires_at < NOW() AND legal_hold = false`,
    );
    return finishStep(step, candidate, del.rowCount ?? 0);
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

function finishStep(step: string, candidate: number, deleted: number): StepResult {
  console.log(`[retention.${step}] deleted ${deleted} rows`);
  Sentry.addBreadcrumb({
    category: 'retention',
    message:  `${step}: deleted ${deleted}`,
    data:     { candidate, deleted },
    level:    'info',
  });
  return { step, candidate, deleted };
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
      ...(r.error ? { error: r.error } : {}),
    };
  }

  const totalCandidate = results.reduce((s, r) => s + r.candidate, 0);
  const totalDeleted   = results.reduce((s, r) => s + r.deleted,   0);

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
      per_step:        perStep,
    },
  } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
}
