/**
 * test-incident-photo-rule.ts — proves V5 / CB C6 fix (audit/WEEK1.md §C6).
 *
 * Before fix: POST /api/reports with report_type='incident' and no
 * photo_urls silently succeeded.  That's how the 4 legacy rows in B1
 * ended up in prod.
 *
 * After fix: same request must fail with a 400 and a human message.
 * This test covers three cases against a live DB-backed app:
 *
 *   1. incident + 0 photos → 400 with error mentioning camera/photo
 *   2. incident + 1 photo  → 201 (sanity: rule isn't over-blocking)
 *   3. activity + 0 photos → 201 (rule scoped to incident only)
 *
 * Seeds an ephemeral shift + open shift_session for a real guard,
 * exercises the endpoint, then deletes the report rows and the
 * ephemeral fixture.  Safe to run against prod DB.
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-incident-photo-rule.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md §C6)
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
  const g = await pool.query('SELECT id, company_id FROM guards LIMIT 1');
  if (!g.rows[0]) throw new Error('No guards in DB');
  const guardId = g.rows[0].id as string;
  const s = await pool.query('SELECT id FROM sites WHERE company_id = $1 LIMIT 1', [g.rows[0].company_id]);
  if (!s.rows[0]) throw new Error('No sites');
  const siteId = s.rows[0].id as string;

  console.log(`\n=== test-incident-photo-rule — guard ${guardId.slice(0,8)}, site ${siteId.slice(0,8)} ===\n`);

  // Seed an ephemeral shift + open session
  const shift = await pool.query(
    `INSERT INTO shifts (site_id, guard_id, scheduled_start, scheduled_end, status)
     VALUES ($1, $2, NOW() - INTERVAL '10 minutes', NOW() + INTERVAL '4 hours', 'active')
     RETURNING id`,
    [siteId, guardId]
  );
  const shiftId = shift.rows[0].id as string;

  const session = await pool.query(
    `INSERT INTO shift_sessions (shift_id, guard_id, site_id, clocked_in_at, clock_in_coords)
     VALUES ($1, $2, $3, NOW() - INTERVAL '5 minutes', '0,0')
     RETURNING id`,
    [shiftId, guardId, siteId]
  );
  const sessionId = session.rows[0].id as string;
  console.log(`Seeded shift ${shiftId.slice(0,8)} + session ${sessionId.slice(0,8)}\n`);

  const { default: app } = await import('../src/index');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server addr');
  const base = `http://127.0.0.1:${addr.port}`;

  const createdReportIds: string[] = [];

  try {
    const token = jwt.sign(
      { sub: guardId, role: 'guard', company_id: g.rows[0].company_id, jti: uuidv4() },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    // ── 1. Incident + 0 photos must 400 ──────────────────────────────────
    const badRes = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        shift_session_id: sessionId,
        report_type: 'incident',
        description: 'Test: suspicious individual',
        severity: 'low',
        photo_urls: [],
      }),
    });
    assert(badRes.status === 400,
      `incident + 0 photos returns 400 (got ${badRes.status})`);
    const badBody = (await badRes.json()) as { error?: string };
    assert(/photo|camera/i.test(badBody.error ?? ''),
      '400 body mentions photo/camera requirement');

    // ── 2. Incident + 1 photo at a non-bucket URL must be rejected by D2
    // (audit/WEEK1.md §D2 — photo_urls must point at the configured S3
    // bucket so we can fetch + magic-byte-validate them).  Before D2
    // this returned 201; after D2 it 400s on the URL-origin check.  This
    // assertion proves both:
    //   (a) the C6 photo-required rule didn't over-fire — it allowed a
    //       1-photo request through the count check, and
    //   (b) D2 caught the suspicious URL before any DB row was INSERTed.
    // The live "201 happy path with a real S3 object" is covered by
    // scripts/test-incident-photo-rule-live.ts on Railway (real AWS creds).
    const badUrlRes = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        shift_session_id: sessionId,
        report_type: 'incident',
        description: 'Test: suspicious individual with photo',
        severity: 'low',
        photo_urls: [{ url: 'https://example.com/fake.jpg', size_kb: 100 }],
      }),
    });
    assert(badUrlRes.status === 400,
      `incident with non-bucket photo URL returns 400 from D2 (got ${badUrlRes.status})`);
    const badUrlBody = (await badUrlRes.json()) as { error?: string };
    assert(/bucket|storage/i.test(badUrlBody.error ?? ''),
      'D2 400 body mentions bucket/storage origin requirement');

    // ── 3. Activity + 0 photos must still succeed ────────────────────────
    const actRes = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        shift_session_id: sessionId,
        report_type: 'activity',
        description: 'Test: routine patrol',
        photo_urls: [],
      }),
    });
    assert(actRes.status === 201,
      `activity + 0 photos returns 201 (rule scoped to incident only, got ${actRes.status})`);
    const actBody = (await actRes.json()) as { id?: string };
    if (actBody.id) createdReportIds.push(actBody.id);

    // ── 4. Incident with missing photo_urls key (undefined) → 400 ────────
    const missingRes = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        shift_session_id: sessionId,
        report_type: 'incident',
        description: 'Test: no photo_urls key at all',
        severity: 'low',
      }),
    });
    assert(missingRes.status === 400,
      `incident without photo_urls field returns 400 (got ${missingRes.status})`);

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    // Clean up in dependency order
    if (createdReportIds.length > 0) {
      await pool.query('DELETE FROM report_photos WHERE report_id = ANY($1::uuid[])', [createdReportIds]);
      await pool.query('DELETE FROM reports WHERE id = ANY($1::uuid[])', [createdReportIds]);
    }
    await pool.query('DELETE FROM shift_sessions WHERE id = $1', [sessionId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    console.log('Cleaned up shift + session + any created reports.');
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  pool.end().finally(() => process.exit(1));
});
