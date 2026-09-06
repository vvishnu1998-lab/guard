/**
 * Tests for the /api/ai/enhance-description failure branch.
 *
 * Incident: docs/OPS/INCIDENTS/2026-09-06-enhancement-credit-exhaustion.md
 *
 * The regression under test is specific and was customer-visible: the catch
 * block used to return `err.message`, which for an Anthropic SDK error is the
 * entire upstream body. On 2026-09-06 that put the vendor's billing text
 * ("Your credit balance is too low to access the Anthropic API...") into the
 * client-facing `error` field, and apps/mobile/lib/errorCopy.ts:53 rendered it
 * verbatim to a guard on a paying tenant.
 *
 * So the assertions are mostly NEGATIVE -- what must never appear in the
 * response -- because that is what actually broke.
 *
 * Same convention as the jobs tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert. The
 * Anthropic SDK, Sentry and the auth middleware are replaced in require.cache
 * before the route loads, so no network call and no event is ever sent.
 *
 * Run:
 *   cd apps/api && npx ts-node src/routes/_aiEnhance.test.ts
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

// ── Spies ───────────────────────────────────────────────────────────────────

interface SentryCall { message: string; opts: any }
const sentryCalls: SentryCall[] = [];
const logLines: string[] = [];

/** What the SDK actually throws: message IS the whole upstream body. */
const CREDIT_MESSAGE =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
  '"Your credit balance is too low to access the Anthropic API. Please go to ' +
  'Plans & Billing to upgrade or purchase credits."},"request_id":"req_011Cen"}';

let nextBehaviour: 'credit400' | 'timeout' | 'ok' | 'empty' = 'credit400';
let createCalls = 0;
let capturedClientOpts: any = null;

class FakeAnthropic {
  messages: { create: (args: unknown) => Promise<unknown> };
  constructor(opts: any) {
    capturedClientOpts = opts;
    this.messages = {
      create: async () => {
        createCalls += 1;
        if (nextBehaviour === 'credit400') {
          const e: any = new Error(CREDIT_MESSAGE);
          e.name = 'BadRequestError';
          e.status = 400;
          throw e;
        }
        if (nextBehaviour === 'timeout') {
          const e: any = new Error('Request timed out.');
          e.name = 'APIConnectionTimeoutError';
          throw e;
        }
        if (nextBehaviour === 'empty') {
          return { content: [{ type: 'text', text: '   ' }], usage: {} };
        }
        return {
          content: [{ type: 'text', text: 'Observed a vehicle at the north gate.' }],
          usage: { input_tokens: 10, output_tokens: 20 },
        };
      },
    };
  }
}

inject('@anthropic-ai/sdk', { __esModule: true, default: FakeAnthropic });
inject('../services/sentry', {
  Sentry: {
    captureMessage: (message: string, opts: any) => { sentryCalls.push({ message, opts }); return 'evt'; },
    captureException: () => 'evt',
  },
});
// requireAuth is a middleware factory; pass through with a fixed actor.
inject('../middleware/auth', {
  requireAuth: () => (req: any, _res: unknown, next: () => void) => {
    req.user = { sub: 'guard-uuid-1', company_id: 'company-uuid-1' };
    next();
  },
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = (require('./ai') as { default: any }).default;

// ── Minimal express-free harness ────────────────────────────────────────────
// The route is registered on an express Router; rather than stand up express,
// pull the handler stack off the layer and drive it directly.

function getHandlers(): Function[] {
  const layer = router.stack.find(
    (l: any) => l.route && l.route.path === '/enhance-description',
  );
  assert.ok(layer, 'route /enhance-description not found on the router');
  return layer.route.stack.map((s: any) => s.handle);
}

interface Captured { status: number; body: any; headers: Record<string, string> }

async function callRoute(body: unknown): Promise<Captured> {
  const req: any = { body, user: undefined };
  const out: Captured = { status: 200, body: undefined, headers: {} };
  const res: any = {
    status(code: number) { out.status = code; return res; },
    json(payload: unknown) { out.body = payload; return res; },
    setHeader(k: string, v: string) { out.headers[k] = v; },
  };
  for (const h of getHandlers()) {
    let advanced = false;
    await h(req, res, () => { advanced = true; });
    if (!advanced) break;
  }
  return out;
}

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];
const origError = console.error;
const origLog = console.log;

function reset(): void {
  sentryCalls.length = 0;
  logLines.length = 0;
  createCalls = 0;
  nextBehaviour = 'credit400';
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  reset();
  console.error = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
  console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
  try {
    await fn();
    passed += 1;
    console.error = origError; console.log = origLog;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error = origError; console.log = origLog;
    failures.push(name);
    console.log(`  FAIL ${name}`);
    console.log(`       ${e instanceof Error ? e.message : String(e)}`);
  }
}

const GOOD_TEXT = 'Observed a vehicle parked by the north gate for twenty minutes tonight.';

async function main(): Promise<void> {
  console.log('ai.ts — enhance-description failure branch\n');

  await test('client is constructed with an 8s timeout and maxRetries 0', async () => {
    // The pair matters: an 8s timeout with the SDK's default 2 retries would
    // not bound the wait, which is the whole point of setting it.
    assert.strictEqual(capturedClientOpts?.timeout, 8000, 'timeout');
    assert.strictEqual(capturedClientOpts?.maxRetries, 0, 'maxRetries');
  });

  await test('credit-exhaustion 400 NEVER leaks the vendor message', async () => {
    const r = await callRoute({ text: GOOD_TEXT, report_type: 'activity' });

    const serialised = JSON.stringify(r.body);
    assert.ok(!serialised.includes('credit balance'), 'no "credit balance" in body');
    assert.ok(!serialised.includes('Plans & Billing'), 'no billing copy in body');
    assert.ok(!serialised.includes('invalid_request_error'), 'no vendor error type');
    assert.ok(!serialised.includes('req_011Cen'), 'no upstream request_id');
    assert.ok(!serialised.includes('Anthropic'), 'vendor is not named to the guard');
  });

  await test('failure returns 503 with a stable code and guard-safe copy', async () => {
    const r = await callRoute({ text: GOOD_TEXT, report_type: 'activity' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error, 'ENHANCEMENT_UNAVAILABLE', 'error is a CODE');
    assert.strictEqual(
      r.body.message,
      'Enhancement unavailable — your text will be submitted as written.',
      'message is the copy',
    );
  });

  await test('Sentry gets enhancement_failed with low-cardinality tags and NO identity', async () => {
    await callRoute({ text: GOOD_TEXT, report_type: 'activity' });
    assert.strictEqual(sentryCalls.length, 1, 'exactly one capture');
    const c = sentryCalls[0];
    assert.strictEqual(c.message, 'enhancement_failed');
    assert.deepStrictEqual(c.opts.tags, { status: '400', flow: 'report_enhance' });

    // POLICY.md: tags carry no per-guard identity. Ids belong in extra.
    const tagValues = Object.values(c.opts.tags).join(' ');
    assert.ok(!tagValues.includes('guard-uuid-1'), 'no guard id in tags');
    assert.ok(!tagValues.includes('company-uuid-1'), 'no company id in tags');
    assert.strictEqual(c.opts.extra.guard_id, 'guard-uuid-1', 'id is in extra');
    assert.strictEqual(c.opts.extra.company_id, 'company-uuid-1');
  });

  await test('failure log line carries guard= and company=, like the success line', async () => {
    await callRoute({ text: GOOD_TEXT, report_type: 'activity' });
    const line = logLines.find((l) => l.includes('[ai.enhance.failed]'));
    assert.ok(line, `expected an [ai.enhance.failed] line, got: ${logLines.join(' | ')}`);
    assert.ok(line!.includes('guard=guard-uuid-1'), 'guard id present');
    assert.ok(line!.includes('company=company-uuid-1'), 'company id present');
    assert.ok(line!.includes('status=400'), 'status present');
  });

  await test('a 400 is NOT retried — one upstream call only', async () => {
    await callRoute({ text: GOOD_TEXT, report_type: 'activity' });
    assert.strictEqual(createCalls, 1, 'the 529 loop must not retry a 400');
  });

  await test('a timeout degrades the same way and is not leaked either', async () => {
    nextBehaviour = 'timeout';
    const r = await callRoute({ text: GOOD_TEXT, report_type: 'activity' });
    assert.strictEqual(r.status, 503);
    assert.strictEqual(r.body.error, 'ENHANCEMENT_UNAVAILABLE');
    assert.ok(!JSON.stringify(r.body).includes('timed out'), 'no upstream wording');
    assert.strictEqual(sentryCalls[0].opts.tags.status, '0', 'no HTTP status on a timeout');
  });

  await test('an empty AI response degrades identically, not as a 500', async () => {
    nextBehaviour = 'empty';
    const r = await callRoute({ text: GOOD_TEXT, report_type: 'activity' });
    assert.strictEqual(r.status, 503, 'was 500 "Empty response from AI"');
    assert.strictEqual(r.body.error, 'ENHANCEMENT_UNAVAILABLE');
    assert.strictEqual(sentryCalls[0].opts.tags.status, 'empty');
  });

  await test('the success path is unchanged', async () => {
    nextBehaviour = 'ok';
    const r = await callRoute({ text: GOOD_TEXT, report_type: 'activity' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.enhanced, 'Observed a vehicle at the north gate.');
    assert.deepStrictEqual(sentryCalls, [], 'no Sentry event on success');
    assert.ok(
      logLines.some((l) => l.includes('[ai.enhance.success]')),
      'success line still logged',
    );
  });

  await test('input validation still rejects short text before any upstream call', async () => {
    const r = await callRoute({ text: 'short', report_type: 'activity' });
    assert.strictEqual(r.status, 400, 'validation keeps its own 400');
    assert.strictEqual(createCalls, 0, 'no paid call for invalid input');
    assert.deepStrictEqual(sentryCalls, [], 'validation is not an enhancement failure');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

void main();
