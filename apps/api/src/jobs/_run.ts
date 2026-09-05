/**
 * runJob -- the single registration point for every scheduled job.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 0 established that a throw inside a node-cron tick is completely
 * invisible. Three facts compose into that:
 *
 *   1. node_modules/node-cron/src/scheduler.js:36 re-arms the poll with
 *      setTimeout(matchTime, delay) INSIDE matchTime, independent of task
 *      execution -- so a throwing tick never stops the schedule.
 *   2. node_modules/node-cron/src/task.js:25 catches every async rejection
 *      itself and emits 'task-failed'.
 *   3. Nothing listens for 'task-failed'. It is not the 'error' event, so an
 *      emit with zero listeners is a silent no-op.
 *
 * Net effect before this wrapper: a wedged job produced no log, no Sentry
 * event, no crash and no restart, while GET /health kept returning
 * {"status":"ok"} because it only runs SELECT 1. Thirteen of the nineteen
 * jobs also log nothing on a quiet tick, so "no output" is the normal steady
 * state and cannot be used as a signal.
 *
 * Detection therefore has to be POSITIVE EMISSION plus absence-alerting:
 * every tick writes a cron_heartbeats row (schema_v67), and a row whose
 * last_tick_at is older than its job's interval is the alarm.
 *
 * INVARIANTS THIS WRAPPER MUST HOLD
 * ---------------------------------
 * - The heartbeat write NEVER throws and NEVER blocks the job's own logic.
 *   It runs in finally, inside its own try/catch. If cron_heartbeats does
 *   not exist yet -- which is the state between merging this code and
 *   applying v67 -- the job still runs normally and only the heartbeat line
 *   logs an error.
 * - Job inner logic is untouched. Existing try/catch blocks and existing
 *   log lines stay exactly as they were; this wrapper is strictly additive.
 * - The tick callback never rejects, so node-cron's 'task-failed' path is
 *   unreachable in normal operation. The listener attached below is pure
 *   belt-and-braces for a bug in this file itself.
 */
import cron, { ScheduledTask } from 'node-cron';
import { pool } from '../db/pool';
import { Sentry } from '../services/sentry';

export interface RunJobOptions {
  /** tz database name. Omitted means the container clock (UTC on Railway). */
  timezone?: string;
  /**
   * Send Sentry cron check-ins for this job.
   *
   * FALSE for the three per-minute jobs (breakExpiryCron, expireSwapRequests,
   * pingReminder). At one tick per minute each, those three alone would be
   * ~1.3M check-ins/month. The org's cron-monitor quota could not be read
   * from the API (see docs/OPS/CRONS.md), so the conservative rule stands:
   * per-minute jobs are covered by the cron_heartbeats table only, which
   * costs nothing and detects the same condition.
   */
  sentryMonitor?: boolean;
}

const HEARTBEAT_SQL = `
  INSERT INTO cron_heartbeats (job_name, last_tick_at, last_run_ms, last_result, last_error)
  VALUES ($1, NOW(), $2, $3, $4)
  ON CONFLICT (job_name) DO UPDATE SET
    last_tick_at = EXCLUDED.last_tick_at,
    last_run_ms  = EXCLUDED.last_run_ms,
    last_result  = EXCLUDED.last_result,
    last_error   = EXCLUDED.last_error`;

/** last_error is a triage hint, not a log. The full error goes to Sentry. */
const MAX_ERROR_CHARS = 500;

let registeredCount = 0;

/**
 * Why captureCheckIn and not Sentry.withMonitor.
 *
 * withMonitor(slug, callback, config) exists in @sentry/node 8.55.2
 * (re-exported from @sentry/core, exports.d.ts:95) and is the documented
 * ergonomic wrapper. It is NOT safe for an async callback that can reject.
 * From node_modules/@sentry/core/build/cjs/exports.js:170-179:
 *
 *     if (is.isThenable(maybePromiseResult)) {
 *       Promise.resolve(maybePromiseResult).then(
 *         () => { finishCheckIn('ok'); },
 *         e => { finishCheckIn('error'); throw e; },
 *       );
 *     }
 *
 * The promise produced by that .then() is discarded -- not returned, not
 * awaited, not caught. When the callback rejects, the rejection handler
 * re-throws into that orphaned promise, producing a genuine unhandled
 * rejection distinct from the one the caller awaits. Node 20+ defaults to
 * --unhandled-rejections=throw, and package.json pins engines >=20.0.0, so
 * that terminates the process. Railway would then restart it
 * (restartPolicyType ON_FAILURE, maxRetries 3).
 *
 * Using withMonitor here would therefore convert today's silent-failure mode
 * into a crash loop -- strictly worse than the problem being fixed.
 *
 * captureCheckIn (exports.js:128-140) is fully synchronous, returns a string
 * id, and creates no promise at all. Driving in_progress/ok/error by hand
 * gives identical monitor behaviour with none of the hazard.
 */
function safeCheckIn(
  checkIn: Parameters<typeof Sentry.captureCheckIn>[0],
  config?: Parameters<typeof Sentry.captureCheckIn>[1],
): string | undefined {
  try {
    return config ? Sentry.captureCheckIn(checkIn, config) : Sentry.captureCheckIn(checkIn);
  } catch {
    // Monitoring must never be able to break the thing it monitors.
    return undefined;
  }
}

/**
 * node-cron 3.0.3 emits 'task-failed' on the inner Task, NOT on the
 * ScheduledTask that schedule() returns. Attaching to the returned object
 * alone would be a listener that can never fire. The inner Task is reachable
 * only as the private _task field, so this reads it defensively and falls
 * back to the public object if the internal shape ever changes.
 */
function attachTaskFailedListener(task: ScheduledTask, name: string): void {
  const inner = (task as unknown as { _task?: { on?: unknown } })._task;
  const target =
    inner && typeof inner.on === 'function' ? (inner as unknown as ScheduledTask) : task;
  try {
    target.on('task-failed', (e: unknown) => {
      console.error(`[${name}] task-failed`, e);
      Sentry.captureException(e, { tags: { job: name, path: 'task-failed' } });
    });
  } catch {
    // A listener we could not attach is not worth failing registration over.
  }
}

/**
 * Register a scheduled job with heartbeat + error reporting.
 *
 * @param name  Job name -- the source file's basename without .ts. Doubles as
 *              the cron_heartbeats primary key and the Sentry monitor slug.
 * @param expr  Crontab expression, unchanged from the job's original call.
 * @param fn    The job body. Its own inner try/catch stays as-is.
 *
 * fn is typed Promise<unknown>, not Promise<void>: three jobs return a value
 * that the scheduler has never consumed -- runClockOutReminder and
 * runOrphanedSessionCheck return Promise<number>, runNightlyPurge returns
 * Promise<StepResult[]> -- and TypeScript does not widen Promise<number> to
 * Promise<void>. The alternative was three throwaway wrapper arrows at the
 * call sites; unknown says the same thing without them. The return value is
 * awaited and discarded either way.
 */
export function runJob(
  name: string,
  expr: string,
  fn: () => Promise<unknown>,
  opts: RunJobOptions = {},
): ScheduledTask {
  const { timezone, sentryMonitor = false } = opts;

  const monitorConfig = {
    schedule: { type: 'crontab' as const, value: expr },
    checkinMargin: 2,
    maxRuntime: 10,
    timezone: timezone ?? 'UTC',
  };

  const task = cron.schedule(
    expr,
    async () => {
      const start = Date.now();
      let result: 'ok' | 'error' = 'ok';
      let err: unknown;

      const checkInId = sentryMonitor
        ? safeCheckIn({ monitorSlug: name, status: 'in_progress' }, monitorConfig)
        : undefined;

      try {
        await fn();
      } catch (e) {
        result = 'error';
        err = e;
        console.error(`[${name}] tick failed`, e);
        Sentry.captureException(e, { tags: { job: name } });
      } finally {
        const durationMs = Date.now() - start;

        if (sentryMonitor && checkInId) {
          safeCheckIn({
            monitorSlug: name,
            status: result,
            checkInId,
            // Sentry expects seconds; Date.now() deltas are milliseconds.
            duration: durationMs / 1000,
          });
        }

        try {
          await pool.query(HEARTBEAT_SQL, [
            name,
            durationMs,
            result,
            err ? String(err).slice(0, MAX_ERROR_CHARS) : null,
          ]);
        } catch (hbErr) {
          // Swallowed on purpose. Between merging this code and applying v67
          // the table does not exist, and a monitoring write must never take
          // down the job it is monitoring.
          console.error(`[${name}] heartbeat write failed`, hbErr);
        }
      }
    },
    // Pass no options object at all when there is no timezone, so behaviour
    // is byte-identical to the two-argument cron.schedule calls this replaced.
    timezone ? { timezone } : undefined,
  );

  attachTaskFailedListener(task, name);
  registeredCount += 1;
  return task;
}

/** Count of jobs registered so far. Exported for tests. */
export function registeredJobCount(): number {
  return registeredCount;
}

/**
 * Called from index.ts after the job imports have run. Job registration is an
 * import side-effect, so this must not be called before them or it reports 0.
 */
export function logJobRegistration(): void {
  console.log(`[jobs] registered ${registeredCount} jobs with heartbeats`);
}
