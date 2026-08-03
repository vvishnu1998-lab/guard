import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';

const router = Router();

// Admin-facing checkpoint CRUD + scan history (C3a). Guard-facing scan
// and link endpoints are C3b — not in this file yet.
//
// Checkpoints are created UNLINKED (label only). code_value / code_type /
// lat / lng / link_accuracy_m / linked_at / linked_by_guard_id are set
// exclusively by a guard's link scan, so every admin write path here
// refuses them. Unlink clears them; past scans are kept — they remain
// valid history of where the guard actually was.

const LINK_ONLY_FIELDS = [
  'code_value', 'code_type', 'lat', 'lng',
  'link_accuracy_m', 'linked_at', 'linked_by_guard_id',
] as const;

function validLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const trimmed = label.trim();
  return trimmed.length >= 1 && trimmed.length <= 120 ? trimmed : null;
}

function validRadius(radius: unknown): boolean {
  return typeof radius === 'number' && Number.isInteger(radius) && radius >= 10 && radius <= 500;
}

// GET /api/checkpoints?site_id=<uuid> — all checkpoints for a site,
// inactive included (the UI filters). 404 when the site isn't ours.
router.get('/', requireAuth('company_admin'), async (req, res) => {
  const { site_id } = req.query;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(404).json({ error: 'Site not found' });

  const result = await pool.query(
    `SELECT sc.*, (sc.code_value IS NOT NULL) AS linked
     FROM site_checkpoints sc
     WHERE sc.site_id = $1
     ORDER BY sc.sort_order ASC, sc.created_at ASC`,
    [site_id]
  );
  res.json(result.rows);
});

// POST /api/checkpoints — create an UNLINKED checkpoint (label only).
// Link fields from the client are ignored by construction: only
// site_id / label / radius_meters are ever read from the body.
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { site_id, label, radius_meters } = req.body;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  const cleanLabel = validLabel(label);
  if (cleanLabel === null) {
    return res.status(400).json({ error: 'label is required (1-120 characters)' });
  }
  if (radius_meters !== undefined && !validRadius(radius_meters)) {
    return res.status(400).json({ error: 'radius_meters must be an integer between 10 and 500' });
  }

  // Verify site belongs to admin's company
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  const result = await pool.query(
    `INSERT INTO site_checkpoints (site_id, label, radius_meters, sort_order)
     VALUES ($1, $2, $3,
             COALESCE((SELECT MAX(sort_order) + 1 FROM site_checkpoints WHERE site_id = $1), 0))
     RETURNING *, (code_value IS NOT NULL) AS linked`,
    [site_id, cleanLabel, radius_meters ?? 50]
  );
  res.status(201).json(result.rows[0]);
});

// PATCH /api/checkpoints/:id — label / radius_meters / sort_order /
// is_active only. Any link-state key in the body at all → 400.
router.patch('/:id', requireAuth('company_admin'), async (req, res) => {
  const forbidden = LINK_ONLY_FIELDS.filter((k) => k in req.body);
  if (forbidden.length > 0) {
    return res.status(400).json({
      error: `Fields set only by a guard's link scan: ${forbidden.join(', ')}. Use /unlink to clear them.`,
    });
  }

  const { label, radius_meters, sort_order, is_active } = req.body;

  const ownerCheck = await pool.query(
    `SELECT sc.id FROM site_checkpoints sc
     JOIN sites s ON s.id = sc.site_id
     WHERE sc.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Checkpoint not found' });

  const fields: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (label !== undefined) {
    const cleanLabel = validLabel(label);
    if (cleanLabel === null) {
      return res.status(400).json({ error: 'label must be 1-120 characters' });
    }
    fields.push(`label = $${idx++}`);
    values.push(cleanLabel);
  }
  if (radius_meters !== undefined) {
    if (!validRadius(radius_meters)) {
      return res.status(400).json({ error: 'radius_meters must be an integer between 10 and 500' });
    }
    fields.push(`radius_meters = $${idx++}`);
    values.push(radius_meters);
  }
  if (sort_order !== undefined) {
    if (typeof sort_order !== 'number' || !Number.isInteger(sort_order)) {
      return res.status(400).json({ error: 'sort_order must be an integer' });
    }
    fields.push(`sort_order = $${idx++}`);
    values.push(sort_order);
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') {
      return res.status(400).json({ error: 'is_active must be a boolean' });
    }
    fields.push(`is_active = $${idx++}`);
    values.push(is_active);
  }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(req.params.id);
  const result = await pool.query(
    `UPDATE site_checkpoints SET ${fields.join(', ')} WHERE id = $${idx}
     RETURNING *, (code_value IS NOT NULL) AS linked`,
    values
  );
  res.json(result.rows[0]);
});

// POST /api/checkpoints/:id/unlink — clear the link state so a guard can
// re-anchor a checkpoint that was linked at the wrong position. Past
// scans are intentionally kept.
router.post('/:id/unlink', requireAuth('company_admin'), async (req, res) => {
  const ownerCheck = await pool.query(
    `SELECT sc.id FROM site_checkpoints sc
     JOIN sites s ON s.id = sc.site_id
     WHERE sc.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Checkpoint not found' });

  const result = await pool.query(
    `UPDATE site_checkpoints
     SET code_value = NULL, code_type = NULL, lat = NULL, lng = NULL,
         link_accuracy_m = NULL, linked_at = NULL, linked_by_guard_id = NULL
     WHERE id = $1
     RETURNING *, (code_value IS NOT NULL) AS linked`,
    [req.params.id]
  );
  res.json(result.rows[0]);
});

// DELETE /api/checkpoints/:id?confirm=delete_scans — hard delete.
// checkpoint_scans has ON DELETE CASCADE (schema_v44), so this destroys
// scan history; without the explicit confirm param, 409 with the count.
// Prefer PATCH is_active=false.
router.delete('/:id', requireAuth('company_admin'), async (req, res) => {
  const ownerCheck = await pool.query(
    `SELECT sc.id FROM site_checkpoints sc
     JOIN sites s ON s.id = sc.site_id
     WHERE sc.id = $1 AND s.company_id = $2`,
    [req.params.id, req.user!.company_id]
  );
  if (!ownerCheck.rows[0]) return res.status(404).json({ error: 'Checkpoint not found' });

  const countResult = await pool.query(
    'SELECT COUNT(*)::int AS scan_count FROM checkpoint_scans WHERE checkpoint_id = $1',
    [req.params.id]
  );
  const scanCount = countResult.rows[0].scan_count;

  if (req.query.confirm !== 'delete_scans') {
    return res.status(409).json({
      error: `Deleting this checkpoint destroys ${scanCount} scan record(s). ` +
        `Repeat with ?confirm=delete_scans to proceed, or set is_active=false to hide it instead.`,
      scan_count: scanCount,
    });
  }

  await pool.query('DELETE FROM site_checkpoints WHERE id = $1', [req.params.id]);
  res.json({ success: true, scans_deleted: scanCount });
});

// GET /api/checkpoints/scans?site_id=<uuid>&from=<ISO>&to=<ISO> — scan
// history for a site. Defaults to the last 7 days; range capped at 92
// days; result capped at 1000 rows with a `truncated` flag.
router.get('/scans', requireAuth('company_admin'), async (req, res) => {
  const { site_id, from, to } = req.query;
  if (!site_id) return res.status(400).json({ error: 'site_id is required' });

  const toDate = to !== undefined ? new Date(String(to)) : new Date();
  const fromDate = from !== undefined
    ? new Date(String(from))
    : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ error: 'from/to must be valid ISO timestamps' });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ error: 'from must be before to' });
  }
  if (toDate.getTime() - fromDate.getTime() > 92 * 24 * 60 * 60 * 1000) {
    return res.status(400).json({ error: 'Range must be 92 days or less' });
  }

  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(404).json({ error: 'Site not found' });

  const CAP = 1000;
  const result = await pool.query(
    `SELECT cs.*, sc.label AS checkpoint_label, g.name AS guard_name
     FROM checkpoint_scans cs
     JOIN site_checkpoints sc ON sc.id = cs.checkpoint_id
     JOIN guards g ON g.id = cs.guard_id
     WHERE cs.site_id = $1 AND cs.scanned_at >= $2 AND cs.scanned_at <= $3
     ORDER BY cs.scanned_at DESC
     LIMIT ${CAP + 1}`,
    [site_id, fromDate.toISOString(), toDate.toISOString()]
  );

  const truncated = result.rows.length > CAP;
  res.json({
    scans: truncated ? result.rows.slice(0, CAP) : result.rows,
    truncated,
  });
});

export default router;
