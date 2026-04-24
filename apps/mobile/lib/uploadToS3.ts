/**
 * S3 Upload Utility (Section 11.4)
 *
 * D1 / audit/WEEK1.md §D1 — switched from PUT-presigned to POST-presigned
 * so the policy can pin content-length-range (size cap) in addition to
 * Content-Type and key.  See apps/api/src/services/s3.ts.
 *
 * Flow:
 *   1. POST /api/uploads/presign → { post_url, fields, public_url, max_bytes }
 *   2. Build multipart/form-data with every field in `fields` THEN the
 *      file (named `file`, in that order — S3 requires the file last).
 *   3. POST the form to `post_url`.  S3 evaluates the policy and:
 *        - 204 on success
 *        - 403 EntityTooLarge on size breach
 *        - 403 on key/Content-Type drift
 *        - 403 ExpiredToken after 5 min
 *   4. Return { public_url, size_kb } for the report payload.
 */
import { apiClient } from './apiClient';

export interface UploadResult {
  public_url: string;
  size_kb:    number;
}

interface PresignedPostResponse {
  post_url:   string;
  fields:     Record<string, string>;
  public_url: string;
  key:        string;
  max_bytes:  number;
}

/**
 * Upload a local file URI to S3 via pre-signed POST.
 * @param localUri  - expo file URI (e.g. file:///var/...)
 * @param context   - storage folder prefix: 'report' | 'ping' | 'clock_in'
 */
export async function uploadToS3(
  localUri: string,
  context: 'report' | 'ping' | 'clock_in' = 'report'
): Promise<UploadResult> {
  // 1. Get presigned POST policy from API
  const presign = await apiClient.post<PresignedPostResponse>(
    '/uploads/presign',
    { content_type: 'image/jpeg', context }
  );

  // Defensive — detect deployment skew where the API is still on the
  // pre-D1 PUT-presigned shape ({ url } only).  Without this guard,
  // the next line crashes with "Cannot convert undefined value to
  // object" when Object.entries(undefined) is invoked, which is what
  // the operator saw in production on 2026-04-24 (mobile shipped with
  // the new shape, prod API still on audit-base e2fec53 with the old
  // shape).  Fail fast with an actionable message instead.
  if (!presign || typeof presign !== 'object'
      || !presign.fields || typeof presign.fields !== 'object'
      || !presign.post_url
      || !presign.public_url
      || typeof presign.max_bytes !== 'number') {
    throw new Error(
      'Upload service returned an unexpected response shape. ' +
      'The API may need to be redeployed with the latest upload changes. ' +
      'Please contact your administrator.'
    );
  }

  // 2. Fetch local file as blob
  const fileRes = await fetch(localUri);
  const blob    = await fileRes.blob();
  const size_kb = Math.round(blob.size / 1024);

  if (blob.size > presign.max_bytes) {
    throw new Error(
      `File exceeds maximum upload size of ${Math.round(presign.max_bytes / 1024 / 1024)} MiB`
    );
  }

  // 3. Build multipart body — fields first, file last (S3 requirement)
  const form = new FormData();
  for (const [k, v] of Object.entries(presign.fields)) {
    form.append(k, v);
  }
  // RN FormData expects the { uri, name, type } object form for files
  form.append('file', {
    uri:  localUri,
    name: presign.key.split('/').pop() ?? 'upload.jpg',
    type: 'image/jpeg',
  } as unknown as Blob);

  // 4. POST to S3 — DO NOT set Content-Type explicitly; let RN/fetch
  //    set the multipart boundary header.
  const s3Res = await fetch(presign.post_url, {
    method: 'POST',
    body:   form,
  });

  if (!s3Res.ok) {
    const body = await s3Res.text().catch(() => '');
    throw new Error(`S3 upload failed: ${s3Res.status} ${body.slice(0, 200)}`);
  }

  return { public_url: presign.public_url, size_kb };
}
