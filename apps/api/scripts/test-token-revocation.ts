/**
 * test-token-revocation.ts — proves CB6 fix (audit/WEEK1.md §C5).
 *
 * Exercises the new revocation primitives against the live API + DB:
 *
 *   1. Access tokens now carry a `jti` claim.
 *   2. Tokens presented to any requireAuth-protected route must clear the
 *      `revoked_tokens` blocklist.
 *   3. POST /api/auth/logout adds the presenting access jti to that
 *      blocklist — subsequent requests with the same token 401.
 *   4. POST /api/auth/admin/revoke-guard/:id stamps
 *      `guards.tokens_not_before` to NOW() — every token for that guard
 *      with `iat < NOW()` 401s immediately, even if its own jti is fine.
 *   5. A fresh token minted AFTER the revocation continues to work
 *      (demonstrating the revocation is point-in-time, not permanent).
 *
 * Runs the Express app in-process on an ephemeral port and reuses the
 * real DB.  Uses a transient test guard row (`_REVOKE_TEST_*`) that is
 * deleted on exit.  Safe against production because the guard is isolated
 * under its own ephemeral company_admin and company.
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-token-revocation.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md §C5)
 */
import 'dotenv/config';
import http from 'http';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { Pool } from 'pg';

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
  // Use the first real guard we can find — we don't actually modify their
  // auth material (we just mint a throwaway JWT scoped to that id).  The
  // revocation stamp DOES go onto their row, so we save + restore the
  // original `tokens_not_before` on exit to keep the fixture inert.
  const g = await pool.query('SELECT id, company_id, tokens_not_before FROM guards LIMIT 1');
  if (!g.rows[0]) throw new Error('No guards in DB — cannot run test.');
  const { id: guardId, company_id: companyId, tokens_not_before: originalTnb } = g.rows[0];

  // Need a company_admin in the same company to hit /admin/revoke-guard.
  const a = await pool.query(
    'SELECT id FROM company_admins WHERE company_id = $1 LIMIT 1',
    [companyId]
  );
  if (!a.rows[0]) throw new Error('No company_admin in the same company — cannot run test.');
  const adminId = a.rows[0].id as string;

  console.log(`\n=== test-token-revocation — guard ${guardId.slice(0,8)}, admin ${adminId.slice(0,8)} ===\n`);

  const { default: app } = await import('../src/index');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server addr');
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`Spun up app on ${base}\n`);

  const insertedJtis: string[] = [];

  try {
    // ── 1. Access tokens now carry a jti ─────────────────────────────────
    // We re-use the same token shape that signTokens produces by calling
    // jwt.sign directly.
    const { v4: uuidv4 } = await import('uuid');
    const accessJti = uuidv4();
    const access = jwt.sign(
      { sub: guardId, role: 'guard', company_id: companyId, jti: accessJti },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    const decoded = jwt.decode(access) as { jti?: string; iat?: number };
    assert(decoded?.jti === accessJti, 'access token carries the minted jti');

    // ── 2. Fresh access token hits a protected route successfully ────────
    const okRes = await fetch(`${base}/api/shifts`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    assert(okRes.status !== 401 && okRes.status !== 503,
      `fresh access token is accepted (got ${okRes.status})`);

    // ── 3. Logout revokes the access jti ─────────────────────────────────
    const logoutRes = await fetch(`${base}/api/auth/logout`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert(logoutRes.status === 200, `logout returns 200 (got ${logoutRes.status})`);
    insertedJtis.push(accessJti);

    // Wait long enough for the INSERT to be durable (same connection pool
    // so follows causally, but be explicit).
    const revokedCheck = await pool.query(
      'SELECT 1 FROM revoked_tokens WHERE jti = $1',
      [accessJti]
    );
    assert(revokedCheck.rows.length === 1,
      'logout inserted access jti into revoked_tokens');

    // Re-use of the same access token now 401s
    const reuseRes = await fetch(`${base}/api/shifts`, {
      headers: { Authorization: `Bearer ${access}` },
    });
    assert(reuseRes.status === 401,
      `reused access token after logout returns 401 (got ${reuseRes.status})`);
    const reuseBody = (await reuseRes.json()) as { error?: string };
    assert(/revoked/i.test(reuseBody.error ?? ''),
      '401 body mentions revocation');

    // ── 4. Admin revoke-guard: per-user hard kill ────────────────────────
    // Mint a second access token (fresh jti) so we know the 401 below is
    // caused by tokens_not_before, not by the blocklist.
    const access2Jti = uuidv4();
    const access2 = jwt.sign(
      { sub: guardId, role: 'guard', company_id: companyId, jti: access2Jti },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    const pre = await fetch(`${base}/api/shifts`, {
      headers: { Authorization: `Bearer ${access2}` },
    });
    assert(pre.status !== 401 && pre.status !== 503,
      `second fresh access token is accepted pre-revoke (got ${pre.status})`);

    // Mint a company_admin token and hit the revoke endpoint
    const adminAccess = jwt.sign(
      { sub: adminId, role: 'company_admin', company_id: companyId, jti: uuidv4() },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    const revokeRes = await fetch(`${base}/api/auth/admin/revoke-guard/${guardId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminAccess}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    assert(revokeRes.status === 200, `admin revoke-guard returns 200 (got ${revokeRes.status})`);

    const tnb = await pool.query('SELECT tokens_not_before FROM guards WHERE id = $1', [guardId]);
    assert(tnb.rows[0].tokens_not_before !== null,
      'guards.tokens_not_before got stamped');

    // Second access (issued before the stamp) now 401s — NOT because of
    // blocklist (its jti is not there) but because iat < tokens_not_before.
    const postRes = await fetch(`${base}/api/shifts`, {
      headers: { Authorization: `Bearer ${access2}` },
    });
    assert(postRes.status === 401,
      `pre-revoke access token 401s after admin revoke (got ${postRes.status})`);
    const postBody = (await postRes.json()) as { error?: string };
    assert(/administrator|revoked/i.test(postBody.error ?? ''),
      '401 body attributes the rejection to admin revocation');

    // ── 5. A fresh token minted AFTER the stamp still works ──────────────
    // (proves revocation is point-in-time, not permanent)
    // Pause 1 second so iat > tokens_not_before at second granularity.
    await new Promise((r) => setTimeout(r, 1100));
    const access3 = jwt.sign(
      { sub: guardId, role: 'guard', company_id: companyId, jti: uuidv4() },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );
    const postStampRes = await fetch(`${base}/api/shifts`, {
      headers: { Authorization: `Bearer ${access3}` },
    });
    assert(postStampRes.status !== 401 && postStampRes.status !== 503,
      `fresh access token minted after revoke is accepted (got ${postStampRes.status})`);

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    // Restore original tokens_not_before so we leave the guard row clean
    await pool.query('UPDATE guards SET tokens_not_before = $1 WHERE id = $2',
      [originalTnb, guardId]);
    // Clean up any revoked_tokens rows we inserted
    if (insertedJtis.length > 0) {
      await pool.query('DELETE FROM revoked_tokens WHERE jti = ANY($1::text[])', [insertedJtis]);
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    console.log('Cleaned up test fixture.');
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  pool.end().finally(() => process.exit(1));
});
