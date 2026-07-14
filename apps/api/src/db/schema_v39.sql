-- Schema v39 — task_due notification plumbing (EXPAND phase)
--
-- Two independent additions, both prep for Build 38's taskDueCron:
--
--   ① task_instances.notified_at — populated by the new
--      apps/api/src/jobs/taskDueCron.ts on the tick that fires the
--      task_reminder push. Idempotency gate is the UPDATE
--      RETURNING id pattern (WHERE notified_at IS NULL) — a
--      concurrent 5-min tick lands on the same row, RETURNING
--      empty, and skips the push. Nullable + no default so
--      existing rows stay unaffected until the cron actually
--      fires against them.
--
--      Partial index idx_task_instances_due_pending backs the
--      cron's per-tick scan:
--        WHERE status = 'pending' AND notified_at IS NULL
--        ORDER BY due_at
--      With one row per pending task per shift and pending rows
--      shrinking as guards complete tasks, the partial predicate
--      keeps the index tiny.
--
--   ② task_templates.recurrence_days — TEXT[] populated only
--      when recurrence = 'custom'. Reads
--      lowercase-day-name strings ('sunday' .. 'saturday') per
--      the DAY_NAMES array in services/tasks.ts. Nullable is
--      correct: 'daily' | 'weekdays' | 'weekends' templates never
--      populate it, and the generator's short-circuit at
--      services/tasks.ts:26-31 checks recurrence first so a NULL
--      here is safe.
--
--      Landing the column now (v39) unblocks the generator SELECT
--      change in Commit B — without this migration, adding
--      recurrence_days to the SELECT list would 42703 at run time.
--
-- Both DDLs use IF NOT EXISTS so the migrate.ts loop stays idempotent
-- across deploys. No renames, no drops, no CHECK constraint changes.

ALTER TABLE task_instances
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_task_instances_due_pending
  ON task_instances (due_at)
  WHERE status = 'pending' AND notified_at IS NULL;

ALTER TABLE task_templates
  ADD COLUMN IF NOT EXISTS recurrence_days TEXT[];
