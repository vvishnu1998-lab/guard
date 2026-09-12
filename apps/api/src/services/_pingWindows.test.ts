/**
 * Tests for windowJustOpened — the window a ping reminder prompts for.
 *
 * WHY THIS FILE EXISTS AND WHY IT IS NOT IN _pingReminder.test.ts. That file
 * tests sendReminder, the push/notification helper, and to do so it injects
 * stubs over the whole window layer (`windowJustOpened: () => null`,
 * `siteLocalLabel: () => 'label'`) and over `pool.query`. The runJob body —
 * window selection, the claim, the eligibility filter — is never executed
 * there. Window arithmetic therefore has no coverage in that harness by
 * construction, and adding it would mean putting pure date maths behind a
 * database mock.
 *
 * windowJustOpened is pure, so it is tested directly, at the same level
 * scripts/check-window-anchor.ts already tests completedTrackableWindows.
 *
 * WHAT IS DELIBERATELY NOT COVERED HERE: the break waiver at open.
 * `breakOverlapsWindow` is async and queries break_sessions, so it cannot be
 * exercised from a pure test. The behaviour it produces — a guard already on
 * break when a window opens gets no prompt, while a break STARTED later in
 * the window waives the missed flag without having suppressed the prompt —
 * is UNTESTED and must be confirmed live, on a boundary that coincides with
 * an open break. See jobs/pingReminder.ts's break-check comment.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/services/_pingWindows.test.ts
 */
import assert from 'node:assert';
import { windowJustOpened, windowJustClosed } from './pingWindows';

const MIN = 60 * 1000;

/** Same expression jobs/pingReminder.ts uses, restated so a change there
 *  that is not mirrored here shows up as a failing expectation. */
const recoveryMsFor = (intervalMs: number) => Math.min(10 * MIN, Math.floor(intervalMs / 3));

const D = (iso: string) => new Date(iso);

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

/** windowJustOpened's start, as an ISO string, or null. */
function openedAt(args: {
  start: string; end: string; clockIn: string; now: string; intervalMin?: number;
}): string | null {
  const intervalMs = (args.intervalMin ?? 30) * MIN;
  const w = windowJustOpened(
    D(args.start), D(args.end), D(args.clockIn), D(args.now),
    recoveryMsFor(intervalMs), intervalMs,
  );
  return w ? w.windowStart.toISOString() : null;
}

// A 3-hour shift on a 30-min grid: windows open at 18:00, 18:30, 19:00,
// 19:30, 20:00, 20:30. A 21:00 window would end at 21:30 and is refused by R3.
const SHIFT = { start: '2026-09-12T18:00:00.000Z', end: '2026-09-12T21:00:00.000Z' };

console.log('windowJustOpened — reminder window selection\n');

// ── R4: a window that opened before clock-in is not the guard's to answer ──
// This is the case that produced the dispatch: reddy clocked in at 18:02:42
// and got nothing at 18:00, then his first prompt at 18:30.
test('clock-in mid-window: NO prompt at the window already in progress', () => {
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: '2026-09-12T18:02:00.000Z', now: '2026-09-12T18:00:05.000Z' }),
    null,
  );
});

test('clock-in mid-window: first prompt at the NEXT window open (18:30)', () => {
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: '2026-09-12T18:02:00.000Z', now: '2026-09-12T18:30:05.000Z' }),
    '2026-09-12T18:30:00.000Z',
  );
});

test('clock-in EXACTLY on a boundary: that window counts (>= not >)', () => {
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: '2026-09-12T18:30:00.000Z', now: '2026-09-12T18:30:05.000Z' }),
    '2026-09-12T18:30:00.000Z',
  );
});

test('clock-in 1 min before a boundary: that window counts', () => {
  // NOTE: the job would still not send at 18:30:05 — pingReminder's SQL
  // filter excludes sessions with clocked_in_at > NOW() - 5 minutes. The
  // prompt slips to the recovery pass and lands by 18:40 at the latest.
  // That filter is job-level, not window-level, so it is not modelled here.
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: '2026-09-12T18:29:00.000Z', now: '2026-09-12T18:30:05.000Z' }),
    '2026-09-12T18:30:00.000Z',
  );
});

test('clock-in after every window has opened: no prompt at all', () => {
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: '2026-09-12T20:45:00.000Z', now: '2026-09-12T20:50:00.000Z' }),
    null,
  );
});

// ── Recovery: a dropped cron tick still fires, while the window is open ────
test('cron tick missed by 3 min: recovery fires, still names 18:30', () => {
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: '2026-09-12T17:55:00.000Z', now: '2026-09-12T18:33:00.000Z' }),
    '2026-09-12T18:30:00.000Z',
  );
});

test('cron tick missed by 12 min: prompt is LOST (missedPingCron still flags)', () => {
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: '2026-09-12T17:55:00.000Z', now: '2026-09-12T18:42:00.000Z' }),
    null,
  );
});

test('recovery boundary is exact: 10 min in fires, 10 min + 1 ms does not', () => {
  const base = { ...SHIFT, clockIn: '2026-09-12T17:55:00.000Z' };
  assert.strictEqual(openedAt({ ...base, now: '2026-09-12T18:40:00.000Z' }), '2026-09-12T18:30:00.000Z');
  assert.strictEqual(openedAt({ ...base, now: '2026-09-12T18:40:00.001Z' }), null);
});

// ── R3: no window may overrun scheduled_end ───────────────────────────────
test('R3: a window whose END exceeds scheduled_end never opens', () => {
  // 18:00–18:45 admits only the 18:00 window; 18:30 would end at 19:00.
  const SHORT = { start: '2026-09-12T18:00:00.000Z', end: '2026-09-12T18:45:00.000Z' };
  assert.strictEqual(
    openedAt({ ...SHORT, clockIn: '2026-09-12T17:55:00.000Z', now: '2026-09-12T18:00:05.000Z' }),
    '2026-09-12T18:00:00.000Z',
  );
  // At 18:30 there is no new window — the only one opened 30 min ago and is
  // outside recovery, so nothing is prompted for the tail of the shift.
  assert.strictEqual(
    openedAt({ ...SHORT, clockIn: '2026-09-12T17:55:00.000Z', now: '2026-09-12T18:30:05.000Z' }),
    null,
  );
});

test('before the shift starts: nothing has opened', () => {
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: '2026-09-12T17:50:00.000Z', now: '2026-09-12T17:59:00.000Z' }),
    null,
  );
});

// ── Cadence: 15 / 30 / 45 ─────────────────────────────────────────────────
test('15-min cadence: opens on the 15-grid, recovery is 5 min not 10', () => {
  const S = { start: '2026-09-12T18:00:00.000Z', end: '2026-09-12T19:00:00.000Z' };
  const ci = '2026-09-12T17:55:00.000Z';
  assert.strictEqual(recoveryMsFor(15 * MIN), 5 * MIN, 'recovery = interval/3');
  assert.strictEqual(
    openedAt({ ...S, clockIn: ci, now: '2026-09-12T18:15:04.000Z', intervalMin: 15 }),
    '2026-09-12T18:15:00.000Z',
  );
  // 6 min in — past the 5-min recovery for this cadence.
  assert.strictEqual(
    openedAt({ ...S, clockIn: ci, now: '2026-09-12T18:21:00.000Z', intervalMin: 15 }),
    null,
  );
});

test('30-min cadence: recovery is the full 10 min', () => {
  assert.strictEqual(recoveryMsFor(30 * MIN), 10 * MIN);
});

test('45-min cadence: opens on the 45-grid, recovery capped at 10 min', () => {
  const ci = '2026-09-12T17:55:00.000Z';
  assert.strictEqual(recoveryMsFor(45 * MIN), 10 * MIN, 'capped, not interval/3 = 15');
  // Grid: 18:00, 18:45, 19:30, 20:15. 21:00 would end 21:45 > 21:00 (R3).
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: ci, now: '2026-09-12T18:45:05.000Z', intervalMin: 45 }),
    '2026-09-12T18:45:00.000Z',
  );
  assert.strictEqual(
    openedAt({ ...SHIFT, clockIn: ci, now: '2026-09-12T20:15:05.000Z', intervalMin: 45 }),
    '2026-09-12T20:15:00.000Z',
  );
});

// ── The whole point of the change, stated as an assertion ─────────────────
test('at one instant, open and closed name DIFFERENT windows', () => {
  const args = [D(SHIFT.start), D(SHIFT.end), D('2026-09-12T18:02:00.000Z'),
                D('2026-09-12T19:00:05.000Z'), 10 * MIN, 30 * MIN] as const;
  const opened = windowJustOpened(...args);
  const closed = windowJustClosed(...args);
  assert.strictEqual(opened?.windowStart.toISOString(), '2026-09-12T19:00:00.000Z',
    'at-open prompts for the window now beginning');
  assert.strictEqual(closed?.windowStart.toISOString(), '2026-09-12T18:30:00.000Z',
    'at-close prompted for the window that just ended — the one already flagged');
  assert.notStrictEqual(opened!.windowStart.getTime(), closed!.windowStart.getTime());
});

test('R4 is inherited identically by both helpers', () => {
  const args = [D(SHIFT.start), D(SHIFT.end), D('2026-09-12T18:02:00.000Z'),
                D('2026-09-12T18:30:05.000Z'), 10 * MIN, 30 * MIN] as const;
  // The 18:00 window is skipped by both: never prompted, never flagged.
  assert.strictEqual(windowJustOpened(...args)?.windowStart.toISOString(), '2026-09-12T18:30:00.000Z');
  assert.strictEqual(windowJustClosed(...args), null, 'nothing trackable has closed yet');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
