/**
 * Upload Routes
 *
 * POST /api/uploads/presign — returns a pre-signed S3 POST policy for
 * client-side upload.  Mobile uploads directly to S3 via multipart/
 * form-data; only the resulting public URL is sent to the API.
 *
 * D1 / audit/WEEK1.md §D1 — switched from PUT to POST so the policy
 * can pin content-length-range (1 byte … MAX_UPLOAD_BYTES) in addition
 * to Content-Type and key.  V6 demonstrated the PUT presigner had no
 * size cap in the signature; an attacker could upload arbitrary bytes.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { createPresignedUploadPost, MAX_UPLOAD_BYTES } from '../services/s3';

const router = Router();

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

const ALLOWED_CONTEXTS = new Set(['report', 'ping', 'clock_in']);

// POST /api/uploads/presign
// Body: { content_type: string, context: 'report' | 'ping' | 'clock_in' }
// Returns: { post_url, fields, public_url, key, max_bytes }
//
// Client must POST multipart/form-data to `post_url` with:
//   - every key/value in `fields` (key, Content-Type, policy, signature, …)
//   - the file as the LAST field, named `file`
// S3 evaluates the policy and returns 204 on success or 4xx on policy
// breach (oversized body, mismatched type, tampered key).
router.post('/presign', requireAuth('guard'), async (req, res) => {
  const { content_type, context = 'report' } = req.body;

  if (!content_type || !ALLOWED_TYPES[content_type]) {
    return res.status(400).json({ error: 'content_type must be image/jpeg, image/png, or image/webp' });
  }
  if (!ALLOWED_CONTEXTS.has(context)) {
    return res.status(400).json({ error: 'context must be report, ping, or clock_in' });
  }

  const ext = ALLOWED_TYPES[content_type];
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key  = `${context}/${req.user!.company_id}/${date}/${uuidv4()}.${ext}`;

  try {
    const { url: post_url, fields } = await createPresignedUploadPost(key, content_type);
    const public_url = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    res.json({
      post_url,
      fields,
      public_url,
      key,
      max_bytes: MAX_UPLOAD_BYTES,
    });
  } catch (err: any) {
    console.error('presign error', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

export default router;
