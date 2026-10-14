/**
 * Tests the "Missed — answered … late" figure.
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
 * Under a minute it reads in SECONDS (fix/pdf-polish). Rounded to whole
 * minutes, an answer 9-29 s after the close read "answered 0 minutes late":
 * missed, and yet not late. 43 of the 224 answered misses in production were
 * in that band (read 2026-10-11).
 *
 * The wording is services/answeredLate.ts's lateBy(), imported here. The
 * lateness itself is still computed inline in routes/activityLog.ts, an
 * Express router that opens a database pool at import, so that expression is
 * restated here and pinned by the SOURCE assertions at the bottom, which fail
 * if the route stops matching it.
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
import { lateBy } from '../services/answeredLate';

/** The route's expression: milliseconds from the window's END to the answer. */
function lateMsFromEnd(windowEndIso: string, pingedAtIso: string): number {
  return Date.parse(pingedAtIso) - Date.parse(windowEndIso);
}

/** The pre-2026-09-12 form, kept to show the size of that correction. */
function answeredMinutesLate_OLD(windowStartIso: string, pingedAtIso: string): number {
  return Math.max(0, Math.round((Date.parse(pingedAtIso) - Date.parse(windowStartIso)) / 60_000));
}

/** The route's status text for a resolver at `pingedAtIso`. */
function render(windowEndIso: string, pingedAtIso: string): string {
  const ms = lateMsFromEnd(windowEndIso, pingedAtIso);
  return ms <= 0 ? 'Missed — answered late' : `Missed — answered ${lateBy(ms)} late`;
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

console.log('activityLog — "Missed — answered … late"\n');

// ── The production row the end-measurement came from ──────────────────────
// session bb3934c9, a Star Guard guard, missed_pings e80658df:
//   window 18:30:00 → 19:00:00Z, resolved by ping 79e7bd01 at 19:00:52.912Z
const W_START = '2026-09-12T18:30:00.000Z';
const W_END   = '2026-09-12T19:00:00.000Z';
const PINGED  = '2026-09-12T19:00:52.912Z';

test('Star Guard session bb3934c9: 53 s past the deadline reads 53 seconds, not 31 minutes', () => {
  // 52.912 s: under a minute the figure counts whole seconds.
  assert.strictEqual(render(W_END, PINGED), 'Missed — answered 53 seconds late');
  assert.strictEqual(answeredMinutesLate_OLD(W_START, PINGED), 31, 'the old figure, for contrast');
});

test('the figure does not scale with the cadence', () => {
  // Same delay, three grids. From the END all read the same; from the START
  // they read the window length plus the delay.
  const cases: Array<[number, string]> = [
    [15, '2026-09-12T18:45:00.000Z'],
    [30, '2026-09-12T18:30:00.000Z'],
    [45, '2026-09-12T18:15:00.000Z'],
  ];
  for (const [mins, start] of cases) {
    assert.strictEqual(render(W_END, PINGED), 'Missed — answered 53 seconds late', `${mins}-min grid, from end`);
    assert.strictEqual(
      answeredMinutesLate_OLD(start, PINGED), mins + 1,
      `${mins}-min grid, from start — the cadence-scaling defect`,
    );
  }
});

// ── Under a minute: seconds, never zero ───────────────────────────────────
test('the production band that read "0 minutes" now reads its seconds', () => {
  // 9.0 s and 29.x s bound the 43 production rows; 15.2 s is their median.
  assert.strictEqual(render(W_END, '2026-09-12T19:00:09.000Z'), 'Missed — answered 9 seconds late');
  assert.strictEqual(render(W_END, '2026-09-12T19:00:15.200Z'), 'Missed — answered 15 seconds late');
  assert.strictEqual(render(W_END, '2026-09-12T19:00:29.400Z'), 'Missed — answered 29 seconds late');
});

test('under a second reads 1 second, never 0', () => {
  assert.strictEqual(lateBy(1), '1 second');
  assert.strictEqual(lateBy(400), '1 second');
  assert.strictEqual(lateBy(1_499), '1 second');
  assert.strictEqual(lateBy(1_500), '2 seconds');
});

test('what rounds to a minute reads "1 minute", never "60 seconds"', () => {
  assert.strictEqual(lateBy(59_499), '59 seconds');
  assert.strictEqual(lateBy(59_500), '1 minute');
  assert.strictEqual(lateBy(60_000), '1 minute');
});

// ── From a minute up: whole minutes, rounded, as before ───────────────────
test('rounding is to the nearest minute, as it always was', () => {
  assert.strictEqual(lateBy(89_000), '1 minute', '89 s → 1');
  assert.strictEqual(lateBy(90_000), '2 minutes', '90 s → 2');
  assert.strictEqual(render(W_END, '2026-09-12T19:31:00.000Z'), 'Missed — answered 31 minutes late');
});

test('a long backfill still reports the real delay', () => {
  assert.strictEqual(render(W_END, '2026-09-12T21:00:00.000Z'), 'Missed — answered 120 minutes late');
});

// ── No figure where none is true ──────────────────────────────────────────
test('an answer at or before the close gets no figure', () => {
  // A window is resolved by window_label, so a labelled ping may land before
  // that window's own close. It is not late, and "0 seconds late" would say
  // the same contradiction "0 minutes late" did. Not seen in production.
  assert.strictEqual(render(W_END, W_END), 'Missed — answered late');
  assert.strictEqual(render(W_END, '2026-09-12T18:45:00.000Z'), 'Missed — answered late');
});

// ── Drift guard: the route must still measure from the END, through lateBy ─
test('routes/activityLog.ts measures lateMs from windowEndMs and words it with lateBy', () => {
  const src = readFileSync(join(__dirname, 'activityLog.ts'), 'utf8');
  assert.ok(
    src.includes('const lateMs = resolver ? Date.parse(resolver.pinged_at) - windowEndMs : null;'),
    'lateMs no longer matches the expected windowEndMs expression — this test has drifted from the source',
  );
  assert.ok(!/lateMs[\s\S]{0,120}windowStartMs/.test(src), 'lateMs appears to reference windowStartMs again');
  assert.ok(src.includes('} else if (lateMs === null || lateMs <= 0) {'), 'the no-figure branch changed');
  assert.ok(src.includes('status     = `Missed — answered ${lateBy(lateMs)} late`;'), 'the status no longer goes through lateBy');
  assert.ok(!/answered \$\{\w+\} \$\{\w+ === 1 \? 'minute'/.test(src), 'a minutes-only rendering is back');
  // windowStartMs must SURVIVE — it is the row id and event_time.
  assert.ok(src.includes('const windowStartMs = Date.parse(m.window_start);'), 'windowStartMs still needed');
  assert.ok(src.includes('id:             `missed-${s.session_id}-${windowStartMs}`'), 'row id uses window start');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
