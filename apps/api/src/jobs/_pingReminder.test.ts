/**
 * Tests for pingReminder's no-device skip accounting.
 *
 * Incident: docs/OPS/INCIDENTS/2026-09-05-push-skip-null-token.md
 *
 * The behaviour under test is narrow and specific. A guard with no active
 * guard_devices row yields fcm_token = null, and sendReminder must:
 *   - increment the tick-scoped counter,
 *   - send NO push,
 *   - emit NO Sentry event (this is the regression the incident is about),
 *   - still write the in-app notification.
 *
 * That last one is the important assertion. Suppressing the notification would
 * be a guard-facing behaviour change and Tier 2 under docs/OPS/POLICY.md, so it
 * is asserted explicitly rather than assumed.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/jobs/_pingReminder.test.ts
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

// ── Spies, installed before pingReminder loads ──────────────────────────────

const pushes: Array<{ token: string; title: string }> = [];
const notifications: Array<{ guardId: string; type: string; shiftSessionId: string }> = [];
const sentryCalls: Array<{ method: string; arg: unknown }> = [];

inject('node-cron', {
  __esModule: true,
  default: { schedule: () => ({ on() {}, _task: { on() {} } }) },
});
inject('../db/pool', { pool: { query: async () => ({ rows: [], rowCount: 0 }) } });

// Any Sentry call at all is a failure for these tests, so every method records.
const sentryStub = new Proxy({}, {
  get: (_t, prop: string) => (arg: unknown) => {
    sentryCalls.push({ method: prop, arg });
    return 'stub';
  },
});
inject('../services/sentry', { Sentry: sentryStub });

inject('../services/firebase', {
  async sendPushNotification(a: { token: string; title: string }) {
    pushes.push({ token: a.token, title: a.title });
  },
});
inject('../services/notifications', {
  async insertNotification(a: { guardId: string; type: string; shiftSessionId: string }) {
    notifications.push({ guardId: a.guardId, type: a.type, shiftSessionId: a.shiftSessionId });
  },
  // pingReminder imports NotificationType as a type only; nothing to provide.
});
inject('../services/deviceRegistry', {
  ACTIVE_PUSH_TOKEN_SQL: (alias: string) => `(SELECT NULL) AS fcm_token /*${alias}*/`,
});
inject('../services/pingWindows', {
  breakOverlapsWindow: async () => false,
  siteLocalLabel: () => 'label',
  windowJustClosed: () => null,
});
inject('./_run', { runJob: () => ({ on() {}, _task: { on() {} } }) });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendReminder, newSkipCounter } = require('./pingReminder') as typeof import('./pingReminder');

// ── Harness ─────────────────────────────────────────────────────────────────

let passed = 0;
const failures: string[] = [];

function reset(): void {
  pushes.length = 0;
  notifications.length = 0;
  sentryCalls.length = 0;
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

const NO_DEVICE = {
  guard_id: '5ddb92e2-1c4d-482d-a178-a002eb2b22c9',
  fcm_token: null,
  shift_session_id: '53d85e33-7a6c-44e8-af53-5045924ed8c4',
};
const WITH_DEVICE = {
  guard_id: '6143c82e-19e4-479d-81ec-c1df26bef6c2',
  fcm_token: 'ExponentPushToken[stub]',
  shift_session_id: '86c5a0f1-068c-4057-8b98-b7a79aa565c8',
};

async function main(): Promise<void> {
  console.log('pingReminder — no-device skip accounting\n');

  await test('no device row: counter increments, no push, NO Sentry call', async () => {
    const skipped = newSkipCounter();
    await sendReminder(NO_DEVICE, 'ping_reminder', 'Location ping', 'body', {}, skipped);

    assert.strictEqual(skipped.skippedNoDevice, 1, 'counter incremented');
    assert.strictEqual(pushes.length, 0, 'no push attempted without a token');
    assert.deepStrictEqual(
      sentryCalls, [],
      `expected zero Sentry calls, got ${JSON.stringify(sentryCalls.map((c) => c.method))}`,
    );
  });

  await test('no device row: the in-app notification is STILL written', async () => {
    // Guard-facing behaviour. Suppressing this would be Tier 2.
    const skipped = newSkipCounter();
    await sendReminder(NO_DEVICE, 'ping_reminder', 'Location ping', 'body', {}, skipped);

    assert.strictEqual(notifications.length, 1, 'one notification row');
    assert.strictEqual(notifications[0].guardId, NO_DEVICE.guard_id);
    assert.strictEqual(notifications[0].type, 'ping_reminder');
    assert.strictEqual(notifications[0].shiftSessionId, NO_DEVICE.shift_session_id);
  });

  await test('with a device: push sent, counter untouched, no Sentry call', async () => {
    const skipped = newSkipCounter();
    await sendReminder(WITH_DEVICE, 'ping_reminder', 'Location ping', 'body', {}, skipped);

    assert.strictEqual(skipped.skippedNoDevice, 0, 'counter not incremented');
    assert.strictEqual(pushes.length, 1, 'push attempted');
    assert.strictEqual(pushes[0].token, WITH_DEVICE.fcm_token);
    assert.strictEqual(notifications.length, 1, 'notification still written');
    assert.deepStrictEqual(sentryCalls, []);
  });

  await test('counter accumulates across a tick and is per-counter, not global', async () => {
    // Reproduces the observed production shape: 3 no-device guards on one tick.
    const tickA = newSkipCounter();
    for (let i = 0; i < 3; i += 1) {
      await sendReminder(NO_DEVICE, 'ping_reminder', 'Location ping', 'body', {}, tickA);
    }
    assert.strictEqual(tickA.skippedNoDevice, 3);

    // A second, overlapping tick must not inherit the first tick's count --
    // node-cron does not serialise ticks.
    const tickB = newSkipCounter();
    await sendReminder(NO_DEVICE, 'ping_reminder', 'Location ping', 'body', {}, tickB);
    assert.strictEqual(tickB.skippedNoDevice, 1, 'fresh counter starts at 0');
    assert.strictEqual(tickA.skippedNoDevice, 3, 'first counter unaffected');

    assert.strictEqual(notifications.length, 4, 'every call still wrote its notification');
    assert.deepStrictEqual(sentryCalls, []);
  });

  await test('omitting the counter is safe (no throw, still no Sentry)', async () => {
    await sendReminder(NO_DEVICE, 'ping_reminder', 'Location ping', 'body');
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(pushes.length, 0);
    assert.deepStrictEqual(sentryCalls, []);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

void main();
