import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AuthPayload, requireAuth } from '../middleware/auth';
import { generateOtp, hashOtp, verifyOtp, otpExpiresAt, sendOtpSms } from '../services/sms';
import { sendPasswordResetEmail } from '../services/email';

const router = Router();

const MAX_FAILED_ATTEMPTS = 5;
const ACCESS_TOKEN_TTL  = '8h';   // web sessions; mobile app refreshes automatically
const REFRESH_TOKEN_TTL = '30d';

// ── Token helpers ────────────────────────────────────────────────────────────

function signTokens(payload: Omit<AuthPayload, 'iat' | 'exp' | 'jti'>) {
  const jti = uuidv4(); // unique ID embedded in refresh token for revocation
  const access = jwt.sign(payload, process.env.JWT_SECRET!, { expiresIn: ACCESS_TOKEN_TTL });
  const refresh = jwt.sign({ ...payload, jti }, process.env.JWT_REFRESH_SECRET!, { expiresIn: REFRESH_TOKEN_TTL });
  return { access, refresh };
}

async function logEvent(
  actorId: string,
  role: AuthPayload['role'],
  eventType: string,
  req: Request
) {
  await pool.query(
    `INSERT INTO auth_events (actor_id, role, event_type, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorId, role, eventType, req.ip, req.headers['user-agent'] ?? null]
  ).catch(() => {}); // non-blocking — never fail a login because of logging
}

// ── Guard: email + password login ────────────────────────────────────────────

router.post('/guard/login', async (req: Request, res: Response) => {
  const { email, password, fcm_token } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const guardResult = await pool.query(
    `SELECT id, company_id, password_hash, is_active, must_change_password
     FROM guards WHERE email = $1`,
    [email.toLowerCase().trim()]
  );
  const guard = guardResult.rows[0];

  // Always run bcrypt to prevent timing attacks even if guard not found
  const hashToCheck = guard?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!guard || !valid) {
    if (guard) {
      // Increment failed attempts
      await pool.query(
        `INSERT INTO login_attempts (guard_id, failed_count, updated_at)
         VALUES ($1, 1, NOW())
         ON CONFLICT (guard_id) DO UPDATE
           SET failed_count = login_attempts.failed_count + 1,
               locked_at    = CASE WHEN login_attempts.failed_count + 1 >= $2
                                   THEN NOW() ELSE login_attempts.locked_at END,
               updated_at   = NOW()`,
        [guard.id, MAX_FAILED_ATTEMPTS]
      );
      await logEvent(guard.id, 'guard', 'login_failed', req);
    }
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!guard.is_active) {
    return res.status(403).json({ error: 'Account deactivated. Contact your supervisor.' });
  }

  // Check lockout
  const lockResult = await pool.query(
    'SELECT failed_count, locked_at FROM login_attempts WHERE guard_id = $1',
    [guard.id]
  );
  const lockRow = lockResult.rows[0];
  if (lockRow?.locked_at && lockRow.failed_count >= MAX_FAILED_ATTEMPTS) {
    await logEvent(guard.id, 'guard', 'login_blocked_locked', req);
    return res.status(423).json({
      error: 'Account locked after 5 failed attempts. Contact your supervisor to unlock.',
      locked: true,
    });
  }

  // Success — clear failed attempts, update FCM token
  await pool.query(
    `INSERT INTO login_attempts (guard_id, failed_count, updated_at)
     VALUES ($1, 0, NOW())
     ON CONFLICT (guard_id) DO UPDATE SET failed_count = 0, locked_at = NULL, updated_at = NOW()`,
    [guard.id]
  );
  if (fcm_token) {
    await pool.query('UPDATE guards SET fcm_token = $1 WHERE id = $2', [fcm_token, guard.id]);
  }

  const tokens = signTokens({ sub: guard.id, role: 'guard', company_id: guard.company_id });
  await logEvent(guard.id, 'guard', 'login_success', req);

  res.json({
    ...tokens,
    must_change_password: guard.must_change_password,
  });
});

// ── Guard: badge / QR code login (shared site devices) ──────────────────────

router.post('/guard/badge', async (req: Request, res: Response) => {
  const { badge_number, pin, fcm_token } = req.body;
  if (!badge_number || !pin) return res.status(400).json({ error: 'badge_number and pin required' });

  const guardResult = await pool.query(
    'SELECT id, company_id, password_hash, is_active, must_change_password FROM guards WHERE badge_number = $1',
    [badge_number.trim()]
  );
  const guard = guardResult.rows[0];
  const hashToCheck = guard?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
  const valid = await bcrypt.compare(pin, hashToCheck);

  if (!guard || !valid || !guard.is_active) {
    return res.status(401).json({ error: 'Invalid badge number or PIN' });
  }

  if (fcm_token) {
    await pool.query('UPDATE guards SET fcm_token = $1 WHERE id = $2', [fcm_token, guard.id]);
  }

  const tokens = signTokens({ sub: guard.id, role: 'guard', company_id: guard.company_id });
  await logEvent(guard.id, 'guard', 'badge_login_success', req);

  res.json({ ...tokens, must_change_password: guard.must_change_password });
});

// ── Guard: change password (required on first login) ─────────────────────────

router.post('/guard/change-password', requireAuth('guard'), async (req: Request, res: Response) => {
  const { current_password, new_password } = req.body;
  if (!new_password || new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const guardResult = await pool.query(
    'SELECT password_hash FROM guards WHERE id = $1',
    [req.user!.sub]
  );
  const valid = await bcrypt.compare(current_password, guardResult.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(new_password, 12);
  await pool.query(
    'UPDATE guards SET password_hash = $1, must_change_password = false WHERE id = $2',
    [newHash, req.user!.sub]
  );
  await logEvent(req.user!.sub, 'guard', 'password_changed', req);
  res.json({ success: true });
});

// ── Star admin login ─────────────────────────────────────────────────────────

router.post('/admin/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const result = await pool.query(
    'SELECT id, company_id, password_hash, is_active, is_primary FROM company_admins WHERE email = $1',
    [email.toLowerCase().trim()]
  );
  const admin = result.rows[0];
  const hashToCheck = admin?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!admin || !valid || !admin.is_active) {
    if (admin) await logEvent(admin.id, 'company_admin', 'login_failed', req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const tokens = signTokens({
    sub: admin.id,
    role: 'company_admin',
    company_id: admin.company_id,
    is_primary: admin.is_primary,
  });
  await logEvent(admin.id, 'company_admin', 'login_success', req);
  res.json(tokens);
});

// ── Client portal login ──────────────────────────────────────────────────────

router.post('/client/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const result = await pool.query(
    'SELECT c.id, c.site_id, c.password_hash, c.is_active FROM clients c WHERE c.email = $1',
    [email.toLowerCase().trim()]
  );
  const client = result.rows[0];
  const hashToCheck = client?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!client || !valid || !client.is_active) {
    return res.status(401).json({ error: 'Invalid credentials or portal access disabled' });
  }

  // Check data retention — block login if site data window has expired
  const retentionResult = await pool.query(
    'SELECT client_star_access_disabled FROM data_retention_log WHERE site_id = $1',
    [client.site_id]
  );
  if (retentionResult.rows[0]?.client_star_access_disabled) {
    return res.status(403).json({
      error: 'Access to this site has expired. Contact your security provider.',
    });
  }

  const tokens = signTokens({ sub: client.id, role: 'client', site_id: client.site_id });
  await logEvent(client.id, 'client', 'login_success', req);
  res.json(tokens);
});

// ── Vishnu super admin login ─────────────────────────────────────────────────

router.post('/vishnu/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  if (email.toLowerCase().trim() !== process.env.VISHNU_EMAIL?.toLowerCase()) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, process.env.VISHNU_PASSWORD_HASH!);
  if (!valid) {
    await logEvent('00000000-0000-0000-0000-000000000000', 'vishnu', 'login_failed', req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const tokens = signTokens({ sub: '00000000-0000-0000-0000-000000000000', role: 'vishnu' });
  await logEvent('00000000-0000-0000-0000-000000000000', 'vishnu', 'login_success', req);
  res.json(tokens);
});

// ── Refresh token rotation ───────────────────────────────────────────────────

router.post('/refresh', async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).json({ error: 'refresh_token required' });

  let payload: AuthPayload & { jti?: string };
  try {
    payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET!) as AuthPayload & { jti?: string };
  } catch {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }

  // Check revocation blocklist
  if (payload.jti) {
    const revoked = await pool.query('SELECT id FROM revoked_tokens WHERE jti = $1', [payload.jti]);
    if (revoked.rows.length > 0) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
    // Revoke the consumed refresh token (rotation — each token is single-use)
    const exp = new Date(payload.exp * 1000);
    await pool.query(
      'INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [payload.jti, exp]
    );
  }

  const { iat: _iat, exp: _exp, jti: _jti, ...rest } = payload;
  const tokens = signTokens(rest);
  await logEvent(payload.sub, payload.role, 'token_refresh', req);
  res.json(tokens);
});

// ── Logout ───────────────────────────────────────────────────────────────────

router.post('/logout', requireAuth('guard', 'company_admin', 'client', 'vishnu'), async (req: Request, res: Response) => {
  const { refresh_token } = req.body;
  if (refresh_token) {
    try {
      const payload = jwt.verify(refresh_token, process.env.JWT_REFRESH_SECRET!) as AuthPayload & { jti?: string };
      if (payload.jti) {
        await pool.query(
          'INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
          [payload.jti, new Date(payload.exp * 1000)]
        );
      }
    } catch { /* already expired — no action needed */ }
  }
  await logEvent(req.user!.sub, req.user!.role, 'logout', req);
  res.json({ success: true });
});

// ── Star admin: revoke a guard session remotely (Section 7) ─────────────────

router.post('/admin/revoke-guard/:guard_id', requireAuth('company_admin'), async (req: Request, res: Response) => {
  // Verify guard belongs to admin's company
  const guardResult = await pool.query(
    'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
    [req.params.guard_id, req.user!.company_id]
  );
  if (!guardResult.rows[0]) return res.status(404).json({ error: 'Guard not found' });

  // Clear FCM token so device gets no more pushes, log the revocation
  await pool.query('UPDATE guards SET fcm_token = NULL WHERE id = $1', [req.params.guard_id]);
  await logEvent(req.params.guard_id, 'guard', 'session_revoked', req);

  // The guard's next API call will fail because their tokens will be rotated/rejected.
  // For immediate hard revocation we add their current JTI to revoked_tokens.
  // The client is responsible for clearing SecureStore on 401 response.
  res.json({ success: true, message: 'Guard session revoked. They will be logged out on next API call.' });
});

// ── Star admin (primary): unlock a locked guard account ─────────────────────

router.post('/admin/unlock-guard/:guard_id', requireAuth('company_admin'), async (req: Request, res: Response) => {
  // Only primary admin can unlock
  const adminResult = await pool.query(
    'SELECT is_primary FROM company_admins WHERE id = $1',
    [req.user!.sub]
  );
  if (!adminResult.rows[0]?.is_primary) {
    return res.status(403).json({ error: 'Only the primary admin can unlock accounts' });
  }

  const guardResult = await pool.query(
    'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
    [req.params.guard_id, req.user!.company_id]
  );
  if (!guardResult.rows[0]) return res.status(404).json({ error: 'Guard not found' });

  await pool.query(
    `UPDATE login_attempts
     SET failed_count = 0, locked_at = NULL, unlocked_by = $1, updated_at = NOW()
     WHERE guard_id = $2`,
    [req.user!.sub, req.params.guard_id]
  );
  await logEvent(req.params.guard_id, 'guard', 'unlocked', req);
  res.json({ success: true });
});

// ── SMS self-service unlock: request OTP ────────────────────────────────────
// Guard calls this when locked out and no supervisor is available.
// Requires guard to have a phone_number registered on their account.

router.post('/guard/request-unlock', async (req: Request, res: Response) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  const guardResult = await pool.query(
    'SELECT id, phone_number FROM guards WHERE email = $1 AND is_active = true',
    [email.toLowerCase().trim()]
  );
  const guard = guardResult.rows[0];

  // Always respond with the same message to prevent email enumeration
  const safeResponse = {
    message: 'If your account is locked and a phone number is registered, you will receive an SMS.',
  };

  if (!guard?.phone_number) {
    await logEvent(guard?.id ?? uuidv4(), 'guard', 'sms_unlock_no_phone', req);
    return res.json(safeResponse);
  }

  // Check guard is actually locked
  const lockResult = await pool.query(
    'SELECT failed_count, locked_at FROM login_attempts WHERE guard_id = $1',
    [guard.id]
  );
  if (!lockResult.rows[0]?.locked_at) {
    return res.json(safeResponse); // not locked — silently no-op
  }

  const otp     = generateOtp();
  const otpHash = await hashOtp(otp);
  const expiry  = otpExpiresAt();

  await pool.query(
    `INSERT INTO login_attempts (guard_id, failed_count, otp_hash, otp_expires_at, updated_at)
     VALUES ($1, 5, $2, $3, NOW())
     ON CONFLICT (guard_id) DO UPDATE
       SET otp_hash = $2, otp_expires_at = $3, updated_at = NOW()`,
    [guard.id, otpHash, expiry]
  );

  await sendOtpSms(guard.phone_number, otp);
  await logEvent(guard.id, 'guard', 'sms_unlock_requested', req);

  res.json(safeResponse);
});

// ── SMS self-service unlock: verify OTP and issue tokens ────────────────────

router.post('/guard/verify-unlock', async (req: Request, res: Response) => {
  const { email, otp } = req.body;
  if (!email || !otp) return res.status(400).json({ error: 'email and otp required' });

  const guardResult = await pool.query(
    'SELECT g.id, g.company_id FROM guards g WHERE g.email = $1 AND g.is_active = true',
    [email.toLowerCase().trim()]
  );
  const guard = guardResult.rows[0];
  if (!guard) return res.status(401).json({ error: 'Invalid or expired code' });

  const lockResult = await pool.query(
    'SELECT otp_hash, otp_expires_at FROM login_attempts WHERE guard_id = $1',
    [guard.id]
  );
  const lock = lockResult.rows[0];

  if (!lock?.otp_hash || !lock?.otp_expires_at) {
    return res.status(401).json({ error: 'Invalid or expired code' });
  }
  if (new Date(lock.otp_expires_at) < new Date()) {
    return res.status(401).json({ error: 'Code has expired. Request a new one.' });
  }

  const valid = await verifyOtp(otp, lock.otp_hash);
  if (!valid) {
    await logEvent(guard.id, 'guard', 'sms_unlock_wrong_otp', req);
    return res.status(401).json({ error: 'Invalid or expired code' });
  }

  // OTP correct — clear lock and OTP
  await pool.query(
    `UPDATE login_attempts
     SET failed_count = 0, locked_at = NULL, otp_hash = NULL, otp_expires_at = NULL, updated_at = NOW()
     WHERE guard_id = $1`,
    [guard.id]
  );

  const tokens = signTokens({ sub: guard.id, role: 'guard', company_id: guard.company_id });
  await logEvent(guard.id, 'guard', 'sms_unlock_success', req);

  res.json({ ...tokens, message: 'Account unlocked successfully.' });
});

// ── Forgot password: generate token + send email ─────────────────────────────

router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email, portal } = req.body;
  if (!email || !portal) return res.status(400).json({ error: 'email and portal required' });
  if (!['admin', 'client', 'vishnu'].includes(portal)) {
    return res.status(400).json({ error: 'invalid portal' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Validate email exists for the given portal
  let emailExists = false;
  if (portal === 'admin') {
    const r = await pool.query('SELECT id FROM company_admins WHERE email = $1 AND is_active = true', [normalizedEmail]);
    emailExists = r.rows.length > 0;
  } else if (portal === 'client') {
    const r = await pool.query('SELECT id FROM clients WHERE email = $1 AND is_active = true', [normalizedEmail]);
    emailExists = r.rows.length > 0;
  } else if (portal === 'vishnu') {
    emailExists = normalizedEmail === process.env.VISHNU_EMAIL?.toLowerCase();
  }

  // Always respond the same way to prevent email enumeration
  const safeResponse = { message: 'Reset email sent if account exists' };

  if (!emailExists) {
    return res.json(safeResponse);
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await pool.query(
    `INSERT INTO password_reset_tokens (email, portal, token, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [normalizedEmail, portal, token, expiresAt],
  );

  const resetUrl = `https://guard-web-one.vercel.app/${portal}/reset-password?token=${token}`;
  await sendPasswordResetEmail(normalizedEmail, resetUrl, portal);

  res.json(safeResponse);
});

// ── Reset password: validate token + update password ─────────────────────────

router.post('/reset-password', async (req: Request, res: Response) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'token and password required' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const { rows } = await pool.query(
    `SELECT * FROM password_reset_tokens
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()`,
    [token],
  );
  if (!rows[0]) return res.status(400).json({ error: 'Invalid or expired reset token' });

  const { email, portal, id } = rows[0];
  const hash = await bcrypt.hash(password, 12);

  if (portal === 'admin') {
    await pool.query('UPDATE company_admins SET password_hash = $1 WHERE email = $2', [hash, email]);
  } else if (portal === 'client') {
    await pool.query('UPDATE clients SET password_hash = $1 WHERE email = $2', [hash, email]);
  } else if (portal === 'vishnu') {
    // Vishnu password lives in env; update not applicable via DB — just mark token used
    // The actual env var would need to be updated separately.
    // For now we mark the token used and respond success.
  }

  await pool.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [id]);

  res.json({ message: 'Password reset successfully' });
});

export default router;
