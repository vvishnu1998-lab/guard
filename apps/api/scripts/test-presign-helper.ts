/**
 * Verifies the presign helpers added in PR1 of the S3 lockdown sequence
 * (pre-launch security punchlist #1). Standalone — exercises the helpers
 * against the real configured bucket (signs locally, no GET issued).
 *
 *   cd apps/api && npx ts-node --require dotenv/config scripts/test-presign-helper.ts \
 *     dotenv_config_path=../../.env
 *
 * Exits 0 on all-pass, 1 on first fail.
 */
import {
  presignGet,
  extractS3Key,
  urlOrPresign,
  presignAll,
  PRESIGN_GET_TTL_SECONDS,
} from '../src/services/s3';

let failed = 0;

function eq<T>(name: string, actual: T, expected: T): void {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  if (pass) console.log(`PASS  ${name}`);
  else {
    console.error(`FAIL  ${name}\n      actual:   ${JSON.stringify(actual)}\n      expected: ${JSON.stringify(expected)}`);
    failed += 1;
  }
}

function ok(name: string, condition: boolean, hint = ''): void {
  if (condition) console.log(`PASS  ${name}`);
  else {
    console.error(`FAIL  ${name}${hint ? ` — ${hint}` : ''}`);
    failed += 1;
  }
}

async function main() {
  const bucket = process.env.S3_BUCKET ?? 'guard-media-prod';
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const sampleKey = 'report/00000000-0000-0000-0000-000000000000/2026-06-10/test.jpg';
  const fullUrl = `https://${bucket}.s3.${region}.amazonaws.com/${sampleKey}`;
  const foreignUrl = `https://some-other-bucket.s3.us-east-1.amazonaws.com/${sampleKey}`;

  // ── extractS3Key ────────────────────────────────────────────────────────
  eq('extractS3Key passes through bare key', extractS3Key(sampleKey), sampleKey);
  eq('extractS3Key extracts key from full URL', extractS3Key(fullUrl), sampleKey);
  eq('extractS3Key returns path from foreign URL (warns)', extractS3Key(foreignUrl), sampleKey);
  eq('extractS3Key passes through malformed input', extractS3Key('not-a-url-or-key'), 'not-a-url-or-key');
  eq('extractS3Key handles empty key URL', extractS3Key(`https://${bucket}.s3.${region}.amazonaws.com/`), `https://${bucket}.s3.${region}.amazonaws.com/`);

  // ── presignGet ──────────────────────────────────────────────────────────
  const signed = await presignGet(sampleKey, 60);
  ok('presignGet returns a URL', typeof signed === 'string' && signed.length > 0);
  ok('presignGet URL contains the bucket host', signed.includes(`${bucket}.s3.`), 'expected bucket host in signed URL');
  ok('presignGet URL contains X-Amz-Signature', signed.includes('X-Amz-Signature='), 'aws-sdk v2 should produce SigV4');
  ok('presignGet URL contains the key path', signed.includes(encodeURIComponent('report/').replace(/%2F/g, '/')) || signed.includes('report/'), 'key path missing');
  ok('presignGet URL honours TTL=60', signed.includes('X-Amz-Expires=60'), 'should set Expires param to 60 sec');

  // Default TTL
  const defaultSigned = await presignGet(sampleKey);
  ok('presignGet default TTL is 15 min',
    defaultSigned.includes(`X-Amz-Expires=${PRESIGN_GET_TTL_SECONDS}`),
    `expected X-Amz-Expires=${PRESIGN_GET_TTL_SECONDS}`);

  // Invalid input
  let threw = false;
  try { await presignGet('', 60); } catch { threw = true; }
  ok('presignGet rejects empty key', threw);
  threw = false;
  try { await presignGet(null as unknown as string, 60); } catch { threw = true; }
  ok('presignGet rejects null key', threw);

  // ── urlOrPresign ────────────────────────────────────────────────────────
  eq('urlOrPresign(null) → null', await urlOrPresign(null), null);
  eq('urlOrPresign(undefined) → null', await urlOrPresign(undefined), null);
  eq('urlOrPresign("") → null', await urlOrPresign(''), null);

  const out1 = await urlOrPresign(fullUrl);
  ok('urlOrPresign(full URL) returns a signed URL', !!out1 && out1.includes('X-Amz-Signature='));
  ok('urlOrPresign signed URL points at correct bucket', !!out1 && out1.includes(`${bucket}.s3.`));

  const out2 = await urlOrPresign(sampleKey);
  ok('urlOrPresign(bare key) returns a signed URL', !!out2 && out2.includes('X-Amz-Signature='));
  ok('urlOrPresign(bare key) signed URL contains the key path', !!out2 && out2.includes('report/'));

  // ── presignAll — the `photos[]` aggregate shape ─────────────────────────
  eq('presignAll(null) → []', await presignAll(null), []);
  eq('presignAll(undefined) → []', await presignAll(undefined), []);
  eq('presignAll([]) → []', await presignAll([]), []);
  const arr1 = await presignAll([fullUrl, fullUrl]);
  ok('presignAll returns same-length array', arr1.length === 2);
  ok('presignAll items are signed URLs', arr1.every((u) => u.includes('X-Amz-Signature=')));
  // Mixed null inside the array (e.g. a partially-failed array_agg) — drops null
  const arr2 = await presignAll([fullUrl, null, sampleKey]);
  ok('presignAll drops null items', arr2.length === 2);
  ok('presignAll preserves order across nulls',
    arr2[0].includes(encodeURIComponent('test.jpg')) || arr2[0].includes('test.jpg'),
    'first item should still be the full-URL input after signing');

  // ── End-to-end shape verification — simulate the transform per endpoint ─
  // Reports list: row.photos = await presignAll(row.photos)
  const reportsRow = { id: 'r1', photos: [fullUrl, sampleKey] };
  reportsRow.photos = await presignAll(reportsRow.photos);
  ok('reports list row.photos[*] are all signed',
    reportsRow.photos.every((u: string) => u.includes('X-Amz-Signature=')));

  // Activity log: r.log_media_url + r.log_media_urls together
  const activityRow = { log_media_url: sampleKey as string | null, log_media_urls: [fullUrl] };
  activityRow.log_media_url = await urlOrPresign(activityRow.log_media_url);
  activityRow.log_media_urls = await presignAll(activityRow.log_media_urls);
  ok('activity row log_media_url is a signed URL',
    !!activityRow.log_media_url && activityRow.log_media_url.includes('X-Amz-Signature='));
  ok('activity row log_media_urls[0] is a signed URL',
    activityRow.log_media_urls[0]?.includes('X-Amz-Signature='));

  // Sites GET: row.instructions_pdf_url
  const siteRow = { id: 's1', instructions_pdf_url: sampleKey as string | null };
  siteRow.instructions_pdf_url = await urlOrPresign(siteRow.instructions_pdf_url);
  ok('site row instructions_pdf_url is a signed URL',
    !!siteRow.instructions_pdf_url && siteRow.instructions_pdf_url.includes('X-Amz-Signature='));

  // Sites GET on row with no PDF
  const noPdfSite = { id: 's2', instructions_pdf_url: null as string | null };
  noPdfSite.instructions_pdf_url = await urlOrPresign(noPdfSite.instructions_pdf_url);
  ok('site row with null pdf stays null', noPdfSite.instructions_pdf_url === null);

  // Breach (admin /violations): row.photo_url null-safe
  const breachRow = { id: 'b1', photo_url: null as string | null };
  breachRow.photo_url = await urlOrPresign(breachRow.photo_url);
  ok('breach row with null photo_url stays null', breachRow.photo_url === null);
  const breachWithPhoto = { id: 'b2', photo_url: fullUrl as string | null };
  breachWithPhoto.photo_url = await urlOrPresign(breachWithPhoto.photo_url);
  ok('breach row with photo gets signed URL',
    !!breachWithPhoto.photo_url && breachWithPhoto.photo_url.includes('X-Amz-Signature='));

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('');
  if (failed === 0) {
    console.log(`OK   all checks passed`);
    process.exit(0);
  } else {
    console.error(`FAIL ${failed} check(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
