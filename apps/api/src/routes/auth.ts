import { Router, Request, Response } from 'express';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AuthPayload, requireAuth } from '../middleware/auth';
import { sendTempPasswordEmail } from '../services/email';

const router = Router();

const MAX_FAILED_ATTEMPTS = 5;
const ACCESS_TOKEN_TTL  = '8h';   // web sessions; mobile app refreshes automatically
const REFRESH_TOKEN_TTL = '30d';

// Password policy: 6–8 characters/digits, alphanumeric.
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 8;
function validatePassword(p: unknown): string | null {
  if (typeof p !== 'string') return 'Password is required';
  if (p.length < PASSWORD_MIN || p.length > PASSWORD_MAX) {
    return `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`;
  }
  return null;
}

// Generate a random 8-char alphanumeric temporary password.
const TEMP_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
function generateTempPassword(): string {
  let out = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}

// ── Token helpers ────────────────────────────────────────────────────────────

function signTokens(payload: Omit<AuthPayload, 'iat' | 'exp' | 'jti'>) {
  const accessJti  = uuidv4();
  const refreshJti = uuidv4();
  const access  = jwt.sign({ ...payload, jti: accessJti },  process.env.JWT_SECRET!,         { expiresIn: ACCESS_TOKEN_TTL  });
  const refresh = jwt.sign({ ...payload, jti: refreshJti }, process.env.JWT_REFRESH_SECRET!, { expiresIn: REFRESH_TOKEN_TTL });
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
  ).catch(() => {});
}

// ── Guard: email + password login ────────────────────────────────────────────

router.post('/guard/login', async (req: Request, res: Response) => {
  const { email, password, fcm_token } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const guardResult = await pool.query(
    `SELECT g.id, g.company_id, g.password_hash, g.is_active, g.must_change_password,
            c.is_active AS company_active,
            bool_or(s.is_active) AS any_site_active
     FROM guards g
     JOIN companies c ON c.id = g.company_id
     LEFT JOIN guard_site_assignments gsa ON gsa.guard_id = g.id
       AND (gsa.assigned_until IS NULL OR gsa.assigned_until >= CURRENT_DATE)
     LEFT JOIN sites s ON s.id = gsa.site_id
     WHERE g.email = $1
     GROUP BY g.id, g.company_id, g.password_hash, g.is_active, g.must_change_password, c.is_active`,
    [email.toLowerCase().trim()]
  );
  const guard = guardResult.rows[0];

  const hashToCheck = guard?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!guard || !valid) {
    if (guard) {
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

  if (!guard.company_active) {
    return res.status(403).json({ error: 'Your company account has been deactivated. Please contact your administrator.' });
  }

  if (guard.any_site_active === false) {
    return res.status(403).json({ error: 'Your assigned site has been deactivated. Please contact your administrator.' });
  }

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

// ── Guard: change password (required on first login / after forgot-password) ─

router.post('/guard/change-password', requireAuth('guard'), async (req: Request, res: Response) => {
  const { current_password, new_password } = req.body;
  const policyErr = validatePassword(new_password);
  if (policyErr) return res.status(400).json({ error: policyErr });

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
    `SELECT ca.id, ca.company_id, ca.password_hash, ca.is_active, ca.is_primary, ca.must_change_password,
            c.is_active AS company_active
     FROM company_admins ca
     JOIN companies c ON c.id = ca.company_id
     WHERE ca.email = $1`,
    [email.toLowerCase().trim()]
  );
  const admin = result.rows[0];
  const hashToCheck = admin?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!admin || !valid || !admin.is_active) {
    if (admin) await logEvent(admin.id, 'company_admin', 'login_failed', req);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!admin.company_active) {
    return res.status(403).json({ error: 'Your company account has been deactivated. Please contact your platform administrator.' });
  }

  const tokens = signTokens({
    sub: admin.id,
    role: 'company_admin',
    company_id: admin.company_id,
    is_primary: admin.is_primary,
  });
  await logEvent(admin.id, 'company_admin', 'login_success', req);
  res.json({ ...tokens, must_change_password: admin.must_change_password });
});

// ── Star admin: change password ──────────────────────────────────────────────

router.post('/admin/change-password', requireAuth('company_admin'), async (req: Request, res: Response) => {
  const { current_password, new_password } = req.body;
  const policyErr = validatePassword(new_password);
  if (policyErr) return res.status(400).json({ error: policyErr });

  const adminResult = await pool.query(
    'SELECT password_hash FROM company_admins WHERE id = $1',
    [req.user!.sub]
  );
  if (!adminResult.rows[0]) return res.status(404).json({ error: 'Admin not found' });
  const valid = await bcrypt.compare(current_password, adminResult.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(new_password, 12);
  await pool.query(
    'UPDATE company_admins SET password_hash = $1, must_change_password = false WHERE id = $2',
    [newHash, req.user!.sub]
  );
  await logEvent(req.user!.sub, 'company_admin', 'password_changed', req);
  res.json({ success: true });
});

// ── Client portal login ──────────────────────────────────────────────────────

router.post('/client/login', async (req: Request, res: Response) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const result = await pool.query(
    `SELECT cl.id, cl.site_id, cl.password_hash, cl.is_active, cl.must_change_password,
            co.is_active AS company_active,
            s.is_active AS site_active
     FROM clients cl
     JOIN sites s ON s.id = cl.site_id
     JOIN companies co ON co.id = s.company_id
     WHERE cl.email = $1`,
    [email.toLowerCase().trim()]
  );
  const client = result.rows[0];
  const hashToCheck = client?.password_hash ?? '$2b$12$invalidhashpadding000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hashToCheck);

  if (!client || !valid || !client.is_active) {
    return res.status(401).json({ error: 'Invalid credentials or portal access disabled' });
  }

  if (!client.company_active) {
    return res.status(403).json({ error: 'Your company account has been deactivated. Please contact your administrator.' });
  }

  if (client.site_active === false) {
    return res.status(403).json({ error: 'Your site access has been deactivated. Please contact your administrator.' });
  }

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
  res.json({ ...tokens, must_change_password: client.must_change_password });
});

// ── Client portal: change password ───────────────────────────────────────────

router.post('/client/change-password', requireAuth('client'), async (req: Request, res: Response) => {
  const { current_password, new_password } = req.body;
  const policyErr = validatePassword(new_password);
  if (policyErr) return res.status(400).json({ error: policyErr });

  const clientResult = await pool.query(
    'SELECT password_hash FROM clients WHERE id = $1',
    [req.user!.sub]
  );
  if (!clientResult.rows[0]) return res.status(404).json({ error: 'Client not found' });
  const valid = await bcrypt.compare(current_password, clientResult.rows[0].password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const newHash = await bcrypt.hash(new_password, 12);
  await pool.query(
    'UPDATE clients SET password_hash = $1, must_change_password = false WHERE id = $2',
    [newHash, req.user!.sub]
  );
  await logEvent(req.user!.sub, 'client', 'password_changed', req);
  res.json({ success: true });
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

  if (payload.jti) {
    const revoked = await pool.query('SELECT id FROM revoked_tokens WHERE jti = $1', [payload.jti]);
    if (revoked.rows.length > 0) {
      return res.status(401).json({ error: 'Token has been revoked' });
    }
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
  if (req.user?.jti) {
    await pool.query(
      'INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.jti, new Date(req.user.exp * 1000)]
    ).catch(() => {});
  }

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
    } catch {}
  }
  await logEvent(req.user!.sub, req.user!.role, 'logout', req);
  res.json({ success: true });
});

// ── Star admin: revoke a guard session remotely ─────────────────────────────

router.post('/admin/revoke-guard/:guard_id', requireAuth('company_admin'), async (req: Request, res: Response) => {
  const guardResult = await pool.query(
    'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
    [req.params.guard_id, req.user!.company_id]
  );
  if (!guardResult.rows[0]) return res.status(404).json({ error: 'Guard not found' });

  await pool.query(
    'UPDATE guards SET tokens_not_before = NOW(), fcm_token = NULL WHERE id = $1',
    [req.params.guard_id]
  );
  await logEvent(req.params.guard_id, 'guard', 'session_revoked', req);

  res.json({
    success: true,
    message: 'Guard sessions revoked. All active tokens for this guard are invalid as of now.',
  });
});

// ── Star admin (primary): unlock a locked guard account ─────────────────────

router.post('/admin/unlock-guard/:guard_id', requireAuth('company_admin'), async (req: Request, res: Response) => {
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

// ── Forgot password: email a temporary 8-char password ──────────────────────
// User enters their email; if it matches an account in the named portal,
// generate a temp password, hash it, set must_change_password=true, and email
// the plaintext to the user. On next login, the frontend forces a change
// before any route is accessible. Same success message regardless of whether
// the email exists (anti-enumeration).

router.post('/forgot-password', async (req: Request, res: Response) => {
  const { email, portal } = req.body;
  if (!email || !portal) return res.status(400).json({ error: 'email and portal required' });
  if (!['admin', 'client', 'guard', 'vishnu'].includes(portal)) {
    return res.status(400).json({ error: 'invalid portal' });
  }

  const normalizedEmail = email.toLowerCase().trim();
  const safeResponse = { message: 'If that email is registered, a temporary password has been sent.' };

  // Vishnu super-admin password lives in env, not DB — no temp-password flow.
  // Silently return the safe response to avoid enumeration.
  if (portal === 'vishnu') return res.json(safeResponse);

  // Look up the user in the right table
  let userId: string | null = null;
  let table: 'company_admins' | 'clients' | 'guards' | null = null;
  if (portal === 'admin') {
    const r = await pool.query(
      `SELECT ca.id FROM company_admins ca
       JOIN companies c ON c.id = ca.company_id
       WHERE ca.email = $1 AND ca.is_active = true AND c.is_active = true`,
      [normalizedEmail]
    );
    if (r.rows[0]) { userId = r.rows[0].id; table = 'company_admins'; }
  } else if (portal === 'client') {
    const r = await pool.query(
      `SELECT cl.id FROM clients cl
       JOIN sites s ON s.id = cl.site_id
       JOIN companies co ON co.id = s.company_id
       WHERE cl.email = $1 AND cl.is_active = true AND co.is_active = true`,
      [normalizedEmail]
    );
    if (r.rows[0]) { userId = r.rows[0].id; table = 'clients'; }
  } else if (portal === 'guard') {
    const r = await pool.query(
      `SELECT g.id FROM guards g
       JOIN companies c ON c.id = g.company_id
       WHERE g.email = $1 AND g.is_active = true AND c.is_active = true`,
      [normalizedEmail]
    );
    if (r.rows[0]) { userId = r.rows[0].id; table = 'guards'; }
  }

  if (!userId || !table) return res.json(safeResponse);

  const tempPassword = generateTempPassword();
  const hash = await bcrypt.hash(tempPassword, 12);

  await pool.query(
    `UPDATE ${table} SET password_hash = $1, must_change_password = true WHERE id = $2`,
    [hash, userId]
  );

  // For guards: also clear any failed-attempt lock so the temp can be used.
  if (table === 'guards') {
    await pool.query(
      `UPDATE login_attempts SET failed_count = 0, locked_at = NULL, updated_at = NOW() WHERE guard_id = $1`,
      [userId]
    ).catch(() => {});
  }

  await sendTempPasswordEmail(normalizedEmail, tempPassword, portal as 'admin' | 'client' | 'guard');
  await logEvent(userId, portal === 'admin' ? 'company_admin' : portal === 'client' ? 'client' : 'guard', 'password_reset_emailed', req);

  res.json(safeResponse);
});

export default router;
