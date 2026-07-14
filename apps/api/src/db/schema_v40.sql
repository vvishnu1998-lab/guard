-- Schema v40 — task_templates.scheduled_time site-timezone backfill
--
-- EXPAND phase for the fix landing alongside this migration in
-- services/tasks.ts (generator rewrite) and TaskTemplateModal.tsx
-- (drop the browser-TZ conversion). Runs BEFORE the code push, per
-- the standard expand-then-extend cadence.
--
-- ── Bug being retroactively fixed ────────────────────────────────
--   ① services/tasks.ts:34-38 setUTCHours() over-writes only the
--      UTC time-of-day portion of clockInAt, keeping the UTC date
--      unchanged. When scheduled_time expressed in UTC lands on a
--      different UTC date than the clock-in date (e.g. 9 PM PDT =
--      04:00 UTC next day), due_at ends up in the past by up to
--      24 hours. taskDueCron fires the reminder at whatever time
--      the guard clocked in, not at the intended wall clock.
--
--   ② TaskTemplateModal.tsx:26-31 localTimeToUtc() converts the
--      admin's *browser* wall-clock to UTC before storing on save,
--      making scheduled_time depend on the admin's TZ. sites.timezone
--      (added in v21) is the source of truth for how a template's
--      time should be interpreted — the admin's browser TZ should
--      not affect what is stored.
--
-- ── Fix ──────────────────────────────────────────────────────────
-- Store scheduled_time as site-local wall-clock (naive TIME). The
-- generator (rewritten in the accompanying commit) computes due_at
-- via Postgres timezone math using sites.timezone. Any admin, in any
-- browser TZ, edits the same site-local value.
--
-- Backfill: reverse the old localTimeToUtc using the site's own
-- timezone. Per Vishnu's Option B decision — prod today has one
-- template (Mosser Towers, saved by an admin in Pacific), so this
-- yields exact intent for the only affected row. Semantics for any
-- historical multi-TZ admin: recover the site-local wall-clock the
-- template *should* have meant. Future edits store site-local
-- directly (no conversion), so this is the last time this dance
-- needs to happen.
--
-- ── Idempotency ─────────────────────────────────────────────────
-- migrate.ts re-runs every file on every deploy, so a naïve UPDATE
-- would double-shift on the second run. Guarded by a COMMENT ON
-- COLUMN marker: after the backfill applies, the column comment is
-- set to 'wall_clock_local_v40'. Subsequent runs check the comment
-- and skip. The due_at recompute below is a pure function of stable
-- inputs, so re-running is naturally safe.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_description d
      JOIN pg_attribute  a ON a.attrelid = d.objoid AND a.attnum = d.objsubid
      JOIN pg_class      c ON c.oid = a.attrelid
     WHERE c.relname = 'task_templates'
       AND a.attname = 'scheduled_time'
       AND d.description = 'wall_clock_local_v40'
  ) THEN
    -- Reverse the old localTimeToUtc using each site's own timezone.
    -- CURRENT_DATE as anchor: today's DST state is used for the
    -- shift. Prod has one template (saved in PDT summer); with prod
    -- currently in PDT, the reverse is exact. Any winter-edited
    -- template read from a summer-run migration would land off by
    -- one hour — acceptable for the single existing template and
    -- corrected on next admin edit under the new store-local flow.
    UPDATE task_templates tt
       SET scheduled_time = (
             ((CURRENT_DATE + tt.scheduled_time)::TIMESTAMP AT TIME ZONE 'UTC')
                AT TIME ZONE s.timezone
           )::TIME
      FROM sites s
     WHERE s.id = tt.site_id;

    COMMENT ON COLUMN task_templates.scheduled_time IS 'wall_clock_local_v40';
  END IF;
END $$;

-- Recompute due_at on pending, unnotified task_instances using the
-- corrected formula: session's clocked_in_at, projected into the
-- site's timezone as a date, plus the (now site-local)
-- scheduled_time, projected back to TIMESTAMPTZ via the site's TZ.
--
-- Anchor: most recent shift_session on the shift. In normal
-- operation there is one active session per active shift;
-- multi-session shifts pick the current session — matches what the
-- next generator run would use.
--
-- notified_at IS NOT NULL rows are left alone (already fired
-- incorrectly per Vishnu's decision; not worth chasing).
--
-- Pattern: CTE pre-computes new_due_at inside a normal SELECT
-- (where LATERAL scopes correctly), then UPDATE joins on the CTE.
-- Direct LATERAL in an UPDATE ... FROM referencing the target-
-- table alias is a Postgres scoping violation (same class as the
-- handoffNudge SQL bug).
--
-- Idempotent: pure function of stable inputs, safe to re-run.
WITH computed AS (
  SELECT ti.id AS instance_id,
         ((sess.clocked_in_at AT TIME ZONE s.timezone)::DATE + tt.scheduled_time)::TIMESTAMP
            AT TIME ZONE s.timezone AS new_due_at
    FROM task_instances ti
    JOIN task_templates tt ON tt.id = ti.template_id
    JOIN sites          s  ON s.id  = ti.site_id
    JOIN LATERAL (
           SELECT clocked_in_at
             FROM shift_sessions
            WHERE shift_id = ti.shift_id
            ORDER BY clocked_in_at DESC
            LIMIT 1
         ) sess ON true
   WHERE ti.notified_at IS NULL
     AND ti.status      = 'pending'
)
UPDATE task_instances ti
   SET due_at = c.new_due_at
  FROM computed c
 WHERE ti.id = c.instance_id;
