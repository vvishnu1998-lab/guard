import { magicMatches } from './imageMagic';

/**
 * Width and height of a PNG or JPEG, read from the file header.
 *
 * Written for the company logo upload (routes/companyProfile.ts), which must
 * refuse an image whose longest side is outside 256..2048 px. Nothing in
 * apps/api decodes images and the logo is never resized, so this reads only
 * what the size check needs: the PNG IHDR chunk, or the first JPEG
 * start-of-frame segment. The type comes from the magic bytes (imageMagic.ts),
 * never from the file name or the declared content type.
 *
 * It does NOT validate the rest of the file. A valid header followed by
 * garbage passes, so anything that later DRAWS the image (a PDF letterhead)
 * must still survive a decode failure.
 */

export type ImageKind = 'png' | 'jpeg';

export interface ImageDimensions {
  kind: ImageKind;
  width: number;
  height: number;
}

/** PNG or JPEG by magic bytes; null for anything else, WebP included. */
export function detectImageKind(buf: Buffer): ImageKind | null {
  if (magicMatches('image/png', buf)) return 'png';
  if (magicMatches('image/jpeg', buf)) return 'jpeg';
  return null;
}

/** Null when the type is not PNG/JPEG or the header is truncated or malformed. Never throws. */
export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  switch (detectImageKind(buf)) {
    case 'png':  return readPng(buf);
    case 'jpeg': return readJpeg(buf);
    default:     return null;
  }
}

// After the 8-byte signature a PNG must open with IHDR: a 4-byte length (13),
// the type 'IHDR', then width and height as big-endian uint32.
function readPng(buf: Buffer): ImageDimensions | null {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(8) !== 13 || buf.toString('latin1', 12, 16) !== 'IHDR') return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { kind: 'png', width, height };
}

// SOF0..SOF15 carry the frame size, except C4 (DHT), C8 (JPG) and CC (DAC),
// which share the range but are not frame headers.
function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

// Walk the segments after SOI. Each is FF <marker>, optionally preceded by FF
// fill bytes; all but the standalone markers carry a 2-byte length that counts
// itself. The frame header is length(2) precision(1) height(2) width(2).
function readJpeg(buf: Buffer): ImageDimensions | null {
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) return null;
    while (buf[i + 1] === 0xff && i + 2 < buf.length) i += 1;
    const marker = buf[i + 1];
    i += 2;
    if (marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    // End of image, or scan data, before any frame header.
    if (marker === 0xd9 || marker === 0xda) return null;
    if (i + 2 > buf.length) return null;
    const length = buf.readUInt16BE(i);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (length < 7 || i + 7 > buf.length) return null;
      const height = buf.readUInt16BE(i + 3);
      const width = buf.readUInt16BE(i + 5);
      // Height 0 means "set later by a DNL marker", which this does not follow.
      if (width === 0 || height === 0) return null;
      return { kind: 'jpeg', width, height };
    }
    i += length;
  }
  return null;
}
