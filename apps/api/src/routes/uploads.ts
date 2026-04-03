/**
 * Upload Routes
 * POST /api/uploads/presign — returns a pre-signed S3 PUT URL for client-side upload.
 * Mobile uploads directly to S3; only the resulting public URL is sent to the API.
 */
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../middleware/auth';
import { getUploadPresignedUrl } from '../services/s3';

const router = Router();

const ALLOWED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
};

// POST /api/uploads/presign
// Body: { content_type: string, context: 'report' | 'ping' | 'clock_in' }
// Returns: { presigned_url, public_url, key }
router.post('/presign', requireAuth('guard'), async (req, res) => {
  const { content_type, context = 'report' } = req.body;

  if (!content_type || !ALLOWED_TYPES[content_type]) {
    return res.status(400).json({ error: 'content_type must be image/jpeg, image/png, or image/webp' });
  }

  const ext = ALLOWED_TYPES[content_type];
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key  = `${context}/${req.user!.company_id}/${date}/${uuidv4()}.${ext}`;

  try {
    const presigned_url = await getUploadPresignedUrl(key, content_type);
    const public_url    = `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

    res.json({ presigned_url, public_url, key });
  } catch (err: any) {
    console.error('presign error', err);
    res.status(500).json({ error: 'Failed to generate upload URL' });
  }
});

export default router;
