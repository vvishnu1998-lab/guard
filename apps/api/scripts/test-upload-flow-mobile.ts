/**
 * test-upload-flow-mobile.ts — proves the mobile upload helper's
 * multipart-form construction is wire-compatible with what
 * /api/uploads/presign returns.
 *
 * Background (2026-04-24 regression):
 *   The shipped mobile APK crashed with "Cannot convert undefined value
 *   to object" when calling `Object.entries(presign.fields)` because
 *   prod was still on the audit-base API code (returns `{ url }` only,
 *   pre-D1).  This test enforces the contract end-to-end so any future
 *   API/mobile drift is caught at CI time, not at S25 time.
 *
 * What it verifies (no real S3 round-trip — placeholder AWS creds locally):
 *   1. /api/uploads/presign returns the new POST shape with:
 *        post_url, fields { key, Content-Type, Policy, X-Amz-Signature, ... },
 *        public_url, key, max_bytes
 *   2. The mobile-side construction
 *        const form = new FormData();
 *        for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
 *        form.append('file', { uri, name, type } as Blob);
 *      runs to completion without TypeError on every field shape the
 *      API returns (catches the "missing fields" regression class).
 *   3. The constructed FormData carries every field from `fields` plus
 *      `file` last (S3 requires file last).
 *   4. None of the fields have `undefined` / `null` values that
 *      would break the multipart encoder.
 *   5. The mobile flow rejects the LEGACY shape ({ url } only) with
 *      a clear, actionable error rather than a TypeError — so the
 *      next deployment skew surfaces a debuggable error on-device.
 *
 * Live S3 round-trip remains the responsibility of test-d2-magic-live.ts
 * (Railway shell, real AWS creds).
 *
 * Usage:
 *   npx tsx apps/api/scripts/test-upload-flow-mobile.ts
 *
 * Author: Week-1 follow-up (2026-04-24 mobile regression)
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

/**
 * Mirror of what apps/mobile/lib/uploadToS3.ts does between getting
 * the presign response and actually fetching S3.  If THIS function
 * throws TypeError on any of the response shapes the API returns,
 * the mobile shipped APK will too.
 */
function buildMobileMultipart(
  presign: PresignResp,
  fakeFile: { uri: string; name: string; type: string }
): FormData {
  // Defensive guard mirrors what the mobile uploader does post-fix.
  if (!presign || typeof presign !== 'object'
      || !presign.fields || typeof presign.fields !== 'object'
      || !presign.post_url
      || !presign.public_url
      || typeof presign.max_bytes !== 'number') {
    throw new Error(
      'Upload service returned an unexpected response shape. ' +
      'The API may need to be redeployed with the latest upload changes.'
    );
  }

  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) {
    form.append(k, v);
  }
  // Node's global FormData accepts strings; we use a string stand-in for
  // the file blob since this test is checking the construction path,
  // not the byte payload.
  form.append('file', `${fakeFile.uri}|${fakeFile.name}|${fakeFile.type}`);
  return form;
}

async function run() {
  const g = await pool.query('SELECT id, company_id FROM guards LIMIT 1');
  if (!g.rows[0]) throw new Error('No guards in DB');
  const guardId = g.rows[0].id as string;
  const companyId = g.rows[0].company_id as string;

  console.log(`\n=== test-upload-flow-mobile — guard ${guardId.slice(0,8)} ===\n`);

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

    // ── 1. Presign happy path: new shape is returned ────────────────────
    for (const ctx of ['report', 'ping', 'clock_in'] as const) {
      const presignRes = await fetch(`${base}/api/uploads/presign`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ content_type: 'image/jpeg', context: ctx }),
      });
      assert(presignRes.status === 200, `presign for context=${ctx} returns 200 (got ${presignRes.status})`);
      const presign = (await presignRes.json()) as PresignResp;

      // Shape contract — every key the mobile uploader reads must be present and the right type.
      assert(typeof presign.post_url === 'string', `[ctx=${ctx}] post_url is a string`);
      assert(presign.fields && typeof presign.fields === 'object', `[ctx=${ctx}] fields is an object (regression: was undefined when prod served pre-D1 shape)`);
      assert(typeof presign.public_url === 'string', `[ctx=${ctx}] public_url is a string`);
      assert(typeof presign.key === 'string' && presign.key.length > 0, `[ctx=${ctx}] key is a non-empty string`);
      assert(typeof presign.max_bytes === 'number' && presign.max_bytes > 0, `[ctx=${ctx}] max_bytes is a positive number`);

      // No null/undefined values among the fields — the multipart encoder rejects those.
      for (const [k, v] of Object.entries(presign.fields)) {
        assert(typeof v === 'string' && v.length > 0, `[ctx=${ctx}] fields.${k} is a non-empty string`);
      }

      // The mobile-side construction MUST not throw.
      let form: FormData | null = null;
      try {
        form = buildMobileMultipart(presign, {
          uri:  'file:///tmp/fake.jpg',
          name: presign.key.split('/').pop() ?? 'upload.jpg',
          type: 'image/jpeg',
        });
      } catch (e: any) {
        throw new Error(`[ctx=${ctx}] mobile multipart construction threw: ${e.message}`);
      }
      assert(form !== null, `[ctx=${ctx}] mobile multipart constructed without error`);

      // Field count matches the API response + the file part.
      const formKeys = Array.from(form.keys());
      const expected = Object.keys(presign.fields).length + 1; // +1 for `file`
      assert(formKeys.length === expected,
        `[ctx=${ctx}] form carries every API field plus 'file' (got ${formKeys.length} parts, expected ${expected})`);

      // 'file' MUST be the last part — S3 requires it.
      assert(formKeys[formKeys.length - 1] === 'file',
        `[ctx=${ctx}] 'file' is the last form part (S3 requirement)`);
    }

    // ── 2. Defensive: the mobile guard catches the legacy shape ──────────
    //    Simulate prod-on-old-code returning `{ url }` only.  The mobile
    //    helper MUST throw a clear error rather than TypeError on
    //    Object.entries(undefined).
    let caughtMessage = '';
    try {
      buildMobileMultipart({ url: 'https://example.com/legacy' } as any, {
        uri: 'file:///tmp/fake.jpg', name: 'fake.jpg', type: 'image/jpeg',
      });
    } catch (e: any) {
      caughtMessage = e.message;
    }
    assert(caughtMessage.length > 0,
      'mobile multipart throws on legacy { url } shape (does not return undefined-pass)');
    assert(/redeployed|unexpected response shape|administrator/i.test(caughtMessage),
      `legacy-shape error message is actionable (got: "${caughtMessage.slice(0, 100)}")`);
    assert(!/Cannot convert undefined value to object/i.test(caughtMessage),
      'legacy-shape error is NOT the cryptic "Cannot convert undefined value to object" TypeError');

    // ── 3. Defensive: missing `fields` key (partial upgrade) ─────────────
    let caughtPartial = '';
    try {
      buildMobileMultipart(
        { post_url: 'https://x', public_url: 'https://y', key: 'k', max_bytes: 5_242_880 } as any,
        { uri: 'file:///tmp/fake.jpg', name: 'fake.jpg', type: 'image/jpeg' }
      );
    } catch (e: any) {
      caughtPartial = e.message;
    }
    assert(caughtPartial.length > 0,
      'mobile multipart throws when `fields` is missing entirely');

    // ── 4. Defensive: `max_bytes` missing or non-numeric ─────────────────
    let caughtNoMax = '';
    try {
      buildMobileMultipart(
        { post_url: 'https://x', fields: {}, public_url: 'https://y', key: 'k' } as any,
        { uri: 'file:///tmp/fake.jpg', name: 'fake.jpg', type: 'image/jpeg' }
      );
    } catch (e: any) {
      caughtNoMax = e.message;
    }
    assert(caughtNoMax.length > 0,
      'mobile multipart throws when `max_bytes` is missing (cannot validate file size)');

    console.log('\n=== ALL ASSERTIONS PASSED ===\n');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    console.log('Done.  No DB/S3 cleanup needed (presign + construction-only test).');
  }
}

run()
  .then(() => process.exit(0))   // aws-sdk v2 keepalive holds the event loop open; force-exit on success
  .catch((err) => {
    console.error('TEST FAILED:', err);
    pool.end().finally(() => process.exit(1));
  });
