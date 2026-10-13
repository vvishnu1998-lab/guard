#!/usr/bin/env node
/**
 * Generate a static QR SVG for https://www.netraops.com/app?src=<tag>.
 *
 *   node scripts/gen-store-qr.js desktop public/qr/app-desktop.svg
 *   node scripts/gen-store-qr.js admin   public/qr/app-admin.svg
 *   node scripts/gen-store-qr.js desktop /tmp/noise.svg --noise     (negative control)
 *
 * WHY A SCRIPT AND COMMITTED SVGS: the payload is a constant, so a runtime
 * generator would add a dependency and a failure mode for nothing. The code
 * itself must never change without a re-scan on real phones, which is exactly
 * what committing the file makes reviewable.
 *
 * SPEC (owner-approved research, 2026-10-13): static code, no shortener or
 * tracker; error correction M for clean screens; a 4-module quiet zone baked
 * into the SVG; navy modules on white, no logo, no rounding, no gold or cyan
 * modules. Payload = APP_PAGE_URL + '?src=' + tag, the tag one of the short
 * aliases in lib/storeLinks.ts (9 characters or fewer) so the symbol stays a
 * 29x29 version-3 code. Display it at a whole number of pixels per module
 * (37 modules incl. quiet zone x 6px = 222px).
 *
 * The encoder is the MIT-licensed one bundled in qrcode-terminal (already in
 * node_modules as a transitive dependency; NOT a declared dependency of
 * apps/web). If it is ever absent this script fails loudly: do not add a
 * production dependency for it, install it in a scratch directory instead.
 *
 * --noise flips ~40% of the modules at random. It exists only to prove that
 * scripts/decode-qr.swift can FAIL; never commit its output.
 */
const fs = require('fs');
const path = require('path');

let QRCode, ECC;
try {
  QRCode = require('qrcode-terminal/vendor/QRCode');
  ECC = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');
} catch (e) {
  console.error('qrcode-terminal is not installed; install it in a scratch directory and point NODE_PATH at it.');
  process.exit(2);
}

const [tag, outPath, ...flags] = process.argv.slice(2);
if (!tag || !outPath) {
  console.error('usage: gen-store-qr.js <tag> <out.svg> [--noise]');
  process.exit(2);
}
if (!/^[a-z0-9_]{2,9}$/.test(tag)) {
  console.error(`tag '${tag}' must be a registry alias of 9 characters or fewer`);
  process.exit(2);
}

const NAVY = '#0B1526';
const QUIET = 4;
const payload = `https://www.netraops.com/app?src=${tag}`;

// Version 3-M holds 42 bytes; the encoder throws if the data does not fit.
const qr = new QRCode(3, ECC.M);
qr.addData(payload);
qr.make();
const n = qr.getModuleCount();
if (n !== 29) {
  console.error(`expected a 29x29 symbol, got ${n}x${n}`);
  process.exit(1);
}

let seed = 12345; // deterministic noise
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const noise = flags.includes('--noise');

let d = '';
for (let y = 0; y < n; y++) {
  for (let x = 0; x < n; x++) {
    let dark = qr.isDark(y, x);
    if (noise && rnd() < 0.4) dark = !dark;
    if (dark) d += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
  }
}
const size = n + QUIET * 2;
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 6}" height="${size * 6}" shape-rendering="crispEdges" role="img" aria-label="QR code: opens netraops.com/app">` +
  `<rect width="${size}" height="${size}" fill="#fff"/>` +
  `<path fill="${NAVY}" d="${d}"/>` +
  `</svg>\n`;

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
fs.writeFileSync(outPath, svg);
console.log(`${noise ? 'NOISE ' : ''}${outPath}: ${payload} (${payload.length} bytes) -> ${n}x${n} modules + ${QUIET} quiet, ECC M, ${svg.length} bytes`);
