import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { pool } from '../db/pool';
import bcrypt from 'bcrypt';

const router = Router();

router.get('/', requireAuth('company_admin', 'vishnu'), async (req, res) => {
  const isVishnu = req.user!.role === 'vishnu';
  const result = await pool.query(
    `SELECT g.id, g.name, g.email, g.badge_number, g.is_active, g.created_at,
            array_agg(json_build_object('site_id', gsa.site_id, 'site_name', s.name,
              'assigned_from', gsa.assigned_from, 'assigned_until', gsa.assigned_until))
              FILTER (WHERE gsa.id IS NOT NULL) as assignments
     FROM guards g
     LEFT JOIN guard_site_assignments gsa ON gsa.guard_id = g.id
     LEFT JOIN sites s ON s.id = gsa.site_id
     ${isVishnu ? '' : 'WHERE g.company_id = $1'}
     GROUP BY g.id ORDER BY g.name`,
    isVishnu ? [] : [req.user!.company_id]
  );
  res.json(result.rows);
});

router.post('/', requireAuth('company_admin'), async (req, res) => {
  const { name, email, badge_number, temp_password } = req.body;
  const password_hash = await bcrypt.hash(temp_password, 12);
  const result = await pool.query(
    `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, name, email, badge_number, is_active, created_at`,
    [req.user!.company_id, name, email, password_hash, badge_number]
  );
  res.status(201).json(result.rows[0]);
});

router.patch('/:id/deactivate', requireAuth('company_admin'), async (req, res) => {
  await pool.query(
    'UPDATE guards SET is_active = false WHERE id = $1 AND company_id = $2',
    [req.params.id, req.user!.company_id]
  );
  res.json({ success: true });
});

router.post('/:id/assign', requireAuth('company_admin'), async (req, res) => {
  const { site_id, assigned_from, assigned_until } = req.body;
  const siteCheck = await pool.query(
    'SELECT id FROM sites WHERE id = $1 AND company_id = $2',
    [site_id, req.user!.company_id]
  );
  if (!siteCheck.rows[0]) return res.status(403).json({ error: 'Site not found' });
  const result = await pool.query(
    `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from, assigned_until)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.params.id, site_id, assigned_from, assigned_until || null]
  );
  res.status(201).json(result.rows[0]);
});

export default router;
