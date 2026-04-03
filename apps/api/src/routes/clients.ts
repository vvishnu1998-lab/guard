import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';

const router = Router();

// GET /api/clients/:site_id — admin views client portal account for a site
router.get('/:site_id', requireAuth('company_admin'), async (req, res) => {
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [req.params.site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  const result = await pool.query(
    'SELECT id, name, email, is_active, created_at FROM clients WHERE site_id = $1',
    [req.params.site_id]
  );
  res.json(result.rows[0] || null);
});

// POST /api/clients — create client portal account for a site
router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { site_id, name, email, password } = req.body;
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });

  const password_hash = await bcrypt.hash(password, 12);
  const result = await pool.query(
    `INSERT INTO clients (site_id, name, email, password_hash)
     VALUES ($1, $2, $3, $4)
     RETURNING id, site_id, name, email, is_active, created_at`,
    [site_id, name, email, password_hash]
  );
  res.status(201).json(result.rows[0]);
});

export default router;
