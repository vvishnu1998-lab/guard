/**
 * compressImage — the SINGLE compression implementation for every photo
 * this app uploads.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * There were two copies: components/CameraCapture.tsx and
 * hooks/usePhotoAttachments.ts, with identical parameters and one
 * difference that mattered — CameraCapture console.warn'd on failure and
 * usePhotoAttachments had a completely EMPTY catch. Both then did the same
 * thing: silently fall back to `photo.uri`, the raw capture taken at
 * quality 0.9, and upload that.
 *
 * That is how 25 of 274 objects under report/ ended up over 800 KB, and how
 * vamshi's 919 KB photo became an S3 orphan on 2026-08-22: S3 accepted it
 * (MAX_UPLOAD_BYTES is 5 MiB), Postgres refused it (chk_file_size was
 * 800 KB), and nothing deleted the object. Because both catches were
 * silent, there is no record anywhere of WHY compression failed on those
 * captures — which is the second reason this file exists.
 *
 * Same move as services/siteTime.ts on the API side: remove the second
 * copy rather than add a third.
 *
 * ── THE INVARIANT ───────────────────────────────────────────────────────
 *
 * NEVER upload the raw capture. Compress, MEASURE the result, and if it is
 * still over the ceiling, retry at a lower quality. If it is still over
 * after the ladder is exhausted, THROW — do not hand the caller something
 * the server will reject after S3 has already taken it. Uploading a photo
 * the DB will refuse is the bug; failing loudly in the guard's hand is the
 * fix.
 *
 * ── WHAT IS DELIBERATELY UNCHANGED ──────────────────────────────────────
 *
 * The target stays 1080px / JPEG 0.8. The defect being fixed is the silent
 * fallback, not the target, and changing both at once would confound them —
 * any change in artifact size or quality after this ships is attributable
 * to the fallback being gone, nothing else. The retry ladder below only
 * engages on a capture that busts the ceiling at 0.8, which at 1080px is
 * pathological rather than routine.
 *
 * EXIF is stripped as a side effect of re-encoding through ImageManipulator
 * (iOS UIImage.jpegData, Android Bitmap.compress). Do NOT bypass the
 * manipulator for uploads.
 */
import * as ImageManipulator from 'expo-image-manipulator';
import * as Sentry from '@sentry/react-native';
import { GuardFacingError } from './errors';

/** Long edge, in px. Unchanged from both previous copies. */
const TARGET_WIDTH = 1080;

/**
 * Quality ladder. The first value is the target and is what virtually every
 * capture uses; the rest exist so a pathological frame degrades instead of
 * being uploaded raw or rejected outright.
 */
const QUALITY_LADDER = [0.8, 0.6, 0.4];

/**
 * MUST match routes/reports.ts MAX_PHOTO_KB and report_photos.chk_file_size
 * (both 5120 as of schema_v54), which in turn match services/s3.ts
 * MAX_UPLOAD_BYTES (5 MiB). Four places, one number. Changing one without
 * the others reopens the gap that orphaned the 919 KB photo.
 */
export const MAX_PHOTO_KB = 5120;

export interface CompressResult {
  /** file:// URI of the compressed artifact. Never the raw capture. */
  uri: string;
  /** Measured byte length of that artifact. */
  bytes: number;
  /** Size in KB, rounded the same way uploadToS3 reports size_kb. */
  sizeKb: number;
  /** Which rung of the ladder produced it. */
  quality: number;
  /** How many manipulator passes it took (1 on the happy path). */
  attempts: number;
}

/** Measure a local file the same way uploadToS3 does, so the number the
 *  server is told is the number we checked. */
async function measure(uri: string): Promise<number> {
  const res = await fetch(uri);
  const blob = await res.blob();
  return blob.size;
}

/**
 * Compress `sourceUri` to a JPEG that is guaranteed to be within the
 * ceiling, or throw.
 *
 * @param sourceUri local file URI from the camera or picker
 * @param ctx       short label for breadcrumbs/Sentry ('camera' | 'report')
 * @throws Error with guard-facing copy when compression fails outright or
 *         cannot get the artifact under the ceiling.
 */
export async function compressImage(sourceUri: string, ctx: string): Promise<CompressResult> {
  let lastBytes: number | null = null;
  let attempts = 0;

  for (const quality of QUALITY_LADDER) {
    attempts++;
    let uri: string;
    try {
      const result = await ImageManipulator.manipulateAsync(
        sourceUri,
        [{ resize: { width: TARGET_WIDTH } }],
        { compress: quality, format: ImageManipulator.SaveFormat.JPEG },
      );
      if (!result?.uri) throw new Error('ImageManipulator returned no uri');
      uri = result.uri;
    } catch (err: any) {
      // The old code swallowed this and uploaded the raw capture, which is
      // why we have no idea why it ever failed. Record the reason, then
      // fail — the caller must not be handed the original.
      Sentry.captureException(err, {
        tags:  { flow: 'compress_image', ctx },
        extra: { quality, attempts, target_width: TARGET_WIDTH, source_uri_scheme: sourceUri.split(':')[0] },
      });
      console.error(`[compressImage:${ctx}] manipulateAsync failed at q=${quality}:`, err);
      throw new GuardFacingError(
        'This photo could not be processed on your device. Retake it — if it keeps failing, tell your supervisor.',
      );
    }

    let bytes: number;
    try {
      bytes = await measure(uri);
    } catch (err: any) {
      Sentry.captureException(err, {
        tags:  { flow: 'compress_image', ctx },
        extra: { stage: 'measure', quality, attempts },
      });
      console.error(`[compressImage:${ctx}] measure failed at q=${quality}:`, err);
      throw new GuardFacingError(
        'This photo could not be measured on your device. Retake it — if it keeps failing, tell your supervisor.',
      );
    }

    lastBytes = bytes;
    const sizeKb = Math.round(bytes / 1024);
    console.log(`[compressImage:${ctx}] q=${quality} attempt=${attempts} size_kb=${sizeKb}`);

    if (sizeKb <= MAX_PHOTO_KB) {
      if (attempts > 1) {
        // Reaching the ladder at all is worth knowing about — it means a
        // capture busted the ceiling at the target quality.
        Sentry.captureMessage('compress_image_needed_retry', {
          level: 'warning',
          tags:  { flow: 'compress_image', ctx },
          extra: { final_quality: quality, attempts, size_kb: sizeKb },
        } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
      }
      return { uri, bytes, sizeKb, quality, attempts };
    }
  }

  // Ladder exhausted and still over. Fail in the guard's hand rather than
  // uploading something the server will refuse after S3 has taken it.
  const finalKb = lastBytes !== null ? Math.round(lastBytes / 1024) : -1;
  Sentry.captureMessage('compress_image_over_ceiling', {
    level: 'error',
    tags:  { flow: 'compress_image', ctx },
    extra: { size_kb: finalKb, limit_kb: MAX_PHOTO_KB, attempts, ladder: QUALITY_LADDER },
  } as unknown as Parameters<typeof Sentry.captureMessage>[1]);
  console.error(`[compressImage:${ctx}] over ceiling after ${attempts} attempts: ${finalKb}KB > ${MAX_PHOTO_KB}KB`);

  // Copy names the SIZE, not a position. "Photo 1" goes stale the instant
  // the guard removes one from the list; a size identifies the offending
  // capture no matter how the list is reordered.
  throw new GuardFacingError(
    `This photo is still ${formatKb(finalKb)} after compression — the limit is ${formatKb(MAX_PHOTO_KB)}. ` +
    'Retake it from further back or in better light, then try again.',
  );
}

/** 919 -> "919 KB", 5120 -> "5.0 MB". Used in guard-facing copy. */
export function formatKb(kb: number): string {
  if (kb < 0) return 'an unknown size';
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
}
