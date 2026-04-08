/**
 * S3 Upload Utility (Section 11.4)
 * 1. Calls POST /api/uploads/presign to get a pre-signed PUT URL from the server
 * 2. PUTs the compressed image directly to S3 (no image data touches the API)
 * 3. Returns { public_url, size_kb } for inclusion in the report payload
 */
import { apiClient } from './apiClient';

export interface UploadResult {
  public_url: string;
  size_kb:    number;
}

/**
 * Upload a local file URI to S3 via pre-signed URL.
 * @param localUri  - expo file URI (e.g. file:///var/...)
 * @param context   - storage folder prefix: 'report' | 'ping' | 'clock_in'
 */
export async function uploadToS3(
  localUri: string,
  context: 'report' | 'ping' | 'clock_in' = 'report'
): Promise<UploadResult> {
  // 1. Get pre-signed URL from API
  const { presigned_url, public_url } = await apiClient.post<{ presigned_url: string; public_url: string }>(
    '/uploads/presign',
    { content_type: 'image/jpeg', context }
  );

  // 2. Fetch local file as blob
  const fileRes  = await fetch(localUri);
  const blob     = await fileRes.blob();
  const size_kb  = Math.round(blob.size / 1024);

  // 3. PUT directly to S3
  const s3Res = await fetch(presigned_url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: blob,
  });

  if (!s3Res.ok) {
    throw new Error(`S3 upload failed: ${s3Res.status}`);
  }

  return { public_url, size_kb };
}
