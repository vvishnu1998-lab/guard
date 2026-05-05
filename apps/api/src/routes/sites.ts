import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import { uploadBufferToS3 } from '../services/s3';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const PDF_MAGIC = Buffer.from([0x25, 0x50, 0x44, 0x46]); // %PDF

// GET /api/sites
router.get('/', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const result = await pool.query(
    `SELECT s.*, c.name as company_name,
            drl.client_star_access_until, drl.data_delete_at, drl.client_star_access_disabled,
            sg.center_lat, sg.center_lng, sg.radius_meters,
            sg.polygon_coordinates,
            CASE WHEN sg.site_id IS NOT NULL THEN true ELSE false END AS has_geofence
     FROM sites s
     JOIN companies c ON c.id = s.company_id
     LEFT JOIN data_retention_log drl ON drl.site_id = s.id
     LEFT JOIN site_geofence sg ON sg.site_id = s.id
     ${isVishnu ? '' : 'WHERE s.company_id = $1'}
     ORDER BY s.created_at DESC`,
    isVishnu ? [] : [req.user!.company_id]
  );
  res.json(result.rows);
});

// GET /api/sites/:id
router.get('/:id', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const result = await pool.query(
    `SELECT s.*, c.name as company_name,
            drl.client_star_access_until, drl.data_delete_at, drl.client_star_access_disabled,
            sg.center_lat, sg.center_lng, sg.radius_meters, sg.polygon_coordinates,
            CASE WHEN sg.site_id IS NOT NULL THEN true ELSE false END AS has_geofence
     FROM sites s
     JOIN companies c ON c.id = s.company_id
     LEFT JOIN data_retention_log drl ON drl.site_id = s.id
     LEFT JOIN site_geofence sg ON sg.site_id = s.id
     WHERE s.id = $1 ${isVishnu ? '' : 'AND s.company_id = $2'}`,
    isVishnu ? [req.params.id] : [req.params.id, req.user!.company_id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Site not found' });
  res.json(result.rows[0]);
});

// POST /api/sites — admin creates a site and its retention record (contract_end is optional)
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { name, address, contract_start, contract_end, instructions_pdf_url } = req.body;
  if (!name || !address || !contract_start) {
    return res.status(400).json({ error: 'name, address, contract_start are required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const siteResult = await client.query(
      `INSERT INTO sites (company_id, name, address, contract_start, contract_end, instructions_pdf_url)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user!.company_id, name, address, contract_start, contract_end || null, instructions_pdf_url || null]
    );
    const site = siteResult.rows[0];
    const accessUntil = contract_end ? (() => { const d = new Date(contract_end); d.setDate(d.getDate() + 90); return d; })() : null;
    const deleteAt    = contract_end ? (() => { const d = new Date(contract_end); d.setDate(d.getDate() + 150); return d; })() : null;
    await client.query(
      `INSERT INTO data_retention_log (site_id, client_star_access_until, data_delete_at)
       VALUES ($1, $2, $3)`,
      [site.id, accessUntil, deleteAt]
    );
    await client.query('COMMIT');
    res.status(201).json(site);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

// PUT /api/sites/:id — update site fields including instructions_pdf_url
router.put('/:id', requireAuth('company_admin'), async (req, res) => {
  const { name, address, contract_start, contract_end, instructions_pdf_url } = req.body;
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  const result = await pool.query(
    `UPDATE sites SET
       name = COALESCE($1, name),
       address = COALESCE($2, address),
       contract_start = COALESCE($3, contract_start),
       contract_end = COALESCE($4, contract_end),
       instructions_pdf_url = COALESCE($5, instructions_pdf_url)
     WHERE id = $6 RETURNING *`,
    [name || null, address || null, contract_start || null, contract_end || null, instructions_pdf_url ?? null, req.params.id]
  );
  res.json(result.rows[0]);
});

// POST /api/sites/:id/instructions — server-side PDF upload with magic bytes validation
router.post('/:id/instructions', requireAuth('company_admin'), upload.single('file'), async (req, res) => {
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const buf = req.file.buffer;
  if (buf.length < 4 || !buf.slice(0, 4).equals(PDF_MAGIC)) {
    return res.status(400).json({ error: 'File is not a valid PDF (magic bytes check failed)' });
  }

  const key = `site-instructions/${req.params.id}/instructions.pdf`;
  const url = await uploadBufferToS3(key, buf, 'application/pdf');

  await pool.query(
    'UPDATE sites SET instructions_pdf_url = $1 WHERE id = $2',
    [url, req.params.id]
  );

  res.json({ url, key });
});

// PATCH /api/sites/:id/geofence
router.patch('/:id/geofence', requireAuth('company_admin'), async (req, res) => {
  const { polygon_coordinates, center_lat, center_lng, radius_meters } = req.body;
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  const result = await pool.query(
    `INSERT INTO site_geofence (site_id, polygon_coordinates, center_lat, center_lng, radius_meters, created_by_admin)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (site_id) DO UPDATE SET
       polygon_coordinates = EXCLUDED.polygon_coordinates,
       center_lat = EXCLUDED.center_lat,
       center_lng = EXCLUDED.center_lng,
       radius_meters = EXCLUDED.radius_meters,
       updated_at = NOW()
     RETURNING *`,
    [req.params.id, JSON.stringify(polygon_coordinates), center_lat, center_lng, radius_meters, req.user!.sub]
  );
  res.json(result.rows[0]);
});

// PATCH /api/sites/:id/client-access — Star enables/disables client portal
router.patch('/:id/client-access', requireAuth('company_admin'), async (req, res) => {
  const { enabled } = req.body;
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  await pool.query(
    'UPDATE clients SET is_active = $1 WHERE site_id = $2',
    [enabled, req.params.id]
  );
  if (!enabled) {
    await pool.query(
      'UPDATE sites SET client_access_disabled_at = NOW() WHERE id = $1',
      [req.params.id]
    );
  } else {
    await pool.query(
      'UPDATE sites SET client_access_disabled_at = NULL WHERE id = $1',
      [req.params.id]
    );
  }
  res.json({ success: true });
});

export default router;
