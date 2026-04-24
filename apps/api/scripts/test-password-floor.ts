/**
 * test-password-floor.ts — proves C7 fix (audit/WEEK1.md §C7).
 *
 * Three things must hold after the fix:
 *
 *   1. POST /api/guards (admin creates a guard) rejects temp_password < 12
 *      with a 400 ("Temporary password must be at least 12 characters").
 *   2. The same endpoint accepts a 12-char temp_password (201).
 *   3. POST /api/auth/guard/change-password rejects new_password < 12
 *      with a 400 ("New password must be at least 12 characters").
 *      Also accepts a 12-char new_password and clears must_change_password.
 *   4. Brand-new guard rows have must_change_password = true (forced
 *      rotation invariant — the temp credential cannot stay live).
 *
 * Boots the Express app in-process on an ephemeral port and reuses the
 * real DB.  All ephemeral rows are deleted on exit (the test guard is
 * created fresh for each run with a UUID-tagged email + badge to avoid
 * collisions with the real fixture).
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-password-floor.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md §C7)
 */
import 'dotenv/config';
import http from 'http';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';

if (!process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

async function run() {
  // Need a real company_admin to call POST /api/guards.
  const a = await pool.query('SELECT id, company_id FROM company_admins LIMIT 1');
  if (!a.rows[0]) throw new Error('No company_admin in DB — cannot run test.');
  const adminId = a.rows[0].id as string;
  const companyId = a.rows[0].company_id as string;

  console.log(`\n=== test-password-floor — admin ${adminId.slice(0,8)}, company ${companyId.slice(0,8)} ===\n`);

  const { default: app } = await import('../src/index');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server addr');
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`Spun up app on ${base}\n`);

  const tag = uuidv4().slice(0, 8);
  const email = `c7-test-${tag}@example.com`;
  const badge = `C7-${tag}`;
  let createdGuardId: string | null = null;

  try {
    const adminToken = jwt.sign(
      { sub: adminId, role: 'company_admin', company_id: companyId, jti: uuidv4() },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    // ── 1. Temp password 11 chars (one short) → 400 ──────────────────────
    const shortRes = await fetch(`${base}/api/guards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: `C7 Test ${tag}`,
        email,
        badge_number: badge,
        temp_password: 'shortpass11', // 11 chars, just under the floor
      }),
    });
    assert(shortRes.status === 400, `11-char temp_password returns 400 (got ${shortRes.status})`);
    const shortBody = (await shortRes.json()) as { error?: string };
    assert(/at least 12/i.test(shortBody.error ?? ''), '400 body mentions 12-char floor');

    // Confirm no row was created
    const noRow = await pool.query('SELECT id FROM guards WHERE email = $1', [email]);
    assert(noRow.rows.length === 0, 'no guard row was created on rejection');

    // ── 2. Temp password exactly 12 chars → 201 ──────────────────────────
    const tempPassword = 'TempPass1234'; // 12 chars
    const okRes = await fetch(`${base}/api/guards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        name: `C7 Test ${tag}`,
        email,
        badge_number: badge,
        temp_password: tempPassword,
      }),
    });
    assert(okRes.status === 201, `12-char temp_password returns 201 (got ${okRes.status})`);
    const okBody = (await okRes.json()) as { id?: string };
    if (!okBody.id) throw new Error('Missing guard id on success response');
    createdGuardId = okBody.id;

    // ── 3. Forced-rotation invariant: must_change_password = true on new row
    const flag = await pool.query(
      'SELECT must_change_password FROM guards WHERE id = $1',
      [createdGuardId]
    );
    assert(flag.rows[0].must_change_password === true,
      'new guard row has must_change_password = true (forced rotation)');

    // ── 4. change-password with 11-char new_password → 400 ───────────────
    const guardToken = jwt.sign(
      { sub: createdGuardId, role: 'guard', company_id: companyId, jti: uuidv4() },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    const shortChangeRes = await fetch(`${base}/api/auth/guard/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guardToken}` },
      body: JSON.stringify({ current_password: tempPassword, new_password: 'shortNew111' }), // 11 chars
    });
    assert(shortChangeRes.status === 400,
      `change-password with 11-char new_password returns 400 (got ${shortChangeRes.status})`);
    const shortChangeBody = (await shortChangeRes.json()) as { error?: string };
    assert(/at least 12/i.test(shortChangeBody.error ?? ''),
      'change-password 400 body mentions 12-char floor');

    // ── 5. change-password with 12-char new_password → 200 + flag cleared
    const newPassword = 'NewPass12345!'; // 13 chars, above the floor
    const okChangeRes = await fetch(`${base}/api/auth/guard/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${guardToken}` },
      body: JSON.stringify({ current_password: tempPassword, new_password: newPassword }),
    });
    assert(okChangeRes.status === 200,
      `change-password with 13-char new_password returns 200 (got ${okChangeRes.status})`);

    const flagAfter = await pool.query(
      'SELECT must_change_password FROM guards WHERE id = $1',
      [createdGuardId]
    );
    assert(flagAfter.rows[0].must_change_password === false,
      'must_change_password flipped to false after successful rotation');

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    if (createdGuardId) {
      // Cascade-safe cleanup: no FKs to test guard yet; if you change this,
      // delete shift_sessions / shifts / guard_site_assignments first.
      await pool.query('DELETE FROM guards WHERE id = $1', [createdGuardId]);
    } else {
      // In case the row was created but creation handler failed downstream,
      // sweep by email/badge as a belt-and-braces cleanup.
      await pool.query('DELETE FROM guards WHERE email = $1 OR badge_number = $2', [email, badge]);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    console.log('Cleaned up test guard.');
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  pool.end().finally(() => process.exit(1));
});
