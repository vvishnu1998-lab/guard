-- ============================================================
-- schema_v23 — Guard-to-guard shift swap requests (Phase 1a)
-- ============================================================
-- New table for guard-initiated swap flows. Distinct from the
-- pre-existing shift_reassignments table (schema_v15) which is the
-- admin-triggered reassign audit trail — this one is guard-driven
-- and stateful (pending → accepted / declined / expired).
--
-- Expand step of an expand-then-extend rollout. The code that will
-- start writing this table ships in a follow-up commit; this file
-- is safe to run against prod first because no existing SELECT/INSERT
-- touches it.
--
-- Design notes:
--   * `initiated_by` covers both this phase (guard_pre_shift) and the
--     future Phase 2 (guard_handoff) + the possibility of an admin
--     using this pipeline later. Keeps a single table for all swap
--     history rather than fragmenting.
--   * `from_session_id` / `to_session_id` are nullable — Phase 1
--     pre-shift swaps don't have sessions yet. Phase 2 handoff will
--     populate them.
--   * `admin_notified_at` records when the FYI email fired so admins
--     can audit "was I told about this swap". Nullable because
--     decline / expire never notify admin.
-- ============================================================

CREATE TABLE IF NOT EXISTS shift_swap_requests (
  id                UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_id          UUID        NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  from_guard_id     UUID        NOT NULL REFERENCES guards(id),
  to_guard_id       UUID        NOT NULL REFERENCES guards(id),
  initiated_by      TEXT        NOT NULL
                     CHECK (initiated_by IN ('admin','guard_pre_shift','guard_handoff')),
  reason            TEXT        CHECK (reason IS NULL OR char_length(reason) <= 200),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at       TIMESTAMPTZ,
  declined_at       TIMESTAMPTZ,
  status            TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','accepted','declined','expired')),
  from_session_id   UUID        REFERENCES shift_sessions(id),
  to_session_id     UUID        REFERENCES shift_sessions(id),
  admin_notified_at TIMESTAMPTZ
);

-- Detail-page render + swap history join by shift.
CREATE INDEX IF NOT EXISTS idx_shift_swap_requests_shift
  ON shift_swap_requests (shift_id);

-- Recipient inbox: "show me my pending swap invitations."
CREATE INDEX IF NOT EXISTS idx_shift_swap_requests_to_guard_status
  ON shift_swap_requests (to_guard_id, status);

-- Partial index for the every-minute expiry cron — only touches
-- pending rows, so the scan stays constant-time regardless of how
-- many accepted/declined/expired rows accumulate historically.
CREATE INDEX IF NOT EXISTS idx_shift_swap_requests_pending_requested
  ON shift_swap_requests (requested_at)
  WHERE status = 'pending';
