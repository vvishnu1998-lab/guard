#!/usr/bin/env node
/**
 * Fail the build when the mobile break constant drifts from the server's.
 *
 * WHY THIS EXISTS. apps/mobile/constants/breakDurations.ts and
 * apps/api/src/constants/breakDurations.ts are two hand-maintained copies of
 * the same number. The monorepo has no shared package between the two apps,
 * and every previous attempt to keep them aligned was a header comment
 * asking a human to remember. That failed. This is the mechanism that
 * replaces the comment.
 *
 * WIRED TO `postinstall` in apps/mobile/package.json, so it runs on every
 * `npm install` and inside every EAS build (EAS installs before it bundles).
 * A drifted constant therefore fails the build rather than shipping.
 *
 * DELIBERATELY LENIENT IN ONE DIRECTION: if the server file cannot be found
 * or cannot be parsed, this exits 0 with a warning. A mobile-only checkout,
 * a shallow clone, or a future refactor that moves the server file must not
 * brick `npm install`. The check protects against silent DISAGREEMENT, which
 * is the failure that actually happened; it does not try to prove the server
 * file exists.
 *
 * Regex rather than an import because this is plain CJS run by npm before any
 * TypeScript toolchain is guaranteed to be available.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MOBILE = path.join(__dirname, '..', 'constants', 'breakDurations.ts');
const SERVER = path.join(__dirname, '..', '..', 'api', 'src', 'constants', 'breakDurations.ts');

function readNumber(file, name) {
  const src = fs.readFileSync(file, 'utf8');
  // `export const NAME = 30;` / `export const NAME: number = 30;`
  const m = src.match(new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=]+)?=\\s*(\\d+)`));
  return m ? Number(m[1]) : null;
}

function warn(msg) {
  console.warn(`[check-break-constants] SKIPPED: ${msg}`);
  process.exit(0);
}

let mobile, server;
try {
  mobile = readNumber(MOBILE, 'BREAK_DURATION_MINUTES');
} catch (err) {
  warn(`could not read the mobile constants file (${err.code || err.message})`);
}
try {
  if (!fs.existsSync(SERVER)) warn('server constants file not present in this checkout');
  server = readNumber(SERVER, 'BREAK_DURATION_MINUTES');
} catch (err) {
  warn(`could not read the server constants file (${err.code || err.message})`);
}

if (mobile === null) {
  console.error(
    '[check-break-constants] FAIL: BREAK_DURATION_MINUTES not found in\n' +
    `  ${MOBILE}\n` +
    'If you renamed it, update this script in the same commit — that rename is\n' +
    'exactly the drift this check exists to catch.',
  );
  process.exit(1);
}
if (server === null) warn('BREAK_DURATION_MINUTES not found in the server file');

if (mobile !== server) {
  console.error(
    '\n[check-break-constants] FAIL — break duration has drifted.\n\n' +
    `  mobile  ${MOBILE}\n          BREAK_DURATION_MINUTES = ${mobile}\n\n` +
    `  server  ${SERVER}\n          BREAK_DURATION_MINUTES = ${server}\n\n` +
    'These two must agree. The server value is authoritative — it decides\n' +
    'planned_duration_minutes and therefore when breakExpiryCron auto-closes\n' +
    'the break. Fix the mobile copy, or change both in the same commit.\n',
  );
  process.exit(1);
}

console.log(`[check-break-constants] OK — BREAK_DURATION_MINUTES = ${mobile} on both sides`);
