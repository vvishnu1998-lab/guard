/**
 * validatePhotoOrQuarantine — the shared gate every client-supplied photo
 * URL passes before the row referencing it is written.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * This function was already written, but it lived file-private inside
 * routes/locations.ts and served only two of the paths that need it (ping
 * and clock-in-verification). routes/reports.ts and routes/inspections.ts
 * each carry their own inline re-implementation of the same four steps, so
 * the logic was already triplicated before the clock-out photo needed it.
 *
 * Moved here verbatim rather than copied a fourth time. Same move as
 * services/siteTime.ts and mobile's lib/compressImage.ts: remove a copy
 * rather than add one.
 *
 * ── WHAT IT GUARANTEES ──────────────────────────────────────────────────
 *
 *   1. The URL points at OUR bucket. photo_url is client-supplied; a
 *      tampered URL aimed at attacker-controlled storage would otherwise
 *      let the attacker dictate the bytes we accept as a "verified photo".
 *   2. The declared content type is one we allow.
 *   3. The object actually EXISTS in S3 (Range-GET of the first 16 bytes).
 *   4. Those bytes match the declared type. A mismatch writes a
 *      quarantined_uploads forensics row and rejects.
 *
 * Synchronous-by-design (awaited inline, not deferred): an
 * accept-now-reject-later flow is worse UX than a ~60ms wait, because the
 * guard has already walked away by the time the rejection lands.
 *
 * NOT MIGRATED YET: routes/reports.ts and routes/inspections.ts still carry
 * their own inline copies. Folding them onto this helper is a follow-up —
 * reports.ts in particular validates an ARRAY with per-photo index reporting
 * and was hardened separately, so it is not a mechanical substitution.
 */
import { pool } from '../db/pool';
import { getS3ObjectHead, s3KeyFromPublicUrl } from './s3';
import { isAllowedContentType, magicMatches, describeMagic } from './imageMagic';

export type PhotoValidation =
  | { ok: true }
  | { ok: false; status: number; body: { error: string } };

export async function validatePhotoOrQuarantine(
  photoUrl: string | null | undefined,
  ctx: { guardId: string; companyId?: string; shiftSessionId?: string },
): Promise<PhotoValidation> {
  // TODO(sentinel-removal): null and 'pending' are legacy fallbacks the
  // mobile uses when S3 isn't configured. Deprecated-but-supported. When
  // we remove the fallback path, grep for `sentinel-removal` and tighten
  // this to reject unset photo_urls outright.
  //
  // NOTE for the clock-out caller: a skipped photo arrives here as
  // undefined and returns ok:true. That is correct — "no photo" is a valid
  // recorded outcome there, and the reason column records which. This
  // helper validates a photo IF one was supplied; it never decides whether
  // one was required.
  if (!photoUrl || photoUrl === 'pending') return { ok: true };

  // Defense against URL substitution — photo_url is client-supplied and
  // must be validated against our bucket allowlist. A tampered URL pointing
  // at attacker-controlled storage would otherwise let the attacker dictate
  // the bytes we accept as a "verified photo".
  const key = s3KeyFromPublicUrl(photoUrl);
  if (!key) {
    return {
      ok: false,
      status: 400,
      body: { error: 'photo_url must point at the configured S3 bucket' },
    };
  }

  // The presigned POST policy pins Content-Type=image/jpeg per upload,
  // so we treat the declared type as image/jpeg here. (Forward-compat
  // hook: if the client ever uploads PNG/WEBP, add the content_type to
  // the payload and pass it in.)
  const declared = 'image/jpeg';
  if (!isAllowedContentType(declared)) {
    return {
      ok: false,
      status: 400,
      body: { error: `unsupported content_type ${declared}` },
    };
  }

  let head: Buffer;
  try {
    head = await getS3ObjectHead(key, 16);
  } catch {
    return {
      ok: false,
      status: 400,
      body: { error: `Photo not found in storage (key=${key}); please re-upload before submitting.` },
    };
  }

  if (!magicMatches(declared, head)) {
    const detected = describeMagic(head);
    await pool.query(
      `INSERT INTO quarantined_uploads
         (s3_key, declared_content_type, detected_magic,
          guard_id, company_id, shift_session_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, declared, detected, ctx.guardId, ctx.companyId ?? null, ctx.shiftSessionId ?? null],
    );
    return {
      ok: false,
      status: 400,
      body: {
        error: `Uploaded file is not a valid ${declared} (detected: ${detected}). The upload has been quarantined; please re-take the photo.`,
      },
    };
  }

  return { ok: true };
}
