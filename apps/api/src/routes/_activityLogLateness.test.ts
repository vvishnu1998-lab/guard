/**
 * Tests the "Missed — answered N minutes late" figure.
 *
 * WHY. The number is measured from the window's END, because the obligation
 * did not expire until the window closed. It was measured from the START
 * until 2026-09-12, which counted the whole window as lateness and produced a
 * figure that scaled with the CADENCE rather than with the delay: the same
 * 53-second backfill read 31 minutes on a 30-minute grid, 16 on a 15-minute
 * one and 46 on a 45-minute one. It is a client-visible string — it reaches
 * the admin activity log and, via routes/admin.ts, the PDF handed to clients
 * (admin.ts:1805 reuses this exact string and does not recompute it) — so it
 * is asserted rather than eyeballed.
 *
 * The arithmetic is inlined rather than imported. routes/activityLog.ts is an
 * Express router that opens a database pool at import time, so requiring it
 * from a test would need the whole injection harness _pingReminder.test.ts
 * uses. Inlining keeps the expression in one readable place; the guard against
 * drift is the FORMULA assertion at the bottom, which fails if the source
 * stops matching this shape.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/routes/_activityLogLateness.test.ts
 */
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Verbatim from routes/activityLog.ts's missed-window loop. */
function answeredMinutesLate(windowEndIso: string, pingedAtIso: string): number {
  return Math.max(0, Math.round((Date.parse(pingedAtIso) - Date.parse(windowEndIso)) / 60_000));
}

/** The pre-2026-09-12 form, kept to show the size of the correction. */
function answeredMinutesLate_OLD(windowStartIso: string, pingedAtIso: string): number {
  return Math.max(0, Math.round((Date.parse(pingedAtIso) - Date.parse(windowStartIso)) / 60_000));
}

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

console.log('activityLog — "Missed — answered N minutes late"\n');

// ── The production row this change came from ──────────────────────────────
// session bb3934c9, guard reddy (Star Guard), missed_pings e80658df:
//   window 18:30:00 → 19:00:00Z, resolved by ping 79e7bd01 at 19:00:52.912Z
const W_START = '2026-09-12T18:30:00.000Z';
const W_END   = '2026-09-12T19:00:00.000Z';
const PINGED  = '2026-09-12T19:00:52.912Z';

test('reddy bb3934c9: 53 s past the deadline reads 1 minute, not 31', () => {
  assert.strictEqual(answeredMinutesLate(W_END, PINGED), 1);
  assert.strictEqual(answeredMinutesLate_OLD(W_START, PINGED), 31, 'the old figure, for contrast');
});

test('the figure no longer scales with cadence', () => {
  // Same 53-second delay, three grids. From the END all read 1; from the
  // START they read the window length plus the delay.
  const cases: Array<[number, string]> = [
    [15, '2026-09-12T18:45:00.000Z'],
    [30, '2026-09-12T18:30:00.000Z'],
    [45, '2026-09-12T18:15:00.000Z'],
  ];
  for (const [mins, start] of cases) {
    assert.strictEqual(answeredMinutesLate(W_END, PINGED), 1, `${mins}-min grid, from end`);
    assert.strictEqual(
      answeredMinutesLate_OLD(start, PINGED), mins + 1,
      `${mins}-min grid, from start — the cadence-scaling defect`,
    );
  }
});

// ── Boundaries ────────────────────────────────────────────────────────────
test('answered exactly at close reads 0', () => {
  assert.strictEqual(answeredMinutesLate(W_END, W_END), 0);
});

test('a ping BEFORE the close cannot go negative (clamped at 0)', () => {
  // Reachable: a window is resolved by window_label, and a ping carrying a
  // label may land before that window's own close — the label is what binds
  // it, not the timestamp.
  assert.strictEqual(answeredMinutesLate(W_END, '2026-09-12T18:45:00.000Z'), 0);
});

test('rounding is to the nearest minute, not floor', () => {
  assert.strictEqual(answeredMinutesLate(W_END, '2026-09-12T19:00:29.000Z'), 0, '29 s → 0');
  assert.strictEqual(answeredMinutesLate(W_END, '2026-09-12T19:00:31.000Z'), 1, '31 s → 1');
  assert.strictEqual(answeredMinutesLate(W_END, '2026-09-12T19:01:30.000Z'), 2, '90 s → 2');
});

test('singular/plural render matches the source', () => {
  const render = (n: number) => `Missed — answered ${n} ${n === 1 ? 'minute' : 'minutes'} late`;
  assert.strictEqual(render(answeredMinutesLate(W_END, PINGED)), 'Missed — answered 1 minute late');
  assert.strictEqual(
    render(answeredMinutesLate(W_END, '2026-09-12T19:31:00.000Z')),
    'Missed — answered 31 minutes late',
  );
});

test('a long backfill still reports the real delay', () => {
  assert.strictEqual(answeredMinutesLate(W_END, '2026-09-12T21:00:00.000Z'), 120);
});

// ── Drift guard: the source must still measure from the END ───────────────
test('routes/activityLog.ts measures answeredMin from windowEndMs', () => {
  const src = readFileSync(join(__dirname, 'activityLog.ts'), 'utf8');
  assert.ok(
    /const answeredMin = resolver\s*\?\s*Math\.max\(0, Math\.round\(\(Date\.parse\(resolver\.pinged_at\) - windowEndMs\) \/ 60_000\)\)/.test(src),
    'answeredMin no longer matches the expected windowEndMs expression — this test has drifted from the source',
  );
  assert.ok(
    !/answeredMin[\s\S]{0,120}windowStartMs/.test(src),
    'answeredMin appears to reference windowStartMs again',
  );
  // windowStartMs must SURVIVE — it is the row id and event_time.
  assert.ok(src.includes('const windowStartMs = Date.parse(m.window_start);'), 'windowStartMs still needed');
  assert.ok(src.includes('id:             `missed-${s.session_id}-${windowStartMs}`'), 'row id uses window start');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
