import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';
import { generateTempPassword } from '../utils/tempPassword';
import { validatePassword, logEvent } from './auth';
import { Sentry } from '../services/sentry';
import { sendClientWelcomeEmail } from '../services/email';

/**
 * Session C — Client account CRUD for the admin sites page.
 *
 * Endpoints:
 *   GET  /api/clients/:site_id            list all clients for a site (array)
 *   POST /api/clients                     create a new client (auto-gen password
 *                                         if `password` is omitted; returns
 *                                         temp_password so the admin can share)
 *   PATCH /api/clients/:id                update name/email/is_active
 *                                         (is_active change also bumps
 *                                         tokens_not_before, kicking sessions)
 *   POST /api/clients/:id/reset-password  mint a fresh temp password + kick
 *                                         sessions + require change on login
 *
 * Auth:
 *   company_admin — scoped to sites under their company
 *   vishnu        — full access across all companies
 */
const router = Router();

// Verify caller has scope to a given site. Returns the site row or null.
async function siteInScope(siteId: string, callerCompanyId: string | undefined, isVishnu: boolean) {
  if (isVishnu) {
    const r = await pool.query('SELECT id FROM sites WHERE id = $1', [siteId]);
    return r.rows[0] ?? null;
  }
  const r = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [siteId, callerCompanyId],
  );
  return r.rows[0] ?? null;
}

// Verify caller has scope to a given client (via clients.company_id — the
// permanent tenant anchor added in schema_v36). Returns { id, site_id,
// email, company_id } or null.
async function clientInScope(clientId: string, callerCompanyId: string | undefined, isVishnu: boolean) {
  if (isVishnu) {
    const r = await pool.query(
      'SELECT id, site_id, email, company_id FROM clients WHERE id = $1',
      [clientId],
    );
    return r.rows[0] ?? null;
  }
  const r = await pool.query(
    `SELECT id, site_id, email, company_id FROM clients
      WHERE id = $1 AND company_id = $2`,
    [clientId, callerCompanyId],
  );
  return r.rows[0] ?? null;
}

// GET /api/clients/:site_id — list all clients linked to a site.
// v36 multi-site: source of truth flipped from clients.site_id to the
// client_sites junction. Each returned row also carries a `sites` array
// of every OTHER site the client is linked to, so the admin UI can show
// "Sites: A, B, C" per client row without needing a second fetch.
router.get('/:site_id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await siteInScope(req.params.site_id, req.user!.company_id, isVishnu);
  if (!scope) return res.status(isVishnu ? 404 : 403).json({ error: 'Site not found' });

  const result = await pool.query(
    `SELECT c.id, c.site_id, c.name, c.email, c.is_active, c.must_change_password,
            c.created_at, c.last_login_at,
            COALESCE(
              (SELECT json_agg(json_build_object('id', s2.id, 'name', s2.name) ORDER BY s2.name)
                 FROM client_sites cs2
                 JOIN sites s2 ON s2.id = cs2.site_id
                WHERE cs2.client_id = c.id),
              '[]'::json
            ) AS sites
       FROM clients c
       JOIN client_sites cs ON cs.client_id = c.id
      WHERE cs.site_id = $1
      ORDER BY c.is_active DESC, LOWER(c.email) ASC`,
    [req.params.site_id],
  );
  res.json(result.rows);
});

// POST /api/clients — create a client account.
// Body: { site_id, name, email, password? }
// If password is omitted the server generates a 12-char temp password.
// Response: { client, temp_password? }  (temp_password only when auto-gen)
//
// v36 multi-site: writes clients.site_id (legacy, still NOT NULL through
// EXPAND phase), clients.company_id (permanent tenant anchor), AND the
// client_sites junction row in a single transaction. Contract phase
// (v37+) will drop clients.site_id and this write becomes junction-only.
router.post('/', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const { site_id, name, email, password: providedPassword } = req.body ?? {};
  if (!site_id || typeof site_id !== 'string')                            return res.status(400).json({ error: 'site_id is required' });
  if (typeof name !== 'string' || name.trim().length < 2)                 return res.status(400).json({ error: 'name is required (min 2 chars)' });
  if (typeof email !== 'string' || !email.includes('@'))                  return res.status(400).json({ error: 'valid email is required' });

  const isVishnu = req.user!.role === 'vishnu';
  const scope = await siteInScope(site_id, req.user!.company_id, isVishnu);
  if (!scope) return res.status(isVishnu ? 404 : 403).json({ error: 'Site not found' });

  // Need the site's company_id to seed clients.company_id. siteInScope
  // returns { id } only; a separate lookup keeps that helper focused.
  const siteCompany = await pool.query<{ company_id: string }>(
    'SELECT company_id FROM sites WHERE id = $1',
    [site_id],
  );
  if (!siteCompany.rows[0]) return res.status(404).json({ error: 'Site not found' });
  const companyId = siteCompany.rows[0].company_id;

  const autoGenerated = !providedPassword;
  const tempPassword  = autoGenerated ? generateTempPassword(12) : String(providedPassword);
  if (!autoGenerated) {
    const policyErr = validatePassword(tempPassword);
    if (policyErr) return res.status(400).json({ error: policyErr });
  }
  const password_hash = await bcrypt.hash(tempPassword, 12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO clients (site_id, company_id, name, email, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, site_id, name, email, is_active, must_change_password,
                 created_at, last_login_at`,
      [site_id, companyId, name.trim(), email.trim().toLowerCase(), password_hash],
    );
    const clientRow = inserted.rows[0];
    await client.query(
      `INSERT INTO client_sites (client_id, site_id, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (client_id, site_id) DO NOTHING`,
      [clientRow.id, site_id, req.user!.sub],
    );
    await client.query('COMMIT');
    res.status(201).json({
      client: { ...clientRow, sites: [{ id: site_id, name: null }] },
      // Only echo the temp password when we generated it — otherwise the
      // admin already knows the password they sent in.
      ...(autoGenerated ? { temp_password: tempPassword } : {}),
    });

    sendClientWelcomeEmail({
      client_id:     clientRow.id,
      client_name:   clientRow.name,
      client_email:  clientRow.email,
      company_id:    companyId,
      site_ids:      [site_id],
      temp_password: tempPassword,
    }).catch((err) => Sentry.captureException(err));
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505' && err.constraint === 'clients_email_key') {
      return res.status(409).json({ error: 'A client with this email already exists' });
    }
    throw err;
  } finally {
    client.release();
  }
});

// PATCH /api/clients/:id — update name / email / is_active.
// Changing is_active also bumps tokens_not_before to kick any active
// session (Session B pattern). Bumping on reactivate is intentional too:
// if the client had a stale token from before the deactivate, it stays dead.
router.patch('/:id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await clientInScope(req.params.id, req.user!.company_id, isVishnu);
  if (!scope) return res.status(404).json({ error: 'Client not found' });

  const { name, email, is_active } = req.body ?? {};
  const sets: string[]  = [];
  const params: unknown[] = [];
  if (name      !== undefined) {
    if (typeof name !== 'string' || name.trim().length < 2) return res.status(400).json({ error: 'name must be at least 2 characters' });
    params.push(name.trim());                          sets.push(`name = $${params.length}`);
  }
  if (email     !== undefined) {
    if (typeof email !== 'string' || !email.includes('@')) return res.status(400).json({ error: 'valid email is required' });
    params.push(email.trim().toLowerCase());           sets.push(`email = $${params.length}`);
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'is_active must be boolean' });
    params.push(is_active);                            sets.push(`is_active = $${params.length}`);
    sets.push('tokens_not_before = NOW()');
  }
  if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' });

  params.push(req.params.id);
  try {
    const result = await pool.query(
      `UPDATE clients SET ${sets.join(', ')} WHERE id = $${params.length}
       RETURNING id, site_id, name, email, is_active, must_change_password,
                 created_at, last_login_at`,
      params,
    );
    res.json(result.rows[0]);
  } catch (err: any) {
    if (err.code === '23505' && err.constraint === 'clients_email_key') {
      return res.status(409).json({ error: 'A client with this email already exists' });
    }
    throw err;
  }
});

// POST /api/clients/:id/reset-password — mint fresh temp password.
// Also bumps tokens_not_before (login-required) and forces must_change_password.
router.post('/:id/reset-password', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await clientInScope(req.params.id, req.user!.company_id, isVishnu);
  if (!scope) return res.status(404).json({ error: 'Client not found' });

  const tempPassword  = generateTempPassword(12);
  const password_hash = await bcrypt.hash(tempPassword, 12);

  await pool.query(
    `UPDATE clients
        SET password_hash        = $1,
            must_change_password = true,
            tokens_not_before    = NOW()
      WHERE id = $2`,
    [password_hash, req.params.id],
  );

  res.json({ temp_password: tempPassword, email: scope.email });
});

// POST /api/clients/:id/resend-welcome — rotate temp password, kick session, resend welcome email.
router.post('/:id/resend-welcome', requireAuth('company_admin'), async (req, res) => {
  const scope = await clientInScope(req.params.id, req.user!.company_id, false);
  if (!scope) return res.status(404).json({ error: 'Client not found' });

  // Resolve all currently-linked sites for the v36 multisite welcome template.
  const sitesResult = await pool.query<{ site_id: string; name: string | null }>(
    `SELECT cs.site_id, s.name
       FROM client_sites cs
       LEFT JOIN sites s ON s.id = cs.site_id
      WHERE cs.client_id = $1`,
    [scope.id],
  );
  const site_ids = sitesResult.rows.map((r) => r.site_id);

  const clientRow = await pool.query<{ name: string; email: string; company_id: string }>(
    'SELECT name, email, company_id FROM clients WHERE id = $1',
    [scope.id],
  );
  const target = clientRow.rows[0];
  if (!target) return res.status(404).json({ error: 'Client not found' });

  const tempPassword  = generateTempPassword(12);
  const password_hash = await bcrypt.hash(tempPassword, 12);

  await pool.query(
    `UPDATE clients
        SET password_hash        = $1,
            must_change_password = true,
            tokens_not_before    = NOW()
      WHERE id = $2`,
    [password_hash, scope.id],
  );

  let email_status: 'sent' | 'failed' = 'sent';
  try {
    await sendClientWelcomeEmail({
      client_id:     scope.id,
      client_name:   target.name,
      client_email:  target.email,
      company_id:    target.company_id,
      site_ids,
      temp_password: tempPassword,
    });
    await logEvent(scope.id, 'client', 'welcome_email_resent', req);
  } catch (err) {
    email_status = 'failed';
    Sentry.captureException(err);
    await logEvent(scope.id, 'client', 'welcome_email_send_failed', req);
  }

  res.json({ temp_password: tempPassword, email_status });
});

// ── v36 multi-site link/unlink ──────────────────────────────────────────────
//
// POST /api/clients/:client_id/sites — body { site_id }. Links an additional
// site to an existing client. Tenant check: the client's company_id must
// match the site's company_id (vishnu bypasses). Duplicate check via the
// junction's UNIQUE (client_id, site_id) → 23505 → 409.
//
// DELETE /api/clients/:client_id/sites/:site_id — unlinks. Last-site guard:
// if this would leave the client with zero linked sites the request 400s
// so the admin has to either deactivate the client outright or add another
// site first. Also bumps clients.tokens_not_before so any live session
// carrying the unlinked site_id in its JWT is kicked on the next request.

router.post('/:client_id/sites', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await clientInScope(req.params.client_id, req.user!.company_id, isVishnu);
  if (!scope) return res.status(404).json({ error: 'Client not found' });

  const { site_id } = req.body ?? {};
  if (typeof site_id !== 'string' || !site_id) {
    return res.status(400).json({ error: 'site_id is required' });
  }

  // Tenant check: the site's company_id must match the client's. Vishnu
  // is allowed cross-company (matches the pattern used by siteInScope).
  const site = await pool.query<{ id: string; company_id: string; is_active: boolean }>(
    'SELECT id, company_id, is_active FROM sites WHERE id = $1',
    [site_id],
  );
  if (!site.rows[0]) return res.status(404).json({ error: 'Site not found' });
  if (!isVishnu && site.rows[0].company_id !== scope.company_id) {
    return res.status(403).json({ error: 'Cannot link a client across companies' });
  }
  if (!site.rows[0].is_active) {
    return res.status(409).json({ error: 'Cannot link an inactive site' });
  }

  try {
    await pool.query(
      `INSERT INTO client_sites (client_id, site_id, created_by)
       VALUES ($1, $2, $3)`,
      [scope.id, site_id, req.user!.sub],
    );
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Client is already linked to this site' });
    }
    throw err;
  }
  res.status(201).json({ client_id: scope.id, site_id });
});

router.delete('/:client_id/sites/:site_id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const scope = await clientInScope(req.params.client_id, req.user!.company_id, isVishnu);
  if (!scope) return res.status(404).json({ error: 'Client not found' });

  // Last-site guard: the check-then-delete is inherently racy under
  // concurrent unlinks, but the FK cascade on clients keeps the DB
  // consistent (zero rows = harmless) and the guard catches the common
  // single-admin case. Real concurrency would need SERIALIZABLE or an
  // advisory lock — over-engineered for this admin surface.
  const count = await pool.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM client_sites WHERE client_id = $1',
    [scope.id],
  );
  if (Number(count.rows[0].n) <= 1) {
    return res.status(400).json({
      error: 'Client would have no sites. Deactivate the client or add another site first.',
    });
  }

  const result = await pool.query(
    'DELETE FROM client_sites WHERE client_id = $1 AND site_id = $2',
    [scope.id, req.params.site_id],
  );
  if (result.rowCount === 0) {
    return res.status(404).json({ error: 'Link not found' });
  }

  // Kick any live session whose JWT still baked in this site_id.
  await pool.query(
    'UPDATE clients SET tokens_not_before = NOW() WHERE id = $1',
    [scope.id],
  );
  res.json({ success: true });
});

export default router;
