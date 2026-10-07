/**
 * image-fixtures.ts — real, decodable PNG and JPEG test images built in code,
 * plus the broken variants the decode check must refuse.
 *
 * test-image-dimensions.ts builds HEADERS only (a signature and an IHDR or a
 * SOF, nothing after). Those stay right for the dimension reader, but they do
 * not decode, so since the logo upload checks that an image decodes they can
 * no longer stand in for a valid upload. These can.
 *
 * Nothing here reads a file or the network. Garbage bytes come from a seeded
 * generator, so every fixture is identical on every run.
 */
import zlib from 'node:zlib';
// The checker's own CRC: test-image-decode.ts pins it to the standard check
// value and to zlib.crc32, so sharing it here cannot hide a wrong CRC.
import { crc32 } from '../src/services/imageDecode';

// ── PNG ─────────────────────────────────────────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function ihdr(w: number, h: number, depth: number, ctype: number, interlace = 0): Buffer {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(w, 0);
  d.writeUInt32BE(h, 4);
  d[8] = depth; d[9] = ctype; d[10] = 0; d[11] = 0; d[12] = interlace;
  return pngChunk('IHDR', d);
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];

/** Raw scanlines (filter byte 0) for a solid image, Adam7 order when interlaced. */
function scanlines(w: number, h: number, depth: number, ctype: number, interlace: number, pixel: Buffer): Buffer {
  const passes = interlace
    ? ADAM7.map(([x0, y0, dx, dy]) => ({ w: w > x0 ? Math.ceil((w - x0) / dx) : 0, h: h > y0 ? Math.ceil((h - y0) / dy) : 0 }))
    : [{ w, h }];
  const rows: Buffer[] = [];
  for (const p of passes) {
    if (!p.w || !p.h) continue;
    const rowBytes = Math.ceil((p.w * CHANNELS[ctype] * depth) / 8);
    const row = Buffer.alloc(1 + rowBytes);
    for (let i = 1; i < row.length; i++) row[i] = pixel[(i - 1) % pixel.length];
    for (let y = 0; y < p.h; y++) rows.push(row);
  }
  return Buffer.concat(rows);
}

export interface PngOptions {
  /** 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA. Default 6. */
  ctype?: 0 | 2 | 3 | 4 | 6;
  depth?: 1 | 2 | 4 | 8 | 16;
  interlace?: 0 | 1;
  /** Drop this many scanlines from the end of the image data. */
  shortRows?: number;
  /** Overwrite the first scanline's filter byte. */
  firstFilter?: number;
  /** Leave out PLTE from a palette image. */
  omitPalette?: boolean;
  /** Extra chunks inserted before IEND. */
  extra?: Buffer[];
}

/** A PNG that decodes: a solid teal (or grey) image of w × h. */
export function pngImage(w: number, h: number, o: PngOptions = {}): Buffer {
  const ctype = o.ctype ?? 6;
  const depth = o.depth ?? 8;
  const interlace = o.interlace ?? 0;
  const px: Record<number, Buffer> = {
    0: depth === 16 ? Buffer.from([0x76, 0x76]) : Buffer.from([depth === 8 ? 0x76 : 0x55]),
    2: depth === 16 ? Buffer.from([0x0f, 0x0f, 0x76, 0x76, 0x6e, 0x6e]) : Buffer.from([0x0f, 0x76, 0x6e]),
    3: Buffer.from([depth === 8 ? 1 : 0x55]),
    4: depth === 16 ? Buffer.from([0x76, 0x76, 0xff, 0xff]) : Buffer.from([0x76, 0xff]),
    6: depth === 16 ? Buffer.from([0x0f, 0x0f, 0x76, 0x76, 0x6e, 0x6e, 0xff, 0xff]) : Buffer.from([0x0f, 0x76, 0x6e, 0xff]),
  };
  let raw = scanlines(w, h, depth, ctype, interlace, px[ctype]);
  if (o.shortRows) {
    const rowLen = 1 + Math.ceil((w * CHANNELS[ctype] * depth) / 8);
    raw = raw.subarray(0, raw.length - o.shortRows * rowLen);
  }
  if (o.firstFilter !== undefined) { raw = Buffer.from(raw); raw[0] = o.firstFilter; }
  const parts = [PNG_SIG, ihdr(w, h, depth, ctype, interlace)];
  if (ctype === 3 && !o.omitPalette) parts.push(pngChunk('PLTE', Buffer.from([0x0f, 0x76, 0x6e, 0xfa, 0xcc, 0x15])));
  parts.push(pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })), ...(o.extra ?? []), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/**
 * A decodable PNG of EXACTLY `total` bytes, padded with a private ancillary
 * chunk (`paDd`: ancillary, private, safe to copy), which decoders skip.
 */
export function pngPadded(w: number, h: number, total: number): Buffer {
  const base = pngImage(w, h, { ctype: 2 });
  const fill = total - base.length - 12;
  if (fill < 0) throw new Error(`pngPadded: ${w}x${h} is already ${base.length} bytes`);
  return pngImage(w, h, { ctype: 2, extra: [pngChunk('paDd', Buffer.alloc(fill))] });
}

/** Seeded bytes, never 0xFF (so a JPEG walk cannot mistake them for a marker). */
export function seededBytes(n: number, seed = 167, avoidFF = false): Buffer {
  const out = Buffer.alloc(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    let b = s >>> 24;
    if (avoidFF && b === 0xff) b = 0xfe;
    out[i] = b;
  }
  return out;
}

/**
 * The N167 case: a valid signature and IHDR (RGBA, so pdfkit would decode it),
 * then an IDAT chunk of garbage with a CORRECT CRC, then IEND. The header
 * reader accepts it; the image data does not inflate.
 */
export function pngCorruptAfterHeader(w: number, h: number): Buffer {
  return Buffer.concat([PNG_SIG, ihdr(w, h, 8, 6), pngChunk('IDAT', seededBytes(4096)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A copy of `png` with one byte of the first IDAT payload flipped (its CRC now wrong). */
export function pngBadCrc(png: Buffer): Buffer {
  const out = Buffer.from(png);
  out[png.indexOf('IDAT', 8, 'latin1') + 4 + 10] ^= 0x40;
  return out;
}

// ── JPEG ────────────────────────────────────────────────────────────────────
// A baseline JPEG encoder for exactly one image: a solid mid-grey w × h.
// Every 8×8 block has DC 0 (grey 128 after the level shift) and no AC terms,
// so with a DC table holding only category 0 (code "0") and an AC table holding
// only EOB (code "0"), each block is two zero bits. The result is a complete,
// standard file any decoder reads (verified with macOS ImageIO and poppler).

function seg(marker: number, body: Buffer): Buffer {
  const head = Buffer.alloc(4);
  head[0] = 0xff; head[1] = marker; head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

export interface JpegOptions {
  /** SOF marker byte. Default 0xC0 (baseline). */
  sof?: number;
  /** Sample precision written in the SOF. Default 8. */
  precision?: number;
}

export function jpegImage(w: number, h: number, o: JpegOptions = {}): Buffer {
  const jfif = seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));
  const dqt = seg(0xdb, Buffer.concat([Buffer.from([0x00]), Buffer.alloc(64, 1)]));
  const sofBody = Buffer.alloc(9);
  sofBody[0] = o.precision ?? 8;
  sofBody.writeUInt16BE(h, 1);
  sofBody.writeUInt16BE(w, 3);
  sofBody[5] = 1; sofBody[6] = 1; sofBody[7] = 0x11; sofBody[8] = 0;
  const sof = seg(o.sof ?? 0xc0, sofBody);
  const bits = Buffer.alloc(16); bits[0] = 1;
  const dhtDc = seg(0xc4, Buffer.concat([Buffer.from([0x00]), bits, Buffer.from([0x00])]));
  const dhtAc = seg(0xc4, Buffer.concat([Buffer.from([0x10]), bits, Buffer.from([0x00])]));
  const sos = seg(0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]));
  const blocks = Math.ceil(w / 8) * Math.ceil(h / 8);
  const nbits = blocks * 2;
  const scan = Buffer.alloc(Math.ceil(nbits / 8));
  if (nbits % 8) scan[scan.length - 1] = (1 << (8 - (nbits % 8))) - 1;   // pad the last byte with 1s
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, dqt, sof, dhtDc, dhtAc, sos, scan, Buffer.from([0xff, 0xd9])]);
}

/** Everything up to the end of the SOF segment, then marker-free garbage. */
export function jpegCorruptAfterHeader(w: number, h: number): Buffer {
  const j = jpegImage(w, h);
  const at = j.indexOf(Buffer.from([0xff, 0xc0]));
  const end = at + 2 + j.readUInt16BE(at + 2);
  return Buffer.concat([j.subarray(0, end), seededBytes(3000, 167, true)]);
}

/** A complete JPEG with its EOI and the last bytes of scan data cut off. */
export function jpegTruncated(w: number, h: number): Buffer {
  const j = jpegImage(w, h);
  return j.subarray(0, j.length - 6);
}
