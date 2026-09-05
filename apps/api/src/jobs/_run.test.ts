/**
 * Unit tests for runJob (jobs/_run.ts).
 *
 * NO TEST FRAMEWORK IS INSTALLED in apps/api -- there is no jest, vitest or
 * mocha, no "test" script, and no pre-existing *.test.ts file. The project's
 * actual test layout is standalone ts-node scripts under apps/api/scripts.
 * This file follows that convention and uses node:assert, so it adds zero
 * dependencies and needs no package.json change.
 *
 * Run:
 *   cd apps/api && npx ts-node src/jobs/_run.test.ts
 *
 * node-cron, the pg pool and Sentry are all replaced in require.cache BEFORE
 * _run is loaded, so no timer is ever armed, no socket is ever opened and no
 * event is ever sent. Mocking node-cron also hands us the tick callback
 * directly, which is what makes the tick observable at all.
 */
import assert from 'node:assert';
import Module from 'node:module';

type Tick = () => Promise<void>;

// ── Mocks, installed before _run is required ────────────────────────────────

interface HeartbeatCall {
  sql: string;
  params: unknown[];
}

const heartbeats: HeartbeatCall[] = [];
let poolShouldThrow = false;

interface CheckIn {
  monitorSlug: string;
  status: string;
  checkInId?: string;
  duration?: number;
}
const checkIns: CheckIn[] = [];
const captured: Array<{ err: unknown; tags: Record<string, unknown> }> = [];

let capturedTick: Tick | undefined;
let capturedExpr: string | undefined;
let capturedOpts: unknown;
let listenerTarget: string | undefined;

function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}

const fakeTask = {
  _task: {
    on(event: string, _fn: unknown) {
      listenerTarget = `_task:${event}`;
    },
  },
  on(event: string, _fn: unknown) {
    listenerTarget = `scheduledTask:${event}`;
  },
};

// __esModule matters: tsconfig has esModuleInterop, so _run's
// `import cron from 'node-cron'` compiles to __importDefault(require(...)).
// Without this flag the helper would wrap the mock again and cron.schedule
// would resolve to undefined.
inject('node-cron', {
  __esModule: true,
  default: {
    schedule(expr: string, fn: Tick, opts: unknown) {
      capturedExpr = expr;
      capturedTick = fn;
      capturedOpts = opts;
      return fakeTask;
    },
  },
});

inject('../db/pool', {
  pool: {
    async query(sql: string, params: unknown[]) {
      if (poolShouldThrow) throw new Error('relation "cron_heartbeats" does not exist');
      heartbeats.push({ sql, params });
      return { rows: [], rowCount: 0 };
    },
  },
});

inject('../services/sentry', {
  Sentry: {
    captureException(err: unknown, ctx?: { tags?: Record<string, unknown> }) {
      captured.push({ err, tags: ctx?.tags ?? {} });
      return 'evt';
    },
    captureCheckIn(checkIn: CheckIn) {
      checkIns.push(checkIn);
      return `checkin-${checkIns.length}`;
    },
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runJob, registeredJobCount } = require('./_run') as typeof import('./_run');

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function reset(): void {
  heartbeats.length = 0;
  checkIns.length = 0;
  captured.length = 0;
  poolShouldThrow = false;
  capturedTick = undefined;
  listenerTarget = undefined;
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  reset();
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Silence the wrapper's console.error while asserting it was called. */
async function withCapturedStderr(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
  };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

function lastHeartbeat(): HeartbeatCall {
  assert.ok(heartbeats.length > 0, 'expected a heartbeat write, got none');
  return heartbeats[heartbeats.length - 1];
}

// ── Tests ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('runJob (apps/api/src/jobs/_run.ts)\n');

  await test('succeeding fn writes last_result=ok with a duration and no error', async () => {
    runJob('okJob', '*/5 * * * *', async () => {});
    await capturedTick!();

    const hb = lastHeartbeat();
    assert.strictEqual(hb.params[0], 'okJob', 'job_name');
    assert.strictEqual(typeof hb.params[1], 'number', 'last_run_ms is a number');
    assert.strictEqual(hb.params[2], 'ok', 'last_result');
    assert.strictEqual(hb.params[3], null, 'last_error is null on success');
    assert.strictEqual(captured.length, 0, 'nothing reported to Sentry');
  });

  await test('throwing fn writes last_result=error and the error never escapes', async () => {
    runJob('boomJob', '*/5 * * * *', async () => {
      throw new Error('kaboom');
    });

    // The assertion that matters: awaiting the tick must not reject. If the
    // wrapper let the throw through, node-cron would swallow it into an
    // unlistened 'task-failed' emit and the job would fail invisibly -- the
    // exact condition this wrapper exists to eliminate.
    const logged = await withCapturedStderr(async () => {
      await assert.doesNotReject(capturedTick!(), 'tick must not reject');
    });

    const hb = lastHeartbeat();
    assert.strictEqual(hb.params[0], 'boomJob');
    assert.strictEqual(hb.params[2], 'error', 'last_result');
    assert.ok(String(hb.params[3]).includes('kaboom'), 'last_error carries the message');
    assert.ok(logged.some((l) => l.includes('[boomJob] tick failed')), 'logged the failure');
    assert.strictEqual(captured.length, 1, 'reported once to Sentry');
    assert.strictEqual(captured[0].tags.job, 'boomJob', 'tagged with the job name');
  });

  await test('last_error is truncated to 500 characters', async () => {
    runJob('longErrJob', '*/5 * * * *', async () => {
      throw new Error('x'.repeat(5000));
    });
    await withCapturedStderr(async () => {
      await capturedTick!();
    });
    assert.strictEqual(String(lastHeartbeat().params[3]).length, 500);
  });

  await test('heartbeat write failure is swallowed and logged, job still succeeds', async () => {
    poolShouldThrow = true;
    runJob('hbFailJob', '*/5 * * * *', async () => {});

    const logged = await withCapturedStderr(async () => {
      await assert.doesNotReject(capturedTick!(), 'tick must not reject');
    });

    assert.strictEqual(heartbeats.length, 0, 'no heartbeat recorded');
    assert.ok(
      logged.some((l) => l.includes('[hbFailJob] heartbeat write failed')),
      'logged the heartbeat failure',
    );
    assert.strictEqual(captured.length, 0, 'a heartbeat failure is not a job failure');
  });

  await test('sentryMonitor:true sends in_progress then ok', async () => {
    runJob('monJob', '*/5 * * * *', async () => {}, { sentryMonitor: true });
    await capturedTick!();

    assert.strictEqual(checkIns.length, 2, 'two check-ins');
    assert.deepStrictEqual(
      [checkIns[0].status, checkIns[1].status],
      ['in_progress', 'ok'],
    );
    assert.strictEqual(checkIns[1].monitorSlug, 'monJob');
    assert.strictEqual(checkIns[1].checkInId, checkIns[0].monitorSlug ? 'checkin-1' : undefined);
    assert.strictEqual(typeof checkIns[1].duration, 'number', 'duration in seconds');
  });

  await test('sentryMonitor:true sends in_progress then error when fn throws', async () => {
    runJob('monBoom', '*/5 * * * *', async () => {
      throw new Error('nope');
    }, { sentryMonitor: true });
    await withCapturedStderr(async () => {
      await capturedTick!();
    });
    assert.deepStrictEqual(
      [checkIns[0].status, checkIns[1].status],
      ['in_progress', 'error'],
    );
  });

  await test('sentryMonitor defaults to false: per-minute jobs send no check-ins', async () => {
    runJob('perMinute', '* * * * *', async () => {});
    await capturedTick!();
    assert.strictEqual(checkIns.length, 0, 'no check-ins for an unflagged job');
    assert.strictEqual(lastHeartbeat().params[2], 'ok', 'but the heartbeat still lands');
  });

  await test('timezone is forwarded; omitting it passes no options object', async () => {
    runJob('tzJob', '0 9 * * *', async () => {}, { timezone: 'America/Los_Angeles' });
    assert.deepStrictEqual(capturedOpts, { timezone: 'America/Los_Angeles' });
    assert.strictEqual(capturedExpr, '0 9 * * *');

    runJob('noTzJob', '*/5 * * * *', async () => {});
    assert.strictEqual(capturedOpts, undefined, 'no options object when no timezone');
  });

  await test("task-failed listener attaches to node-cron's inner _task, not the outer task", async () => {
    runJob('listenerJob', '*/5 * * * *', async () => {});
    // Attaching to the returned ScheduledTask would be a listener that can
    // never fire: node-cron 3.0.3 emits 'task-failed' on the inner Task only.
    assert.strictEqual(listenerTarget, '_task:task-failed');
  });

  await test('registeredJobCount increases per registration', async () => {
    const before = registeredJobCount();
    runJob('countA', '*/5 * * * *', async () => {});
    runJob('countB', '*/5 * * * *', async () => {});
    assert.strictEqual(registeredJobCount(), before + 2);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

void main();
