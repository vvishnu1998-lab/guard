/**
 * Does an image actually decode? PNG and JPEG only. Never throws.
 *
 * imageDimensions.ts reads a header and stops; that was enough to size-check
 * an upload, and N167 already said a logo whose body is garbage must fall back
 * to the company name. What made this a gate rather than a nicety is how
 * pdfkit 0.18 treats such a file. A PNG with an alpha channel, a tRNS chunk or
 * Adam7 interlacing is decoded by png-js, and png-js inflates the image data
 * with a CALLBACK that throws on bad data (png-js/lib/png-js.cjs, decodePixels).
 * That throw happens on a later tick, outside any try/catch around
 * doc.image(), and the API installs no uncaughtException handler, so the
 * process exits. Measured 2026-10-06: a PNG with a valid IHDR and garbage IDAT
 * passed readImageDimensions, and a process rendering it exited 1 with no PDF.
 *
 *   PNG  — every chunk's CRC, the IHDR rules, PLTE present for palette
 *          images, no unknown critical chunk, then the whole IDAT stream
 *          inflated here (synchronously, so a failure is a return value) and
 *          held to the exact size the header implies, Adam7 included, with
 *          every scanline's filter type checked. That is everything png-js
 *          does before un-filtering, which cannot fail once those hold.
 *   JPEG — a full marker walk: SOI; every segment inside the file; one 8-bit
 *          baseline, extended or progressive frame with 1, 3 or 4 components;
 *          a quantisation table; at least one scan whose data runs to a real
 *          marker; EOI. There is no Huffman decode (the API's dependency tree
 *          has no JPEG decoder), so a file whose structure is intact but whose
 *          scan bits are scrambled passes and renders as noise. That is
 *          cosmetic, never a crash: pdfkit embeds JPEG bytes verbatim
 *          (DCTDecode), exceljs stores them verbatim, and a mail client
 *          decodes its own attachments.
 */
import zlib from 'node:zlib';

export type DecodeCheck =
  | { ok: true; kind: 'png' | 'jpeg'; width: number; height: number }
  | { ok: false; reason: string };

/** Larger than any accepted logo (2048); bounds the inflate for any caller. */
export const DECODE_MAX_SIDE = 4096;

const no = (reason: string): DecodeCheck => ({ ok: false, reason });

// ── CRC-32 (IEEE), table-driven ──────────────────────────────────────────────
// zlib.crc32 exists only from Node 22.2; this does not depend on the runtime.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── PNG ─────────────────────────────────────────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]];
const KNOWN_CRITICAL = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);

function checkPng(buf: Buffer): DecodeCheck {
  if (buf.length < 8 + 25 + 12 + 12 || !buf.subarray(0, 8).equals(PNG_SIG)) return no('png: bad signature');
  let pos = 8;
  let ihdr: { w: number; h: number; depth: number; ctype: number; interlace: number } | null = null;
  let sawPlte = false;
  let sawIend = false;
  const idat: Buffer[] = [];
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const dataEnd = pos + 8 + len;
    if (len > 0x7fffffff || dataEnd + 4 > buf.length) return no(`png: ${type} chunk runs past the end of the file`);
    if (crc32(buf, pos + 4, dataEnd) !== buf.readUInt32BE(dataEnd)) return no(`png: bad CRC in ${type}`);
    if (!ihdr && type !== 'IHDR') return no('png: IHDR is not the first chunk');
    if (type === 'IHDR') {
      if (ihdr || len !== 13) return no('png: bad IHDR');
      const d = buf.subarray(pos + 8, dataEnd);
      ihdr = { w: d.readUInt32BE(0), h: d.readUInt32BE(4), depth: d[8], ctype: d[9], interlace: d[12] };
      if (!ihdr.w || !ihdr.h || ihdr.w > DECODE_MAX_SIDE || ihdr.h > DECODE_MAX_SIDE) return no('png: dimensions out of range');
      if (!(ihdr.ctype in DEPTHS) || !DEPTHS[ihdr.ctype].includes(ihdr.depth)) return no('png: bad colour type or bit depth');
      if (d[10] !== 0 || d[11] !== 0 || ihdr.interlace > 1) return no('png: bad compression, filter or interlace method');
    } else if (type === 'PLTE') {
      if (len === 0 || len % 3 !== 0 || len > 768) return no('png: bad PLTE');
      sawPlte = true;
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(pos + 8, dataEnd));
    } else if (type === 'IEND') {
      sawIend = true;
      break;
    } else if (type.charCodeAt(0) < 0x61 && !KNOWN_CRITICAL.has(type)) {
      return no(`png: unknown critical chunk ${type}`);
    }
    pos = dataEnd + 4;
  }
  if (!ihdr) return no('png: no IHDR');
  if (!sawIend) return no('png: no IEND (truncated)');
  if (idat.length === 0) return no('png: no IDAT');
  if (ihdr.ctype === 3 && !sawPlte) return no('png: palette image without PLTE');

  const { w, h, depth, ctype, interlace } = ihdr;
  const passes = interlace
    ? ADAM7.map(([x0, y0, dx, dy]) => ({ w: w > x0 ? Math.ceil((w - x0) / dx) : 0, h: h > y0 ? Math.ceil((h - y0) / dy) : 0 }))
        .filter((p) => p.w > 0 && p.h > 0)
    : [{ w, h }];
  const rowBytes = (pw: number) => 1 + Math.ceil((pw * CHANNELS[ctype] * depth) / 8);
  const expected = passes.reduce((sum, p) => sum + p.h * rowBytes(p.w), 0);
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    return no(`png: image data does not inflate (${(err as NodeJS.ErrnoException)?.code ?? 'error'})`);
  }
  if (raw.length !== expected) return no(`png: image data is ${raw.length} bytes, the header implies ${expected}`);
  let at = 0;
  for (const p of passes) {
    const step = rowBytes(p.w);
    for (let r = 0; r < p.h; r++, at += step) {
      if (raw[at] > 4) return no(`png: invalid filter type ${raw[at]}`);
    }
  }
  return { ok: true, kind: 'png', width: w, height: h };
}

// ── JPEG ────────────────────────────────────────────────────────────────────
// SOF0 baseline, SOF1 extended sequential, SOF2 progressive: the Huffman-coded
// frames every PDF viewer and mail client decodes. Lossless, arithmetic and
// hierarchical frames are refused, and a refused logo falls back to the name.
const SOF_SUPPORTED = new Set([0xc0, 0xc1, 0xc2]);
const SOF_ALL = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const hex = (m: number) => `FF${m.toString(16).toUpperCase().padStart(2, '0')}`;

function checkJpeg(buf: Buffer): DecodeCheck {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return no('jpeg: no SOI');
  let pos = 2;
  let frame: { w: number; h: number } | null = null;
  let sawDqt = false;
  let scans = 0;
  for (;;) {
    if (pos >= buf.length) return no('jpeg: no EOI (truncated)');
    if (buf[pos] !== 0xff) return no(`jpeg: expected a marker at byte ${pos}`);
    while (pos < buf.length && buf[pos] === 0xff) pos++;
    if (pos >= buf.length) return no('jpeg: no EOI (truncated)');
    const m = buf[pos++];
    if (m === 0xd9) break;
    if (m === 0x00 || m === 0x01 || m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) return no(`jpeg: unexpected marker ${hex(m)}`);
    if (pos + 2 > buf.length) return no('jpeg: segment length runs past the end of the file');
    const len = buf.readUInt16BE(pos);
    if (len < 2 || pos + len > buf.length) return no(`jpeg: ${hex(m)} segment runs past the end of the file`);
    const body = buf.subarray(pos + 2, pos + len);
    if (SOF_ALL.has(m)) {
      if (!SOF_SUPPORTED.has(m)) return no(`jpeg: unsupported frame type ${hex(m)}`);
      if (frame || body.length < 6) return no('jpeg: bad frame header');
      const precision = body[0];
      const h = body.readUInt16BE(1);
      const w = body.readUInt16BE(3);
      const comps = body[5];
      if (precision !== 8) return no(`jpeg: ${precision}-bit samples`);
      if (![1, 3, 4].includes(comps) || body.length !== 6 + 3 * comps) return no('jpeg: bad component count');
      if (!w || !h || w > DECODE_MAX_SIDE || h > DECODE_MAX_SIDE) return no('jpeg: dimensions out of range');
      frame = { w, h };
    }
    if (m === 0xdb) sawDqt = true;
    pos += len;
    if (m === 0xda) {
      if (!frame) return no('jpeg: scan before the frame header');
      scans++;
      const start = pos;
      while (pos < buf.length) {
        if (buf[pos] === 0xff) {
          const next = buf[pos + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { pos += 2; continue; }
          if (next === 0xff) { pos += 1; continue; }
          break;
        }
        pos++;
      }
      if (pos === start) return no('jpeg: empty scan');
    }
  }
  if (!frame) return no('jpeg: no frame header');
  if (!sawDqt) return no('jpeg: no quantisation table');
  if (scans === 0) return no('jpeg: no scan');
  return { ok: true, kind: 'jpeg', width: frame.w, height: frame.h };
}

export function checkImageDecodes(buf: Buffer): DecodeCheck {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 4) return no('empty');
    if (buf[0] === 0x89 && buf[1] === 0x50) return checkPng(buf);
    if (buf[0] === 0xff && buf[1] === 0xd8) return checkJpeg(buf);
    return no('neither PNG nor JPEG');
  } catch (err) {
    // Every read above is bounds-checked; this is a backstop, not a path.
    return no(`unexpected: ${err instanceof Error ? err.message : String(err)}`);
  }
}
