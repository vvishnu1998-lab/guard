/**
 * Tests for SendGrid failure accounting.
 *
 * Incident: docs/OPS/INCIDENTS/2026-09-01-unauthorized-burst.md
 *
 * A declining card made SendGrid return 401 on every send for 6d 18h. The old
 * `reportSendgridFailure` was a `Sentry.captureException` per failed RECIPIENT,
 * and `sendMissedShiftAlert` deliberately retries every 5 minutes while every
 * recipient fails, so the pair emitted 480 events/hour and exhausted the org's
 * monthly Sentry quota in ~10 hours.
 *
 * The three properties asserted here are exactly the ones that failed:
 *   - a sustained outage produces AT MOST ONE capture, not one per occurrence;
 *   - a recovery followed by a new failure produces EXACTLY ONE capture, so a
 *     genuinely new outage is never swallowed by the rate limit;
 *   - the recipient never reaches Sentry — unbounded cardinality, and PII under
 *     docs/OPS/POLICY.md.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/services/_sendgridFailure.test.ts
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

interface Captured { method: string; message: unknown; opts: any }
const captures: Captured[] = [];

const sentryStub = new Proxy({}, {
  get: (_t, prop: string) => (message: unknown, opts: any) => {
    captures.push({ method: prop, message, opts });
    return 'stub';
  },
});

// email.ts runs module-level side effects on import: sgMail.setApiKey and a
// hard throw if SENDGRID_FROM_EMAIL is unset. Both are stubbed/satisfied so the
// module loads in isolation without touching the network or the database.
process.env.SENDGRID_FROM_EMAIL = 'alerts@example.invalid';
process.env.SENDGRID_API_KEY = 'stub-key-sgMail-is-injected';
inject('../services/sentry', { Sentry: sentryStub });
inject('../db/pool', { pool: { query: async () => ({ rows: [], rowCount: 0 }) } });
inject('@sendgrid/mail', { __esModule: true, default: { setApiKey() {}, async send() {} } });

// The unit under test is module-private, so it is exercised through the two
// exported doors the production code uses. `reportSendgridFailure` is reached
// via the test-only re-export below.
const email = require('./email') as typeof import('./email');
const { noteSendgridSuccess, __resetSendgridFailureState, __reportSendgridFailureForTest: report } =
  email as any;

const logLines: string[] = [];
const realError = console.error;
const realLog = console.log;
console.error = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };
console.log = (...a: unknown[]) => { logLines.push(a.map(String).join(' ')); };

function reset(): void {
  captures.length = 0;
  logLines.length = 0;
  __resetSendgridFailureState();
}

const err401 = { code: 401, message: 'Unauthorized', response: { statusCode: 401, body: 'x' } };

let passed = 0;
function check(name: string, fn: () => void): void {
  reset();
  fn();
  passed += 1;
  realLog(`  ok  ${name}`);
}

// ── 1. 50 failures produce at most one capture ──────────────────────────────
check('50 consecutive failures produce <= 1 Sentry capture', () => {
  for (let i = 0; i < 50; i += 1) {
    report('missed_shift_alert', err401, { recipient: `admin${i}@example.invalid` });
  }
  assert.ok(captures.length <= 1, `expected <=1 capture, got ${captures.length}`);
  assert.strictEqual(captures.length, 1, 'the transition itself should still capture exactly once');
  assert.strictEqual(captures[0].method, 'captureMessage');
  assert.strictEqual(captures[0].message, 'sendgrid_failing');
});

// ── 2. success then failure produces exactly one capture ────────────────────
check('success then failure produces exactly 1 capture', () => {
  report('missed_shift_alert', err401, {});      // transition -> capture #1
  assert.strictEqual(captures.length, 1);
  noteSendgridSuccess('missed_shift_alert');     // recovery resets the state
  captures.length = 0;
  report('missed_shift_alert', err401, {});      // new transition -> exactly 1
  assert.strictEqual(captures.length, 1, `expected exactly 1, got ${captures.length}`);
});

// ── 3. recipient identity never reaches Sentry ──────────────────────────────
check('recipient is never a tag and never reaches Sentry at all', () => {
  const secret = 'someone@example.invalid';
  for (let i = 0; i < 5; i += 1) report('missed_shift_alert', err401, { recipient: secret });
  assert.strictEqual(captures.length, 1);
  const { tags, extra } = captures[0].opts;
  assert.deepStrictEqual(Object.keys(tags).sort(), ['flow', 'service', 'status']);
  assert.strictEqual(tags.recipient, undefined);
  const blob = JSON.stringify(captures[0]);
  assert.ok(!blob.includes(secret), 'recipient address leaked into the Sentry payload');
  assert.ok(!blob.includes('example.invalid'), 'an email address leaked into the Sentry payload');
  assert.strictEqual(extra.recipient, undefined);
});

// ── 4. status is a tag, taken from the HTTP status not the message ──────────
check('status is tagged from the HTTP code, not the message text', () => {
  report('daily_shift_report', err401, {});
  assert.strictEqual(captures[0].opts.tags.status, '401');
  assert.strictEqual(captures[0].opts.tags.flow, 'daily_shift_report');
  reset();
  report('daily_shift_report', { message: 'no status anywhere' }, {});
  assert.strictEqual(captures[0].opts.tags.status, 'unknown');
});

// ── 5. the console line is emitted at most once per minute, with the count ──
check('console emits one [sendgrid.fail] line carrying the suppressed count', () => {
  for (let i = 0; i < 50; i += 1) report('missed_shift_alert', err401, {});
  const fails = logLines.filter((l) => l.startsWith('[sendgrid.fail]'));
  assert.strictEqual(fails.length, 1, `expected 1 log line in <60s, got ${fails.length}`);
  assert.match(fails[0], /^\[sendgrid\.fail\] flow=missed_shift_alert count=\d+ status=401$/);
});

// ── 6. flows are independent ────────────────────────────────────────────────
check('each flow transitions independently', () => {
  report('missed_shift_alert', err401, {});
  report('welcome_guard', err401, {});
  for (let i = 0; i < 20; i += 1) report('missed_shift_alert', err401, {});
  assert.strictEqual(captures.length, 2, 'one capture per flow, not per occurrence');
  assert.deepStrictEqual(captures.map((c) => c.opts.tags.flow).sort(), ['missed_shift_alert', 'welcome_guard']);
});

// ── 7. the old behaviour is gone ────────────────────────────────────────────
check('captureException is never called from this path', () => {
  for (let i = 0; i < 30; i += 1) report('missed_shift_alert', err401, {});
  assert.strictEqual(captures.filter((c) => c.method === 'captureException').length, 0);
});

console.log = realLog;
console.error = realError;
realLog(`\n${passed} passed, 0 failed.`);
