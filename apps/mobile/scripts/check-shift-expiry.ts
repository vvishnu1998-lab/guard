#!/usr/bin/env ts-node
/**
 * Prove the background task's local expiry gate (lib/shiftExpiry.ts) matches
 * the server's auto clock-out grace, and behaves at its boundaries.
 *
 * WHY THIS EXISTS. The app keeps a hand copy of AUTO_CLOSE_GRACE_MINUTES. U4b
 * moved the server from 30 to 15 on 2026-09-26 and the app kept 30 for the
 * next OTA (N138): for those weeks every exit between end+15 and end+30 raised
 * a local "Outside post boundary" alert for a session the server had already
 * closed. Nothing failed and nothing logged. This check makes the two numbers
 * fail loudly when they differ.
 *
 * The drift half FAILS, never skips, when it cannot find the server constant.
 * check-break-constants.js skips with exit 0 when its server file is missing,
 * and a batch branch cut before the constant existed would pass that way while
 * checking nothing. The server file is read from the working tree first, then
 * from `git show origin/main:<path>`; the source used is printed. A local
 * origin/main is only as fresh as its last fetch.
 *
 * Run:
 *   cd apps/mobile && npm run check:shift-expiry
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { SHIFT_EXPIRY_GRACE_MS, isPastShiftExpiry, isUsableShiftEnd } from '../lib/shiftExpiry';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
  }
}

function eq(got: unknown, want: unknown, msg: string): void {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${msg}: got ${a}, want ${b}`);
}

const SERVER_REL = 'apps/api/src/constants/autoCloseGrace.ts';

/** { minutes, source } for AUTO_CLOSE_GRACE_MINUTES, or throws. */
function readServerGrace(): { minutes: number; source: string } {
  const repoRoot = join(__dirname, '..', '..', '..');
  let src: string | null = null;
  let source = '';
  const onDisk = join(repoRoot, SERVER_REL);
  if (existsSync(onDisk)) {
    src = readFileSync(onDisk, 'utf8');
    source = `working tree ${SERVER_REL}`;
  } else {
    try {
      src = execFileSync('git', ['show', `origin/main:${SERVER_REL}`], {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
      source = `git show origin/main:${SERVER_REL}`;
    } catch {
      src = null;
    }
  }
  if (src === null) {
    throw new Error(`server constant not found (neither ${SERVER_REL} nor origin/main has it)`);
  }
  const m = src.match(/export\s+const\s+AUTO_CLOSE_GRACE_MINUTES\s*(?::[^=]+)?=\s*(\d+)\s*;/);
  if (!m) throw new Error(`AUTO_CLOSE_GRACE_MINUTES not parseable from ${source}`);
  return { minutes: Number(m[1]), source };
}

const END = '2026-09-28T22:00:00.000Z';
const endMs = Date.parse(END);
const MIN = 60_000;

console.log('[check-shift-expiry]');

test('mobile grace equals the server grace', () => {
  const { minutes, source } = readServerGrace();
  console.log(`        server: ${minutes} min (${source}); mobile: ${SHIFT_EXPIRY_GRACE_MS / MIN} min`);
  eq(SHIFT_EXPIRY_GRACE_MS, minutes * MIN, 'SHIFT_EXPIRY_GRACE_MS vs AUTO_CLOSE_GRACE_MINUTES');
});

test('inside the grace the gate stays open (notify)', () => {
  eq(isPastShiftExpiry(END, endMs), false, 'at end');
  eq(isPastShiftExpiry(END, endMs + 10 * MIN), false, 'end+10');
  eq(isPastShiftExpiry(END, endMs + SHIFT_EXPIRY_GRACE_MS - 1), false, 'end+grace-1ms');
});

test('the boundary is strict: exactly end+grace still notifies', () => {
  eq(isPastShiftExpiry(END, endMs + SHIFT_EXPIRY_GRACE_MS), false, 'end+grace');
  eq(isPastShiftExpiry(END, endMs + SHIFT_EXPIRY_GRACE_MS + 1), true, 'end+grace+1ms');
});

test('past the grace the gate suppresses', () => {
  eq(isPastShiftExpiry(END, endMs + 16 * MIN), true, 'end+16');
  eq(isPastShiftExpiry(END, endMs + 29 * MIN), true, 'end+29 (the 2026-08-06 exit)');
});

test('the gate fails open on a bad or missing end', () => {
  for (const bad of [null, undefined, '', 'garbage', 'NaN']) {
    eq(isPastShiftExpiry(bad as string | null | undefined, endMs + 24 * 60 * MIN), false, `end=${JSON.stringify(bad)}`);
  }
});

test('an offset end parses to the same instant', () => {
  const pdt = '2026-09-28T15:00:00-07:00';
  eq(isPastShiftExpiry(pdt, endMs + SHIFT_EXPIRY_GRACE_MS + 1), true, 'offset form past grace');
  eq(isPastShiftExpiry(pdt, endMs + SHIFT_EXPIRY_GRACE_MS), false, 'offset form at grace');
});

test('isUsableShiftEnd rejects the step4 fallback shape and bad input', () => {
  eq(isUsableShiftEnd('2026-09-28T14:00:00Z', '2026-09-28T22:00:00Z'), true, 'real shift');
  eq(isUsableShiftEnd('2026-09-28T22:00:00Z', '2026-09-28T22:00:00Z'), false, 'end === start (fallback)');
  eq(isUsableShiftEnd('2026-09-28T22:00:00Z', '2026-09-28T14:00:00Z'), false, 'end before start');
  eq(isUsableShiftEnd(null, '2026-09-28T22:00:00Z'), false, 'no start');
  eq(isUsableShiftEnd('2026-09-28T14:00:00Z', 'garbage'), false, 'bad end');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
