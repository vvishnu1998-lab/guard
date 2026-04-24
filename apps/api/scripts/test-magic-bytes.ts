/**
 * test-magic-bytes.ts — proves D2 fix (audit/WEEK1.md §D2), unit-test
 * portion.
 *
 * The magic-byte helpers (`isAllowedContentType`, `magicMatches`,
 * `describeMagic`) are pure functions over Buffer inputs.  This test
 * exercises every recognised format (JPEG, PNG, WEBP) plus several
 * common attacker shapes (zip, php, html, text) and confirms:
 *
 *   1. Real JPEG/PNG/WEBP heads are accepted for their declared type.
 *   2. Cross-type heads are rejected (e.g. PNG bytes labelled jpeg).
 *   3. Polyglot/text/zip/php heads are rejected as image/jpeg, and
 *      describeMagic labels them readably (so quarantined_uploads
 *      rows are useful at triage time without re-fetching the bytes).
 *   4. Empty / short buffers are rejected.
 *   5. Unknown content_types are rejected by isAllowedContentType.
 *
 * The companion live-S3 round-trip (signed POST → S3 → /api/reports
 * fetches bytes → quarantine on mismatch) is documented as the manual
 * Railway verification in WEEK1.md §D2.  This unit test is what runs
 * in CI / on every dev box (no AWS creds required).
 *
 * Usage:
 *   npx ts-node apps/api/scripts/test-magic-bytes.ts
 *
 * Author: Week-1 audit (audit/WEEK1.md §D2)
 */
import { isAllowedContentType, magicMatches, describeMagic } from '../src/services/imageMagic';

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
  console.log(`  ✓ ${msg}`);
}

// ── Real-format heads (synthetic — first N bytes only, since magicMatches
//    looks at exactly the prefix anyway) ──────────────────────────────────
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xff, 0xff, 0xff]);
const PNG_HEAD  = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xff, 0xff, 0xff, 0xff]);
// "RIFF" + 4-byte size + "WEBP" + "VP8 " (the tag inside is irrelevant to the matcher)
const WEBP_HEAD = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from('VP8 ', 'ascii'),
]);

// ── Attacker shapes — each is something that could be uploaded with
//    Content-Type: image/jpeg under the D1 policy and wouldn't be
//    caught by S3 (S3 doesn't sniff bytes) ─────────────────────────
const PHP_HEAD  = Buffer.from('<?php system($_GET["c"]); ?>', 'utf8');
const HTML_HEAD = Buffer.from('<html><body>hi</body></html>',     'utf8');
const ZIP_HEAD  = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // PK\x03\x04
const TEXT_HEAD = Buffer.from('hello world this is a text file', 'utf8');
const EMPTY     = Buffer.alloc(0);
const ONE_BYTE  = Buffer.from([0xff]);

console.log('\n=== test-magic-bytes (D2 unit test) ===\n');

// ── 1. Accept real heads for their declared types ──────────────────────
assert(magicMatches('image/jpeg', JPEG_HEAD), 'JPEG head accepted as image/jpeg');
assert(magicMatches('image/png',  PNG_HEAD),  'PNG  head accepted as image/png');
assert(magicMatches('image/webp', WEBP_HEAD), 'WEBP head accepted as image/webp');

// ── 2. Reject cross-type swaps ─────────────────────────────────────────
assert(!magicMatches('image/jpeg', PNG_HEAD),  'PNG  head REJECTED as image/jpeg');
assert(!magicMatches('image/jpeg', WEBP_HEAD), 'WEBP head REJECTED as image/jpeg');
assert(!magicMatches('image/png',  JPEG_HEAD), 'JPEG head REJECTED as image/png');
assert(!magicMatches('image/webp', PNG_HEAD),  'PNG  head REJECTED as image/webp');

// ── 3. Reject attacker shapes labelled as image/jpeg ───────────────────
assert(!magicMatches('image/jpeg', PHP_HEAD),  'php  payload REJECTED as image/jpeg');
assert(!magicMatches('image/jpeg', HTML_HEAD), 'html payload REJECTED as image/jpeg');
assert(!magicMatches('image/jpeg', ZIP_HEAD),  'zip  payload REJECTED as image/jpeg');
assert(!magicMatches('image/jpeg', TEXT_HEAD), 'text payload REJECTED as image/jpeg');

// ── 4. Empty / short buffers ───────────────────────────────────────────
assert(!magicMatches('image/jpeg', EMPTY),    'empty  buffer REJECTED');
assert(!magicMatches('image/jpeg', ONE_BYTE), 'single byte REJECTED for jpeg (needs ≥3)');
assert(!magicMatches('image/png',  PNG_HEAD.slice(0, 4)), 'short PNG buffer REJECTED');

// ── 5. Unknown content_type rejected up front ──────────────────────────
assert(!isAllowedContentType('application/octet-stream'), 'octet-stream not allowed');
assert(!isAllowedContentType('text/html'),                'text/html not allowed');
assert(!isAllowedContentType(''),                          'empty content_type not allowed');
assert(isAllowedContentType('image/jpeg'),                 'image/jpeg allowed');
assert(isAllowedContentType('image/png'),                  'image/png allowed');
assert(isAllowedContentType('image/webp'),                 'image/webp allowed');

// ── 6. describeMagic labels are useful at triage time ──────────────────
assert(describeMagic(JPEG_HEAD) === 'image/jpeg', 'describeMagic(JPEG) = image/jpeg');
assert(describeMagic(PNG_HEAD)  === 'image/png',  'describeMagic(PNG) = image/png');
assert(describeMagic(WEBP_HEAD) === 'image/webp', 'describeMagic(WEBP) = image/webp');
assert(describeMagic(PHP_HEAD)  === 'php',         'describeMagic(<?php …) = php');
assert(describeMagic(HTML_HEAD) === 'html',        'describeMagic(<html …) = html');
assert(describeMagic(ZIP_HEAD)  === 'zip',         'describeMagic(PK\\x03\\x04 …) = zip');
assert(describeMagic(EMPTY)     === '<empty>',     'describeMagic(empty) = <empty>');
assert(describeMagic(TEXT_HEAD).startsWith('hex:'),'describeMagic(text) falls back to hex dump');

console.log('\n=== ALL ASSERTIONS PASSED ===\n');
