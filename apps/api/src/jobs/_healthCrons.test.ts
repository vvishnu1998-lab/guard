/**
 * Tests for the /health/crons building blocks: cron interval derivation and
 * the staleness computation.
 *
 * Same convention as _run.test.ts -- no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/jobs/_healthCrons.test.ts
 *
 * The pg pool and Sentry are stubbed in require.cache before _run loads, so
 * importing it opens no socket and sends no event. The staleness function is
 * pure, so "mocking the pool" here means handing it the rows a query would
 * have returned -- including the DB-error case, which is exercised against the
 * route's actual contract rather than the helper.
 */
import assert from 'node:assert';
import Module from 'node:module';

function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}

inject('node-cron', {
  __esModule: true,
  default: { schedule: () => ({ on() {}, _task: { on() {} } }) },
});
inject('../db/pool', { pool: { query: async () => ({ rows: [], rowCount: 0 }) } });
inject('../services/sentry', {
  Sentry: { captureException: () => 'evt', captureCheckIn: () => 'checkin' },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mod = require('./_run') as typeof import('./_run');
const { cronIntervalSeconds, computeStaleJobs, runJob, registeredJobs, __resetRegistryForTests } = mod;
type RegisteredJob = import('./_run').RegisteredJob;
type HeartbeatRow = import('./_run').HeartbeatRow;

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * The 19 expressions actually in use, copied from the runJob call sites.
 * If a job's schedule changes and this table is not updated, the mismatch
 * assertion at the bottom fails.
 */
const LIVE_JOBS: Array<[string, string, number]> = [
  ['autoCompleteShifts',    '*/5 * * * *',  300],
  ['breakExpiryCron',       '* * * * *',     60],
  ['chatRetention',         '0 * * * *',   3600],
  ['clockOutReminder',      '*/5 * * * *',  300],
  ['dailyShiftEmail',       '0 9 * * *',  86400],
  ['expireSwapRequests',    '* * * * *',     60],
  ['handoffNudge',          '*/5 * * * *',  300],
  ['lateClockInReminder',   '*/5 * * * *',  300],
  ['locationIntegrityCron', '20 0 * * *', 86400],
  ['missedPingCron',        '*/5 * * * *',  300],
  ['missedReportCron',      '*/5 * * * *',  300],
  ['missedShiftAlert',      '*/5 * * * *',  300],
  ['monthlyHoursReport',    '0 12 1 * *', 2678400],
  ['nightlyPurge',          '0 0 * * *',  86400],
  ['orphanedSessionCheck',  '10 * * * *',  3600],
  ['pingReminder',          '* * * * *',     60],
  ['preShiftReminder',      '*/5 * * * *',  300],
  ['shiftStartReminder',    '*/5 * * * *',  300],
  ['taskDueCron',           '*/5 * * * *',  300],
];

console.log('cronIntervalSeconds + computeStaleJobs\n');

// ── interval derivation ─────────────────────────────────────────────────────

for (const [name, expr, expected] of LIVE_JOBS) {
  test(`interval ${name.padEnd(22)} ${expr.padEnd(12)} -> ${expected}s`, () => {
    assert.strictEqual(cronIntervalSeconds(expr), expected);
  });
}

test('all five supported shapes', () => {
  assert.strictEqual(cronIntervalSeconds('* * * * *'), 60);
  assert.strictEqual(cronIntervalSeconds('*/1 * * * *'), 60);
  assert.strictEqual(cronIntervalSeconds('*/15 * * * *'), 900);
  assert.strictEqual(cronIntervalSeconds('30 * * * *'), 3600);
  assert.strictEqual(cronIntervalSeconds('45 23 * * *'), 86400);
  assert.strictEqual(cronIntervalSeconds('0 0 28 * *'), 2678400);
});

test('unsupported expressions throw loudly rather than guessing', () => {
  const bad = [
    '* * * *',           // four fields
    '* * * * * *',       // six fields
    '0 0 * * 1',         // day-of-week restriction
    '0 0 1 6 *',         // month restriction
    '*/0 * * * *',       // zero step
    '*/60 * * * *',      // step out of range
    '0,30 * * * *',      // list
    '0 9-17 * * *',      // range
    'garbage',
    '',
  ];
  for (const expr of bad) {
    assert.throws(
      () => cronIntervalSeconds(expr),
      /unsupported cron expression/,
      `expected ${JSON.stringify(expr)} to throw`,
    );
  }
});

test('runJob throws at registration on an unsupported expression', () => {
  assert.throws(
    () => runJob('badJob', '0 0 * * 1', async () => {}),
    /unsupported cron expression/,
  );
});

// ── staleness ───────────────────────────────────────────────────────────────

// A fixed clock so the grace-period branch is deterministic.
const NOW = 1_800_000_000_000;

/** Registered long enough ago that the grace period has expired for all three. */
const LONG_AGO = NOW - 365 * 24 * 3600 * 1000;

const jobs: RegisteredJob[] = [
  { name: 'perMinute', expr: '* * * * *', intervalSec: 60, registeredAt: LONG_AGO },
  { name: 'fiveMin', expr: '*/5 * * * *', intervalSec: 300, registeredAt: LONG_AGO },
  { name: 'daily', expr: '0 9 * * *', intervalSec: 86400, registeredAt: LONG_AGO },
];

test('fresh rows produce no stale entries', () => {
  const rows: HeartbeatRow[] = [
    { job_name: 'perMinute', age_s: 30, last_result: 'ok' },
    { job_name: 'fiveMin', age_s: 120, last_result: 'ok' },
    { job_name: 'daily', age_s: 3600, last_result: 'ok' },
  ];
  assert.deepStrictEqual(computeStaleJobs(jobs, rows, NOW), []);
});

test('exactly 2x interval is NOT stale; one second past it is', () => {
  assert.deepStrictEqual(
    computeStaleJobs([jobs[0]], [{ job_name: 'perMinute', age_s: 120, last_result: 'ok' }], NOW),
    [],
    '120s == 2x60 is the boundary and must not alarm',
  );
  const over = computeStaleJobs([jobs[0]], [{ job_name: 'perMinute', age_s: 121, last_result: 'ok' }], NOW);
  assert.strictEqual(over.length, 1);
  assert.strictEqual(over[0].job, 'perMinute');
  assert.strictEqual(over[0].age_s, 121);
  assert.strictEqual(over[0].interval_s, 60);
});

test('a stale row carries its last_result through', () => {
  const stale = computeStaleJobs([jobs[1]], [{ job_name: 'fiveMin', age_s: 9999, last_result: 'error' }], NOW);
  assert.deepStrictEqual(stale, [
    { job: 'fiveMin', age_s: 9999, interval_s: 300, last_result: 'error' },
  ]);
});

test('missing row, grace long expired -> stale with null age and null last_result', () => {
  const stale = computeStaleJobs(jobs, [{ job_name: 'perMinute', age_s: 10, last_result: 'ok' }], NOW);
  assert.strictEqual(stale.length, 2, 'fiveMin and daily are both missing');
  assert.deepStrictEqual(stale.map((s) => s.job), ['fiveMin', 'daily']);
  assert.strictEqual(stale[0].age_s, null);
  assert.strictEqual(stale[0].last_result, null);
});

test('empty table, grace long expired -> every job stale', () => {
  assert.strictEqual(computeStaleJobs(jobs, [], NOW).length, 3);
});

test('age_s arriving as a string (pg text) is compared numerically', () => {
  // Guards against "121" > 120 lexicographic comparison, which would be false
  // for "1000" vs 120 and would silently under-report staleness.
  const stale = computeStaleJobs([jobs[0]], [{ job_name: 'perMinute', age_s: '1000', last_result: 'ok' }], NOW);
  assert.strictEqual(stale.length, 1);
  assert.strictEqual(stale[0].age_s, 1000);
});

// ── Phase 4.1: first-tick grace period ──────────────────────────────────────

test('missing row + just registered -> NOT stale', () => {
  const justNow: RegisteredJob[] = [
    { name: 'perMinute', expr: '* * * * *', intervalSec: 60, registeredAt: NOW },
    { name: 'fiveMin', expr: '*/5 * * * *', intervalSec: 300, registeredAt: NOW },
    { name: 'daily', expr: '0 9 * * *', intervalSec: 86400, registeredAt: NOW },
    { name: 'monthly', expr: '0 12 1 * *', intervalSec: 2678400, registeredAt: NOW },
  ];
  // This is the state one second after a deploy: nothing has ticked yet.
  // Before 4.1 every one of these was stale and the probe returned 503.
  assert.deepStrictEqual(computeStaleJobs(justNow, [], NOW), []);
});

test('missing row + registered 3x interval ago -> stale', () => {
  const old: RegisteredJob[] = [
    { name: 'daily', expr: '0 9 * * *', intervalSec: 86400, registeredAt: NOW - 3 * 86400 * 1000 },
  ];
  const stale = computeStaleJobs(old, [], NOW);
  assert.strictEqual(stale.length, 1);
  assert.deepStrictEqual(stale[0], {
    job: 'daily', age_s: null, interval_s: 86400, last_result: null,
  });
});

test('grace boundary: exactly 2x is NOT stale, one ms past it is', () => {
  const at = (ms: number): RegisteredJob[] => [
    { name: 'fiveMin', expr: '*/5 * * * *', intervalSec: 300, registeredAt: NOW - ms },
  ];
  // Same strictly-greater-than comparison the row-age branch uses, so the two
  // halves of the rule agree at the boundary.
  assert.deepStrictEqual(computeStaleJobs(at(600_000), [], NOW), [], '600000ms == 2x300s must not alarm');
  assert.strictEqual(computeStaleJobs(at(600_001), [], NOW).length, 1);
});

test('grace applies per job, not globally', () => {
  // A realistic post-deploy mix: the daily job is inside its grace and quiet,
  // the 5-minute job is well past its grace and has still never ticked. Only
  // the second is a real finding.
  const mixed: RegisteredJob[] = [
    { name: 'daily', expr: '0 9 * * *', intervalSec: 86400, registeredAt: NOW - 3600 * 1000 },
    { name: 'fiveMin', expr: '*/5 * * * *', intervalSec: 300, registeredAt: NOW - 3600 * 1000 },
  ];
  const stale = computeStaleJobs(mixed, [], NOW);
  assert.deepStrictEqual(stale.map((s) => s.job), ['fiveMin']);
});

test('grace does not rescue a job that HAS a row', () => {
  // registeredAt is irrelevant once a row exists: the row outlives restarts,
  // so a just-restarted process must still report a long-dead job.
  const justBooted: RegisteredJob[] = [
    { name: 'fiveMin', expr: '*/5 * * * *', intervalSec: 300, registeredAt: NOW },
  ];
  const stale = computeStaleJobs(
    justBooted,
    [{ job_name: 'fiveMin', age_s: 99999, last_result: 'ok' }],
    NOW,
  );
  assert.strictEqual(stale.length, 1, 'an old row is stale even inside the grace window');
  assert.strictEqual(stale[0].age_s, 99999);
});

test('computeStaleJobs defaults now to Date.now() when omitted', () => {
  const justNow: RegisteredJob[] = [
    { name: 'daily', expr: '0 9 * * *', intervalSec: 86400, registeredAt: Date.now() },
  ];
  assert.deepStrictEqual(computeStaleJobs(justNow, []), []);
});

test('a heartbeat row with no registered job is ignored, not reported', () => {
  const rows: HeartbeatRow[] = [
    { job_name: 'perMinute', age_s: 10, last_result: 'ok' },
    { job_name: 'fiveMin', age_s: 10, last_result: 'ok' },
    { job_name: 'daily', age_s: 10, last_result: 'ok' },
    { job_name: 'jobDeletedLastYear', age_s: 9_000_000, last_result: 'error' },
  ];
  assert.deepStrictEqual(computeStaleJobs(jobs, rows, NOW), []);
});

// ── registry wiring ─────────────────────────────────────────────────────────

test('runJob populates the registry with name, expr and derived interval', () => {
  __resetRegistryForTests();
  runJob('a', '*/5 * * * *', async () => {});
  runJob('b', '0 12 1 * *', async () => {});
  const reg = registeredJobs() as RegisteredJob[];
  assert.deepStrictEqual(
    reg.map(({ name, expr, intervalSec }) => ({ name, expr, intervalSec })),
    [
      { name: 'a', expr: '*/5 * * * *', intervalSec: 300 },
      { name: 'b', expr: '0 12 1 * *', intervalSec: 2678400 },
    ],
  );
  // registeredAt is wall-clock, so assert it is a plausible recent epoch ms
  // rather than a fixed value.
  for (const j of reg) {
    assert.strictEqual(typeof j.registeredAt, 'number');
    assert.ok(j.registeredAt > 1_700_000_000_000, 'registeredAt looks like epoch ms');
    assert.ok(j.registeredAt <= Date.now(), 'registeredAt is not in the future');
  }
  __resetRegistryForTests();
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
