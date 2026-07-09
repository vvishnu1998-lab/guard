-- ============================================================
-- schema_v22 — Cancellation reason on shifts
-- ============================================================
-- Expand step of an expand-then-extend rollout. The code that will
-- start writing this column ships in a follow-up commit (site
-- deactivate/reactivate cascade); this file is safe to run against
-- prod first because every existing INSERT/UPDATE ignores the new
-- column and the NULL default covers unset rows.
--
-- Motivation: when the site-deactivate flow cancels a batch of
-- future shifts, operators + activity-log readers + billing users
-- need to distinguish that "cancelled" from a shift that a guard
-- cancelled themselves or an admin cancelled ad-hoc. Storing the
-- reason lets `[INACTIVE] site cascade` render distinctively in
-- reports and lets a future re-activation UI know which rows would
-- be candidates to un-cancel (out of scope for this task; noted).
--
-- Kept as free-form TEXT rather than a CHECK-constrained enum so
-- new reason strings can land in one place (route code) without a
-- follow-up migration. The write side validates against a known
-- set; the DB just stores what the app hands it.
-- ============================================================

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
