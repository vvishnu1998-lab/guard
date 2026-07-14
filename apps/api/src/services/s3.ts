import AWS from 'aws-sdk';

const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

// Separate S3 client pinned to SigV4 for presignGet. aws-sdk v2 defaults
// `getSignedUrl*` to SigV2 (deprecated, no region-binding, AWSAccessKeyId
// leaks the key in the URL). We don't want to change the signing scheme
// of the existing upload + putObject + getObject calls as a side-effect of
// this PR, so the SigV4 setting lives on a dedicated instance.
const s3SigV4 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  signatureVersion: 'v4',
});

const BUCKET = process.env.S3_BUCKET!;

/**
 * D1 / audit/WEEK1.md §D1 — maximum object size accepted by the
 * presigned POST policy.  5 MiB is generous for a 1080p JPEG and 10x
 * what the mobile compressor produces (see apps/mobile/hooks/
 * usePhotoAttachments.ts compress(0.6, 1080)).  The browser-equivalent
 * cap; if mobile ever produces something larger, raise this — never
 * remove the cap.
 */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type PresignedPost = {
  /** S3 endpoint URL the client POSTs to */
  url: string;
  /** Form fields the client must include verbatim in the multipart body */
  fields: Record<string, string>;
};

/**
 * D1 / audit/WEEK1.md §D1 — generate a pre-signed POST whose policy
 * pins the key, the Content-Type, AND the content-length-range.  V6
 * showed that the previous PUT-based presigner let a malicious client
 * upload an arbitrary-size object (no length cap in the signature).
 * createPresignedPost returns { url, fields } that the client MUST
 * include verbatim in a multipart/form-data POST — S3 evaluates the
 * policy server-side and rejects 403 on any drift (oversized body,
 * mismatched type, key tampering).
 */
export function createPresignedUploadPost(
  key: string,
  contentType: string,
): Promise<PresignedPost> {
  return new Promise((resolve, reject) => {
    s3.createPresignedPost(
      {
        Bucket: BUCKET,
        Fields: {
          key,
          'Content-Type': contentType,
        },
        Conditions: [
          { bucket: BUCKET },
          ['eq', '$key', key],
          ['eq', '$Content-Type', contentType],
          // 1 byte minimum — rejects empty bodies up front
          ['content-length-range', 1, MAX_UPLOAD_BYTES],
        ],
        Expires: 300, // 5 minutes
      },
      (err, data) => {
        if (err) return reject(err);
        resolve({ url: data.url, fields: data.fields as Record<string, string> });
      },
    );
  });
}

/** Delete a single S3 object — called by nightly purge job */
export async function deleteS3Object(url: string): Promise<void> {
  const key = new URL(url).pathname.replace(/^\//, '');
  await s3.deleteObject({ Bucket: BUCKET, Key: key }).promise();
}

/**
 * D2 / audit/WEEK1.md §D2 — magic-byte verification.
 *
 * Fetch the first `n` bytes of an S3 object via Range request.  Used by
 * the magic-byte validator to confirm an uploaded "image/jpeg" actually
 * starts with FF D8 FF (JPEG SOI) and not, say, "<?php" or a zip header.
 *
 * Cheap: the GetObject Range request is billed as 1 standard request
 * (~$0.0004 / 1k) regardless of size, and we never download more than
 * 16 bytes.
 */
export async function getS3ObjectHead(key: string, n = 16): Promise<Buffer> {
  const resp = await s3.getObject({
    Bucket: BUCKET,
    Key: key,
    Range: `bytes=0-${n - 1}`,
  }).promise();
  if (!resp.Body) throw new Error(`empty body for s3://${BUCKET}/${key}`);
  return resp.Body as Buffer;
}

/**
 * Streaming GetObject — returns a Node Readable that emits body chunks
 * as they arrive from S3. Callers pipe directly to an Express response
 * to avoid buffering the whole object in memory (matters for PDFs,
 * which can be several MB).
 *
 * Error handling contract: the stream emits 'error' on any S3 failure
 * (NoSuchKey, AccessDenied, transient 5xx). Callers MUST attach an
 * 'error' listener before piping; failing to do so crashes the process.
 * See Build 38 shifts.ts GET /:id/instructions.pdf for the response
 * pattern (502 if headers un-sent, res.destroy otherwise).
 */
export function streamS3Object(key: string): NodeJS.ReadableStream {
  return s3.getObject({ Bucket: BUCKET, Key: key }).createReadStream();
}

/**
 * D2 — extract the S3 key from a public URL of the form
 *   https://<bucket>.s3.<region>.amazonaws.com/<key>
 * Returns null if the URL doesn't match (e.g. external URL, malformed).
 * Used to validate that the photo_urls in a report payload point at our
 * bucket before we GetObject them.
 */
/** Upload a buffer directly to S3 — used for server-side validated uploads (e.g. PDFs). */
export async function uploadBufferToS3(
  key: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  await s3.putObject({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }).promise();
  return `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
}

export function s3KeyFromPublicUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const expectedHost = `${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com`;
    if (u.hostname !== expectedHost) return null;
    const key = u.pathname.replace(/^\//, '');
    return key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pre-launch punchlist #1 — S3 bucket lockdown plumbing (PR1)
//
// Once the bucket flips private in PR4, every response handler that today
// returns a stored S3 URL has to instead return a short-lived signed GET
// URL. These three helpers are the bridge:
//
//   presignGet(key, ttl)    — sign a fresh GET URL for `key`, default 15 min
//   extractS3Key(stored)    — normalise a DB column value (full URL OR bare
//                             key) into the key form that presignGet expects
//   urlOrPresign(stored, ttl) — null-safe wrapper that response handlers call
//
// Decision Section 4c (deferred storage-shape migration): we accept BOTH
// formats in `extractS3Key` so PR2 can ship without first migrating every
// existing row's URL column to bare-key form. The backfill happens in PR5
// (or later) without blocking the bucket flip.
// ────────────────────────────────────────────────────────────────────────────

/** Default TTL for a presigned GET — 15 min. Long enough to load a page,
 *  click through a few photos, walk away. Short enough that a screenshot
 *  of the URL becomes useless quickly. */
export const PRESIGN_GET_TTL_SECONDS = 60 * 15;

/**
 * Generate a short-lived signed GET URL for an S3 object.
 *
 * Stays on aws-sdk v2 (`getSignedUrlPromise`) to keep PR1 surgical;
 * the SDK migration to v3 is its own concern and explicitly out of
 * scope per the agreed PR plan.
 */
export function presignGet(
  key: string,
  ttlSec: number = PRESIGN_GET_TTL_SECONDS,
): Promise<string> {
  if (!key || typeof key !== 'string') {
    return Promise.reject(new Error(`presignGet: invalid key: ${JSON.stringify(key)}`));
  }
  return s3SigV4.getSignedUrlPromise('getObject', {
    Bucket: BUCKET,
    Key: key,
    Expires: ttlSec,
  });
}

/**
 * Extract an S3 key from a value that may be either:
 *   - a full public URL: `https://<bucket>.s3.<region>.amazonaws.com/<key>`
 *   - or just the key:   `report/<company_id>/<date>/<uuid>.jpg`
 *
 * Behavior:
 *   - bare key (no scheme)         → passthrough
 *   - URL matching configured bucket → extract key
 *   - URL with foreign host        → console.warn + return URL pathname
 *     (defensive — likely a row written under the old `guard-media-uploads`
 *     bucket name; signing this against our bucket will 404 visibly, which
 *     is the right failure mode for a known-stale row)
 *   - malformed input              → passthrough
 */
export function extractS3Key(stored: string): string {
  if (!/^https?:\/\//.test(stored)) return stored;
  const key = s3KeyFromPublicUrl(stored);
  if (key) return key;
  try {
    const u = new URL(stored);
    // eslint-disable-next-line no-console
    console.warn('[s3.extractS3Key] stored URL host does not match configured bucket', {
      storedHost: u.hostname,
      expectedBucket: BUCKET,
    });
    return u.pathname.replace(/^\//, '') || stored;
  } catch {
    return stored;
  }
}

/**
 * Null-safe response-handler shim: PASS THE STORED URL/KEY,
 * GET BACK A FRESH SIGNED URL (or null).
 *
 * This is the only function PR2 has to import into each response
 * handler — calling it on every photo column makes the eventual
 * bucket flip a no-op for end users.
 */
export async function urlOrPresign(
  stored: string | null | undefined,
  ttlSec: number = PRESIGN_GET_TTL_SECONDS,
): Promise<string | null> {
  if (!stored) return null;
  const key = extractS3Key(stored);
  return presignGet(key, ttlSec);
}

/**
 * Array version of `urlOrPresign` — for the `photos[]` aggregates returned
 * by `array_agg(rp.storage_url ORDER BY rp.photo_index)`. Null/empty input
 * → `[]`. Items that fail presigning are dropped silently (the array
 * shape ≥ 0 items is preserved; a single broken row doesn't tank the
 * whole report). Order is preserved.
 */
export async function presignAll(
  stored: (string | null)[] | null | undefined,
  ttlSec: number = PRESIGN_GET_TTL_SECONDS,
): Promise<string[]> {
  if (!stored || stored.length === 0) return [];
  const signed = await Promise.all(stored.map((u) => urlOrPresign(u, ttlSec)));
  return signed.filter((u): u is string => u !== null);
}
