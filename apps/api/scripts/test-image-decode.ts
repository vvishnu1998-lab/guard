/**
 * test-image-decode.ts — checkImageDecodes (services/imageDecode.ts).
 *
 *   npx ts-node -P tsconfig.scripts.json scripts/test-image-decode.ts     (from apps/api)
 *
 * No database, no network. Fixtures are built in code (scripts/image-fixtures.ts).
 *
 *   C  the CRC-32 the checker uses is the standard one
 *   A  real images of every PNG colour type, bit depth and interlace, and JPEG: accepted
 *   R  each way a file can carry a valid header and still not decode: refused
 *   P  raw pdfkit renders every accepted fixture (in a child process, so a crash
 *      is an exit code); the N167 file CRASHES raw pdfkit, which is why this exists
 *   F  seeded fuzz: the checker never throws, and nothing it accepts crashes pdfkit
 *
 * pdfkit runs in child processes because the failure being guarded against is a
 * throw on a later tick, which would end this process too. poppler's pdftoppm,
 * when installed, re-renders each PDF and must print no error.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { checkImageDecodes, crc32 } from '../src/services/imageDecode';
import {
  jpegCorruptAfterHeader, jpegImage, jpegTruncated, pngBadCrc, pngChunk, pngCorruptAfterHeader,
  pngImage, pngPadded, seededBytes,
} from './image-fixtures';

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) { passes += 1; console.log(`  ✓ ${msg}`); }
  else      { failures += 1; console.log(`  ✗ FAIL: ${msg}`); }
}
function section(title: string): void { console.log(`\n── ${title}`); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'image-decode-'));
const RENDER = path.join(TMP, 'render.js');
fs.writeFileSync(RENDER, `
const PDFDocument = require(${JSON.stringify(require.resolve('pdfkit'))});
const fs = require('fs');
const doc = new PDFDocument({ margin: 0, size: 'A4' });
const chunks = [];
doc.on('data', (c) => chunks.push(c));
doc.on('end', () => { fs.writeFileSync(process.argv[3], Buffer.concat(chunks)); process.stdout.write('END'); });
try { doc.image(fs.readFileSync(process.argv[2]), 50, 14, { fit: [110, 46] }); doc.end(); }
catch (e) { process.stdout.write('SYNC_THROW'); }
`);
const HAVE_POPPLER = spawnSync('pdftoppm', ['-v']).status === 0;

/** Raw pdfkit on `img`, in a child process. */
function renderRaw(name: string, img: Buffer): { exit: number | null; out: string; pdf: boolean; poppler: string } {
  const src = path.join(TMP, `${name}.img`);
  const pdf = path.join(TMP, `${name}.pdf`);
  fs.writeFileSync(src, img);
  const r = spawnSync(process.execPath, [RENDER, src, pdf], { encoding: 'utf8', timeout: 30_000 });
  let poppler = 'not run';
  if (HAVE_POPPLER && fs.existsSync(pdf)) {
    const p = spawnSync('pdftoppm', ['-r', '20', '-png', pdf, path.join(TMP, name)], { encoding: 'utf8' });
    poppler = p.status === 0 && !p.stderr.trim() ? 'clean' : `ERROR ${p.status} ${p.stderr.trim().split('\n')[0]}`;
  }
  return { exit: r.status, out: r.stdout, pdf: fs.existsSync(pdf), poppler };
}

const ACCEPT: Array<[string, Buffer, 'png' | 'jpeg', number, number]> = [
  ['PNG RGBA 8-bit', pngImage(512, 512), 'png', 512, 512],
  ['PNG RGB 8-bit', pngImage(300, 300, { ctype: 2 }), 'png', 300, 300],
  ['PNG palette 8-bit', pngImage(300, 300, { ctype: 3 }), 'png', 300, 300],
  ['PNG palette 4-bit', pngImage(301, 257, { ctype: 3, depth: 4 }), 'png', 301, 257],
  ['PNG grey 1-bit', pngImage(300, 300, { ctype: 0, depth: 1 }), 'png', 300, 300],
  ['PNG grey+alpha 8-bit', pngImage(256, 300, { ctype: 4 }), 'png', 256, 300],
  ['PNG RGBA 16-bit', pngImage(300, 300, { depth: 16 }), 'png', 300, 300],
  ['PNG RGB Adam7 interlaced', pngImage(301, 257, { ctype: 2, interlace: 1 }), 'png', 301, 257],
  ['PNG RGBA Adam7 interlaced', pngImage(257, 301, { interlace: 1 }), 'png', 257, 301],
  ['PNG with a private ancillary chunk, exactly 2 MiB', pngPadded(256, 256, 2 * 1024 * 1024), 'png', 256, 256],
  ['JPEG baseline 640 × 480', jpegImage(640, 480), 'jpeg', 640, 480],
  ['JPEG baseline 2048 × 1024', jpegImage(2048, 1024), 'jpeg', 2048, 1024],
  ['JPEG extended sequential (SOF1)', jpegImage(300, 300, { sof: 0xc1 }), 'jpeg', 300, 300],
];

const REJECT: Array<[string, Buffer, string]> = [
  ['PNG: valid IHDR, garbage IDAT with a correct CRC (N167)', pngCorruptAfterHeader(512, 512), 'does not inflate'],
  ['PNG: one IDAT byte flipped', pngBadCrc(pngImage(512, 512)), 'bad CRC in IDAT'],
  ['PNG: cut at 60%', pngImage(512, 512).subarray(0, Math.floor(pngImage(512, 512).length * 0.6)), 'runs past the end'],
  ['PNG: cut before IEND', pngImage(300, 300, { ctype: 2 }).subarray(0, pngImage(300, 300, { ctype: 2 }).length - 12), 'no IEND'],
  ['PNG: image data 10 rows short', pngImage(300, 300, { ctype: 2, shortRows: 10 }), 'the header implies'],
  ['PNG: filter type 9 on the first row', pngImage(300, 300, { ctype: 2, firstFilter: 9 }), 'invalid filter type 9'],
  ['PNG: palette image without PLTE', pngImage(300, 300, { ctype: 3, omitPalette: true }), 'without PLTE'],
  ['PNG: an unknown critical chunk', pngImage(300, 300, { ctype: 2, extra: [pngChunk('ZZZZ', Buffer.from('x'))] }), 'unknown critical chunk'],
  ['PNG: colour type 2 at 4 bits', Buffer.concat([pngImage(300, 300, { ctype: 2 }).subarray(0, 8), pngChunk('IHDR', Buffer.from([0, 0, 1, 44, 0, 0, 1, 44, 4, 2, 0, 0, 0])), pngImage(300, 300, { ctype: 2 }).subarray(33)]), 'bad colour type or bit depth'],
  ['PNG: 5000 × 10', pngImage(5000, 10, { ctype: 0, depth: 1 }), 'dimensions out of range'],
  ['JPEG: frame header then garbage (N167)', jpegCorruptAfterHeader(640, 480), 'expected a marker'],
  ['JPEG: EOI cut off', jpegTruncated(640, 480), 'no EOI'],
  ['JPEG: 12-bit samples', jpegImage(300, 300, { precision: 12 }), '12-bit'],
  ['JPEG: arithmetic coding (SOF9)', jpegImage(300, 300, { sof: 0xc9 }), 'unsupported frame type FFC9'],
  ['JPEG: lossless (SOF3)', jpegImage(300, 300, { sof: 0xc3 }), 'unsupported frame type FFC3'],
  ['not an image', Buffer.from('%PDF-1.4 not a logo at all'), 'neither PNG nor JPEG'],
  ['empty', Buffer.alloc(0), 'empty'],
];

function main(): void {
  section('C  CRC-32');
  check(crc32(Buffer.from('123456789')) === 0xcbf43926, 'C1 crc32("123456789") = 0xCBF43926, the standard check value');
  const z = (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32;
  if (z) {
    const samples = Array.from({ length: 50 }, (_, i) => seededBytes(1 + i * 37, 1000 + i));
    check(samples.every((b) => crc32(b) === z(b) >>> 0), 'C2 equals node:zlib crc32 on 50 seeded buffers');
  } else {
    console.log('  (C2 skipped: this Node has no zlib.crc32)');
  }

  section('A  real images: accepted with the right kind and size');
  for (const [label, img, kind, w, h] of ACCEPT) {
    const r = checkImageDecodes(img);
    check(r.ok && r.kind === kind && r.width === w && r.height === h, `A ${label} (${img.length} bytes): ${r.ok ? `${r.kind} ${r.width}×${r.height}` : `REFUSED ${r.reason}`}`);
  }

  section('R  a valid header that does not decode: refused, with the reason');
  for (const [label, img, why] of REJECT) {
    const r = checkImageDecodes(img);
    check(!r.ok && r.reason.includes(why), `R ${label}: ${r.ok ? 'ACCEPTED' : r.reason}`);
  }

  section(`P  raw pdfkit on the fixtures (child processes${HAVE_POPPLER ? ', poppler re-render' : ', poppler not installed'})`);
  ACCEPT.forEach(([label, img], i) => {
    const r = renderRaw(`accept-${i}`, img);
    check(r.exit === 0 && r.out === 'END' && r.pdf && (r.poppler === 'clean' || r.poppler === 'not run'),
      `P every accepted fixture renders: ${label} (exit ${r.exit}, ${r.out || 'no output'}, poppler ${r.poppler})`);
  });
  {
    const r = renderRaw('crash-control', pngCorruptAfterHeader(512, 512));
    check(r.exit !== 0 && !r.pdf,
      `P CONTROL: the N167 file given to raw pdfkit ends the process with no PDF (exit ${r.exit}, pdf ${r.pdf}). This is the failure the check prevents.`);
  }

  section('F  seeded fuzz');
  const bases = [pngImage(300, 300), pngImage(300, 300, { ctype: 2, interlace: 1 }), pngImage(300, 300, { ctype: 3 }), jpegImage(320, 240)];
  let threw = 0;
  const accepted = { png: 0, jpeg: 0 };
  const acceptedSamples: Buffer[] = [];
  for (let i = 0; i < 4000; i++) {
    const base = bases[i % bases.length];
    const r = seededBytes(4, 9000 + i);
    let m: Buffer;
    if (r[0] % 3 === 0) m = base.subarray(0, (r.readUInt16BE(1) % base.length));
    else { m = Buffer.from(base); for (let k = 0; k <= r[3] % 4; k++) m[(r.readUInt16BE(1) * (k + 1) * 7919) % m.length] ^= 1 + r[k]; }
    try {
      const v = checkImageDecodes(m);
      if (v.ok) { accepted[v.kind] += 1; if (acceptedSamples.length < 40) acceptedSamples.push(m); }
    } catch {
      threw += 1;
    }
  }
  check(threw === 0, `F1 4,000 truncated or bit-flipped files: the checker never threw (accepted ${accepted.png} PNG, ${accepted.jpeg} JPEG)`);
  check(accepted.png === 0, `F1b no damaged PNG accepted: every PNG byte that matters is under a CRC (accepted ${accepted.png})`);
  let crashed = 0;
  acceptedSamples.forEach((m, i) => { if (renderRaw(`fuzz-${i}`, m).exit !== 0) crashed += 1; });
  check(crashed === 0, `F2 raw pdfkit on ${acceptedSamples.length} accepted mutants (flips that kept the structure, e.g. inside JPEG scan data): no crash`);

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
