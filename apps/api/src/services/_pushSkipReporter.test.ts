/**
 * Tests for the request-path push-skip reporter (N20).
 *
 * swapPush and shiftPush have no tick and no summary line to hang a counter
 * off, so they keep a Sentry event — but at most one per 10 minutes per
 * (flow, company_id), carrying how many occurrences it stands for.
 *
 * The properties asserted are the ones OPEN-ITEMS N20 actually asked for:
 *   - the limiter fires ONCE per window and suppresses the rest;
 *   - company_id is a TAG, so "test tenant, ignore" vs "paying customer, act"
 *     is answerable from the issues list without querying the database;
 *   - the window is keyed PER TENANT, so a burst on the test tenant cannot
 *     suppress the first report for the paying one;
 *   - guard_id is never a tag (unbounded cardinality) but every occurrence is
 *     logged with it.
 *
 * Run:
 *   cd apps/api && npx ts-node src/services/_pushSkipReporter.test.ts
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

const captures: Array<{ method: string; message: unknown; opts: any }> = [];
const sentryStub = new Proxy({}, {
  get: (_t, prop: string) => (message: unknown, opts: any) => {
    captures.push({ method: prop, message, opts });
    return 'stub';
  },
});
inject('./sentry', { Sentry: sentryStub });

const STARNET = '27c4d404-8769-49ca-bfd6-93cb9b890067';
const TESTTEN = 'b7c7d32d-a69e-4842-9eae-0a11eb2ff8ee';
const guardCompany = new Map<string, string>([
  ['g-starnet', STARNET],
  ['g-test', TESTTEN],
]);
let lookupShouldThrow = false;
inject('../db/pool', {
  pool: {
    query: async (_sql: string, params: any[]) => {
      if (lookupShouldThrow) throw new Error('permission denied');
      const c = guardCompany.get(params[0]);
      return { rows: c ? [{ company_id: c }] : [], rowCount: c ? 1 : 0 };
    },
  },
});

const { reportPushSkip, __resetPushSkipState, PUSH_SKIP_WINDOW_MS } =
  require('./pushSkipReporter') as typeof import('./pushSkipReporter');

const logs: string[] = [];
const realWarn = console.warn;
const realError = console.error;
const realLog = console.log;

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  captures.length = 0; logs.length = 0; lookupShouldThrow = false;
  __resetPushSkipState();
  console.warn = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.warn = realWarn; console.error = realError; }
  passed += 1;
  realLog(`  ok  ${name}`);
}

(async () => {
  await check('the limiter fires once per window: 40 skips -> 1 capture', async () => {
    for (let i = 0; i < 40; i += 1) await reportPushSkip('swap_push', 'g-starnet', { shift_id: `s${i}` });
    assert.strictEqual(captures.length, 1, `expected 1 capture, got ${captures.length}`);
    assert.strictEqual(captures[0].method, 'captureMessage');
    assert.strictEqual(captures[0].message, 'push_skip_null_token');
  });

  await check('every occurrence is logged even when the capture is suppressed', async () => {
    for (let i = 0; i < 40; i += 1) await reportPushSkip('swap_push', 'g-starnet');
    const lines = logs.filter((l) => l.startsWith('[push.skip]'));
    assert.strictEqual(lines.length, 40, `expected 40 log lines, got ${lines.length}`);
    assert.strictEqual(lines[0], `[push.skip] flow=swap_push guard=g-starnet company=${STARNET}`);
  });

  await check('company_id is a tag; guard_id is NOT', async () => {
    await reportPushSkip('swap_push', 'g-starnet');
    const { tags, extra } = captures[0].opts;
    assert.deepStrictEqual(Object.keys(tags).sort(), ['company_id', 'flow']);
    assert.strictEqual(tags.company_id, STARNET);
    assert.strictEqual(tags.flow, 'swap_push');
    assert.strictEqual(tags.guard_id, undefined, 'guard_id must not be a tag');
    assert.strictEqual(extra.guard_id, 'g-starnet', 'guard_id belongs in extra');
  });

  await check('the window is keyed per tenant — a test-tenant burst cannot mask STARNET', async () => {
    for (let i = 0; i < 30; i += 1) await reportPushSkip('swap_push', 'g-test');
    assert.strictEqual(captures.length, 1);
    await reportPushSkip('swap_push', 'g-starnet');
    assert.strictEqual(captures.length, 2, 'the paying tenant must still report');
    assert.deepStrictEqual(captures.map((c) => c.opts.tags.company_id).sort(), [STARNET, TESTTEN].sort());
  });

  await check('the window is keyed per flow', async () => {
    await reportPushSkip('swap_push', 'g-starnet');
    await reportPushSkip('shift_assignment', 'g-starnet');
    await reportPushSkip('swap_push', 'g-starnet');
    assert.strictEqual(captures.length, 2);
    assert.deepStrictEqual(captures.map((c) => c.opts.tags.flow), ['swap_push', 'shift_assignment']);
  });

  await check('the capture carries how many occurrences it stands for', async () => {
    for (let i = 0; i < 12; i += 1) await reportPushSkip('swap_push', 'g-starnet');
    assert.strictEqual(captures[0].opts.extra.occurrences_since_last_report, 1,
      'the first capture stands for itself');
    assert.strictEqual(captures[0].opts.extra.window_minutes, PUSH_SKIP_WINDOW_MS / 60000);
  });

  await check('a failed company lookup degrades to company=unknown, never throws', async () => {
    lookupShouldThrow = true;
    await reportPushSkip('swap_push', 'g-starnet');
    assert.strictEqual(captures.length, 1);
    assert.strictEqual(captures[0].opts.tags.company_id, 'unknown');
    assert.ok(logs.some((l) => l.includes('company=unknown')));
  });

  await check('an unknown guard id resolves to unknown rather than throwing', async () => {
    await reportPushSkip('swap_push', 'g-does-not-exist');
    assert.strictEqual(captures.length, 1);
    assert.strictEqual(captures[0].opts.tags.company_id, 'unknown');
  });

  realLog(`\n${passed} passed, 0 failed.`);
})().catch((e) => {
  console.warn = realWarn; console.error = realError;
  realError(`\nFAILED after ${passed} passing:`); realError(e);
  process.exit(1);
});
