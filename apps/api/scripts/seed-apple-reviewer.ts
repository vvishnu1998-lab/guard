/**
 * Seed script to create Apple App Store Reviewer credentials.
 * 
 * To run against production:
 * 1. Ensure DATABASE_URL is set in your environment or .env file.
 * 2. Run: npm run seed:reviewer
 */

import { Pool } from 'pg';
import * as bcrypt from 'bcrypt';

async function seed() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }
  });

  const client = await pool.connect();
  console.log('Connected to database.');

  try {
    await client.query('BEGIN');

    // 1. Create or get Company
    const companyName = 'Apple Review Co';
    let companyRes = await client.query('SELECT id FROM companies WHERE name = $1', [companyName]);
    let companyId: string;

    if (companyRes.rows.length === 0) {
      console.log(`Creating company: ${companyName}`);
      const insertCompany = await client.query(
        'INSERT INTO companies (name) VALUES ($1) RETURNING id',
        [companyName]
      );
      companyId = insertCompany.rows[0].id;
    } else {
      companyId = companyRes.rows[0].id;
      console.log(`Company "${companyName}" already exists. ID: ${companyId}`);
    }

    // 2. Hash Password
    const passwordHash = await bcrypt.hash('Aaaa@1234567', 12);

    // 3. Create or get Admin
    const adminEmail = 'talk2vvreddy@gmail.com';
    const adminRes = await client.query('SELECT id FROM company_admins WHERE email = $1', [adminEmail]);

    if (adminRes.rows.length === 0) {
      console.log(`Creating admin: ${adminEmail}`);
      await client.query(
        `INSERT INTO company_admins (company_id, name, email, password_hash, is_primary) 
         VALUES ($1, $2, $3, $4, true)`,
        [companyId, 'Apple Reviewer Admin', adminEmail, passwordHash]
      );
    } else {
      console.log(`Admin "${adminEmail}" already exists.`);
    }

    // 4. Create or get Guard
    const guardEmail = 'jamesvince26@proton.me';
    let guardRes = await client.query('SELECT id FROM guards WHERE email = $1', [guardEmail]);
    let guardId: string;

    if (guardRes.rows.length === 0) {
      console.log(`Creating guard: ${guardEmail}`);
      const insertGuard = await client.query(
        `INSERT INTO guards (company_id, name, email, password_hash, badge_number) 
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, 'Apple Reviewer Guard', guardEmail, passwordHash, 'AR-100']
      );
      guardId = insertGuard.rows[0].id;
    } else {
      guardId = guardRes.rows[0].id;
      console.log(`Guard "${guardEmail}" already exists. ID: ${guardId}`);
    }

    // 5. Create or get Site
    const siteName = 'Apple Review Site';
    let siteRes = await client.query('SELECT id FROM sites WHERE company_id = $1 AND name = $2', [companyId, siteName]);
    let siteId: string;

    if (siteRes.rows.length === 0) {
      console.log(`Creating site: ${siteName}`);
      const insertSite = await client.query(
        `INSERT INTO sites (company_id, name, address, contract_start, contract_end) 
         VALUES ($1, $2, $3, CURRENT_DATE, CURRENT_DATE + interval '1 year') RETURNING id`,
        [companyId, siteName, '1 Apple Park Way, Cupertino, CA 95014']
      );
      siteId = insertSite.rows[0].id;
    } else {
      siteId = siteRes.rows[0].id;
      console.log(`Site "${siteName}" already exists. ID: ${siteId}`);
    }

    // 6. Assign Guard to Site
    const assignRes = await client.query(
      'SELECT id FROM guard_site_assignments WHERE guard_id = $1 AND site_id = $2',
      [guardId, siteId]
    );

    if (assignRes.rows.length === 0) {
      console.log(`Assigning guard to site.`);
      await client.query(
        `INSERT INTO guard_site_assignments (guard_id, site_id, assigned_from) 
         VALUES ($1, $2, CURRENT_DATE)`,
        [guardId, siteId]
      );
    } else {
      console.log(`Guard already assigned to site.`);
    }

    await client.query('COMMIT');
    console.log('Seed completed successfully.');

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Error during seed:', error);
  } finally {
    client.release();
    await pool.end();
  }
}

seed().catch(console.error);
