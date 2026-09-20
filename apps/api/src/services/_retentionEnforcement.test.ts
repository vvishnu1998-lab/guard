/**
 * Fail-safe audit for the retention enforcement gate.
 *
 * Standalone node:assert, same shape as _mockLocation.test.ts and
 * _healthCrons.test.ts — no test framework in this repo. Run with:
 *   npx ts-node --compiler-options '{"module":"commonjs"}' \
 *     apps/api/src/services/_retentionEnforcement.test.ts
 *
 * THE POINT OF THIS FILE IS THE DIRECTION OF EVERY FAILURE. The gate decides
 * whether a cron may delete production rows, so a test that only proved the
 * happy path would miss the entire hazard. Every case below asserts that a
 * malformed, absent, empty or surprising input leaves the step DRY.
 */
import assert from 'node:assert';
import { globalDryRun, liveStepNames, isStepLive } from './retentionEnforcement';

let passed = 0;
const failures: string[] = [];
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}\n       ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Snapshot and restore, so a failing assertion cannot leak a variable into a
// later case and quietly make it pass. _mockLocation.test.ts does the same.
const SNAP = {
  dry:  process.env.RETENTION_DRY_RUN,
  live: process.env.RETENTION_LIVE_STEPS,
};
function withEnv(dry: string | undefined, live: string | undefined, fn: () => void) {
  if (dry  === undefined) delete process.env.RETENTION_DRY_RUN;    else process.env.RETENTION_DRY_RUN    = dry;
  if (live === undefined) delete process.env.RETENTION_LIVE_STEPS; else process.env.RETENTION_LIVE_STEPS = live;
  try { fn(); } finally {
    if (SNAP.dry  === undefined) delete process.env.RETENTION_DRY_RUN;    else process.env.RETENTION_DRY_RUN    = SNAP.dry;
    if (SNAP.live === undefined) delete process.env.RETENTION_LIVE_STEPS; else process.env.RETENTION_LIVE_STEPS = SNAP.live;
  }
}

console.log('retention enforcement gate\n');

// ── the master switch: only the exact literal disarms it ───────────────────
for (const [v, expected] of [
  [undefined, true], ['', true], ['true', true], ['TRUE', true],
  ['False', true], ['FALSE', true], [' false', true], ['false ', true],
  ['0', true], ['no', true], ['false', false],
] as Array<[string | undefined, boolean]>) {
  test(`globalDryRun(${JSON.stringify(v)}) -> ${expected}`, () => {
    withEnv(v, undefined, () => assert.strictEqual(globalDryRun(), expected));
  });
}

// ── the allowlist parser: total, and never throws ──────────────────────────
for (const [raw, expected] of [
  [undefined, []], ['', []], ['   ', []], [',', []], [',,', []], [' , , ', []],
  ['step2_reports', ['step2_reports']],
  ['  step2_reports  ', ['step2_reports']],
  ['STEP2_REPORTS', ['step2_reports']],
  ['step2_reports,notifications', ['step2_reports', 'notifications']],
  ['step2_reports,,notifications', ['step2_reports', 'notifications']],
  ['step2_reports;notifications', ['step2_reports;notifications']],
  ['*', ['*']],
  ['all', ['all']],
] as Array<[string | undefined, string[]]>) {
  test(`liveStepNames(${JSON.stringify(raw)}) -> ${JSON.stringify(expected)}`, () => {
    withEnv('false', raw, () => assert.deepStrictEqual(liveStepNames(), expected));
  });
}

test('liveStepNames does not throw on a 1MB value', () => {
  withEnv('false', 'x'.repeat(1_000_000) + ',step2_reports', () => {
    assert.strictEqual(liveStepNames().includes('step2_reports'), true);
  });
});

test('liveStepNames passes unicode through without throwing', () => {
  const weird = [String.fromCodePoint(0x1F600), 'ステップ', 'step2_reports'].join(',');
  withEnv('false', weird, () => {
    assert.strictEqual(liveStepNames().includes('step2_reports'), true);
  });
});

// A NUL byte TRUNCATES the whole variable, and that is the platform, not us.
// Environment variables are NUL-terminated C strings: Node accepts the
// assignment and reads back everything before the first NUL. Measured — an
// 18-character value whose first character is NUL reads back as length 0.
//
// Which is why the polarity matters. Under this allowlist a truncated
// variable parses to [] and every step stays DRY. Under a denylist the same
// truncation would have emptied the skip-list and deleted across every step.
// The same accident, opposite outcome.
test('a NUL byte truncates the variable, and truncation fails toward dry-run', () => {
  const truncating = [String.fromCharCode(0), 'step2_reports'].join(',');
  withEnv('false', truncating, () => {
    assert.strictEqual(process.env.RETENTION_LIVE_STEPS, '');
    assert.deepStrictEqual(liveStepNames(), []);
    assert.strictEqual(isStepLive('step2_reports'), false);
  });
});

// A NUL LATER in the value truncates only the tail, so earlier names survive.
// Asserted so the truncation point is recorded rather than assumed.
test('a NUL mid-value keeps the names before it and drops the rest', () => {
  const mid = ['step2_reports', String.fromCharCode(0) + 'notifications'].join(',');
  withEnv('false', mid, () => {
    assert.strictEqual(isStepLive('step2_reports'), true);
    assert.strictEqual(isStepLive('notifications'), false);
  });
});

// ── THE GATE: nothing is live unless BOTH switches say so ──────────────────
const LIVE_CASES: Array<[string | undefined, string | undefined, string, boolean]> = [
  // master switch not disarmed -> ALWAYS dry, whatever the allowlist says
  [undefined, 'step2_reports', 'step2_reports', false],
  ['true',    'step2_reports', 'step2_reports', false],
  ['False',   'step2_reports', 'step2_reports', false],
  ['',        'step2_reports', 'step2_reports', false],
  // master switch disarmed, allowlist absent/empty/malformed -> dry
  ['false', undefined,  'step2_reports', false],
  ['false', '',         'step2_reports', false],
  ['false', '   ',      'step2_reports', false],
  ['false', ',,',       'step2_reports', false],
  ['false', 'step_2_reports', 'step2_reports', false],
  ['false', 'step2_report',   'step2_reports', false],
  // NO WILDCARD: these must match nothing
  ['false', '*',   'step2_reports', false],
  ['false', 'all', 'step2_reports', false],
  ['false', '*',   'notifications', false],
  // the only combination that deletes
  ['false', 'step2_reports', 'step2_reports', true],
  ['false', ' STEP2_REPORTS ', 'step2_reports', true],
  ['false', 'notifications,step2_reports', 'step2_reports', true],
  // a named step does not license its neighbours
  ['false', 'step2_reports', 'step3_pings', false],
];
for (const [dry, live, step, expected] of LIVE_CASES) {
  test(`isStepLive(${JSON.stringify(step)}) dry=${JSON.stringify(dry)} live=${JSON.stringify(live)} -> ${expected}`, () => {
    withEnv(dry, live, () => assert.strictEqual(isStepLive(step), expected));
  });
}

test('an empty step name is never live, even fully armed', () => {
  withEnv('false', ',,', () => assert.strictEqual(isStepLive(''), false));
});

test('env is restored after every case — no leak into the process', () => {
  assert.strictEqual(process.env.RETENTION_DRY_RUN, SNAP.dry);
  assert.strictEqual(process.env.RETENTION_LIVE_STEPS, SNAP.live);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(`failed: ${failures.join(', ')}`); process.exit(1); }
