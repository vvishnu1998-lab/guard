#!/usr/bin/env ts-node
/**
 * Prove lib/geofenceState.ts's transition table, and the round-trip of the
 * persisted record, over every combination that reaches it.
 *
 * WHY THIS EXISTS. The whole of Bug 2's fix is one boolean: does this ENTER
 * notify? Getting it wrong in either direction is silent on a device —
 *
 *   too eager  — the original bug: "Back on post" on every foreground and
 *                every relaunch, at a guard who never moved.
 *   too quiet  — a genuine return to post goes unacknowledged, and the guard
 *                has no confirmation the app noticed they came back.
 *
 * Neither shows up in a typecheck and neither throws. The table is small
 * enough to enumerate exhaustively, so it is enumerated.
 *
 * ts-node, matching check-respond-copy.ts and check-tray-predicate.ts.
 * lib/geofenceState.ts imports nothing from React Native precisely so this
 * can run on a laptop. NOT wired to postinstall — ts-node is not guaranteed
 * inside an EAS build. Run via `npm run check:geofence-transitions`.
 */
import {
  decideTransition,
  readStoredState,
  serializeGeofenceState,
  GEOFENCE_STATE_KEY,
  GeofenceEvent,
  StoredState,
  StoredSnapshot,
} from '../lib/geofenceState';

/** Build a snapshot without going through JSON, for table rows. */
function snap(state: StoredState, reported = false): StoredSnapshot {
  return { state, reported };
}

const SESSION = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
const OTHER   = '00000000-0000-0000-0000-000000000000';

let failures = 0;
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) {
    failures++;
    console.error(`  FAIL  ${label}\n        want ${JSON.stringify(want)}\n        got  ${JSON.stringify(got)}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

// ── The full transition table: 3 stored states x 2 events ──────────────────
interface Row {
  event:    GeofenceEvent;
  stored:   StoredState;
  reported: boolean;
  notify:   boolean;
  next:     string;
  why:      string;
}
const TABLE: Row[] = [
  { event: 'exit',  stored: 'outside', reported: true,  notify: false, next: 'outside', why: 'PHASE 3b — duplicate exit from a re-registration; the server already has this breach' },
  { event: 'exit',  stored: 'outside', reported: false, notify: true,  next: 'outside', why: 'PHASE 3b — the first POST never landed (dead zone); retry it rather than drop the violation' },
  { event: 'exit',  stored: 'inside',  reported: false, notify: true,  next: 'outside', why: 'the ordinary breach' },
  { event: 'exit',  stored: 'unknown', reported: false, notify: true,  next: 'outside', why: 'first event of the session; assume real' },
  { event: 'enter', stored: 'outside', reported: true,  notify: true,  next: 'inside',  why: 'genuine re-entry after a reported exit' },
  { event: 'enter', stored: 'outside', reported: false, notify: true,  next: 'inside',  why: 'genuine re-entry — reported is irrelevant on the enter side' },
  { event: 'enter', stored: 'inside',  reported: false, notify: false, next: 'inside',  why: 'BUG 2 — re-registration while already on post' },
  { event: 'enter', stored: 'unknown', reported: false, notify: false, next: 'inside',  why: 'BUG 2 — first event of the session (clock-in on post), or a foreign record' },
];

console.log('[check-geofence-transitions] transition table');
for (const r of TABLE) {
  const d = decideTransition(r.event, snap(r.stored, r.reported));
  check(
    `${r.event.padEnd(5)} + stored=${r.stored.padEnd(7)} reported=${String(r.reported).padEnd(5)} -> ${d.notify ? 'NOTIFY ' : 'suppress'} next=${d.nextState}  (${r.why})`,
    { notify: d.notify, nextState: d.nextState },
    { notify: r.notify, nextState: r.next },
  );
}

// Exhaustiveness: every combination above must be covered, no more, no less.
// Only 'outside' can be reported, so the meaningful space is
// 2 events x (inside, unknown, outside-unreported, outside-reported) = 8.
const combos = new Set<string>();
for (const e of ['enter', 'exit'] as GeofenceEvent[]) {
  combos.add(`${e}/inside/false`);
  combos.add(`${e}/unknown/false`);
  combos.add(`${e}/outside/false`);
  combos.add(`${e}/outside/true`);
}
for (const r of TABLE) combos.delete(`${r.event}/${r.stored}/${r.reported}`);
if (combos.size) {
  failures++;
  console.error(`  FAIL  transition table is incomplete — missing ${Array.from(combos).join(', ')}`);
} else {
  console.log('  ok    table covers all 8 (event x stored x reported) combinations');
}

// ── Persisted-record round trip and scoping ────────────────────────────────
console.log('[check-geofence-transitions] stored record');
const U = { state: 'unknown', reported: false };
check('round trip inside',            readStoredState(serializeGeofenceState(SESSION, 'inside',  false), SESSION), { state: 'inside',  reported: false });
check('round trip outside unreported',readStoredState(serializeGeofenceState(SESSION, 'outside', false), SESSION), { state: 'outside', reported: false });
check('round trip outside REPORTED',  readStoredState(serializeGeofenceState(SESSION, 'outside', true),  SESSION), { state: 'outside', reported: true });
check('record from ANOTHER session reads unknown — a new shift never inherits',
      readStoredState(serializeGeofenceState(OTHER, 'outside', true), SESSION), U);
check('absent key reads unknown',            readStoredState(null, SESSION), U);
check('empty string reads unknown',          readStoredState('', SESSION), U);
check('legacy pre-Build-34 bare "inside" reads unknown (JSON.parse throws)',
      readStoredState('inside', SESSION), U);
check('legacy bare "outside" reads unknown', readStoredState('outside', SESSION), U);
check('corrupt JSON reads unknown',          readStoredState('{"sessionId":', SESSION), U);
check('JSON non-object reads unknown',       readStoredState('42', SESSION), U);
check('JSON null reads unknown',             readStoredState('null', SESSION), U);
check('right session, bogus state reads unknown',
      readStoredState(JSON.stringify({ sessionId: SESSION, state: 'sideways' }), SESSION), U);
check('missing state field reads unknown',
      readStoredState(JSON.stringify({ sessionId: SESSION }), SESSION), U);
check('PHASE 3 record with NO reported field reads reported=false — an upgrade re-reports rather than swallowing',
      readStoredState(JSON.stringify({ sessionId: SESSION, state: 'outside' }), SESSION), { state: 'outside', reported: false });
check('non-boolean reported reads false',
      readStoredState(JSON.stringify({ sessionId: SESSION, state: 'outside', reported: 'yes' }), SESSION), { state: 'outside', reported: false });

// ── The key itself must be writable by SecureStore ─────────────────────────
// Keys may contain only alphanumerics, '.', '-' and '_' (SecureStore.js:148).
// A `geofence_state:<uuid>` scheme would throw at runtime, on a background
// task, where nobody would see it.
if (!/^[A-Za-z0-9._-]+$/.test(GEOFENCE_STATE_KEY)) {
  failures++;
  console.error(`  FAIL  GEOFENCE_STATE_KEY ${JSON.stringify(GEOFENCE_STATE_KEY)} is not a legal SecureStore key`);
} else {
  console.log(`  ok    GEOFENCE_STATE_KEY ${JSON.stringify(GEOFENCE_STATE_KEY)} is a legal SecureStore key`);
}

// ── The property the whole fix rests on ────────────────────────────────────
// A re-registration replays the position the device is already in. Whatever
// that position is, replaying it must never notify on the enter side.
for (const stored of ['inside', 'unknown'] as StoredState[]) {
  if (decideTransition('enter', snap(stored)).notify) {
    failures++;
    console.error(`  FAIL  enter with stored=${stored} notifies — the synthetic-ENTER bug is back`);
  }
}
console.log('  ok    no enter notifies without a recorded exit');

// Phase 3b's own invariant: suppressing an exit must NEVER lose a violation.
// An unreported 'outside' has to keep re-POSTing until the server confirms.
if (!decideTransition('exit', snap('outside', false)).notify) {
  failures++;
  console.error('  FAIL  an UNREPORTED exit is being suppressed — the violation would be lost');
} else {
  console.log('  ok    an unreported exit always retries');
}
if (decideTransition('exit', snap('outside', true)).notify) {
  failures++;
  console.error('  FAIL  a reported duplicate exit still notifies — Phase 3b is not in effect');
} else {
  console.log('  ok    a reported duplicate exit is suppressed');
}

if (failures) {
  console.error(`[check-geofence-transitions] FAIL — ${failures} check(s).`);
  process.exit(1);
}
console.log(`[check-geofence-transitions] PASS — ${TABLE.length} transitions + record scoping + key legality + 3b no-loss invariant.`);
