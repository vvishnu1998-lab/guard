-- ============================================================
-- Schema v3 — SMS OTP unlock support
-- ============================================================

ALTER TABLE login_attempts
  ADD COLUMN IF NOT EXISTS otp_hash       VARCHAR(255),
  ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMPTZ;
