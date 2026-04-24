/**
 * test-pdf-handoff.ts — proves CB5 fix (audit/WEEK1.md C4): long-lived
 * client JWTs no longer travel in the PDF download URL.
 *
 * What this covers:
 *   1. POST /api/client/reports/pdf-link (Authorization: Bearer <client JWT>)
 *      returns { url, expires_in=60 } where url carries `?dl=<short token>`
 *      and does NOT carry the full access JWT.
 *   2. GET /api/client/reports/pdf?dl=<good handoff> succeeds (200, PDF
 *      content-type).
 *   3. GET /api/client/reports/pdf?dl=<tampered> fails (401).
 *   4. GET /api/client/reports/pdf?dl=<wrong-purpose> fails (403).
 *   5. GET /api/client/reports/pdf?dl=<expired> fails (401).
 *   6. GET /api/client/reports/pdf?token=<any> returns 410 Gone
 *      (legacy param explicitly retired).
 *   7. GET /api/client/reports/pdf with Authorization: Bearer still works
 *      (useful fallback for server-to-server).
 *
 * The script boots the Express app in-process on an ephemeral port,
 * uses a real `client` role JWT minted against the live DB's first site,
 * and talks to the API via fetch.  No real user data is touched.
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-pdf-handoff.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md, C4)
 */
import 'dotenv/config';
import http from 'http';
import jwt from 'jsonwebtoken';
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

async function pickSite(): Promise<{ siteId: string; clientId: string }> {
  // Find a site with at least one client row so we can mint a real client JWT.
  const r = await pool.query(
    `SELECT s.id AS site_id, c.id AS client_id
       FROM sites s JOIN clients c ON c.site_id = s.id
      LIMIT 1`
  );
  if (!r.rows[0]) throw new Error('No client row in DB; cannot test');
  return { siteId: r.rows[0].site_id, clientId: r.rows[0].client_id };
}

async function run() {
  const { siteId, clientId } = await pickSite();
  console.log(`\n=== test-pdf-handoff — client ${clientId.slice(0,8)}, site ${siteId.slice(0,8)} ===\n`);

  // Boot the app in-process on an ephemeral port.
  // We dynamically import so the env-var guard in index.ts sees our stub.
  const { default: app } = await import('../src/index');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server addr');
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`Spun up app on ${base}\n`);

  try {
    // Mint a real client JWT (same shape as login would)
    const clientJwt = jwt.sign(
      { sub: clientId, role: 'client', site_id: siteId },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    // ── 1. Happy path: POST pdf-link returns handoff URL ─────────────────
    const linkRes = await fetch(`${base}/api/client/reports/pdf-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${clientJwt}`,
      },
      body: JSON.stringify({ from: '2024-01-01T00:00:00', to: '2026-12-31T23:59:59' }),
    });
    assert(linkRes.status === 200, 'pdf-link POST returns 200 for client JWT');
    const linkBody = (await linkRes.json()) as { url: string; expires_in: number };
    assert(typeof linkBody.url === 'string' && linkBody.url.includes('?dl='),
      'response.url contains ?dl= handoff token');
    assert(!linkBody.url.includes(clientJwt),
      'response.url does NOT contain the long-lived client JWT');
    assert(linkBody.expires_in === 60,
      `expires_in = 60 (got ${linkBody.expires_in})`);

    // ── 2. GET with good handoff succeeds and streams a PDF ──────────────
    const pdfRes = await fetch(`${base}${linkBody.url}`);
    assert(pdfRes.status === 200, `GET ?dl=<good> returns 200 (got ${pdfRes.status})`);
    assert(pdfRes.headers.get('content-type') === 'application/pdf',
      'Content-Type is application/pdf');
    const head = new Uint8Array(await pdfRes.arrayBuffer()).slice(0, 5);
    assert(head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46,
      'response body starts with "%PDF" magic bytes');

    // ── 3. Tampered handoff → 401 ────────────────────────────────────────
    const tampered = linkBody.url.replace(/([A-Za-z0-9_-]{10})(?=\.)/, 'AAAAAAAAAA');
    const tamperedRes = await fetch(`${base}${tampered}`);
    assert(tamperedRes.status === 401,
      `tampered ?dl= returns 401 (got ${tamperedRes.status})`);

    // ── 4. Wrong-purpose token (signed with JWT_SECRET but missing
    //      purpose=pdf_download) → 403 ─────────────────────────────────────
    const wrongPurpose = jwt.sign(
      { sub: clientId, role: 'client', site_id: siteId },
      process.env.JWT_SECRET!,
      { expiresIn: 60 }
    );
    const wpRes = await fetch(`${base}/api/client/reports/pdf?dl=${encodeURIComponent(wrongPurpose)}`);
    assert(wpRes.status === 403,
      `wrong-purpose ?dl= returns 403 (got ${wpRes.status})`);

    // ── 5. Expired handoff → 401 ─────────────────────────────────────────
    const expired = jwt.sign(
      {
        sub: clientId,
        role: 'client',
        site_id: siteId,
        purpose: 'pdf_download',
        from: '2024-01-01T00:00:00',
        to: '2026-12-31T23:59:59',
      },
      process.env.JWT_SECRET!,
      { expiresIn: -10 } // already expired
    );
    const expRes = await fetch(`${base}/api/client/reports/pdf?dl=${encodeURIComponent(expired)}`);
    assert(expRes.status === 401,
      `expired ?dl= returns 401 (got ${expRes.status})`);

    // ── 6. Legacy ?token= param → 410 Gone ───────────────────────────────
    const legacyRes = await fetch(`${base}/api/client/reports/pdf?token=${clientJwt}`);
    assert(legacyRes.status === 410,
      `legacy ?token= returns 410 Gone (got ${legacyRes.status})`);
    const legacyBody = (await legacyRes.json()) as { error?: string };
    assert(/pdf-link/.test(legacyBody.error ?? ''),
      '410 body mentions pdf-link migration path');

    // ── 7. Authorization: Bearer fallback still works ────────────────────
    const bearerRes = await fetch(
      `${base}/api/client/reports/pdf?from=2024-01-01T00:00:00&to=2026-12-31T23:59:59`,
      { headers: { Authorization: `Bearer ${clientJwt}` } }
    );
    assert(bearerRes.status === 200,
      `Authorization: Bearer still works for GET (got ${bearerRes.status})`);
    assert(bearerRes.headers.get('content-type') === 'application/pdf',
      'Bearer fallback response is application/pdf');

    // ── 8. No auth at all → 401 ───────────────────────────────────────────
    const noAuthRes = await fetch(`${base}/api/client/reports/pdf`);
    assert(noAuthRes.status === 401,
      `no auth returns 401 (got ${noAuthRes.status})`);

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  pool.end().finally(() => process.exit(1));
});
