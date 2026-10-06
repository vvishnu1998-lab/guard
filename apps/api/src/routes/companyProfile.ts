/**
 * Company profile, Phase A (schema_v82). Mounted at /api/admin/company.
 *
 *   GET   /   any active company admin of the caller's company
 *   PATCH /   the PRIMARY admin only: contact_email, phone, address,
 *             licence_number, website (services/companyProfile.ts)
 *
 * ── PRIMARY IS RE-READ FROM THE DATABASE ON EVERY WRITE ──────────────────
 *
 * Inside the write's own transaction, with the company row locked FOR UPDATE
 * and the admin row FOR SHARE, so a primary transfer cannot land between the
 * check and the write. Never from the JWT: is_primary in the token is copied
 * forward on refresh (auth.ts) and goes stale after a transfer, which is why
 * requirePrimaryAdmin() is not used here. Same source as admin.ts's
 * /company-admins routes and auth.ts's unlock-guard.
 *
 * ── name ─────────────────────────────────────────────────────────────────
 *
 * The company name stays super-admin-only (PATCH /api/admin/companies/:id). A
 * PATCH here that carries `name` is refused with NAME_NOT_EDITABLE.
 *
 * ── AUDIT ────────────────────────────────────────────────────────────────
 *
 * One company_profile_audit row per changed field, written in the same
 * transaction as the UPDATE, which also sets updated_at. A PATCH that changes
 * nothing writes nothing, as in sites.ts's audited edits.
 *
 * ── ERRORS ───────────────────────────────────────────────────────────────
 *
 * { code, error: copy, message: copy } via errorBody(): the
 * PATCH /api/shifts/:id/cancel shape for web-only routes.
 */
import { Router } from 'express';
import type { PoolClient } from 'pg';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { urlOrPresign } from '../services/s3';
import {
  errorBody,
  parseProfilePatch,
  type ProfileField,
} from '../services/companyProfile';

const router = Router();

interface CompanyRow {
  id: string;
  name: string;
  contact_email: string | null;
  phone: string | null;
  address: string | null;
  licence_number: string | null;
  website: string | null;
  logo_url: string | null;
  logo_updated_at: Date | null;
  updated_at: Date | null;
}

const COMPANY_COLUMNS =
  'id, name, contact_email, phone, address, licence_number, website, logo_url, logo_updated_at, updated_at';

type AuditField = ProfileField | 'logo_url';
interface AuditEntry { field: AuditField; oldValue: string | null; newValue: string | null }

/** The response for every route here. logo_url is a fresh presigned GET URL, never the stored one. */
async function profileBody(row: CompanyRow, isPrimary: boolean) {
  return {
    id: row.id,
    name: row.name,
    contact_email: row.contact_email,
    phone: row.phone,
    address: row.address,
    licence_number: row.licence_number,
    website: row.website,
    logo_url: await urlOrPresign(row.logo_url),
    logo_updated_at: row.logo_updated_at,
    updated_at: row.updated_at,
    is_primary: isPrimary,
  };
}

/**
 * Inside `client`'s open transaction: lock the company row, then re-read the
 * caller's primary flag. Returns the locked row, or the response to send.
 */
async function lockForPrimaryWrite(
  client: PoolClient,
  companyId: string,
  adminId: string,
): Promise<{ ok: true; company: CompanyRow } | { ok: false; status: number; body: Record<string, unknown> }> {
  const company = await client.query<CompanyRow>(
    `SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = $1 FOR UPDATE`,
    [companyId],
  );
  if (!company.rows[0]) {
    return { ok: false, status: 404, body: errorBody('COMPANY_NOT_FOUND', 'Company not found.') };
  }
  const admin = await client.query<{ is_primary: boolean }>(
    `SELECT is_primary FROM company_admins
      WHERE id = $1 AND company_id = $2 AND is_active
      FOR SHARE`,
    [adminId, companyId],
  );
  if (!admin.rows[0]?.is_primary) {
    return {
      ok: false,
      status: 403,
      body: errorBody('NOT_PRIMARY_ADMIN', 'Only the primary admin can change the company profile.'),
    };
  }
  return { ok: true, company: company.rows[0] };
}

/** One row per entry, in one statement, inside the caller's transaction. */
async function insertAudit(
  client: PoolClient,
  companyId: string,
  adminId: string,
  entries: AuditEntry[],
): Promise<void> {
  const params: unknown[] = [companyId, adminId];
  const tuples = entries.map((e) => {
    params.push(e.field, e.oldValue, e.newValue);
    const n = params.length;
    return `($1, $2, $${n - 2}, $${n - 1}, $${n})`;
  });
  await client.query(
    `INSERT INTO company_profile_audit (company_id, actor_admin_id, field, old_value, new_value)
     VALUES ${tuples.join(', ')}`,
    params,
  );
}

// GET /api/admin/company
router.get('/', requireAuth('company_admin'), async (req, res) => {
  const companyId = req.user!.company_id!;
  const [company, admin] = await Promise.all([
    pool.query<CompanyRow>(`SELECT ${COMPANY_COLUMNS} FROM companies WHERE id = $1`, [companyId]),
    pool.query<{ is_primary: boolean }>(
      'SELECT is_primary FROM company_admins WHERE id = $1 AND company_id = $2',
      [req.user!.sub, companyId],
    ),
  ]);
  if (!company.rows[0]) return res.status(404).json(errorBody('COMPANY_NOT_FOUND', 'Company not found.'));
  res.json(await profileBody(company.rows[0], admin.rows[0]?.is_primary === true));
});

// PATCH /api/admin/company
router.patch('/', requireAuth('company_admin'), async (req, res) => {
  const companyId = req.user!.company_id!;
  const adminId = req.user!.sub;
  // Validated before the transaction, answered after the primary check, so a
  // non-primary caller gets 403 whatever the body holds.
  const parsed = parseProfilePatch(req.body);

  const client = await pool.connect();
  let row: CompanyRow;
  let changed: ProfileField[] = [];
  try {
    await client.query('BEGIN');
    const gate = await lockForPrimaryWrite(client, companyId, adminId);
    if (!gate.ok) {
      await client.query('ROLLBACK');
      return res.status(gate.status).json(gate.body);
    }
    if (!parsed.ok) {
      await client.query('ROLLBACK');
      return res.status(400).json(parsed.body);
    }

    const before = gate.company;
    const values = parsed.values;
    changed = (Object.keys(values) as ProfileField[]).filter((f) => before[f] !== values[f]);
    if (changed.length === 0) {
      await client.query('ROLLBACK');
      row = before;
    } else {
      // Column names come from PROFILE_FIELDS via parseProfilePatch, never from the request.
      const sets = changed.map((f, i) => `${f} = $${i + 2}`).join(', ');
      const updated = await client.query<CompanyRow>(
        `UPDATE companies SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING ${COMPANY_COLUMNS}`,
        [companyId, ...changed.map((f) => values[f])],
      );
      await insertAudit(client, companyId, adminId, changed.map((f) => ({
        field: f, oldValue: before[f], newValue: values[f] ?? null,
      })));
      await client.query('COMMIT');
      row = updated.rows[0];
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
    throw err;
  } finally {
    client.release();
  }

  res.json({ ...(await profileBody(row, true)), changed });
});

export default router;
