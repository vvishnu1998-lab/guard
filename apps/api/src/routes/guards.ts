import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';
import { validatePassword } from './auth';
import { getAssignedSitesForGuard, writeAssignmentAudit } from '../services/guardAssignments';
import { pacificTodayStr, isPastPacificDateString } from '../services/pacificDate';

const router = Router();

const YYYY_MM_DD = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/guards/me — guard's own profile (used by mobile profile tab)
router.get('/me', requireAuth('guard'), async (req, res) => {
  const result = await pool.query(
    `SELECT g.id, g.name, g.email, g.badge_number, g.created_at,
            co.name as company_name
     FROM guards g
     JOIN companies co ON co.id = g.company_id
     WHERE g.id = $1`,
    [req.user!.sub]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Guard not found' });
  res.json(result.rows[0]);
});

router.get('/', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  // company_name is included on every row so the admin UI can disambiguate
  // when the result set spans multiple companies (Vishnu view). The frontend
  // only surfaces the label when Set<company_name>.size > 1, so single-tenant
  // (company_admin) views stay visually unchanged.
  const result = await pool.query(
    `SELECT g.id, g.name, g.email, g.badge_number, g.is_active, g.created_at,
            co.name AS company_name,
            array_agg(json_build_object(
              'id', gsa.id,
              'site_id', gsa.site_id, 'site_name', s.name,
              'site_is_active', s.is_active,
              'assigned_from', gsa.assigned_from, 'assigned_until', gsa.assigned_until))
              FILTER (WHERE gsa.id IS NOT NULL) as assignments
     FROM guards g
     JOIN companies co ON co.id = g.company_id
     LEFT JOIN guard_site_assignments gsa ON gsa.guard_id = g.id
     LEFT JOIN sites s ON s.id = gsa.site_id
     ${isVishnu ? '' : 'WHERE g.company_id = $1'}
     GROUP BY g.id, co.name ORDER BY g.name`,
    isVishnu ? [] : [req.user!.company_id]
  );
  res.json(result.rows);
});

router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { name, email, badge_number, temp_password } = req.body;

  // Validate required fields
  if (!name?.trim())         return res.status(400).json({ error: 'Guard name is required' });
  if (!email?.trim())        return res.status(400).json({ error: 'Email is required' });
  if (!badge_number?.trim()) return res.status(400).json({ error: 'Badge number is required' });
  if (!temp_password)        return res.status(400).json({ error: 'Temporary password is required' });
  // Forced rotation on first login is wired via guards.must_change_password DEFAULT true.
  const policyErr = validatePassword(temp_password);
  if (policyErr) return res.status(400).json({ error: policyErr });

  try {
    const password_hash = await bcrypt.hash(temp_password, 12);
    const result = await pool.query(
      `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, badge_number, is_active, created_at`,
      [req.user!.company_id, name.trim(), email.trim().toLowerCase(), password_hash, badge_number.trim()]
    );
    res.status(201).json(result.rows[0]);
  } catch (err: any) {
    // PostgreSQL unique_violation = error code 23505
    if (err.code === '23505' && err.constraint?.includes('email')) {
      return res.status(409).json({ error: 'A guard with this email already exists' });
    }
    if (err.code === '23505' && err.constraint?.includes('badge')) {
      return res.status(409).json({ error: 'A guard with this badge number already exists' });
    }
    console.error('[POST /api/guards] Error:', err);
    res.status(500).json({ error: err.message ?? 'Failed to create guard' });
  }
});

router.patch('/:id/deactivate', requireAuth('company_admin'), async (req, res) => {
  await pool.query(
    'UPDATE guards SET is_active = false WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  res.json({ success: true });
});

router.patch('/:id/reactivate', requireAuth('company_admin'), async (req, res) => {
  const result = await pool.query(
    'UPDATE guards SET is_active = true WHERE id = $1 AND company_id = $2 RETURNING id, name, email, is_active',
    [req.params.id, req.user!.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Guard not found' });
  res.json(result.rows[0]);
});

router.post('/:id/assign', requireAuth('company_admin'), async (req, res) => {
  const { site_id, assigned_from, assigned_until } = req.body;

  // Bycatch from Phase A audit: tenant-scope the GUARD too (the prior
  // version only verified site_id was in caller's company, leaving a
  // company_admin able to assign their site to a guard owned by a
  // different company).
  const guardCheck = await pool.query(
    'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  if (!guardCheck.rows[0]) return res.status(403).json({ error: 'Guard not found' });

  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  // Phase B — write the assign + audit row in one transaction so a partial
  // failure can't leave a row without history.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from, assigned_until)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, site_id, assigned_from, assigned_until || null]
    );
    const row = result.rows[0];
    await writeAssignmentAudit(client, {
      assignmentId: row.id,
      action: 'guard_assignment_created',
      changedBy: req.user!.sub,
      before: null,
      after: row,
    });
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    // uq_guard_site_active: (guard_id, site_id, assigned_from)
    if (err?.code === '23505') {
      return res.status(409).json({ error: 'Assignment with this start date already exists.' });
    }
    console.error('[POST /api/guards/:id/assign] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to assign guard' });
  } finally {
    client.release();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Phase B — assignment edit / remove / impact endpoints.
//
// All three are scoped under :guardId so the tenant check is uniform: the
// guard must belong to the caller's company (vishnu has no company scope
// and can touch any). The assignment id is then matched against (id,
// guard_id) so an admin can't operate on another guard's row by guessing
// UUIDs.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Tenant gate shared by the three :guardId/assignments/* endpoints.
 * Returns null on success, otherwise the (status, body) tuple to send.
 */
async function guardBelongsToCaller(
  req: import('express').Request,
): Promise<{ status: number; body: { error: string } } | null> {
  if (req.user!.role === 'vishnu') return null; // vishnu has no company scope
  const r = await pool.query(
    'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
    [req.params.guardId, req.user!.company_id],
  );
  if (!r.rows[0]) return { status: 403, body: { error: 'Guard not found' } };
  return null;
}

// PATCH /api/guards/:guardId/assignments/:id
router.patch('/:guardId/assignments/:id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const tenantErr = await guardBelongsToCaller(req);
  if (tenantErr) return res.status(tenantErr.status).json(tenantErr.body);

  const { assigned_until } = req.body as { assigned_until?: string | null };
  // Validate the incoming value's shape but defer "no past dates" /
  // "no inverted window" to the post-load checks (they need assigned_from).
  if (assigned_until !== null && assigned_until !== undefined) {
    if (typeof assigned_until !== 'string' || !YYYY_MM_DD.test(assigned_until)) {
      return res.status(400).json({ error: 'assigned_until must be YYYY-MM-DD or null' });
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowRes = await client.query(
      `SELECT * FROM guard_site_assignments
        WHERE id = $1 AND guard_id = $2
        FOR UPDATE`,
      [req.params.id, req.params.guardId],
    );
    if (!rowRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const before = rowRes.rows[0];

    // The PATCH body either supplies assigned_until or doesn't. Treat
    // "undefined" the same as "no-op" (current value preserved). Use
    // hasOwnProperty so we can distinguish null from missing — null means
    // "reopen the window."
    const nextUntil = Object.prototype.hasOwnProperty.call(req.body, 'assigned_until')
      ? (assigned_until ?? null)
      : before.assigned_until;

    if (nextUntil !== null) {
      // YYYY-MM-DD comparison vs the row's assigned_from. pg deserialises
      // a DATE column to a JS Date at UTC midnight — Date.toString() then
      // emits "Wed Jun 11 2026 …" which corrupts a lexicographic
      // comparison with a YYYY-MM-DD string ('2' < 'W' so any future date
      // would wrongly compare as "before" assigned_from). Normalize the
      // before-value through toISOString.
      const fromStr = before.assigned_from instanceof Date
        ? before.assigned_from.toISOString().slice(0, 10)
        : String(before.assigned_from).slice(0, 10);
      if (nextUntil < fromStr) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'assigned_until cannot precede assigned_from.' });
      }
      if (isPastPacificDateString(nextUntil)) {
        await client.query('ROLLBACK');
        return res.status(422).json({ error: 'assigned_until cannot be in the past.' });
      }
    }

    const updateRes = await client.query(
      `UPDATE guard_site_assignments
          SET assigned_until = $1
        WHERE id = $2
        RETURNING *`,
      [nextUntil, req.params.id],
    );
    const after = updateRes.rows[0];

    await writeAssignmentAudit(client, {
      assignmentId: after.id,
      action: 'guard_assignment_ended',
      changedBy: req.user!.sub,
      before,
      after,
    });

    await client.query('COMMIT');
    res.json(after);
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[PATCH /api/guards/:guardId/assignments/:id] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to update assignment' });
  } finally {
    client.release();
  }
});

// DELETE /api/guards/:guardId/assignments/:id
router.delete('/:guardId/assignments/:id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const tenantErr = await guardBelongsToCaller(req);
  if (tenantErr) return res.status(tenantErr.status).json(tenantErr.body);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rowRes = await client.query(
      `SELECT * FROM guard_site_assignments
        WHERE id = $1 AND guard_id = $2
        FOR UPDATE`,
      [req.params.id, req.params.guardId],
    );
    if (!rowRes.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Assignment not found' });
    }
    const before = rowRes.rows[0];

    // Audit FIRST, then delete. The audit row has no FK on assignment_id
    // (see schema_v20 comment), so the snapshot in `before` survives even
    // though the parent row is about to disappear.
    await writeAssignmentAudit(client, {
      assignmentId: before.id,
      action: 'guard_assignment_removed',
      changedBy: req.user!.sub,
      before,
      after: null,
    });
    await client.query(`DELETE FROM guard_site_assignments WHERE id = $1`, [req.params.id]);
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err: any) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[DELETE /api/guards/:guardId/assignments/:id] error:', err);
    res.status(500).json({ error: err?.message ?? 'Failed to remove assignment' });
  } finally {
    client.release();
  }
});

// GET /api/guards/:guardId/assignments/:id/impact
// Reports the future-shifts blast radius an admin would lose visibility
// over by ending or removing this assignment. No server-side block —
// grandfather principle — the UI uses this purely to surface a warning.
router.get('/:guardId/assignments/:id/impact', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const tenantErr = await guardBelongsToCaller(req);
  if (tenantErr) return res.status(tenantErr.status).json(tenantErr.body);

  const rowRes = await pool.query(
    `SELECT id, site_id FROM guard_site_assignments
      WHERE id = $1 AND guard_id = $2`,
    [req.params.id, req.params.guardId],
  );
  if (!rowRes.rows[0]) return res.status(404).json({ error: 'Assignment not found' });
  const { site_id } = rowRes.rows[0];

  const futureRes = await pool.query(
    `SELECT (scheduled_start AT TIME ZONE 'America/Los_Angeles')::date AS d
       FROM shifts
      WHERE guard_id = $1
        AND site_id  = $2
        AND scheduled_start > NOW()
        AND status IN ('scheduled', 'active')
      ORDER BY scheduled_start ASC`,
    [req.params.guardId, site_id],
  );

  // pg deserialises DATE columns to JS Date — see PATCH handler for the
  // toString() pitfall. Normalize via toISOString() so the API returns
  // proper YYYY-MM-DD strings (which the web modal then renders verbatim).
  const dates = futureRes.rows.map(r => r.d instanceof Date
    ? r.d.toISOString().slice(0, 10)
    : String(r.d).slice(0, 10));
  res.json({
    future_shift_count: dates.length,
    sample_dates: dates.slice(0, 5),
  });
});

// GET /api/guards/:id/assigned-sites?date=YYYY-MM-DD
//
// Powers the /admin/shifts modal: when an admin picks a guard, the SITE
// dropdown is filtered to that guard's currently-active assignments. The
// date param defaults to today's Pacific calendar date; the modal sends
// the current date when fetching, and server-side enforcement in the
// shift POST handler re-validates per emitted shift date so the dropdown
// is purely a UI convenience.
router.get('/:id/assigned-sites', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const dateParam = (req.query.date as string | undefined) ?? pacificTodayStr();
  if (!YYYY_MM_DD.test(dateParam)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }

  // Tenant gate. vishnu has no company scope and may read any guard's
  // assignments; company_admin can only read guards in their own company.
  if (req.user!.role === 'company_admin') {
    const guardCheck = await pool.query(
      'SELECT id FROM guards WHERE id = $1 AND company_id = $2',
      [req.params.id, req.user!.company_id]
    );
    if (!guardCheck.rows[0]) return res.status(404).json({ error: 'Guard not found' });
  }

  const sites = await getAssignedSitesForGuard(req.params.id, dateParam);
  res.json({ date: dateParam, sites });
});

export default router;
