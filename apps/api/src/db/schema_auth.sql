-- ============================================================
-- Phase 2 — Auth additions
-- Run after schema.sql
-- ============================================================

-- Tracks all authentication events per Section 7 ("all auth events logged with timestamp")
CREATE TABLE IF NOT EXISTS auth_events (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  actor_id   UUID        NOT NULL,             -- guard / admin / client UUID; 'vishnu' stored as nil UUID
  role       VARCHAR(20) NOT NULL CHECK (role IN ('guard','company_admin','client','vishnu')),
  event_type VARCHAR(40) NOT NULL,             -- login_success | login_failed | logout | token_refresh
                                               -- | session_revoked | password_changed | locked | unlocked
  ip_address VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_events_actor
  ON auth_events (actor_id, created_at DESC);

-- Tracks consecutive failed logins for guard accounts; cleared on success or supervisor unlock
CREATE TABLE IF NOT EXISTS login_attempts (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  guard_id     UUID        NOT NULL REFERENCES guards(id) ON DELETE CASCADE UNIQUE,
  failed_count SMALLINT    NOT NULL DEFAULT 0,
  locked_at    TIMESTAMPTZ,          -- set when failed_count reaches 5
  unlocked_by  UUID,                 -- company_admin UUID that cleared the lock
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tracks whether a guard must change password on next login (first login flow)
ALTER TABLE guards
  ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS fcm_token            TEXT;   -- device push token, updated on each login

-- Tracks revoked refresh tokens (blocklist); pruned nightly with expired tokens
CREATE TABLE IF NOT EXISTS revoked_tokens (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  jti        VARCHAR(64) NOT NULL UNIQUE,  -- JWT ID claim
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL          -- same as token exp — for pruning
);

CREATE INDEX IF NOT EXISTS idx_revoked_tokens_jti ON revoked_tokens (jti);
CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expires ON revoked_tokens (expires_at);
