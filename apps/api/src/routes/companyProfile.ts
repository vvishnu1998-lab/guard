/**
 * Company profile, Phase A (schema_v82). Mounted at /api/admin/company.
 *
 *   GET    /       any active company admin of the caller's company
 *   PATCH  /       the PRIMARY admin only: contact_email, phone, address,
 *                  licence_number, website (services/companyProfile.ts)
 *   POST   /logo   the PRIMARY admin only: one PNG or JPEG in field `file`,
 *                  at most 2 MiB, longest side 256..2048 px
 *   DELETE /logo   the PRIMARY admin only
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
 * ── LOGO OBJECTS ─────────────────────────────────────────────────────────
 *
 * Key company-logos/{company_id}/{uuid}.{png|jpg}; the type comes from the
 * magic bytes, never the file name or declared type. logo_url stores the FULL
 * URL, because deleteS3Object (services/s3.ts) skips a bare key.
 *
 * Ordering, the nightlyPurge.ts rule that an orphaned object is recoverable
 * and a dangling pointer is not:
 *   1. the new object is PUT before the transaction;
 *   2. if the transaction does not commit, the new object is deleted again;
 *   3. the previous object is deleted only AFTER the commit. A failed delete
 *      is logged and sent to Sentry, and never fails the request.
 * If COMMIT was sent but its outcome is unknown, nothing is deleted.
 *
 * ── ERRORS ───────────────────────────────────────────────────────────────
 *
 * { code, error: copy, message: copy } via errorBody(): the
 * PATCH /api/shifts/:id/cancel shape for web-only routes. multer's errors are
 * caught here and given codes; there is no global multer handler.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { deleteS3Object, uploadBufferToS3, urlOrPresign } from '../services/s3';
import { Sentry } from '../services/sentry';
import { detectImageKind, readImageDimensions } from '../services/imageDimensions';
import {
  errorBody,
  parseProfilePatch,
  LOGO_MAX_BYTES,
  LOGO_MAX_SIDE,
  LOGO_MIN_SIDE,
  type ProfileField,
} from '../services/companyProfile';

const router = Router();
// +1: busboy 1.6 (under multer) fires its size limit when the byte count
// REACHES fileSize (lib/types/multipart.js `fileSize === fileSizeLimit`), so
// `fileSize: N` accepts at most N - 1 bytes. This accepts exactly 2 MiB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: LOGO_MAX_BYTES + 1, files: 1 } });

const notPrimary = () =>
  errorBody('NOT_PRIMARY_ADMIN', 'Only the primary admin can change the company profile.');

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
    return { ok: false, status: 403, body: notPrimary() };
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

/**
 * POST /logo refuses a non-primary caller BEFORE multer reads the body, so a
 * secondary admin's file is never buffered or sent to S3. The transaction
 * re-checks under lock; this read only saves the work.
 */
async function refuseNonPrimary(req: Request, res: Response, next: NextFunction): Promise<void> {
  const admin = await pool.query<{ is_primary: boolean }>(
    'SELECT is_primary FROM company_admins WHERE id = $1 AND company_id = $2 AND is_active',
    [req.user!.sub, req.user!.company_id],
  );
  if (!admin.rows[0]?.is_primary) {
    res.status(403).json(notPrimary());
    return;
  }
  next();
}

/** multer for one file in field `file`, with its errors answered here as codes. */
function receiveLogo(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json(errorBody('LOGO_TOO_LARGE', 'The logo must be 2 MB or smaller.', { max_bytes: LOGO_MAX_BYTES }));
        return;
      }
      res.status(400).json(errorBody('INVALID_UPLOAD', 'Upload one image file in the form field named "file".'));
      return;
    }
    next(err);
  });
}

/**
 * Deletes a logo object nothing points at any more. Never throws: by the time
 * this runs the database is already right, so a failure leaves an orphan,
 * which is storage cost. It is logged and sent to Sentry so it is not silent.
 */
async function discardLogoObject(url: string, reason: 'replaced' | 'removed' | 'not_committed'): Promise<void> {
  const outcome = await deleteS3Object(url).catch((err: unknown) => ({
    status: 'failed' as const,
    detail: err instanceof Error ? err.message : String(err),
  }));
  if (outcome.status === 'deleted') return;
  console.error(`[companyProfile] logo object not deleted (${reason})`, { url, outcome });
  Sentry.captureMessage('company_logo_delete_failed', {
    level: 'warning',
    tags: { flow: 'company_profile', reason },
    extra: { url, outcome },
  });
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

// POST /api/admin/company/logo — multipart, one file in field `file`
router.post('/logo', requireAuth('company_admin'), refuseNonPrimary, receiveLogo, async (req, res) => {
  const companyId = req.user!.company_id!;
  const adminId = req.user!.sub;
  if (!req.file) {
    return res.status(400).json(errorBody('LOGO_FILE_REQUIRED', 'Choose a PNG or JPEG file to upload.'));
  }

  const buf = req.file.buffer;
  const dims = readImageDimensions(buf);
  if (!dims) {
    return detectImageKind(buf)
      ? res.status(400).json(errorBody('LOGO_UNREADABLE', 'That image could not be read. Export it again as PNG or JPEG and retry.'))
      : res.status(400).json(errorBody('LOGO_UNSUPPORTED_TYPE', 'The logo must be a PNG or JPEG image.'));
  }
  const longest = Math.max(dims.width, dims.height);
  if (longest < LOGO_MIN_SIDE || longest > LOGO_MAX_SIDE) {
    return res.status(400).json(errorBody(
      'LOGO_DIMENSIONS_OUT_OF_RANGE',
      `The logo's longest side must be ${LOGO_MIN_SIDE} to ${LOGO_MAX_SIDE} pixels. This image is ${dims.width} × ${dims.height}.`,
      { width: dims.width, height: dims.height, min_side: LOGO_MIN_SIDE, max_side: LOGO_MAX_SIDE },
    ));
  }

  const ext = dims.kind === 'png' ? 'png' : 'jpg';
  const key = `company-logos/${companyId}/${uuidv4()}.${ext}`;
  let url: string;
  try {
    url = await uploadBufferToS3(key, buf, dims.kind === 'png' ? 'image/png' : 'image/jpeg');
  } catch (err) {
    console.error('[companyProfile] logo upload to S3 failed', { key, message: err instanceof Error ? err.message : String(err) });
    Sentry.captureException(err, { tags: { flow: 'company_profile', step: 'logo_put' } });
    return res.status(502).json(errorBody('LOGO_UPLOAD_FAILED', 'The logo could not be saved. Try again.'));
  }

  const client = await pool.connect();
  let row: CompanyRow;
  let previous: string | null;
  let commitSent = false;
  try {
    await client.query('BEGIN');
    const gate = await lockForPrimaryWrite(client, companyId, adminId);
    if (!gate.ok) {
      await client.query('ROLLBACK');
      await discardLogoObject(url, 'not_committed');
      return res.status(gate.status).json(gate.body);
    }
    previous = gate.company.logo_url;
    const updated = await client.query<CompanyRow>(
      `UPDATE companies SET logo_url = $2, logo_updated_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING ${COMPANY_COLUMNS}`,
      [companyId, url],
    );
    await insertAudit(client, companyId, adminId, [{ field: 'logo_url', oldValue: previous, newValue: url }]);
    commitSent = true;
    await client.query('COMMIT');
    row = updated.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
    // Before COMMIT nothing points at the new object. After it was sent, the
    // row may point at it, so it stays.
    if (!commitSent) await discardLogoObject(url, 'not_committed');
    throw err;
  } finally {
    client.release();
  }

  if (previous && previous !== url) await discardLogoObject(previous, 'replaced');
  res.json(await profileBody(row, true));
});

// DELETE /api/admin/company/logo — idempotent: no logo is a 200 with removed: false
router.delete('/logo', requireAuth('company_admin'), async (req, res) => {
  const companyId = req.user!.company_id!;
  const adminId = req.user!.sub;
  const client = await pool.connect();
  let row: CompanyRow;
  let previous: string | null;
  try {
    await client.query('BEGIN');
    const gate = await lockForPrimaryWrite(client, companyId, adminId);
    if (!gate.ok) {
      await client.query('ROLLBACK');
      return res.status(gate.status).json(gate.body);
    }
    previous = gate.company.logo_url;
    if (!previous) {
      await client.query('ROLLBACK');
      row = gate.company;
    } else {
      const updated = await client.query<CompanyRow>(
        `UPDATE companies SET logo_url = NULL, logo_updated_at = NOW(), updated_at = NOW()
          WHERE id = $1 RETURNING ${COMPANY_COLUMNS}`,
        [companyId],
      );
      await insertAudit(client, companyId, adminId, [{ field: 'logo_url', oldValue: previous, newValue: null }]);
      await client.query('COMMIT');
      row = updated.rows[0];
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { /* connection already broken */ });
    throw err;
  } finally {
    client.release();
  }

  if (previous) await discardLogoObject(previous, 'removed');
  res.json({ ...(await profileBody(row, true)), removed: previous !== null });
});

export default router;
