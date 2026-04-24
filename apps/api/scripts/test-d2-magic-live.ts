/**
 * test-d2-magic-live.ts — D2 live S3 round-trip (Railway-only).
 *
 * Run from a Railway shell where AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
 * AWS_REGION, and S3_BUCKET are real (not the placeholder values
 * shipped in the local dev .env).
 *
 * Exercises the full D1 + D2 flow against live S3 + live DB:
 *
 *   1. Mint a guard token; call /api/uploads/presign for image/jpeg.
 *   2. Direct-POST a real JPEG (FF D8 FF + filler) to S3 → 204.
 *   3. POST /api/reports with that S3 URL → 201 (D2 fetched bytes,
 *      magic matched, report INSERTed).
 *   4. Direct-POST a fake JPEG (text payload labelled image/jpeg) →
 *      S3 still returns 204 (S3 doesn't sniff bytes — D1's job ends
 *      with size + declared MIME).
 *   5. POST /api/reports with that fake URL → 400 with the D2
 *      "Uploaded file is not a valid image/jpeg (detected: hex:…)"
 *      message; quarantined_uploads has a row attributing the
 *      attempt to the test guard.
 *   6. Cleanup: delete both S3 objects, the report row, the
 *      ephemeral shift/session, and the quarantined_uploads row.
 *
 * Usage (from Railway shell):
 *   npx ts-node apps/api/scripts/test-d2-magic-live.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md §D2)
 */
import 'dotenv/config';
import http from 'http';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import AWS from 'aws-sdk';

if (!process.env.ALLOWED_ORIGINS) {
  process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
}

if (!process.env.AWS_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID.startsWith('REPLACE_')) {
  console.error(
    'AWS_ACCESS_KEY_ID is unset or a placeholder.  This script must run from\n' +
    'a Railway shell with real AWS credentials — see audit/WEEK1.md §D2.'
  );
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : undefined,
});

const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});
const BUCKET = process.env.S3_BUCKET!;

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

interface PresignResp {
  post_url: string;
  fields: Record<string, string>;
  public_url: string;
  key: string;
}

async function postMultipart(url: string, fields: Record<string, string>, body: Uint8Array, mime = 'image/jpeg'): Promise<{status: number; body: string}> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([body], { type: mime }), 'upload.jpg');
  const r = await fetch(url, { method: 'POST', body: form });
  return { status: r.status, body: await r.text() };
}

async function run() {
  const g = await pool.query('SELECT id, company_id FROM guards LIMIT 1');
  if (!g.rows[0]) throw new Error('No guards in DB');
  const { id: guardId, company_id: companyId } = g.rows[0];
  const s = await pool.query('SELECT id FROM sites WHERE company_id = $1 LIMIT 1', [companyId]);
  if (!s.rows[0]) throw new Error('No sites');
  const siteId = s.rows[0].id as string;

  console.log(`\n=== test-d2-magic-live — guard ${guardId.slice(0,8)}, bucket ${BUCKET} ===\n`);

  // Seed ephemeral shift + open session
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

  const { default: app } = await import('../src/index');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address() as { port: number };
  const base = `http://127.0.0.1:${addr.port}`;

  const uploadedKeys: string[] = [];
  const createdReportIds: string[] = [];

  try {
    const token = jwt.sign(
      { sub: guardId, role: 'guard', company_id: companyId, jti: uuidv4() },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    // ── 1. Real JPEG round-trip ──────────────────────────────────────────
    const p1 = await fetch(`${base}/api/uploads/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content_type: 'image/jpeg', context: 'report' }),
    });
    const presign1 = (await p1.json()) as PresignResp;
    const realJpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]),
      Buffer.alloc(500, 0x00), // filler
    ]);
    const up1 = await postMultipart(presign1.post_url, presign1.fields, realJpeg);
    assert(up1.status === 204, `real JPEG upload returns 204 (got ${up1.status})`);
    uploadedKeys.push(presign1.key);

    const r1 = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        shift_session_id: sessionId,
        report_type: 'incident',
        description: 'D2 live: real jpeg',
        severity: 'low',
        photo_urls: [{ url: presign1.public_url, size_kb: Math.round(realJpeg.length / 1024) }],
      }),
    });
    assert(r1.status === 201, `incident with real JPEG returns 201 (got ${r1.status})`);
    const r1Body = (await r1.json()) as { id?: string };
    if (r1Body.id) createdReportIds.push(r1Body.id);

    // ── 2. Fake JPEG (text bytes) → quarantine + 400 ─────────────────────
    const p2 = await fetch(`${base}/api/uploads/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content_type: 'image/jpeg', context: 'report' }),
    });
    const presign2 = (await p2.json()) as PresignResp;
    const fakeJpeg = Buffer.from('hello world this is text not jpeg', 'utf8');
    const up2 = await postMultipart(presign2.post_url, presign2.fields, fakeJpeg);
    assert(up2.status === 204,
      `fake JPEG upload returns 204 from S3 (S3 trusts the declared type — proves D1 alone is not enough)`);
    uploadedKeys.push(presign2.key);

    const r2 = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        shift_session_id: sessionId,
        report_type: 'incident',
        description: 'D2 live: fake jpeg',
        severity: 'low',
        photo_urls: [{ url: presign2.public_url, size_kb: 1 }],
      }),
    });
    assert(r2.status === 400,
      `incident with fake JPEG bytes returns 400 from D2 (got ${r2.status})`);
    const r2Body = (await r2.json()) as { error?: string };
    assert(/not a valid image\/jpeg|detected:/i.test(r2Body.error ?? ''),
      'D2 400 body identifies the mismatch');

    const q = await pool.query(
      `SELECT s3_key, declared_content_type, detected_magic
         FROM quarantined_uploads
        WHERE s3_key = $1 AND guard_id = $2`,
      [presign2.key, guardId]
    );
    assert(q.rows.length === 1,
      'quarantined_uploads has exactly one row for the rejected upload');
    assert(q.rows[0].declared_content_type === 'image/jpeg',
      'quarantine row records declared_content_type = image/jpeg');
    assert(q.rows[0].detected_magic.startsWith('hex:') || q.rows[0].detected_magic === 'html',
      `quarantine row records detected_magic = "${q.rows[0].detected_magic}"`);

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    if (createdReportIds.length > 0) {
      await pool.query('DELETE FROM report_photos WHERE report_id = ANY($1::uuid[])', [createdReportIds]);
      await pool.query('DELETE FROM reports WHERE id = ANY($1::uuid[])', [createdReportIds]);
    }
    await pool.query('DELETE FROM quarantined_uploads WHERE guard_id = $1 AND s3_key = ANY($2::text[])',
      [guardId, uploadedKeys]);
    for (const k of uploadedKeys) {
      await s3.deleteObject({ Bucket: BUCKET, Key: k }).promise().catch(() => {});
    }
    await pool.query('DELETE FROM shift_sessions WHERE id = $1', [sessionId]);
    await pool.query('DELETE FROM shifts WHERE id = $1', [shiftId]);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    console.log(`Cleaned up ${uploadedKeys.length} S3 object(s), 1 shift, 1 session, ${createdReportIds.length} report(s).`);
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  pool.end().finally(() => process.exit(1));
});
