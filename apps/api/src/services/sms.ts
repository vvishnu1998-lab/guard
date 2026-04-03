/**
 * SMS service — Twilio-backed OTP for self-service account unlock (Section 7 fallback).
 *
 * Flow:
 *   1. Guard hits POST /api/auth/guard/request-unlock  (provides email)
 *   2. API generates 6-digit OTP, stores hash + expiry in login_attempts row
 *   3. Twilio sends SMS to guard's registered phone_number
 *   4. Guard hits POST /api/auth/guard/verify-unlock   (provides email + OTP)
 *   5. If valid and not expired → clears lock, returns new tokens
 *
 * OTP is hashed with bcrypt before storage — never stored in plaintext.
 * TTL defaults to 10 minutes (configurable via SMS_OTP_TTL_MINUTES env var).
 */

import bcrypt from 'bcrypt';

const TTL_MINUTES = parseInt(process.env.SMS_OTP_TTL_MINUTES ?? '10', 10);

/** Generate a 6-digit numeric OTP string */
export function generateOtp(): string {
  return Math.floor(100_000 + Math.random() * 900_000).toString();
}

/** Hash OTP for safe storage */
export async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, 10);
}

/** Verify a plaintext OTP against its stored hash */
export async function verifyOtp(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}

/** Returns the UTC timestamp when an OTP generated now will expire */
export function otpExpiresAt(): Date {
  const d = new Date();
  d.setMinutes(d.getMinutes() + TTL_MINUTES);
  return d;
}

/**
 * Send OTP via Twilio SMS.
 * Gracefully no-ops if Twilio credentials are not configured
 * so the app starts cleanly in dev without Twilio set up.
 */
export async function sendOtpSms(toNumber: string, otp: string): Promise<void> {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.warn(`[sms] Twilio not configured — OTP for ${toNumber}: ${otp}`);
    return;
  }

  const twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  await twilio.messages.create({
    body: `Your Guard unlock code is: ${otp}\nExpires in ${TTL_MINUTES} minutes. Do not share this code.`,
    from: TWILIO_FROM_NUMBER,
    to: toNumber,
  });

  console.log(`[sms] Unlock OTP sent to ${toNumber}`);
}
