#!/usr/bin/env ts-node
/**
 * Prove T6a (U3): the background geofence task un-suppresses an event past the
 * stored shift end ONLY when the server shows the same session with a later
 * end — and suppresses, exactly as before, in every other case.
 *
 * WHY THIS EXISTS. After an admin extends an active shift (D20), a suspended
 * or killed app never runs the JS that rewrites 'active_shift_end', so the
 * task's local gate would silence every breach from old end + grace on a
 * session the server still has open. The task now asks once. Getting the
 * decision wrong in the permissive direction would re-open the stale-alert
 * bug the gate exists for (2026-08-06: two "left the radius" alerts after a
 * shift ended); getting it wrong the other way keeps real breaches silent.
 * Both directions are pinned here.
 *
 * tasks/locationBackground.ts registers a TaskManager task at import and
 * cannot load under ts-node, so SOURCE ASSERTIONS pin how it uses the rule:
 * only inside the suppress branch, before `return`, and nowhere on the normal
 * path.
 *
 * Run:
 *   cd apps/mobile && npm run check:past-expiry-recheck
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  decidePastExpiryRecheck, RecheckResponse, RECHECK_TIMEOUT_MS, RECHECK_LATE_AFTER_MS,
} from '../lib/pastExpiryRecheck';
import { SHIFT_EXPIRY_GRACE_MS } from '../lib/shiftExpiry';

let passed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
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

const MIN = 60_000;
const SESSION = 'sess-1';
const START   = '2026-09-29T02:30:00.000Z';    // 19:30 PT
const OLD_END = '2026-09-29T03:30:00.000Z';    // 20:30 PT
const NOW     = Date.parse(OLD_END) + SHIFT_EXPIRY_GRACE_MS + 5 * MIN;   // old end + grace + 5
const later   = (min: number) => new Date(NOW + min * MIN).toISOString();

/** The live GET /shifts/active-session body shape (origin/main shifts.ts). */
const body = (over: { sessionId?: unknown; start?: unknown; end?: unknown } = {}) => ({
  shift: {
    id: 'shift-1', site_id: 'site-1', site_name: 'SFMTA',
    scheduled_start: 'start' in over ? over.start : START,
    scheduled_end:   'end' in over ? over.end : later(60),
    geofence: { center_lat: 37.7, center_lng: -122.4, radius_meters: 100, polygon_coordinates: null },
  },
  session: { id: 'sessionId' in over ? over.sessionId : SESSION, shift_id: 'shift-1', clocked_in_at: START },
  current_break: null,
});
const ok = (b: unknown, status = 200): RecheckResponse => ({ ok: true, status, body: b });
/** A prompt answer: asked 800 ms before it is handled. */
const decide = (r: RecheckResponse) => decidePastExpiryRecheck(r, SESSION, NOW - 800, NOW);

console.log('[check-past-expiry-recheck]');

test('extended: same session, later end → report the event, with the new end', () => {
  const end = later(60);
  eq(decide(ok(body({ end }))), { kind: 'extended', scheduledEnd: end }, 'extended');
});
test('an extension that is itself past expiry still suppresses', () => {
  eq(decide(ok(body({ end: OLD_END }))), { kind: 'suppress', reason: 'still_past' }, 'unchanged end');
  eq(decide(ok(body({ end: new Date(NOW - SHIFT_EXPIRY_GRACE_MS - 1).toISOString() }))),
    { kind: 'suppress', reason: 'still_past' }, 'end just past grace');
});
test('an end still inside its grace un-suppresses (the gate would notify too)', () => {
  const end = new Date(NOW - SHIFT_EXPIRY_GRACE_MS + MIN).toISOString();
  eq(decide(ok(body({ end }))).kind, 'extended', 'inside grace');
});
test('closed (null) → suppress, and the region is not disarmed from here', () => {
  eq(decide(ok(null)), { kind: 'suppress', reason: 'no_session' }, 'null');
});
test('another session (handoff, new shift) → suppress', () => {
  eq(decide(ok(body({ sessionId: 'sess-2' }))), { kind: 'suppress', reason: 'different_session' }, 'other session');
  eq(decide(ok(body({ sessionId: undefined }))), { kind: 'suppress', reason: 'different_session' }, 'no session id');
});
test('offline, timeout, no API URL → suppress', () => {
  eq(decide({ ok: false }), { kind: 'suppress', reason: 'fetch_failed' }, 'fetch failed');
});
test('any non-200 (401 expired token, 403, 429, 500, 503) → suppress', () => {
  for (const s of [401, 403, 404, 429, 500, 503]) {
    eq(decide(ok(body(), s)), { kind: 'suppress', reason: 'http_status' }, `HTTP ${s}`);
  }
});
test('a malformed body or window → suppress', () => {
  eq(decide(ok(undefined)), { kind: 'suppress', reason: 'unparseable' }, 'unparseable JSON');
  eq(decide(ok('null')), { kind: 'suppress', reason: 'unparseable' }, 'a string');
  eq(decide(ok(body({ end: 'garbage' }))), { kind: 'suppress', reason: 'unparseable' }, 'bad end');
  eq(decide(ok(body({ end: 1759120000000 }))), { kind: 'suppress', reason: 'unparseable' }, 'numeric end');
  eq(decide(ok(body({ start: later(90) }))), { kind: 'suppress', reason: 'unparseable' }, 'end before start');
  eq(decide(ok({ session: { id: SESSION } })), { kind: 'suppress', reason: 'unparseable' }, 'no shift');
});
test('the timeout leaves room for the violation POST', () => {
  if (!(RECHECK_TIMEOUT_MS > 0 && RECHECK_TIMEOUT_MS <= 5_000)) throw new Error(`RECHECK_TIMEOUT_MS = ${RECHECK_TIMEOUT_MS}`);
});
test('an answer handled late is no answer, whatever it says (Android resume, iOS suspension)', () => {
  const end = later(60);
  const good = ok(body({ end }));
  eq(decidePastExpiryRecheck(good, SESSION, NOW - RECHECK_LATE_AFTER_MS, NOW).kind, 'extended', 'exactly at the limit');
  eq(decidePastExpiryRecheck(good, SESSION, NOW - RECHECK_LATE_AFTER_MS - 1, NOW),
    { kind: 'suppress', reason: 'late' }, 'just past the limit');
  eq(decidePastExpiryRecheck(good, SESSION, NOW - 50 * MIN, NOW),
    { kind: 'suppress', reason: 'late' }, 'handled 50 minutes after the request (the resume replay)');
  eq(decidePastExpiryRecheck(good, SESSION, NaN, NOW), { kind: 'suppress', reason: 'late' }, 'unknown ask time');
  if (!(RECHECK_LATE_AFTER_MS > RECHECK_TIMEOUT_MS && RECHECK_LATE_AFTER_MS <= RECHECK_TIMEOUT_MS + 5_000)) {
    throw new Error(`RECHECK_LATE_AFTER_MS = ${RECHECK_LATE_AFTER_MS}`);
  }
});

const raw = readFileSync(join(__dirname, '..', 'tasks', 'locationBackground.ts'), 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('task: the re-check runs only inside the past-expiry branch', () => {
  const gate = src.indexOf('if (isPastShiftExpiry(shiftEnd, Date.now())) {');
  if (gate < 0) throw new Error('gate not found');
  const calls = [...src.matchAll(/recheckPastExpiry\(sessionId, accessToken\)/g)].map((m) => m.index ?? -1);
  eq(calls.length, 1, 'recheck call sites');
  const breakQuiet = src.indexOf('const onBreak = await isBreakActive()');
  if (!(calls[0] > gate && calls[0] < breakQuiet)) throw new Error('the re-check is outside the gate');
});
test('task: only "extended" falls through; everything else still returns', () => {
  const gate = src.indexOf('if (isPastShiftExpiry(shiftEnd, Date.now())) {');
  const block = src.slice(gate, src.indexOf('const onBreak = await isBreakActive()'));
  if (!/if \(verdict\.kind === 'extended'\) \{/.test(block)) throw new Error('no extended branch');
  const elseAt = block.indexOf('} else {');
  if (elseAt < 0 || !/return;\s*\}\s*\}\s*$/.test(block.slice(elseAt).trimEnd())) {
    throw new Error('the suppress branch no longer returns');
  }
  const extended = block.slice(0, elseAt);
  if (/return;/.test(extended.slice(extended.indexOf("'extended'")))) throw new Error('the extended branch returns');
  if (!/setItemAsync\('active_shift_end', verdict\.scheduledEnd/.test(extended)) {
    throw new Error('the extended branch does not persist the server end');
  }
});
test('task: the re-check is a timer-free XMLHttpRequest with a native timeout, never apiClient or fetch', () => {
  if (/from '\.\.\/lib\/apiClient'/.test(src)) throw new Error('the task imports apiClient (401 → refresh → logout)');
  const req = src.slice(src.indexOf('function getActiveSession'), src.indexOf('async function recheckPastExpiry'));
  for (const s of ['new XMLHttpRequest()', '/api/shifts/active-session', 'xhr.timeout = RECHECK_TIMEOUT_MS;',
                   'xhr.onload', 'xhr.onerror', 'xhr.ontimeout', 'xhr.onabort', 'xhr.send()']) {
    if (!req.includes(s)) throw new Error(`getActiveSession lost "${s}"`);
  }
  // Anything timer-driven would not settle while an Android app is in the background.
  for (const banned of ['fetch(', 'setTimeout', 'AbortController', 'setInterval']) {
    if (req.includes(banned)) throw new Error(`getActiveSession uses ${banned}`);
  }
  const fn = src.slice(src.indexOf('async function recheckPastExpiry'), src.indexOf('export const GEOFENCE_TASK'));
  if (!/const askedAt = Date\.now\(\);[\s\S]*getActiveSession\([\s\S]*decidePastExpiryRecheck\(res, sessionId, askedAt, Date\.now\(\)\)/.test(fn)) {
    throw new Error('recheckPastExpiry no longer stamps the ask time before the request and judges lateness after it');
  }
});
test('task: the normal breach path still alerts before any network call', () => {
  const exitAt = src.indexOf('if (isExit) {');
  const exit = src.slice(exitAt);
  const alert = exit.indexOf("title: 'Outside post boundary'");
  const post  = exit.indexOf('/api/locations/violation');
  if (alert < 0 || post < 0 || alert > post) throw new Error('the local alert no longer precedes the violation POST');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
