/**
 * test-image-dimensions.ts — services/imageDimensions.ts, no database.
 *
 * Fixtures are built byte by byte here, so the expected width and height come
 * from the test, not from the code under test. Covers both PNG and JPEG
 * headers, the JPEG segment walk (fill bytes, DHT/DAC/JPG markers that share
 * the SOF range, scan data or end-of-image before any frame header), truncated
 * and zero-sized headers, non-PNG/JPEG types, and a seeded fuzz pass proving
 * the reader never throws.
 *
 *   npx ts-node scripts/test-image-dimensions.ts          (from apps/api)
 */
import { detectImageKind, readImageDimensions } from '../src/services/imageDimensions';

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }
const show = (v: unknown): string => JSON.stringify(v);

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Signature + IHDR + IEND. CRCs are left zero: the reader does not check them. */
export function pngHeader(width: number, height: number, chunkType = 'IHDR'): Buffer {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write(chunkType, 4, 'latin1');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr[16] = 8;   // bit depth
  ihdr[17] = 6;   // colour type RGBA
  const iend = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([Buffer.from(PNG_SIG), ihdr, iend]);
}

function segment(marker: number, payload: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}
function sofPayload(width: number, height: number): Buffer {
  const p = Buffer.alloc(15);
  p[0] = 8;                      // precision
  p.writeUInt16BE(height, 1);
  p.writeUInt16BE(width, 3);
  p[5] = 3;                      // components
  return p;
}
const JFIF = segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));

/** SOI, APP0, optional segments, a frame header, EOI. */
export function jpegHeader(width: number, height: number, opts: { sof?: number; before?: Buffer[] } = {}): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    JFIF,
    ...(opts.before ?? []),
    segment(opts.sof ?? 0xc0, sofPayload(width, height)),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function main(): void {
  section('PNG');
  check(show(readImageDimensions(pngHeader(300, 200))) === show({ kind: 'png', width: 300, height: 200 }), 'reads 300 × 200');
  check(show(readImageDimensions(pngHeader(2048, 1))) === show({ kind: 'png', width: 2048, height: 1 }), 'reads 2048 × 1');
  check(readImageDimensions(pngHeader(70000, 5))?.width === 70000, 'reads a width above 65535 (uint32, not uint16)');
  check(readImageDimensions(pngHeader(0, 10)) === null, 'zero width → null');
  check(readImageDimensions(pngHeader(10, 0)) === null, 'zero height → null');
  check(readImageDimensions(pngHeader(10, 10, 'IDAT')) === null, 'first chunk not IHDR → null');
  check(readImageDimensions(pngHeader(10, 10).subarray(0, 23)) === null, 'truncated before the height ends → null');
  check(readImageDimensions(Buffer.from(PNG_SIG)) === null, 'signature only → null');
  {
    const b = pngHeader(10, 10);
    b.writeUInt32BE(14, 8);
    check(readImageDimensions(b) === null, 'IHDR length not 13 → null');
  }

  section('JPEG');
  check(show(readImageDimensions(jpegHeader(300, 200))) === show({ kind: 'jpeg', width: 300, height: 200 }), 'baseline SOF0 300 × 200 (width and height not swapped)');
  check(readImageDimensions(jpegHeader(640, 480, { sof: 0xc2 }))?.width === 640, 'progressive SOF2');
  check(readImageDimensions(jpegHeader(640, 480, { sof: 0xc9 }))?.height === 480, 'arithmetic SOF9');
  check(readImageDimensions(jpegHeader(512, 256, { before: [segment(0xe1, Buffer.alloc(60000))] }))?.width === 512, 'skips a 60 KB APP1 (EXIF-sized) segment');
  check(readImageDimensions(jpegHeader(512, 256, { before: [segment(0xc4, Buffer.alloc(20, 7))] }))?.width === 512, 'DHT (C4) is skipped, not read as a frame header');
  check(readImageDimensions(jpegHeader(512, 256, { before: [segment(0xcc, Buffer.alloc(6, 9))] }))?.width === 512, 'DAC (CC) is skipped');
  check(readImageDimensions(jpegHeader(512, 256, { before: [segment(0xc8, Buffer.alloc(6, 9))] }))?.width === 512, 'JPG (C8) is skipped');
  check(readImageDimensions(jpegHeader(512, 256, { before: [Buffer.from([0xff, 0xff, 0xff])] }))?.width === 512, 'FF fill bytes before a marker');
  check(readImageDimensions(jpegHeader(512, 256, { before: [Buffer.from([0xff, 0xd0])] }))?.width === 512, 'standalone RST0 marker (no length) is stepped over');
  check(readImageDimensions(jpegHeader(512, 256, { before: [segment(0xda, Buffer.alloc(10))] })) === null, 'scan data (SOS) before any frame header → null');
  check(readImageDimensions(Buffer.concat([Buffer.from([0xff, 0xd8]), JFIF, Buffer.from([0xff, 0xd9])])) === null, 'end of image with no frame header → null');
  check(readImageDimensions(jpegHeader(0, 100)) === null, 'width 0 → null');
  check(readImageDimensions(jpegHeader(100, 0)) === null, 'height 0 (DNL-deferred) → null');
  {
    const full = jpegHeader(300, 200);
    const sofAt = full.indexOf(Buffer.from([0xff, 0xc0]));
    check(readImageDimensions(full.subarray(0, sofAt + 7)) === null, 'truncated inside the frame header → null');
  }
  {
    const b = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.from([0x00, 0x11, 0x22, 0x33]), JFIF]);
    check(readImageDimensions(b) === null, 'bytes that are not a marker where one must be → null');
  }
  {
    const b = jpegHeader(300, 200);
    b.writeUInt16BE(1, 4);   // APP0 length below its own 2 bytes
    check(readImageDimensions(b) === null, 'segment length < 2 → null (no infinite loop)');
  }

  section('type detection is by magic bytes only');
  check(detectImageKind(pngHeader(1, 1)) === 'png', 'PNG');
  check(detectImageKind(jpegHeader(1, 1)) === 'jpeg', 'JPEG');
  check(detectImageKind(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1')) === null, 'GIF → null');
  check(detectImageKind(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 ', 'latin1')) === null, 'WebP → null (allowed for guard photos, not for the logo)');
  check(detectImageKind(Buffer.from('%PDF-1.7')) === null, 'PDF → null');
  check(detectImageKind(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) === null, 'SVG → null');
  check(detectImageKind(Buffer.alloc(0)) === null && readImageDimensions(Buffer.alloc(0)) === null, 'empty buffer → null');

  section('documented limitation: only the header is read');
  {
    const b = Buffer.concat([pngHeader(400, 400).subarray(0, 33), Buffer.from('not image data at all')]);
    check(readImageDimensions(b)?.width === 400, 'a valid IHDR followed by garbage is ACCEPTED: drawing code must handle a decode failure');
  }

  section('fuzz: never throws (seeded, 20,000 buffers)');
  {
    let seed = 0x5eed;
    const rnd = (): number => { seed = (seed * 1103515245 + 12345) >>> 0; return seed >>> 16; };
    let threw = 0;
    let parsed = 0;
    for (let n = 0; n < 20000; n += 1) {
      const len = rnd() % 64;
      const body = Buffer.alloc(len);
      for (let i = 0; i < len; i += 1) body[i] = (rnd() % 7 === 0) ? 0xff : rnd() & 0xff;
      const prefix = n % 2 === 0 ? Buffer.from([0xff, 0xd8, 0xff]) : Buffer.from(PNG_SIG);
      try {
        if (readImageDimensions(Buffer.concat([prefix, body]))) parsed += 1;
      } catch {
        threw += 1;
      }
    }
    check(threw === 0, `0 of 20,000 random JPEG/PNG-prefixed buffers threw (got ${threw}; ${parsed} happened to parse)`);
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

// The fixture builders above are imported by test-company-profile.ts; only a
// direct run executes the checks.
if (require.main === module) main();
