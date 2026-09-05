-- schema_v67 -- cron_heartbeats: one row per scheduled job, rewritten every tick.
--
-- WHY
-- ---
-- Phase 0 established that a throw inside a node-cron tick is invisible.
-- node-cron catches the rejection itself (src/task.js:25) and emits
-- 'task-failed' on an EventEmitter that has no listener, so a wedged job
-- produces no log, no Sentry event, no crash and no restart -- while
-- /health keeps returning {"status":"ok"} because it only runs SELECT 1.
--
-- 13 of the 19 jobs also log nothing at all on a quiet tick, so "no output"
-- is the normal steady state and cannot be used as a signal. Detection has
-- to be POSITIVE EMISSION plus absence-alerting, which is what this table
-- is for: every tick writes a row, and a row whose last_tick_at is older
-- than its job's interval is the alarm.
--
-- SHAPE
-- -----
-- job_name is the PRIMARY KEY, so this table holds exactly one row per job
-- and never grows. There is no history here on purpose -- a growing table
-- would need its own retention step in nightlyPurge, and the history that
-- matters already lives in Sentry check-ins.
--
-- last_error is truncated to 500 characters by the writer. It is a triage
-- hint, not a log: the full error goes to console.error and Sentry.
--
-- IDEMPOTENT
-- ----------
-- CREATE TABLE IF NOT EXISTS, and the GRANT is guarded on the role
-- existing. migrate.ts replays every file in its array on every run, and
-- claude_readonly does not exist on a fresh local database -- an
-- unguarded GRANT would abort the whole chain there.

CREATE TABLE IF NOT EXISTS cron_heartbeats (
  job_name     TEXT PRIMARY KEY,
  last_tick_at TIMESTAMPTZ NOT NULL,
  last_run_ms  INTEGER,
  last_result  TEXT NOT NULL CHECK (last_result IN ('ok','error')),
  last_error   TEXT
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'claude_readonly') THEN
    GRANT SELECT ON cron_heartbeats TO claude_readonly;
  END IF;
END
$$;
