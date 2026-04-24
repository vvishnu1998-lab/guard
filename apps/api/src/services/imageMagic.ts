/**
 * imageMagic.ts — D2 / audit/WEEK1.md §D2.
 *
 * Magic-byte validator for uploaded images.  D1 closed the size and
 * MIME-pin gaps, but a client can still upload bytes that *claim* to
 * be image/jpeg yet are actually something else (HTML, PHP, zip,
 * polyglot, plain text).  S3 trusts the declared Content-Type — only
 * the bytes themselves can confirm.
 *
 * Used at report-create time: every photo URL submitted in
 * POST /api/reports is HEADed (range 0-15) and verified against the
 * expected magic for its declared extension.  A mismatch:
 *   1. inserts a row in `quarantined_uploads` (forensics trail), and
 *   2. rejects the report with 400 (no DB rows for the report or its
 *      photos are created).
 *
 * The orphan S3 object survives until the bucket lifecycle deletes it
 * (180 days), but it is never linked to a report and never served via
 * a signed read URL.
 *
 * This is the API-side sync alternative to a true S3 ObjectCreated
 * Lambda — it has the same security properties (rejects bad bytes
 * before they're observable in the app) and avoids the operational
 * cost of running a separate Lambda function.  Trade-off: we rely on
 * the report-create endpoint being the only consumer of upload URLs,
 * which is true today.  See WEEK1.md §D2 for the Lambda alternative.
 */

/**
 * Known image magic-byte prefixes.  Length is the number of bytes we
 * must read from the file head to confidently identify the format.
 *
 * Sources:
 *   - JPEG: ITU T.81 / JFIF — every JPEG starts with FF D8 FF (SOI marker
 *     followed by APP0/APP1/etc).
 *   - PNG : RFC 2083 — eight-byte signature 89 50 4E 47 0D 0A 1A 0A.
 *   - WEBP: WebP container is RIFF-based — bytes 0..3 = "RIFF",
 *     bytes 8..11 = "WEBP".  Bytes 4..7 are the file size (variable),
 *     so we do a non-contiguous match: prefix + offset-8 marker.
 */
type Matcher =
  | { kind: 'prefix'; bytes: number[] }
  | { kind: 'riff_webp' };

const SIGNATURES: Record<string, Matcher> = {
  'image/jpeg': { kind: 'prefix',    bytes: [0xff, 0xd8, 0xff] },
  'image/png':  { kind: 'prefix',    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'image/webp': { kind: 'riff_webp' },
};

export function isAllowedContentType(ct: string): boolean {
  return ct in SIGNATURES;
}

/**
 * Returns true iff `head` (first ≥12 bytes of an object) matches the
 * magic signature for `contentType`.  Returns false on any mismatch,
 * unknown content type, or short buffer.  Never throws.
 */
export function magicMatches(contentType: string, head: Buffer): boolean {
  const sig = SIGNATURES[contentType];
  if (!sig) return false;

  if (sig.kind === 'prefix') {
    if (head.length < sig.bytes.length) return false;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (head[i] !== sig.bytes[i]) return false;
    }
    return true;
  }

  if (sig.kind === 'riff_webp') {
    // RIFF....WEBP — bytes 0..3 = "RIFF", bytes 8..11 = "WEBP"
    if (head.length < 12) return false;
    const rIff = head.slice(0, 4).toString('ascii');
    const wEbp = head.slice(8, 12).toString('ascii');
    return rIff === 'RIFF' && wEbp === 'WEBP';
  }

  return false;
}

/**
 * Hex-encoded short label of the detected magic prefix (or "—" if the
 * head is unrecognised).  Used in the quarantined_uploads.detected_magic
 * column for forensics.
 */
export function describeMagic(head: Buffer): string {
  if (head.length === 0) return '<empty>';
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 &&
      head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png';
  if (head.length >= 12 &&
      head.slice(0, 4).toString('ascii') === 'RIFF' &&
      head.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  // Common attacker shapes worth labelling explicitly so on-call can scan
  if (head.length >= 4 && head.slice(0, 4).toString('ascii') === 'PK\x03\x04') return 'zip';
  if (head.length >= 5 && head.slice(0, 5).toString('ascii') === '<?php') return 'php';
  if (head.length >= 4 && head.slice(0, 4).toString('utf8').toLowerCase() === '<htm') return 'html';
  // Fall back to a hex dump of the first 8 bytes
  return `hex:${head.slice(0, Math.min(8, head.length)).toString('hex')}`;
}
