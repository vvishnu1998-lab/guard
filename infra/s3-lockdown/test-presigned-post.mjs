// Simulates the mobile-side flow: API mints a presigned POST policy via
// aws-sdk createPresignedPost; the "client" then POSTs multipart/form-data
// at S3. This proves PR4 doesn't break the upload path even after the
// bucket flips private.
//
// Run AFTER PR4-dress-rehearsal.sh has locked down the test bucket:
//   cd apps/api && node ../../infra/s3-lockdown/test-presigned-post.mjs

import AWS from 'aws-sdk';
import { randomUUID } from 'node:crypto';

const BUCKET = 'guard-media-prod-flip-test';
const REGION = 'us-east-1';
const KEY    = `dress-rehearsal/${randomUUID()}.jpg`;
const TYPE   = 'image/jpeg';

const s3 = new AWS.S3({ region: REGION });

function presignPost() {
  return new Promise((resolve, reject) => {
    s3.createPresignedPost(
      {
        Bucket: BUCKET,
        Fields: { key: KEY, 'Content-Type': TYPE },
        Conditions: [
          { bucket: BUCKET },
          ['eq', '$key', KEY],
          ['eq', '$Content-Type', TYPE],
          ['content-length-range', 1, 5 * 1024 * 1024],
        ],
        Expires: 300,
      },
      (err, data) => (err ? reject(err) : resolve(data)),
    );
  });
}

// 16 bytes of fake JPEG (SOI marker + filler)
const fakeJpeg = Buffer.from([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
]);

const presigned = await presignPost();
console.log('  presigned URL:', presigned.url);
console.log('  fields:       ', Object.keys(presigned.fields).join(', '));

const form = new FormData();
for (const [k, v] of Object.entries(presigned.fields)) form.append(k, v);
form.append('file', new Blob([fakeJpeg], { type: TYPE }), 'rehearsal.jpg');

const res = await fetch(presigned.url, { method: 'POST', body: form });
const body = await res.text();
console.log('  S3 response:  ', res.status, body.slice(0, 120).replace(/\s+/g, ' '));

if (res.status !== 204) {
  console.error('  FAIL upload — expected 204, got', res.status);
  process.exit(1);
}
console.log('  ok            upload succeeded → 204');

const head = await s3.headObject({ Bucket: BUCKET, Key: KEY }).promise();
console.log('  ok            object exists, size =', head.ContentLength, 'bytes');

await s3.deleteObject({ Bucket: BUCKET, Key: KEY }).promise();
console.log('  ok            test object deleted');

console.log('\nPRESIGNED-POST UPLOAD VERIFIED on locked-down test bucket.');
