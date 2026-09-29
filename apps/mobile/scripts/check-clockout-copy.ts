#!/usr/bin/env ts-node
/**
 * Prove what the clock-out screen does with every response POST
 * /shifts/:id/clock-out can give it, now that a clock-out landing after the
 * session closed says "already clocked out" instead of "Clock-Out Failed /
 * Active session not found".
 *
 * WHY THIS EXISTS. Since U4b the server closes an unattended session at
 * end + 15, and since D20 an admin can close one in the past. A guard who
 * then tapped CLOCK OUT got the route's one 404 — prose only, no code — shown
 * raw, the cached session was never repaired, and every retry failed the same
 * way. The fix has to read that 404 WITHOUT reading its prose, which is only
 * safe as the narrow "ask the server" rule in lib/clockOutOutcome.ts. This
 * runs the rule against the bodies the live API sends, verbatim, plus the 409
 * SESSION_CLOSED shape the follow-up API PR will send.
 *
 * The screen itself imports react-native and cannot load under ts-node, so
 * SOURCE ASSERTIONS at the bottom pin how app/clock-out/index.tsx uses the
 * rule: it classifies, and for a 404 it refreshes BEFORE deciding.
 *
 * Run:
 *   cd apps/mobile && npm run check:clockout-copy
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { ApiError, NetworkError, GuardFacingError } from '../lib/errors';
import {
  classifyClockOutError, isConfirmedClosed, alreadyClockedOutBody, ALREADY_CLOCKED_OUT_TITLE, ClockOutFailure,
} from '../lib/clockOutOutcome';

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

/** Bodies transcribed from origin/main apps/api/src/routes/shifts.ts
 *  POST /:id/clock-out and its middleware, and from the 409 SESSION_CLOSED
 *  shape of routes/locations.ts. `apiClient` turns a non-JSON body into
 *  { error: 'HTTP <status>' }. */
const CASES: Array<[string, unknown, ClockOutFailure]> = [
  ['404 no open session (sweep, admin close, handoff, lost response)',
    new ApiError(404, { error: 'Active session not found' }), 'maybe_closed'],
  ['404 from outside the route (non-JSON)', new ApiError(404, { error: 'HTTP 404' }), 'maybe_closed'],
  ['409 SESSION_CLOSED (the follow-up API PR, and every other guard route)',
    new ApiError(409, {
      error: 'SESSION_CLOSED',
      message: 'You are already clocked out of this shift.',
      clocked_out_at: '2026-09-29T03:45:00.000Z',
    }), 'session_closed'],
  ['409 with any other code', new ApiError(409, { error: 'OPEN_SESSION_EXISTS', message: 'x' }), 'other'],
  ['409 with prose in error', new ApiError(409, { error: 'Something conflicted' }), 'other'],
  ['400 PHOTO_REJECTED', new ApiError(400, { error: 'PHOTO_REJECTED', reason: 'stale_exif', message: 'x' }), 'photo_rejected'],
  ['400 other', new ApiError(400, { error: 'Invalid body' }), 'other'],
  ['401 token expired', new ApiError(401, { error: 'Token expired' }), 'other'],
  ['403 account deactivated', new ApiError(403, { error: 'Account deactivated' }), 'other'],
  ['429 (text body)', new ApiError(429, { error: 'HTTP 429' }), 'other'],
  ['500 in-transaction catch', new ApiError(500, { error: 'Failed to clock out' }), 'other'],
  ['500 (non-JSON)', new ApiError(500, { error: 'HTTP 500' }), 'other'],
  ['network failure', new NetworkError(new TypeError('Network request failed')), 'other'],
  ['our own guard-facing error', new GuardFacingError('GPS lock failed.'), 'other'],
  ['a bug (TypeError)', new TypeError("Cannot read properties of null (reading 'id')"), 'other'],
  ['a non-Error throw', 'boom', 'other'],
  ['null', null, 'other'],
];

console.log('[check-clockout-copy]');

for (const [name, err, want] of CASES) {
  test(`classify: ${name} → ${want}`, () => eq(classifyClockOutError(err), want, name));
}

test('the classification never depends on the 404 wording', () => {
  for (const prose of ['Active session not found', 'Shift session not found', '', 'anything at all']) {
    eq(classifyClockOutError(new ApiError(404, { error: prose })), 'maybe_closed', `404 "${prose}"`);
  }
});

test('only proof, or an empty store after the refresh, confirms the session closed', () => {
  eq(isConfirmedClosed('session_closed', true), true, '409, store still holds a session');
  eq(isConfirmedClosed('session_closed', false), true, '409, store empty');
  eq(isConfirmedClosed('maybe_closed', false), true, '404, the server answered null');
  eq(isConfirmedClosed('maybe_closed', true), false, '404, refresh failed or the server still reports a session');
  eq(isConfirmedClosed('photo_rejected', false), false, 'photo rejected');
  eq(isConfirmedClosed('other', false), false, 'anything else');
});

test('the already-clocked-out copy is fixed text, names what was sent, never the server sentence', () => {
  eq(ALREADY_CLOCKED_OUT_TITLE, 'Shift Ended', 'title');
  const base = 'You are already clocked out of this shift.';
  const none  = alreadyClockedOutBody({ notes: false, photo: false });
  const notes = alreadyClockedOutBody({ notes: true,  photo: false });
  const photo = alreadyClockedOutBody({ notes: false, photo: true });
  const both  = alreadyClockedOutBody({ notes: true,  photo: true });
  eq(none, base, 'nothing sent');
  if (!notes.includes('handover notes may not have been saved') || notes.includes('photo')) throw new Error(`notes variant: ${notes}`);
  if (!photo.includes('post photo may not have been saved') || photo.includes('notes')) throw new Error(`photo variant: ${photo}`);
  if (!both.includes('handover notes and post photo may not have been saved')) throw new Error(`both variant: ${both}`);
  for (const body of [none, notes, photo, both]) {
    if (!body.startsWith(base)) throw new Error(`variant lost the base sentence: ${body}`);
    if (/not found|session|HTTP|40\d/i.test(body)) throw new Error(`copy leaks server wording: ${body}`);
    if (/has ended/i.test(body)) throw new Error('"has ended" is false for a handoff — the shift carries on under another guard');
  }
});

const raw = readFileSync(join(__dirname, '..', 'app', 'clock-out', 'index.tsx'), 'utf8');
const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const catchBody = src.slice(src.indexOf('} catch (err: any) {'), src.indexOf('} finally {'));

test('screen: the catch classifies the error once, through the shared rule', () => {
  if (!catchBody.includes('classifyClockOutError(err)')) throw new Error('catch does not call classifyClockOutError');
  if (/err\.status\s*===|err\.code\s*===/.test(catchBody)) throw new Error('catch branches on status/code directly again');
});

test('screen: a 404 refreshes BEFORE deciding, and only an empty store confirms it', () => {
  const at = catchBody.indexOf("failure === 'maybe_closed'");
  if (at < 0) throw new Error('no maybe_closed branch');
  const branch = catchBody.slice(at);
  const refresh = branch.indexOf('await useShiftStore.getState().refreshFromServer()');
  const decide  = branch.indexOf('const confirmed = isConfirmedClosed(failure, !!useShiftStore.getState().activeSession);');
  if (refresh < 0) throw new Error('the 404 branch does not await refreshFromServer');
  if (decide < 0) throw new Error('confirmed is no longer isConfirmedClosed(failure, <store has a session after the refresh>)');
  if (decide < refresh) throw new Error('the 404 is confirmed before the refresh');
});

test('screen: the copy is told what this attempt sent', () => {
  if (!catchBody.includes('alreadyClockedOutBody({ notes: notes.trim().length > 0, photo: !!url })')) {
    throw new Error('alreadyClockedOutBody no longer receives both the notes and the photo');
  }
});

test('screen: never reads the error prose', () => {
  if (src.includes('Active session not found')) throw new Error('the screen matches the 404 wording');
  if (/err\.message\s*(===|\.includes|\.match)/.test(src)) throw new Error('the screen branches on err.message');
});

test('screen: PHOTO_REJECTED keeps its retake / clock out without photo alert', () => {
  const at = catchBody.indexOf("failure === 'photo_rejected'");
  if (at < 0) throw new Error('photo branch missing');
  const photo = catchBody.slice(at, catchBody.indexOf("failure === 'session_closed'"));
  for (const s of ['Retake photo', 'Clock out without photo', 'confirmClockOut(null)']) {
    if (!photo.includes(s)) throw new Error(`photo branch lost "${s}"`);
  }
});

test('screen: the confirmed branch clears the tray and goes home; the rest keeps the old alert', () => {
  if (!/ALREADY_CLOCKED_OUT_TITLE[\s\S]*router\.replace\('\/\(tabs\)\/home'\)/.test(catchBody)) throw new Error('confirmed branch does not route home');
  if (!/if \(confirmed\) \{\s*void syncTrayAndBadge\(\)/.test(catchBody)) throw new Error('confirmed branch does not sync the tray first');
  if (!catchBody.includes("Alert.alert('Clock-Out Failed'")) throw new Error('the generic alert is gone');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
