/**
 * Tests for the nightlyPurge drain path (notifications over STEP_ROW_CAP).
 *
 * The notifications backlog crossed STEP_ROW_CAP at the 2026-10-10 00:00Z run,
 * so the step halted every night, dry or live. It now DRAINS: over the cap it
 * takes the oldest STEP_ROW_CAP rows by created_at, id, and leaves the rest.
 * Every other step must still halt, and an unset environment must still
 * delete nothing — those two are asserted as hard as the drain itself.
 *
 * runNightlyPurge is driven through its REAL body: all 29 steps run, against
 * a fake pool that answers `SELECT id FROM <table>` from seeded rows and
 * HONOURS `ORDER BY created_at, id` — a SELECT without it gets the rows back
 * shuffled, so a drain that forgot to order would delete the wrong batch and
 * fail here rather than in production. Nothing reaches a database, S3 or
 * Sentry.
 *
 * The cap is not retyped: the first case reads it from the run summary's
 * `extra.cap`, which is STEP_ROW_CAP itself.
 *
 * Run:
 *   cd apps/api && npx ts-node src/jobs/_nightlyPurgeDrain.test.ts
 */
import assert from 'node:assert';
import Module from 'node:module';
import { randomUUID } from 'node:crypto';

function inject(request: string, exports: unknown): void {
  const resolved = require.resolve(request);
  const m = new Module(resolved, module);
  m.filename = resolved;
  m.loaded = true;
  m.exports = exports;
  require.cache[resolved] = m;
}

// ── Fakes, installed before nightlyPurge loads ──────────────────────────────

interface Row { id: string; created_at: number }
interface Query { sql: string; params?: unknown[] }

let tables: Record<string, Row[]> = {};
const queries: Query[] = [];

const byAnchorThenId = (a: Row, b: Row) =>
  a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

inject('../db/pool', {
  pool: {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const sel = /^\s*SELECT id FROM (\w+)\s+WHERE\s/.exec(sql);
      if (sel) {
        const seeded = tables[sel[1]] ?? [];
        const rows = /ORDER BY created_at, id\s*$/.test(sql)
          ? [...seeded].sort(byAnchorThenId)
          : seeded;
        return { rows: rows.map((r) => ({ id: r.id })), rowCount: rows.length };
      }
      const del = /^\s*DELETE FROM (\w+) WHERE id = ANY\(\$1::uuid\[\]\)/.exec(sql);
      if (del) {
        const ids = new Set(params?.[0] as string[]);
        const hit = (tables[del[1]] ?? []).filter((r) => ids.has(r.id)).length;
        return { rows: [], rowCount: hit };
      }
      // The media steps' own SELECTs (`SELECT id, photo_url …`) and anything
      // else match no seeded table and see an empty one.
      return { rows: [], rowCount: 0 };
    },
  },
});

// The cron registration at the bottom of nightlyPurge must not schedule anything.
inject('./_run', { runJob: () => ({}) });

inject('../services/s3', {
  deleteS3Object: async () => { throw new Error('S3 must not be reached in these tests'); },
});
inject('../services/mediaOwnership', {
  keysStillReferenced: async () => new Set<string>(),
  assertPointerColumnsCurrent: async () => [],
});

interface SentryCall { method: string; args: unknown[] }
const sentryCalls: SentryCall[] = [];
const sentryStub = new Proxy({}, {
  get: (_t, method: string) => (...args: unknown[]) => {
    sentryCalls.push({ method, args });
    return 'stub';
  },
});
inject('../services/sentry', { Sentry: sentryStub });

// Not stubbed: services/retentionEnforcement. The gate is the thing under
// test as much as the step is, so it runs for real against process.env.

const { runNightlyPurge } = require('./nightlyPurge') as typeof import('./nightlyPurge');

// ── Harness ─────────────────────────────────────────────────────────────────

const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
const logs: string[] = [];
const capture = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };

type StepResult = Awaited<ReturnType<typeof runNightlyPurge>>[number];
interface Summary {
  level: string;
  tags: Record<string, string>;
  extra: Record<string, unknown> & { per_step: Record<string, Record<string, unknown>>; cap: number };
}
interface Run { results: Record<string, StepResult>; summary: Summary; writes: Query[] }

const SNAP = { dry: process.env.RETENTION_DRY_RUN, live: process.env.RETENTION_LIVE_STEPS };
function setEnv(name: 'RETENTION_DRY_RUN' | 'RETENTION_LIVE_STEPS', v: string | undefined): void {
  if (v === undefined) delete process.env[name]; else process.env[name] = v;
}

async function run(dry: string | undefined, live: string | undefined, seed: Record<string, Row[]>): Promise<Run> {
  tables = seed;
  queries.length = 0; sentryCalls.length = 0; logs.length = 0;
  setEnv('RETENTION_DRY_RUN', dry);
  setEnv('RETENTION_LIVE_STEPS', live);
  console.log = capture; console.warn = capture; console.error = capture;
  try {
    const list = await runNightlyPurge();
    const results: Record<string, StepResult> = {};
    for (const r of list) results[r.step] = r;
    const sums = sentryCalls.filter((c) => c.method === 'captureMessage' && c.args[0] === 'retention_run_summary');
    assert.strictEqual(sums.length, 1, 'exactly one run summary per run');
    const summary = sums[0].args[1] as Summary;
    const writes = queries.filter((q) => /^\s*(DELETE|UPDATE)\b/i.test(q.sql));
    return { results, summary, writes };
  } finally {
    console.log = realLog; console.warn = realWarn; console.error = realError;
    setEnv('RETENTION_DRY_RUN', SNAP.dry);
    setEnv('RETENTION_LIVE_STEPS', SNAP.live);
  }
}

/** n rows, three to a timestamp so the id tiebreak is exercised, then shuffled. */
function rows(n: number): Row[] {
  const base = Date.UTC(2026, 6, 13);
  const out: Row[] = [];
  for (let i = 0; i < n; i++) out.push({ id: randomUUID(), created_at: base + Math.floor(i / 3) * 1000 });
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const warnings = () => sentryCalls.filter((c) =>
  c.method === 'captureMessage' && (c.args[1] as { level?: string } | undefined)?.level === 'warning');

let passed = 0;
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  await fn();
  passed += 1;
  realLog(`  ok  ${name}`);
}

let finished = false;
// An await that never settles drains the event loop and Node exits 0 with no
// output. That must read as a failure, not as a pass.
process.on('beforeExit', () => {
  if (!finished) {
    realError(`\nHARNESS EXITED EARLY after ${passed} passing — an await never settled.`);
    process.exitCode = 1;
  }
});

async function main(): Promise<void> {
  realLog('nightlyPurge drain\n');

  let CAP = 0;
  await check('baseline: 29 steps, nothing seeded, nothing written; cap read from the summary', async () => {
    const r = await run(undefined, undefined, {});
    assert.strictEqual(Object.keys(r.results).length, 29);
    assert.strictEqual(r.writes.length, 0);
    CAP = r.summary.extra.cap;
    assert.ok(Number.isInteger(CAP) && CAP > 0, `cap=${CAP}`);
  });

  // ── dry ──────────────────────────────────────────────────────────────────

  await check('dry, under the cap: unchanged — no drained field, no write', async () => {
    const r = await run(undefined, undefined, { notifications: rows(50) });
    const n = r.results.notifications;
    assert.deepStrictEqual(
      { candidate: n.candidate, deleted: n.deleted, live: n.live, halted: n.halted, drained: n.drained, remaining: n.remaining },
      { candidate: 50, deleted: 0, live: false, halted: undefined, drained: undefined, remaining: undefined },
    );
    assert.strictEqual('drained' in r.summary.extra.per_step.notifications, false);
    assert.strictEqual(r.writes.length, 0);
    assert.ok(logs.includes('[retention.notifications] dry-run (RETENTION_DRY_RUN) would delete 50'));
  });

  await check('dry, exactly at the cap: not a drain (cap is a > boundary)', async () => {
    const r = await run(undefined, undefined, { notifications: rows(CAP) });
    const n = r.results.notifications;
    assert.strictEqual(n.candidate, CAP);
    assert.strictEqual(n.halted, undefined);
    assert.strictEqual(n.drained, undefined);
    assert.strictEqual(r.writes.length, 0);
  });

  await check('dry (RETENTION_DRY_RUN unset), over the cap: drains, does NOT halt, would-delete = cap', async () => {
    const r = await run(undefined, undefined, { notifications: rows(CAP + 1234) });
    const n = r.results.notifications;
    assert.deepStrictEqual(
      { candidate: n.candidate, deleted: n.deleted, live: n.live, halted: n.halted, drained: n.drained, remaining: n.remaining },
      { candidate: CAP + 1234, deleted: 0, live: false, halted: undefined, drained: true, remaining: 1234 },
    );
    assert.strictEqual(r.writes.length, 0, 'a dry drain writes nothing');
    assert.strictEqual(warnings().length, 0, 'a drain is never a warning');
    assert.strictEqual(r.summary.level, 'info');
    assert.strictEqual(r.summary.tags.any_halted, 'false');
    assert.deepStrictEqual(r.summary.extra.halted_steps, []);
    assert.deepStrictEqual(r.summary.extra.drained_steps, ['notifications']);
    assert.strictEqual(r.summary.extra.steps_drained, 1);
    assert.deepStrictEqual(r.summary.extra.per_step.notifications, {
      candidate: CAP + 1234, deleted: 0, live: false, halted: false, drained: true, remaining: 1234,
    });
    assert.ok(logs.includes(`[retention.notifications] dry-run (RETENTION_DRY_RUN) would delete ${CAP}`));
    const crumb = sentryCalls.find((c) => c.method === 'addBreadcrumb'
      && (c.args[0] as { message?: string }).message === `notifications: draining ${CAP} of ${CAP + 1234}`);
    assert.ok(crumb, 'drain breadcrumb present');
    assert.strictEqual((crumb!.args[0] as { level: string }).level, 'info');
  });

  await check('dry by allowlist (DRY_RUN=false, step not listed), over the cap: same dry drain', async () => {
    const r = await run('false', 'auth_events', { notifications: rows(CAP + 7) });
    const n = r.results.notifications;
    assert.deepStrictEqual(
      { deleted: n.deleted, live: n.live, drained: n.drained, remaining: n.remaining },
      { deleted: 0, live: false, drained: true, remaining: 7 },
    );
    // auth_events IS live here and, matching nothing, issues its usual empty
    // DELETE — so assert on this table, not on the whole run.
    assert.strictEqual(r.writes.filter((q) => /notifications/.test(q.sql)).length, 0);
    assert.ok(logs.includes(`[retention.notifications] dry-run (not in RETENTION_LIVE_STEPS) would delete ${CAP}`));
  });

  // ── live ─────────────────────────────────────────────────────────────────

  await check('live, over the cap: deletes EXACTLY the cap, oldest by created_at then id', async () => {
    const seeded = rows(CAP + 1234);
    const expected = [...seeded].sort(byAnchorThenId).slice(0, CAP).map((x) => x.id);
    const r = await run('false', 'notifications', { notifications: seeded });

    const sel = queries.filter((q) => /^\s*SELECT id FROM notifications WHERE /.test(q.sql));
    assert.strictEqual(sel.length, 1);
    assert.match(sel[0].sql, /ORDER BY created_at, id$/);

    assert.strictEqual(r.writes.length, 1, 'one write in the whole run');
    assert.match(r.writes[0].sql, /^DELETE FROM notifications WHERE id = ANY\(\$1::uuid\[\]\)$/);
    assert.deepStrictEqual(r.writes[0].params?.[0], expected);

    const n = r.results.notifications;
    assert.deepStrictEqual(
      { candidate: n.candidate, deleted: n.deleted, live: n.live, halted: n.halted, drained: n.drained, remaining: n.remaining },
      { candidate: CAP + 1234, deleted: CAP, live: true, halted: undefined, drained: true, remaining: 1234 },
    );
    assert.strictEqual(warnings().length, 0);
    assert.strictEqual(r.summary.tags.any_halted, 'false');
    assert.strictEqual(r.summary.tags.any_live, 'true');
    assert.deepStrictEqual(r.summary.extra.per_step.notifications, {
      candidate: CAP + 1234, deleted: CAP, live: true, halted: false,
      s3_deleted: 0, s3_failed: 0, s3_skipped: 0, drained: true, remaining: 1234,
    });
  });

  await check('live, under the cap: deletes every candidate, no drained field (unchanged)', async () => {
    const seeded = rows(50);
    const r = await run('false', 'notifications', { notifications: seeded });
    assert.strictEqual(r.writes.length, 1);
    assert.deepStrictEqual(
      new Set(r.writes[0].params?.[0] as string[]),
      new Set(seeded.map((x) => x.id)),
    );
    const n = r.results.notifications;
    assert.deepStrictEqual(
      { candidate: n.candidate, deleted: n.deleted, live: n.live, drained: n.drained, remaining: n.remaining },
      { candidate: 50, deleted: 50, live: true, drained: undefined, remaining: undefined },
    );
  });

  // ── every other step still halts ─────────────────────────────────────────

  await check('NON-drain simple step over the cap, live: halts, deletes nothing, warns', async () => {
    const r = await run('false', 'auth_events', { auth_events: rows(CAP + 1) });
    const a = r.results.auth_events;
    assert.deepStrictEqual(
      { candidate: a.candidate, deleted: a.deleted, live: a.live, halted: a.halted, drained: a.drained },
      { candidate: CAP + 1, deleted: 0, live: true, halted: true, drained: undefined },
    );
    assert.strictEqual(r.writes.length, 0);
    const w = warnings();
    assert.strictEqual(w.length, 1);
    assert.strictEqual(w[0].args[0], `retention.auth_events.halted count=${CAP + 1}`);
    assert.strictEqual(r.summary.tags.any_halted, 'true');
    assert.deepStrictEqual(r.summary.extra.halted_steps, ['auth_events']);
    assert.deepStrictEqual(r.summary.extra.drained_steps, []);
    const s = queries.find((q) => /^\s*SELECT id FROM auth_events WHERE /.test(q.sql));
    assert.ok(s && !/ORDER BY/.test(s.sql), 'a non-drain SELECT is unchanged — no ORDER BY');
  });

  await check('NON-drain step function over the cap, live: halts, deletes nothing', async () => {
    const r = await run('false', 'step2_reports', { reports: rows(CAP + 1) });
    assert.strictEqual(r.results.step2_reports.halted, true);
    assert.strictEqual(r.results.step2_reports.deleted, 0);
    assert.strictEqual(r.writes.length, 0);
  });

  // ── the fail-safe direction ──────────────────────────────────────────────

  await check('unset env vars: nothing deleted anywhere, every table over the cap', async () => {
    const r = await run(undefined, undefined, {
      notifications: rows(CAP + 50), auth_events: rows(CAP + 1), reports: rows(CAP + 1),
      revoked_tokens: rows(300), admin_client_previews: rows(7),
    });
    assert.strictEqual(r.writes.length, 0);
    assert.strictEqual(Object.values(r.results).every((x) => x.deleted === 0 && x.live === false), true);
    assert.strictEqual(r.summary.tags.dry_run, 'true');
    assert.strictEqual(r.summary.tags.any_live, 'false');
  });

  finished = true;
  realLog(`\n${passed} passed, 0 failed.`);
}

main().catch((e) => {
  finished = true;
  realError(`\nFAILED after ${passed} passing:`);
  realError(e);
  process.exit(1);
});
