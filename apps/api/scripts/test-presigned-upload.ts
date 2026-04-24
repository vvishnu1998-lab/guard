/**
 * test-presigned-upload.ts — proves D1 fix (audit/WEEK1.md §D1).
 *
 * The fix replaces the PUT-presigned URL with createPresignedPost, whose
 * policy pins:
 *   - bucket
 *   - key (eq)
 *   - Content-Type (eq)
 *   - content-length-range [1, MAX_UPLOAD_BYTES]
 *
 * Local dev environment has placeholder AWS credentials (real keys live
 * on Railway), so this test does NOT attempt to upload to S3.  It does
 * the next-strongest thing: it base64-decodes the signed `Policy` field
 * returned by /api/uploads/presign and verifies the policy actually
 * contains the conditions above, with the right values.  Tampering or
 * removing any of those conditions produces an SHA mismatch at S3 (the
 * `X-Amz-Signature` is over the base64 policy bytes), so a policy that
 * decodes correctly is functionally equivalent to passing the live
 * round-trip — the S3 server-side validator only acts on what the
 * policy says.
 *
 * The live S3 round-trip (small upload → 204; 6 MiB upload → 4xx) is
 * documented as the manual verification step in WEEK1.md §D1, to be
 * executed on Railway where real AWS credentials are configured.
 *
 * Six things must hold:
 *   1. /api/uploads/presign returns a {post_url, fields, max_bytes} shape.
 *   2. fields includes key, Content-Type, Policy, X-Amz-Signature.
 *   3. The decoded policy's `conditions` array contains an `eq $key` clause
 *      pinning the exact key returned by the API.
 *   4. The decoded policy's conditions contain `eq $Content-Type image/jpeg`.
 *   5. The decoded policy's conditions contain `content-length-range, 1,
 *      5242880` — this is the V6 fix (no length cap was the original gap).
 *   6. /api/uploads/presign rejects an unknown context with 400, and an
 *      unknown content_type with 400 (defense in depth alongside the
 *      policy).
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-presigned-upload.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md §D1)
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

interface PresignResp {
  post_url:   string;
  fields:     Record<string, string>;
  public_url: string;
  key:        string;
  max_bytes:  number;
}

type PolicyCondition =
  | Record<string, string>           // { bucket: '...' }
  | [string, string, string]         // ['eq', '$key', 'value']
  | [string, number, number];        // ['content-length-range', 1, N]

interface DecodedPolicy {
  expiration: string;
  conditions: PolicyCondition[];
}

function decodePolicy(b64: string): DecodedPolicy {
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
}

async function run() {
  const g = await pool.query('SELECT id, company_id FROM guards LIMIT 1');
  if (!g.rows[0]) throw new Error('No guards in DB');
  const guardId = g.rows[0].id as string;
  const companyId = g.rows[0].company_id as string;

  console.log(`\n=== test-presigned-upload — guard ${guardId.slice(0,8)}, bucket ${process.env.S3_BUCKET} ===\n`);

  const { default: app } = await import('../src/index');
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server addr');
  const base = `http://127.0.0.1:${addr.port}`;
  console.log(`Spun up app on ${base}\n`);

  try {
    const token = jwt.sign(
      { sub: guardId, role: 'guard', company_id: companyId, jti: uuidv4() },
      process.env.JWT_SECRET!,
      { expiresIn: '1h' }
    );

    // ── 1. Presign endpoint shape ────────────────────────────────────────
    const presignRes = await fetch(`${base}/api/uploads/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content_type: 'image/jpeg', context: 'report' }),
    });
    assert(presignRes.status === 200, `presign returns 200 (got ${presignRes.status})`);
    const presign = (await presignRes.json()) as PresignResp;
    assert(typeof presign.post_url === 'string' && presign.post_url.includes(process.env.S3_BUCKET!),
      'response carries a post_url pointing at the bucket');
    assert(presign.fields && typeof presign.fields.key === 'string',
      'response carries fields.key');
    assert(presign.fields['Content-Type'] === 'image/jpeg',
      'response carries fields.Content-Type pinned to image/jpeg');
    assert(typeof presign.fields.Policy === 'string' && presign.fields.Policy.length > 100,
      'response carries a base64 Policy field (capital P, SigV4)');
    assert(typeof presign.fields['X-Amz-Signature'] === 'string',
      'response carries an X-Amz-Signature field (SigV4)');
    assert(presign.max_bytes === 5 * 1024 * 1024,
      `max_bytes is 5 MiB (got ${presign.max_bytes})`);
    assert(presign.key.startsWith(`report/${companyId}/`),
      'key is namespaced under report/<company_id>/');

    // ── 2. Decoded policy enforces what we want ──────────────────────────
    const policy = decodePolicy(presign.fields.Policy);
    assert(Array.isArray(policy.conditions) && policy.conditions.length >= 4,
      `policy.conditions is a non-trivial array (got ${policy.conditions?.length} entries)`);

    const keyEq = policy.conditions.find(
      (c) => Array.isArray(c) && c[0] === 'eq' && c[1] === '$key'
    ) as [string, string, string] | undefined;
    assert(keyEq && keyEq[2] === presign.key,
      `policy contains [eq, $key, "${presign.key}"]`);

    const ctEq = policy.conditions.find(
      (c) => Array.isArray(c) && c[0] === 'eq' && c[1] === '$Content-Type'
    ) as [string, string, string] | undefined;
    assert(ctEq && ctEq[2] === 'image/jpeg',
      'policy contains [eq, $Content-Type, "image/jpeg"]');

    const lenRange = policy.conditions.find(
      (c) => Array.isArray(c) && c[0] === 'content-length-range'
    ) as [string, number, number] | undefined;
    assert(lenRange && lenRange[1] === 1 && lenRange[2] === 5 * 1024 * 1024,
      `policy contains [content-length-range, 1, 5242880] (got [${lenRange?.[1]}, ${lenRange?.[2]}])`);

    const bucketCond = policy.conditions.find(
      (c) => !Array.isArray(c) && typeof (c as Record<string, string>).bucket === 'string'
    ) as Record<string, string> | undefined;
    assert(bucketCond && bucketCond.bucket === process.env.S3_BUCKET,
      `policy contains { bucket: "${process.env.S3_BUCKET}" }`);

    // ── 3. Defense-in-depth: bad inputs rejected pre-policy ──────────────
    const badContextRes = await fetch(`${base}/api/uploads/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content_type: 'image/jpeg', context: '../../etc/passwd' }),
    });
    assert(badContextRes.status === 400,
      `unknown context returns 400 (got ${badContextRes.status})`);

    const badTypeRes = await fetch(`${base}/api/uploads/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content_type: 'application/octet-stream', context: 'report' }),
    });
    assert(badTypeRes.status === 400,
      `unknown content_type returns 400 (got ${badTypeRes.status})`);

    // ── 4. Anonymous request must 401 (presign is a guard-only endpoint) ─
    const anonRes = await fetch(`${base}/api/uploads/presign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content_type: 'image/jpeg', context: 'report' }),
    });
    assert(anonRes.status === 401,
      `anonymous presign returns 401 (got ${anonRes.status})`);

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    console.log('Done.  No DB/S3 cleanup needed (presign-only test).');
  }
}

run().catch((err) => {
  console.error('TEST FAILED:', err);
  pool.end().finally(() => process.exit(1));
});
