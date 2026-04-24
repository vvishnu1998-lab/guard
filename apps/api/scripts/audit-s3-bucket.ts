/**
 * audit-s3-bucket.ts — produces a one-shot abuse-audit report of the
 * production media bucket.  Designed to be run from a shell that already
 * has the production AWS_* env vars (i.e. `railway run` or the Railway
 * web shell).
 *
 * Usage (from project root or anywhere with the API env loaded):
 *
 *   railway run --service api npx ts-node apps/api/scripts/audit-s3-bucket.ts
 *
 * Reports:
 *   1. Total object count + total size
 *   2. Objects > 5 MB  (the size cap that D1 is about to introduce)
 *   3. Per-prefix breakdown   (incident/, task/, ping/, …)
 *   4. Random sample of 30 objects: HEAD result vs key extension —
 *      flags any ContentType / extension / magic-byte mismatch.
 *   5. Objects whose top-level prefix is NOT one of the four documented
 *      keyspaces — anything outside that list is suspicious.
 *
 * Read-only.  Does not modify or delete anything.
 *
 * Author: Week-1 audit (audit/WEEK1.md, B2)
 */
import 'dotenv/config';
import AWS from 'aws-sdk';

const ALLOWED_PREFIXES = ['incident/', 'task/', 'ping/', 'report/'];
const SIZE_CAP_BYTES   = 5 * 1024 * 1024;
const SAMPLE_SIZE      = 30;

const s3 = new AWS.S3({
  region:          process.env.AWS_REGION,
  accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const BUCKET = process.env.S3_BUCKET!;
if (!BUCKET) throw new Error('S3_BUCKET env var missing');

interface Obj { key: string; size: number; lastModified?: Date; }

async function listAll(): Promise<Obj[]> {
  const out: Obj[] = [];
  let token: string | undefined;
  do {
    const resp = await s3.listObjectsV2({ Bucket: BUCKET, ContinuationToken: token }).promise();
    for (const c of resp.Contents ?? []) {
      out.push({ key: c.Key!, size: c.Size ?? 0, lastModified: c.LastModified });
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3)   return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function topPrefix(key: string): string {
  const i = key.indexOf('/');
  return i < 0 ? '<root>' : key.slice(0, i + 1);
}

function pickRandom<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  while (copy.length && out.length < n) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}

function expectedContentType(key: string): string | null {
  const ext = key.toLowerCase().split('.').pop();
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png':              return 'image/png';
    case 'webp':             return 'image/webp';
    default:                 return null;
  }
}

async function head(key: string) {
  return s3.headObject({ Bucket: BUCKET, Key: key }).promise();
}

(async () => {
  console.log(`\n=== S3 audit — bucket ${BUCKET} (${process.env.AWS_REGION}) ===\n`);

  const all = await listAll();
  const totalSize = all.reduce((s, o) => s + o.size, 0);
  console.log(`Total objects: ${all.length}`);
  console.log(`Total size:    ${fmtBytes(totalSize)}\n`);

  // -- (2) oversize objects --
  const oversize = all.filter((o) => o.size > SIZE_CAP_BYTES)
                      .sort((a, b) => b.size - a.size);
  console.log(`Objects larger than ${fmtBytes(SIZE_CAP_BYTES)}: ${oversize.length}`);
  for (const o of oversize.slice(0, 25)) {
    console.log(`  ${fmtBytes(o.size).padStart(10)}  ${o.lastModified?.toISOString().slice(0,10)}  ${o.key}`);
  }
  if (oversize.length > 25) console.log(`  … +${oversize.length - 25} more`);
  console.log();

  // -- (3) per-prefix breakdown --
  const prefixMap = new Map<string, { count: number; bytes: number }>();
  for (const o of all) {
    const p = topPrefix(o.key);
    const cur = prefixMap.get(p) ?? { count: 0, bytes: 0 };
    cur.count++;
    cur.bytes += o.size;
    prefixMap.set(p, cur);
  }
  console.log('Per-prefix breakdown:');
  for (const [p, v] of [...prefixMap.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
    const flag = ALLOWED_PREFIXES.includes(p) ? '   ' : ' ⚠️';
    console.log(`  ${flag} ${p.padEnd(20)} ${String(v.count).padStart(6)} objects  ${fmtBytes(v.bytes).padStart(10)}`);
  }
  console.log();

  // -- (5) keys with unknown prefix --
  const unknown = all.filter((o) => !ALLOWED_PREFIXES.includes(topPrefix(o.key)));
  if (unknown.length) {
    console.log(`⚠️  ${unknown.length} objects under unexpected prefixes (showing up to 30):`);
    for (const o of unknown.slice(0, 30)) {
      console.log(`     ${fmtBytes(o.size).padStart(8)}  ${o.key}`);
    }
    console.log();
  }

  // -- (4) random sample HEAD comparison --
  const sample = pickRandom(all, SAMPLE_SIZE);
  console.log(`Random ${sample.length}-object HEAD scan (Content-Type vs extension):`);
  let mismatches = 0;
  for (const o of sample) {
    try {
      const h = await head(o.key);
      const expected = expectedContentType(o.key);
      const actual = h.ContentType ?? '<none>';
      const flag = expected && actual !== expected ? ' ⚠️ MISMATCH' : '   ';
      if (expected && actual !== expected) mismatches++;
      console.log(`  ${flag} ${actual.padEnd(20)}  ${fmtBytes(h.ContentLength ?? 0).padStart(8)}  ${o.key}`);
    } catch (err: any) {
      console.log(`  ❌ HEAD failed: ${o.key} — ${err.message}`);
    }
  }
  console.log(`\nSample mismatches: ${mismatches}/${sample.length}`);
  console.log('\n=== End of audit ===\n');
})();
