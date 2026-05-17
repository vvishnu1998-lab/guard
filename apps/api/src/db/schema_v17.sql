-- Schema v17 — Pre-shift and shift-start push reminders
--
-- Idempotency markers for two new push cron jobs
-- (jobs/preShiftReminder.ts, jobs/shiftStartReminder.ts). Both nullable;
-- cron treats NULL as "not yet sent" and stamps NOW() only on successful
-- FCM dispatch. On FCM failure or missing fcm_token the column stays
-- NULL so the next 5-min tick can retry within the small candidate
-- window (10 min for pre-shift, 5 min for start).

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS pre_shift_reminder_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS start_reminder_sent_at TIMESTAMPTZ;
