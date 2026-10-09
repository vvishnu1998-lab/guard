#!/usr/bin/env ts-node
/**
 * Prove U3 (N146): an open session's cached shift window follows the server
 * after an admin moves the end (D20), without re-registering the region and
 * without a cold start.
 *
 * WHY THIS EXISTS. Before U3 the app cached activeShift at clock-in and
 * refreshFromServer never rewrote it. After an admin EXTENDED an active shift
 * a warm app kept the old end: Time Left and SCHEDULED END were wrong, and the
 * background geofence task — which judges a SecureStore copy of the end — went
 * silent at old end + grace while the guard was still on shift. Nothing
 * errored. The extend push had to ask guards to "fully close and reopen".
 *
 * Three pure pieces are EXECUTED here: the rewrite decision
 * (lib/activeShiftReconcile.ts), and the two queues (lib/asyncQueue.ts) that
 * coalesce refreshes and serialise SecureStore/geofence writes. The store,
 * _layout.tsx and navigateForNotification.ts cannot be imported under ts-node
 * (react-native, expo-router), so SOURCE ASSERTIONS at the bottom pin how they
 * use those pieces: the rewrite keeps the geofence by reference, the geofence
 * effect's deps are unchanged, the window effect depends on the end, and both
 * push paths trigger the refresh.
 *
 * Run:
 *   cd apps/mobile && npm run check:end-reconcile
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  decideWindowRewrite, CachedWindow, isEditForActiveShift, shouldRearmAfterWindowChange,
} from '../lib/activeShiftReconcile';
import { createCoalescer, createSerialQueue } from '../lib/asyncQueue';
import { SHIFT_EXPIRY_GRACE_MS } from '../lib/shiftExpiry';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? e.message : String(e)}`);
  }
}

function eq(got: unknown, want: unknown, msg: string): void {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) throw new Error(`${msg}: got ${a}, want ${b}`);
}

const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

const CACHED: CachedWindow = {
  sessionId: 'sess-1', shiftId: 'shift-1',
  scheduledStart: '2026-09-29T02:30:00.000Z',   // 19:30 PT
  scheduledEnd:   '2026-09-29T03:30:00.000Z',   // 20:30 PT
};
const server = (over: Partial<Record<'sessionId' | 'shiftId' | 'scheduledStart' | 'scheduledEnd', unknown>>) => ({
  sessionId: CACHED.sessionId, shiftId: CACHED.shiftId,
  scheduledStart: CACHED.scheduledStart, scheduledEnd: CACHED.scheduledEnd,
  ...over,
});

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
/** Source with // and /* *\/ comments removed, so an assertion cannot be
 *  satisfied by prose that merely mentions the code. */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

async function main(): Promise<void> {
  console.log('[check-end-reconcile]');

  // ── The rewrite decision ────────────────────────────────────────────────
  await test('extend: same session, later end → rewrite with the server strings', () => {
    eq(decideWindowRewrite(CACHED, server({ scheduledEnd: '2026-09-29T04:45:00.000Z' })),
      { kind: 'rewrite', scheduledStart: CACHED.scheduledStart, scheduledEnd: '2026-09-29T04:45:00.000Z' }, 'extend');
  });
  await test('shorten: earlier end still ahead → rewrite', () => {
    eq(decideWindowRewrite(CACHED, server({ scheduledEnd: '2026-09-29T03:15:00.000Z' })).kind, 'rewrite', 'shorten');
  });
  await test('the same instant in another format is unchanged (instants, not strings)', () => {
    eq(decideWindowRewrite(CACHED, server({ scheduledEnd: '2026-09-28T20:30:00-07:00', scheduledStart: '2026-09-29T02:30:00Z' })),
      { kind: 'keep', reason: 'unchanged' }, 'offset form');
  });
  await test('a start-only change rewrites both fields', () => {
    eq(decideWindowRewrite(CACHED, server({ scheduledStart: '2026-09-29T02:00:00.000Z' })),
      { kind: 'rewrite', scheduledStart: '2026-09-29T02:00:00.000Z', scheduledEnd: CACHED.scheduledEnd }, 'start moved');
  });
  await test("step4's fallback shape (start = end = clock-in) takes the real window", () => {
    const fallback: CachedWindow = { ...CACHED, scheduledStart: '2026-09-29T02:40:41.000Z', scheduledEnd: '2026-09-29T02:40:41.000Z' };
    eq(decideWindowRewrite(fallback, server({})),
      { kind: 'rewrite', scheduledStart: CACHED.scheduledStart, scheduledEnd: CACHED.scheduledEnd }, 'fallback healed');
  });
  await test('another session (a handoff rotation) is left alone', () => {
    eq(decideWindowRewrite(CACHED, server({ sessionId: 'sess-2', scheduledEnd: '2026-09-29T05:00:00.000Z' })),
      { kind: 'keep', reason: 'different_session' }, 'different session');
  });
  await test('another shift is left alone', () => {
    eq(decideWindowRewrite(CACHED, server({ shiftId: 'shift-2' })), { kind: 'keep', reason: 'different_shift' }, 'different shift');
  });
  await test('nothing cached → keep (home restore owns that)', () => {
    eq(decideWindowRewrite(null, server({})), { kind: 'keep', reason: 'no_cached_session' }, 'no cache');
  });
  await test('a response without a shift → keep', () => {
    eq(decideWindowRewrite(CACHED, null), { kind: 'keep', reason: 'no_shift_in_response' }, 'null');
    eq(decideWindowRewrite(CACHED, server({ shiftId: undefined })), { kind: 'keep', reason: 'no_shift_in_response' }, 'no shift id');
  });
  await test('unparseable or non-string times are never applied', () => {
    eq(decideWindowRewrite(CACHED, server({ scheduledEnd: 'garbage' })), { kind: 'keep', reason: 'unparseable' }, 'garbage');
    eq(decideWindowRewrite(CACHED, server({ scheduledEnd: 1759114800000 })), { kind: 'keep', reason: 'unparseable' }, 'number');
    eq(decideWindowRewrite(CACHED, server({ scheduledStart: null })), { kind: 'keep', reason: 'unparseable' }, 'null start');
  });
  await test('an end at or before the start is refused', () => {
    eq(decideWindowRewrite(CACHED, server({ scheduledEnd: CACHED.scheduledStart })), { kind: 'keep', reason: 'not_after_start' }, 'equal');
    eq(decideWindowRewrite(CACHED, server({ scheduledEnd: '2026-09-29T02:00:00.000Z' })), { kind: 'keep', reason: 'not_after_start' }, 'before');
  });

  // ── Which pushes trigger, and when the region is re-armed ───────────────
  await test('push filter: only an edit to the active shift triggers (or one with no shift id)', () => {
    eq(isEditForActiveShift({ shift_id: 'shift-1' }, true, 'shift-1'), true, 'same shift');
    eq(isEditForActiveShift({ shift_id: 'shift-9' }, true, 'shift-1'), false, 'a scheduled shift');
    eq(isEditForActiveShift({}, true, 'shift-1'), true, 'no shift_id');
    eq(isEditForActiveShift(undefined, true, 'shift-1'), true, 'no data');
    eq(isEditForActiveShift({ shift_id: 42 }, true, 'shift-1'), true, 'non-string shift_id');
    eq(isEditForActiveShift({ shift_id: 'shift-1' }, false, undefined), false, 'no session');
  });
  await test('re-arm only when the OLD end had run out and the NEW one has not', () => {
    const now = Date.parse('2026-09-29T04:00:00.000Z');
    const past   = new Date(now - SHIFT_EXPIRY_GRACE_MS - 60_000).toISOString();   // expired
    const inside = new Date(now - SHIFT_EXPIRY_GRACE_MS + 60_000).toISOString();   // within grace
    const future = new Date(now + 60 * 60_000).toISOString();
    eq(shouldRearmAfterWindowChange(false, past,   future, now), true,  'extend after the old end ran out');
    eq(shouldRearmAfterWindowChange(false, inside, future, now), false, 'extend inside the old grace: nothing was dropped');
    eq(shouldRearmAfterWindowChange(false, future, future.replace('05:', '06:'), now), false, 'extend well ahead');
    eq(shouldRearmAfterWindowChange(false, past,   past,   now), false, 'new end also past (shorten/close)');
    eq(shouldRearmAfterWindowChange(true,  future, future, now), true,  'a cancelled re-arm is carried');
    eq(shouldRearmAfterWindowChange(true,  future, past,   now), false, 'carried, but the new end is past');
  });

  // ── createCoalescer ─────────────────────────────────────────────────────
  await test('coalescer: one call, one run', async () => {
    let runs = 0;
    const c = createCoalescer(async () => { runs += 1; await tick(5); });
    await c();
    eq(runs, 1, 'runs');
  });
  await test('coalescer: a burst during a run costs exactly one trailing run', async () => {
    const started: number[] = [];
    let seq = 0;
    const c = createCoalescer(async () => { started.push(++seq); await tick(20); });
    const first = c();
    await tick(1);
    const callAt = seq;                      // run 1 is in flight
    const burst = [c(), c(), c(), c()];
    await Promise.all([first, ...burst]);
    eq(started.length, 2, 'total runs for 1 + 4 calls');
    eq(callAt, 1, 'run 1 was in flight when the burst arrived');
  });
  await test('coalescer: a caller is never answered by a run that started before it asked', async () => {
    let seq = 0;
    const startedAt: number[] = [];
    const c = createCoalescer(async () => { const n = ++seq; startedAt[n] = Date.now(); await tick(30); });
    const p1 = c();
    await tick(10);
    const asked = Date.now();
    await c();                               // must wait for run 2
    await p1;
    if (!(startedAt[2] >= asked)) throw new Error(`run 2 started ${asked - startedAt[2]} ms before the caller asked`);
    eq(seq, 2, 'runs');
  });
  await test('coalescer: a rejected run does not wedge later calls', async () => {
    let n = 0;
    const c = createCoalescer(async () => { n += 1; await tick(5); if (n === 1) throw new Error('boom'); });
    const p1 = c();
    const p2 = c();                          // trailing, must still run
    await p1.then(() => { throw new Error('run 1 should have rejected'); }, () => undefined);
    await p2;
    await c();                               // idle again: a fresh run
    eq(n, 3, 'runs');
  });

  await test('coalescer: runs never overlap, even for a call landing between a run and its trailing run', async () => {
    let active = 0, maxActive = 0, runs = 0;
    const c = createCoalescer(async () => {
      runs += 1; active += 1; maxActive = Math.max(maxActive, active);
      await tick(5);
      active -= 1;
    });
    const a = c();
    // Registered on run 1 BEFORE the trailing run is, so it fires in the gap
    // after run 1 settles and before the trailing run starts.
    const inGap = a.then(() => c());
    const b = c();
    await Promise.all([a, b, inGap]);
    eq(maxActive, 1, 'max concurrent runs');
    eq(runs, 2, 'runs');
  });

  // ── createSerialQueue ───────────────────────────────────────────────────
  await test('serial queue: ops run one at a time in call order', async () => {
    const q = createSerialQueue();
    const log: string[] = [];
    let active = 0, maxActive = 0;
    const op = (id: string, ms: number) => q(async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      log.push(`start ${id}`); await tick(ms); log.push(`end ${id}`);
      active -= 1; return id;
    });
    const results = await Promise.all([op('a', 20), op('b', 1), op('c', 10)]);
    eq(results, ['a', 'b', 'c'], 'results');
    eq(maxActive, 1, 'max concurrency');
    eq(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c'], 'order');
  });
  await test('serial queue: a failure reaches its caller and never blocks the next op', async () => {
    const q = createSerialQueue();
    const failed = q(async () => { throw new Error('keychain'); });
    const after = q(async () => 'ran');
    await failed.then(() => { throw new Error('should have rejected'); }, () => undefined);
    eq(await after, 'ran', 'next op');
  });

  // ── Source assertions ───────────────────────────────────────────────────
  await test('store: refreshFromServer is the coalesced refreshOnce', () => {
    const src = code('store/shiftStore.ts');
    if (!/refreshFromServer:\s*\(\)\s*=>\s*coalescedRefresh\(\)/.test(src)) throw new Error('refreshFromServer no longer delegates to coalescedRefresh');
    if (!/const coalescedRefresh = createCoalescer\(refreshOnce\)/.test(src)) throw new Error('coalescedRefresh is not createCoalescer(refreshOnce)');
  });
  await test('store: the rewrite takes only start/end and keeps every other field by reference', () => {
    const src = code('store/shiftStore.ts');
    const body = src.slice(src.indexOf('async function refreshOnce'), src.indexOf('const coalescedRefresh'));
    if (!body.includes('decideWindowRewrite(')) throw new Error('refreshOnce does not consult decideWindowRewrite');
    if (body.includes('setActiveSession(')) throw new Error('refreshOnce calls setActiveSession — that re-registers the region');
    const m = body.match(/activeShift:\s*\{([\s\S]*?)\}/);
    if (!m) throw new Error('no activeShift rewrite found in refreshOnce');
    const keys = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    eq(keys[0], '...cur.activeShift', 'the rewrite must spread the cached shift first');
    const written = keys.slice(1).map((k) => k.split(':')[0].trim()).sort();
    eq(written, ['scheduled_end', 'scheduled_start'], 'fields taken from the server');
    if (!/state\.clearSession\(\)/.test(body)) throw new Error('a null response no longer goes through clearSession');
  });
  await test("_layout: the geofence effect's deps are unchanged; the window effect follows the end", () => {
    const src = code('app/_layout.tsx');
    if (!src.includes('}, [activeSession?.id, activeShift?.geofence]);')) throw new Error('geofence effect deps changed');
    if (!src.includes('}, [activeSession?.id, activeShift?.scheduled_start, activeShift?.scheduled_end]);')) {
      throw new Error('no effect keyed on the shift window');
    }
    if (/setItemAsync\(\s*'active_shift_end'/.test(src) || /deleteItemAsync\(\s*'active_shift_end'/.test(src)) {
      throw new Error("_layout writes 'active_shift_end' directly — every write must go through syncShiftEndMirror");
    }
  });
  await test('both push paths trigger the refresh for shift_schedule_edited', () => {
    const layout = code('app/_layout.tsx');
    const recv = layout.slice(layout.indexOf('addNotificationReceivedListener'));
    if (!/type === 'shift_schedule_edited'\)\s*\{\s*refreshIfActiveShiftEdited\(data\)/.test(recv)) {
      throw new Error('the foreground receiver does not call refreshIfActiveShiftEdited');
    }
    const nav = code('lib/navigateForNotification.ts');
    const m = /if \(type === 'shift_schedule_edited'\) \{\s*refreshIfActiveShiftEdited\(data\);?\s*\}/.exec(nav);
    if (!m || m.index > nav.indexOf('switch (type)')) throw new Error('the tap path does not refresh before routing');
  });
  await test('the push filter and the re-arm rule are the tested functions, not copies', () => {
    const store = code('store/shiftStore.ts');
    const hook = store.slice(store.indexOf('export function refreshIfActiveShiftEdited'), store.indexOf('const endMirrorQueue'));
    if (!/if \(!isEditForActiveShift\(data, !!st\.activeSession, st\.activeShift\?\.id\)\) return;/.test(hook)) {
      throw new Error('refreshIfActiveShiftEdited no longer gates on isEditForActiveShift');
    }
    const layout = code('app/_layout.tsx');
    if (!/next\.rearm = shouldRearmAfterWindowChange\(prev\.rearm, prev\.end, next\.end, Date\.now\(\)\);/.test(layout)) {
      throw new Error('the window effect no longer decides the re-arm with shouldRearmAfterWindowChange');
    }
    if (!/if \(cancelled \|\| !next\.rearm\) return;/.test(layout)) throw new Error('the re-arm is no longer gated on next.rearm');
  });
  await test('store: an answer overtaken by another writer is never applied', () => {
    const src = code('store/shiftStore.ts');
    const body = src.slice(src.indexOf('async function refreshOnce'), src.indexOf('const coalescedRefresh'));
    if (!/settled = state\.activeShift === askedShift && state\.activeSession === askedSession;/.test(body)) {
      throw new Error('refreshOnce no longer compares the store before and after its GET');
    }
    const gate = body.indexOf('if (!settled) {');
    const clear = body.indexOf('state.clearSession()');
    const rewrite = body.indexOf('decideWindowRewrite(');
    if (gate < 0 || clear < gate || rewrite < gate) throw new Error('the clear or the rewrite can run before the settled check');
  });
  await test("'active_shift_end' is written only by syncShiftEndMirror in the app", () => {
    for (const rel of ['app/_layout.tsx', 'lib/navigateForNotification.ts', 'lib/sessionClosed.ts', 'lib/openSession.ts']) {
      if (/setItemAsync\(\s*'active_shift_end'/.test(code(rel))) throw new Error(`${rel} writes the key directly`);
    }
    const store = code('store/shiftStore.ts');
    const writes = store.match(/setItemAsync\(\s*'active_shift_end'/g) ?? [];
    eq(writes.length, 1, 'writes in the store');
    const mirror = store.slice(store.indexOf('export function syncShiftEndMirror'));
    if (!/setItemAsync\(\s*'active_shift_end'/.test(mirror)) throw new Error('the store write is not inside syncShiftEndMirror');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log(`failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

void main();
