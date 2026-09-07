/**
 * Tests for push_skip_null_token accounting on the three reminder crons (N20).
 *
 * Incident: docs/OPS/INCIDENTS/2026-09-05-push-skip-null-token.md, which fixed
 * the same defect in pingReminder on 2026-09-05 and left these three emitting a
 * `warning`-level Sentry event per skipped push.
 *
 * For each job, a guard with no active guard_devices row (fcm_token null) must:
 *   - increment the tick-scoped counter and print `skipped_no_device=N`,
 *   - send NO push,
 *   - emit NO Sentry event,
 *   - STILL write the in-app notification row.
 *
 * That last one is the assertion that matters. Suppressing the notification
 * would be a guard-facing behaviour change and Tier 2 under docs/OPS/POLICY.md,
 * so it is asserted explicitly rather than assumed — same reasoning as the
 * pingReminder test this is modelled on.
 *
 * The jobs are driven through their REAL bodies: node-cron is stubbed so that
 * runJob's registration hands back the wrapped tick function, which is then
 * invoked directly against a fake pool. Nothing here reaches a network or a
 * database.
 *
 * Run:
 *   cd apps/api && npx ts-node src/jobs/_pushSkipCounters.test.ts
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

// ── Spies, installed before any job module loads ────────────────────────────

const ticks = new Map<string, () => Promise<void>>();
const pushes: Array<{ token: string; title: string }> = [];
const notifications: Array<{ guardId: string; type: string }> = [];
const sentryCalls: Array<{ method: string; arg: unknown }> = [];
const logs: string[] = [];

let selectRows: any[] = [];
const queries: string[] = [];

inject('node-cron', {
  __esModule: true,
  default: {
    schedule: (_expr: string, fn: () => Promise<void>) => {
      // runJob registers exactly one task per module; key by load order.
      ticks.set(String(ticks.size), fn);
      return { on() {}, _task: { on() {} } };
    },
  },
});

inject('../db/pool', {
  pool: {
    query: async (sql: string) => {
      queries.push(sql);
      // Only the candidate SELECT returns rows; UPDATE stamps and the
      // cron_heartbeats upsert must not.
      if (/^\s*SELECT/i.test(sql) && /FROM shifts|FROM\s+shifts/i.test(sql)) {
        return { rows: selectRows, rowCount: selectRows.length };
      }
      return { rows: [], rowCount: 0 };
    },
  },
});

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
  async insertNotification(a: { guardId: string; type: string }) {
    notifications.push({ guardId: a.guardId, type: a.type });
  },
});

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
const capture = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
function silence(): void { console.log = capture; console.warn = capture; console.error = capture; }
function unsilence(): void { console.log = realLog; console.warn = realWarn; console.error = realError; }

// lateClockInReminder imports services/email, which THROWS at module load if
// SENDGRID_FROM_EMAIL is unset and calls sgMail.setApiKey at top level. Both
// are satisfied/stubbed so the job loads in isolation and nothing reaches the
// network. (The first version of this test replaced console before these
// requires and the resulting load failure produced a silent exit 1 — silence
// from a test means broken, so console is now only replaced around the job
// invocations themselves.)
process.env.SENDGRID_FROM_EMAIL = 'alerts@example.invalid';
process.env.SENDGRID_API_KEY = 'stub-key-sgMail-is-injected';
inject('@sendgrid/mail', { __esModule: true, default: { setApiKey() {}, async send() {} } });

// Load order defines the tick keys above. Console is NOT replaced here: a
// module-load failure must be visible, not swallowed into `logs`.
require('./preShiftReminder');   // 0
require('./shiftStartReminder'); // 1
require('./lateClockInReminder');// 2

function reset(): void {
  pushes.length = 0; notifications.length = 0;
  sentryCalls.length = 0; logs.length = 0; queries.length = 0;
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  reset();
  silence();
  try { await fn(); } finally { unsilence(); }
  passed += 1;
  realLog(`  ok  ${name}`);
}

const NO_DEVICE = { guard_id: 'g-nodev', fcm_token: null };
const WITH_DEVICE = { guard_id: 'g-dev', fcm_token: 'tok-abc' };

function shiftRow(o: any, i: number) {
  return {
    shift_id: `s-${i}`, scheduled_start: new Date(), site_name: 'Site',
    guard_name: 'redacted', ...o,
  };
}
function lateRow(o: any, i: number) {
  return {
    shift_id: `s-${i}`, scheduled_start: new Date(), site_name: 'Site',
    guard_name: 'redacted', minutes_late: 12,
    late_10_reminder_sent_at: null, late_15_reminder_sent_at: null,
    late_admin_email_sent_at: new Date(), ...o,
  };
}

(async () => {
  for (const [idx, job, mk] of [
    ['0', 'preShiftReminder', shiftRow],
    ['1', 'shiftStartReminder', shiftRow],
  ] as const) {
    await check(`${job}: 3 no-device guards -> skipped_no_device=3, 0 Sentry, 3 notifications`, async () => {
      selectRows = [0, 1, 2].map((i) => mk(NO_DEVICE, i));
      await ticks.get(idx)!();
      const line = logs.find((l) => l.includes(`[${job}] candidates=`));
      assert.ok(line, `no summary line for ${job}: ${logs.join(' | ')}`);
      assert.match(line!, /skipped_no_device=3/);
      assert.strictEqual(sentryCalls.length, 0, `Sentry called: ${JSON.stringify(sentryCalls)}`);
      assert.strictEqual(pushes.length, 0, 'a push was sent for a guard with no device');
      assert.strictEqual(notifications.length, 3, 'in-app notification rows must still be written');
    });

    await check(`${job}: guards WITH a device still get the push and do not count`, async () => {
      selectRows = [mk(WITH_DEVICE, 0), mk(NO_DEVICE, 1)];
      await ticks.get(idx)!();
      const line = logs.find((l) => l.includes(`[${job}] candidates=`))!;
      assert.match(line, /skipped_no_device=1/);
      assert.strictEqual(pushes.length, 1);
      assert.strictEqual(pushes[0].token, 'tok-abc');
      assert.strictEqual(notifications.length, 2);
      assert.strictEqual(sentryCalls.length, 0);
    });

    await check(`${job}: counter is tick-scoped, not module-scoped`, async () => {
      selectRows = [mk(NO_DEVICE, 0)];
      await ticks.get(idx)!();
      reset();
      selectRows = [mk(NO_DEVICE, 0)];
      await ticks.get(idx)!();
      const line = logs.find((l) => l.includes(`[${job}] candidates=`))!;
      assert.match(line, /skipped_no_device=1/, 'second tick must start from 0, not accumulate');
    });
  }

  await check('lateClockInReminder: skipped_no_device is separate from skipped (unassigned)', async () => {
    selectRows = [
      lateRow(NO_DEVICE, 0),
      lateRow({ guard_id: null, fcm_token: null }, 1), // unassigned -> the OTHER counter
    ];
    await ticks.get('2')!();
    const line = logs.find((l) => l.includes('[lateClockIn] fired'));
    assert.ok(line, `no summary line: ${logs.join(' | ')}`);
    assert.match(line!, /skipped=1 /, 'unassigned shift must count under the pre-existing `skipped`');
    assert.match(line!, /skipped_no_device=1/, 'no-device must count under the new field');
    assert.strictEqual(sentryCalls.length, 0);
    assert.strictEqual(pushes.length, 0);
    assert.strictEqual(notifications.length, 1, 'the assigned guard still gets the in-app row');
  });

  await check('lateClockInReminder: a guard with a device is pushed and not counted', async () => {
    selectRows = [lateRow(WITH_DEVICE, 0)];
    await ticks.get('2')!();
    const line = logs.find((l) => l.includes('[lateClockIn] fired'))!;
    assert.match(line, /skipped_no_device=0/);
    assert.strictEqual(pushes.length, 1);
    assert.strictEqual(sentryCalls.length, 0);
  });

  realLog(`\n${passed} passed, 0 failed.`);
})().catch((e) => {
  unsilence();
  realError(`\nFAILED after ${passed} passing:`);
  realError(e);
  process.exit(1);
});
