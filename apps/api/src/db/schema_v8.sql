-- schema_v8.sql — Week 1 audit fix CB1 (audit/REPORT.md, audit/WEEK1.md C1)
--
-- Two changes:
--   1. Backfill any historical shift_sessions rows where total_hours is NULL
--      because the auto-complete cron used to update clocked_out_at without
--      computing total_hours. We use the same gross-minus-breaks math the
--      manual clock-out endpoint applies.
--   2. Add a CHECK constraint preventing negative total_hours from ever
--      slipping in (defence in depth — the fixed cron also clamps to 0).
--
-- Idempotent: re-runnable without harm.

-- ---- 1. Backfill ----------------------------------------------------------
UPDATE shift_sessions ss
   SET total_hours = GREATEST(
         0,
         EXTRACT(EPOCH FROM (ss.clocked_out_at - ss.clocked_in_at)) / 3600.0
         - COALESCE((
             SELECT SUM(duration_minutes)
               FROM break_sessions bs
              WHERE bs.shift_session_id = ss.id
                AND bs.duration_minutes IS NOT NULL
           ), 0) / 60.0
       )
 WHERE ss.clocked_out_at IS NOT NULL
   AND ss.total_hours IS NULL;

-- ---- 2. CHECK constraint --------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'chk_total_hours_nonneg'
       AND conrelid = 'shift_sessions'::regclass
  ) THEN
    ALTER TABLE shift_sessions
      ADD CONSTRAINT chk_total_hours_nonneg
      CHECK (total_hours IS NULL OR total_hours >= 0);
  END IF;
END$$;
