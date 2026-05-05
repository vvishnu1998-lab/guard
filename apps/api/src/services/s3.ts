import AWS from 'aws-sdk';

const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
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
