import AWS from 'aws-sdk';

const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
});

const BUCKET = process.env.S3_BUCKET!;

/** Generate a pre-signed upload URL — client uploads directly to S3 (Section 11.4) */
export async function getUploadPresignedUrl(key: string, contentType: string): Promise<string> {
  return s3.getSignedUrlPromise('putObject', {
    Bucket: BUCKET,
    Key: key,
    ContentType: contentType,
    Expires: 300, // 5 minutes
    // S3 lifecycle rule handles hard-delete backstop at 180 days
  });
}

/** Delete a single S3 object — called by nightly purge job */
export async function deleteS3Object(url: string): Promise<void> {
  const key = new URL(url).pathname.replace(/^\//, '');
  await s3.deleteObject({ Bucket: BUCKET, Key: key }).promise();
}
