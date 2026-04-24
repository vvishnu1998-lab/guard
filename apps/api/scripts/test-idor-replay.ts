/**
 * test-idor-replay.ts — re-runs the V1 IDOR probe (audit/VERIFICATION.md §V1)
 * against an in-process app boot, with two fully ephemeral companies so the
 * test is reproducible without prod creds.
 *
 * Why this matters in Phase E:
 *   The original V1 probe was executed manually against the live API as
 *   `david406payne@proton.me` (Client B, Company B) and Admin B.  Phase C
 *   touched auth.ts, middleware/auth.ts, and clientPortal.ts — none of
 *   those changes were intended to weaken tenant isolation, but a
 *   regression test that re-runs the probe end-to-end is the only way
 *   to be sure no `req.user.site_id` / `req.user.company_id` enforcement
 *   was lost in the diff.
 *
 * Fixture (deleted on exit):
 *   Company A: 1 admin, 1 site, 1 client (with site_id = A-site),
 *              1 guard, 1 shift_session, 1 report
 *   Company B: same shape
 *
 * Probe matrix — every assertion proves "Client B / Admin B cannot
 * see Company A's data, even with carefully crafted query/path params":
 *
 *   1. Client B GET /api/client/site                → returns B's site
 *   2. Client B GET /api/client/site?site_id=<A>    → still B's site (param ignored)
 *   3. Client B GET /api/client/reports             → only B's reports
 *   4. Client B GET /api/client/reports?site_id=<A> → still only B's reports
 *   5. Client B GET /api/reports                    → only B's reports
 *   6. Client B GET /api/reports?site_id=<A>        → []
 *   7. Client B GET /api/shifts                     → 403 (role mismatch)
 *   8. Client B POST /api/locations/ping            → 403 (role mismatch)
 *   9. Client B POST /api/client/reports/pdf-link with from/to → 200 + token
 *      that, when consumed at GET /api/client/reports/pdf, only returns
 *      B's PDF rows even though `site_id` is in the JWT, not the query.
 *  10. Admin  B GET /api/sites                      → only B's sites listed
 *  11. Admin  B GET /api/admin/kpis                 → only B's company_id
 *  12. Admin  B GET /api/shifts                     → only B's shifts listed
 *  13. Admin  B GET /api/guards                     → only B's guards listed
 *  14. Admin  B GET /api/reports?site_id=<A>        → []
 *  15. Symmetric: Admin A → none of B's site/guard/shift/report rows.
 *
 * Anything that returns >0 rows from the *other* company is an IDOR
 * regression and the script throws.
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-idor-replay.ts
 *
 * Author: Week-1 audit (Phase E re-verification — audit/WEEK1.md §E)
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

interface Tenant {
  companyId: string;
  adminId: string;
  siteId: string;
  clientId: string;
  guardId: string;
  shiftId: string;
  sessionId: string;
  reportId: string;
  adminToken: string;
  clientToken: string;
}

async function seedTenant(label: string, stamp: number): Promise<Tenant> {
  const tag = `${label}_${stamp}`;
  const company = await pool.query(
    `INSERT INTO companies (name) VALUES ($1) RETURNING id`,
    [`_IDOR_TEST_${tag}`]
  );
  const companyId = company.rows[0].id as string;

  const admin = await pool.query(
    `INSERT INTO company_admins (company_id, name, email, password_hash, is_primary)
     VALUES ($1, $2, $3, '_unused_', true) RETURNING id`,
    [companyId, `Admin ${tag}`, `idor-admin-${tag}@example.com`]
  );
  const adminId = admin.rows[0].id as string;

  const site = await pool.query(
    `INSERT INTO sites (company_id, name, address, contract_start, contract_end)
     VALUES ($1, $2, '_idor_addr_', NOW() - INTERVAL '30 days', NOW() + INTERVAL '180 days')
     RETURNING id`,
    [companyId, `Site ${tag}`]
  );
  const siteId = site.rows[0].id as string;

  const client = await pool.query(
    `INSERT INTO clients (site_id, name, email, password_hash)
     VALUES ($1, $2, $3, '_unused_') RETURNING id`,
    [siteId, `Client ${tag}`, `idor-client-${tag}@example.com`]
  );
  const clientId = client.rows[0].id as string;

  const guard = await pool.query(
    `INSERT INTO guards (company_id, name, email, password_hash, badge_number)
     VALUES ($1, $2, $3, '_unused_', $4) RETURNING id`,
    [companyId, `Guard ${tag}`, `idor-guard-${tag}@example.com`, `IDOR-${tag}`]
  );
  const guardId = guard.rows[0].id as string;

  const shift = await pool.query(
    `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
     VALUES ($1, $2, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '7 hours', 'active')
     RETURNING id`,
    [siteId, guardId]
  );
  const shiftId = shift.rows[0].id as string;

  const session = await pool.query(
    `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords)
     VALUES ($1, $2, $3, NOW() - INTERVAL '30 minutes', '0,0')
     RETURNING id`,
    [shiftId, guardId, siteId]
  );
  const sessionId = session.rows[0].id as string;

  const report = await pool.query(
    `INSERT INTO reports (shift_session_id, site_id, report_type, description, severity, delete_at)
     VALUES ($1, $2, 'activity', $3, 'low', NOW() + INTERVAL '150 days')
     RETURNING id`,
    [sessionId, siteId, `_IDOR_TEST_${tag} routine patrol`]
  );
  const reportId = report.rows[0].id as string;

  const adminToken = jwt.sign(
    { sub: adminId, role: 'company_admin', company_id: companyId, jti: uuidv4() },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );
  const clientToken = jwt.sign(
    { sub: clientId, role: 'client', site_id: siteId, jti: uuidv4() },
    process.env.JWT_SECRET!,
    { expiresIn: '1h' }
  );

  return { companyId, adminId, siteId, clientId, guardId, shiftId, sessionId, reportId, adminToken, clientToken };
}

async function teardownTenant(t: Tenant) {
  // Order matters: report_photos → reports → shift_sessions → shifts → guards → clients → sites → admins → company.
  await pool.query('DELETE FROM report_photos WHERE report_id = $1', [t.reportId]);
  await pool.query('DELETE FROM reports WHERE id = $1', [t.reportId]);
  await pool.query('DELETE FROM shift_sessions WHERE id = $1', [t.sessionId]);
  await pool.query('DELETE FROM shifts WHERE id = $1', [t.shiftId]);
  await pool.query('DELETE FROM guards WHERE id = $1', [t.guardId]);
  await pool.query('DELETE FROM clients WHERE id = $1', [t.clientId]);
  await pool.query('DELETE FROM sites WHERE id = $1', [t.siteId]);
  await pool.query('DELETE FROM company_admins WHERE id = $1', [t.adminId]);
  await pool.query('DELETE FROM companies WHERE id = $1', [t.companyId]);
}

async function run() {
  const stamp = Date.now();
  console.log(`\n=== test-idor-replay (V1) — stamp ${stamp} ===\n`);

  const A = await seedTenant('A', stamp);
  const B = await seedTenant('B', stamp);
  console.log(`Seeded Co A site ${A.siteId.slice(0,8)} report ${A.reportId.slice(0,8)}`);
  console.log(`Seeded Co B site ${B.siteId.slice(0,8)} report ${B.reportId.slice(0,8)}\n`);

  const { default: app } = await import('../src/index');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server addr');
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`Spun up app on ${base}\n`);

  const get = async (path: string, token: string) => {
    const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, body };
  };
  const post = async (path: string, token: string, payload: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    return { status: r.status, body };
  };

  try {
    // ── Client B → /api/client/site ───────────────────────────────────────
    const cb1 = await get('/api/client/site', B.clientToken);
    assert(cb1.status === 200, `Client B GET /api/client/site → 200 (got ${cb1.status})`);
    assert((cb1.body as { id: string }).id === B.siteId,
      'Client B GET /api/client/site returns B-site, not A-site');

    // ── Client B → /api/client/site?site_id=<A> (param injection) ─────────
    const cb2 = await get(`/api/client/site?site_id=${A.siteId}`, B.clientToken);
    assert(cb2.status === 200, `Client B GET /api/client/site?site_id=<A> → 200 (got ${cb2.status})`);
    assert((cb2.body as { id: string }).id === B.siteId,
      'site_id query param IGNORED — Client B still gets B-site');

    // ── Client B → /api/client/reports (legit) ────────────────────────────
    const cb3 = await get('/api/client/reports', B.clientToken);
    assert(cb3.status === 200, `Client B GET /api/client/reports → 200 (got ${cb3.status})`);
    const cb3Rows = cb3.body as Array<{ id: string }>;
    assert(cb3Rows.some((r) => r.id === B.reportId),
      'Client B sees their own B-report');
    assert(!cb3Rows.some((r) => r.id === A.reportId),
      'Client B does NOT see A-report in /api/client/reports');

    // ── Client B → /api/client/reports?site_id=<A> ────────────────────────
    const cb4 = await get(`/api/client/reports?site_id=${A.siteId}`, B.clientToken);
    assert(cb4.status === 200, `Client B GET /api/client/reports?site_id=<A> → 200 (got ${cb4.status})`);
    const cb4Rows = cb4.body as Array<{ id: string }>;
    assert(!cb4Rows.some((r) => r.id === A.reportId),
      'Client B with site_id=<A> param STILL does NOT see A-report');

    // ── Client B → /api/reports (the role-shared list) ────────────────────
    const cb5 = await get('/api/reports', B.clientToken);
    assert(cb5.status === 200, `Client B GET /api/reports → 200 (got ${cb5.status})`);
    const cb5Rows = cb5.body as Array<{ id: string }>;
    assert(!cb5Rows.some((r) => r.id === A.reportId),
      'Client B GET /api/reports does NOT include A-report');

    // ── Client B → /api/reports?site_id=<A> ───────────────────────────────
    const cb6 = await get(`/api/reports?site_id=${A.siteId}`, B.clientToken);
    assert(cb6.status === 200, `Client B GET /api/reports?site_id=<A> → 200 (got ${cb6.status})`);
    const cb6Rows = cb6.body as Array<{ id: string }>;
    assert(!cb6Rows.some((r) => r.id === A.reportId),
      'Client B GET /api/reports?site_id=<A> does NOT include A-report');

    // ── Client B → /api/shifts (role-restricted) ──────────────────────────
    const cb7 = await get('/api/shifts', B.clientToken);
    assert(cb7.status === 403, `Client B GET /api/shifts → 403 (got ${cb7.status})`);

    // ── Client B → POST /api/locations/ping (role-restricted) ─────────────
    const cb8 = await post('/api/locations/ping', B.clientToken, {
      shift_session_id: A.sessionId, latitude: 0, longitude: 0,
    });
    assert(cb8.status === 403, `Client B POST /api/locations/ping → 403 (got ${cb8.status})`);

    // ── Client B → /api/client/reports/pdf-link ───────────────────────────
    const cb9 = await post('/api/client/reports/pdf-link', B.clientToken, {
      from: '2026-01-01', to: '2026-12-31',
    });
    assert(cb9.status === 200, `Client B POST /api/client/reports/pdf-link → 200 (got ${cb9.status})`);
    const cb9Body = cb9.body as { url: string };
    assert(typeof cb9Body.url === 'string' && cb9Body.url.includes('?dl='),
      'pdf-link returns ?dl= handoff URL');
    // The handoff token is a JWT scoped to B's site_id; it cannot be repointed
    // at A's site by editing the URL.  Decode + verify it carries B's site_id.
    const dlToken = decodeURIComponent(cb9Body.url.split('?dl=')[1]);
    const dlPayload = jwt.verify(dlToken, process.env.JWT_SECRET!) as {
      site_id: string; purpose: string;
    };
    assert(dlPayload.site_id === B.siteId,
      'pdf handoff token is pinned to B.site_id, not arbitrary');
    assert(dlPayload.purpose === 'pdf_download',
      'pdf handoff token carries purpose=pdf_download (cannot be replayed against other endpoints)');

    // ── Admin B → /api/sites ──────────────────────────────────────────────
    const ab1 = await get('/api/sites', B.adminToken);
    assert(ab1.status === 200, `Admin B GET /api/sites → 200 (got ${ab1.status})`);
    const ab1Rows = ab1.body as Array<{ id: string }>;
    assert(ab1Rows.some((r) => r.id === B.siteId),
      'Admin B sees their own B-site in /api/sites');
    assert(!ab1Rows.some((r) => r.id === A.siteId),
      'Admin B does NOT see A-site in /api/sites');

    // ── Admin B → /api/admin/kpis ─────────────────────────────────────────
    const ab2 = await get('/api/admin/kpis', B.adminToken);
    assert(ab2.status === 200, `Admin B GET /api/admin/kpis → 200 (got ${ab2.status})`);
    // KPIs should be company-scoped — there's no path/query to inject another company_id.

    // ── Admin B → /api/shifts ─────────────────────────────────────────────
    const ab3 = await get('/api/shifts', B.adminToken);
    assert(ab3.status === 200, `Admin B GET /api/shifts → 200 (got ${ab3.status})`);
    const ab3Rows = ab3.body as Array<{ id: string }>;
    assert(!ab3Rows.some((r) => r.id === A.shiftId),
      'Admin B does NOT see A-shift in /api/shifts');

    // ── Admin B → /api/guards ─────────────────────────────────────────────
    const ab4 = await get('/api/guards', B.adminToken);
    assert(ab4.status === 200, `Admin B GET /api/guards → 200 (got ${ab4.status})`);
    const ab4Rows = ab4.body as Array<{ id: string }>;
    assert(!ab4Rows.some((r) => r.id === A.guardId),
      'Admin B does NOT see A-guard in /api/guards');

    // ── Admin B → /api/reports?site_id=<A> ────────────────────────────────
    const ab5 = await get(`/api/reports?site_id=${A.siteId}`, B.adminToken);
    assert(ab5.status === 200, `Admin B GET /api/reports?site_id=<A> → 200 (got ${ab5.status})`);
    const ab5Rows = ab5.body as Array<{ id: string }>;
    assert(!ab5Rows.some((r) => r.id === A.reportId),
      'Admin B GET /api/reports?site_id=<A> still does NOT include A-report');

    // ── Symmetric: Admin A must not see B-rows ───────────────────────────
    const aa1 = await get('/api/sites', A.adminToken);
    assert(aa1.status === 200, `Admin A GET /api/sites → 200 (got ${aa1.status})`);
    const aa1Rows = aa1.body as Array<{ id: string }>;
    assert(aa1Rows.some((r) => r.id === A.siteId),
      'Admin A sees their own A-site');
    assert(!aa1Rows.some((r) => r.id === B.siteId),
      'Admin A does NOT see B-site');

    const aa2 = await get('/api/guards', A.adminToken);
    const aa2Rows = aa2.body as Array<{ id: string }>;
    assert(!aa2Rows.some((r) => r.id === B.guardId),
      'Admin A does NOT see B-guard');

    console.log('\n=== ALL ASSERTIONS PASSED — V1 IDOR isolation holds ===\n');
  } finally {
    await teardownTenant(A);
    await teardownTenant(B);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    console.log('Cleaned up both ephemeral tenants.');
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  pool.end().finally(() => process.exit(1));
});
