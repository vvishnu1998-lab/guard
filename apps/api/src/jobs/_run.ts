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

/** One entry per registered job. Feeds GET /health/crons. */
export interface RegisteredJob {
  name: string;
  expr: string;
  intervalSec: number;
  /**
   * Epoch ms at which this job was registered, i.e. process boot.
   *
   * Exists to give a never-ticked job a grace period. Without it, a job with
   * no heartbeat row counted as stale immediately, so /health/crons returned
   * 503 from the moment of deploy until every job had fired once -- up to a
   * month, gated by monthlyHoursReport. That is a probe that alarms
   * continuously and then gets muted right before it would start meaning
   * something.
   *
   * Resets on every restart, which is correct: a fresh process legitimately
   * has no row yet for a job that is not due. A job that HAS a row is
   * unaffected, because the row survives restarts and its age is measured
   * from the last real tick.
   */
  registeredAt: number;
}

const registry: RegisteredJob[] = [];

/** Registered jobs, in registration order. Read-only view for the route. */
export function registeredJobs(): readonly RegisteredJob[] {
  return registry;
}

/**
 * Expected seconds between ticks, derived from a crontab expression.
 *
 * Deliberately NOT a general cron parser. It covers exactly the five shapes
 * the 19 jobs actually use and throws on anything else, at registration time,
 * so an unsupported expression fails loudly at boot rather than silently
 * producing a wrong staleness threshold. cron-parser is not a dependency of
 * this repo and is not being added for five patterns.
 *
 *   * * * * *      -> 60        every minute
 *   NUM/N * * * *  -> N * 60    every N minutes
 *   M * * * *      -> 3600      hourly at minute M
 *   M H * * *      -> 86400     daily at H:M
 *   M H D * *      -> 2678400   monthly on day D (31d; the longest month, so
 *                               the threshold never fires early on a short one)
 */
export function cronIntervalSeconds(expr: string): number {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`[jobs] unsupported cron expression ${JSON.stringify(expr)}: expected 5 fields, got ${fields.length}`);
  }
  const [minute, hour, dom, month, dow] = fields;
  const isNum = (s: string) => /^\d+$/.test(s);

  if (month !== '*' || dow !== '*') {
    throw new Error(`[jobs] unsupported cron expression ${JSON.stringify(expr)}: month and day-of-week must both be '*'`);
  }

  if (minute === '*' && hour === '*' && dom === '*') return 60;

  const step = /^\*\/(\d+)$/.exec(minute);
  if (step && hour === '*' && dom === '*') {
    const n = Number(step[1]);
    if (!Number.isInteger(n) || n < 1 || n > 59) {
      throw new Error(`[jobs] unsupported cron expression ${JSON.stringify(expr)}: step ${step[1]} out of range`);
    }
    return n * 60;
  }

  if (isNum(minute) && hour === '*' && dom === '*') return 3600;
  if (isNum(minute) && isNum(hour) && dom === '*') return 86400;
  if (isNum(minute) && isNum(hour) && isNum(dom)) return 2678400;

  throw new Error(`[jobs] unsupported cron expression ${JSON.stringify(expr)}: no supported pattern matched`);
}

/** One row of cron_heartbeats, as the /health/crons query returns it. */
export interface HeartbeatRow {
  job_name: string;
  age_s: string | number;
  last_result: string;
}

/** A job the probe considers dead. age_s/last_result are null if it never ran. */
export interface StaleJob {
  job: string;
  age_s: number | null;
  interval_s: number;
  last_result: string | null;
}

/**
 * Pure staleness computation, extracted so it is testable without standing up
 * express or a database. `now` is a parameter rather than a Date.now() call so
 * the grace-period branch can be tested at an arbitrary point in time.
 *
 * Two rules, depending on whether the job has ever ticked:
 *
 *   HAS a heartbeat row  -> stale when the row is older than TWICE its own
 *                           interval. 2x absorbs one skipped tick; beyond that
 *                           is a real gap.
 *   NO heartbeat row     -> stale only once it has been REGISTERED for longer
 *                           than that same 2x window (Phase 4.1). Before that,
 *                           "no row" means "not due yet".
 *
 * The grace period exists because the first rule alone made every never-ticked
 * job stale the instant the process booted, so the probe returned 503 from
 * deploy until all 19 jobs had fired -- up to a month, gated by
 * monthlyHoursReport. It changes nothing about how fast a genuinely dead job
 * is caught: still 48h for a daily job, ~62 days for the monthly one.
 *
 * A row present in the table but NOT in the registry is ignored -- that is a
 * job that was renamed or removed, and its stale row is a leftover, not an
 * outage. Deleting it is a manual cleanup, not this function's job.
 */
export function computeStaleJobs(
  jobs: readonly RegisteredJob[],
  rows: readonly HeartbeatRow[],
  now: number = Date.now(),
): StaleJob[] {
  const byName = new Map(rows.map((r) => [r.job_name, r]));
  const stale: StaleJob[] = [];
  for (const j of jobs) {
    const thresholdSec = 2 * j.intervalSec;
    const row = byName.get(j.name);

    if (!row) {
      // NEVER TICKED. Stale only once the job has been registered for longer
      // than it should have taken to fire twice. Before that, "no row" means
      // "not due yet", which is the normal state of a daily job seconds after
      // a deploy -- not an outage.
      //
      // The threshold is the same 2x used below, so a job that is genuinely
      // dead is still caught on the same schedule: a daily job within 48h, a
      // monthly one within about 62 days. The grace shifts nothing except the
      // false positive at t=0.
      const sinceRegisteredMs = now - j.registeredAt;
      if (sinceRegisteredMs > thresholdSec * 1000) {
        stale.push({ job: j.name, age_s: null, interval_s: j.intervalSec, last_result: null });
      }
      continue;
    }

    // HAS TICKED. Unchanged: measured from the last real tick, and the row
    // outlives restarts, so this needs no grace.
    const ageS = Number(row.age_s);
    if (ageS > thresholdSec) {
      stale.push({ job: j.name, age_s: ageS, interval_s: j.intervalSec, last_result: row.last_result });
    }
  }
  return stale;
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

  // Derived BEFORE the schedule call so an unsupported expression throws at
  // boot, not at the first tick. A wrong staleness threshold is worse than a
  // crash on deploy: it makes /health/crons quietly lie.
  const intervalSec = cronIntervalSeconds(expr);

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
  registry.push({ name, expr, intervalSec, registeredAt: Date.now() });
  registeredCount += 1;
  return task;
}

/** Count of jobs registered so far. Exported for tests. */
export function registeredJobCount(): number {
  return registeredCount;
}

/** Reset the registry. Test-only; never called by application code. */
export function __resetRegistryForTests(): void {
  registry.length = 0;
  registeredCount = 0;
}

/**
 * Called from index.ts after the job imports have run. Job registration is an
 * import side-effect, so this must not be called before them or it reports 0.
 */
export function logJobRegistration(): void {
  console.log(`[jobs] registered ${registeredCount} jobs with heartbeats`);
}
