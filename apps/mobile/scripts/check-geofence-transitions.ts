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
} from '../lib/geofenceState';

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
interface Row { event: GeofenceEvent; stored: StoredState; notify: boolean; next: string; why: string }
const TABLE: Row[] = [
  { event: 'exit',  stored: 'unknown', notify: true,  next: 'outside', why: 'leaving is always real — the OS never synthesises an EXIT for a device that is inside' },
  { event: 'exit',  stored: 'inside',  notify: true,  next: 'outside', why: 'the ordinary breach' },
  { event: 'exit',  stored: 'outside', notify: true,  next: 'outside', why: 'duplicate exit still notifies — Phase 3 leaves EXIT behaviour unchanged by design' },
  { event: 'enter', stored: 'outside', notify: true,  next: 'inside',  why: 'THE ONLY notifying enter: follows a recorded exit' },
  { event: 'enter', stored: 'inside',  notify: false, next: 'inside',  why: 'BUG 2 — re-registration while already on post' },
  { event: 'enter', stored: 'unknown', notify: false, next: 'inside',  why: 'BUG 2 — first event of the session (clock-in on post), or a foreign record' },
];

console.log('[check-geofence-transitions] transition table');
for (const r of TABLE) {
  const d = decideTransition(r.event, r.stored);
  check(
    `${r.event.padEnd(5)} + stored=${r.stored.padEnd(7)} -> ${d.notify ? 'NOTIFY ' : 'suppress'} next=${d.nextState}  (${r.why})`,
    { notify: d.notify, nextState: d.nextState },
    { notify: r.notify, nextState: r.next },
  );
}

// Exhaustiveness: every combination above must be covered, no more, no less.
const combos = new Set<string>();
for (const e of ['enter', 'exit'] as GeofenceEvent[]) {
  for (const s of ['inside', 'outside', 'unknown'] as StoredState[]) combos.add(`${e}/${s}`);
}
for (const r of TABLE) combos.delete(`${r.event}/${r.stored}`);
if (combos.size) {
  failures++;
  console.error(`  FAIL  transition table is incomplete — missing ${Array.from(combos).join(', ')}`);
} else {
  console.log('  ok    table covers all 6 (event x stored) combinations');
}

// ── Persisted-record round trip and scoping ────────────────────────────────
console.log('[check-geofence-transitions] stored record');
check('round trip inside',  readStoredState(serializeGeofenceState(SESSION, 'inside'),  SESSION), 'inside');
check('round trip outside', readStoredState(serializeGeofenceState(SESSION, 'outside'), SESSION), 'outside');
check('record from ANOTHER session reads unknown — a new shift never inherits',
      readStoredState(serializeGeofenceState(OTHER, 'outside'), SESSION), 'unknown');
check('absent key reads unknown',            readStoredState(null, SESSION), 'unknown');
check('empty string reads unknown',          readStoredState('', SESSION), 'unknown');
check('legacy pre-Build-34 bare "inside" reads unknown (JSON.parse throws)',
      readStoredState('inside', SESSION), 'unknown');
check('legacy bare "outside" reads unknown', readStoredState('outside', SESSION), 'unknown');
check('corrupt JSON reads unknown',          readStoredState('{"sessionId":', SESSION), 'unknown');
check('JSON non-object reads unknown',       readStoredState('42', SESSION), 'unknown');
check('JSON null reads unknown',             readStoredState('null', SESSION), 'unknown');
check('right session, bogus state reads unknown',
      readStoredState(JSON.stringify({ sessionId: SESSION, state: 'sideways' }), SESSION), 'unknown');
check('missing state field reads unknown',
      readStoredState(JSON.stringify({ sessionId: SESSION }), SESSION), 'unknown');

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
  if (decideTransition('enter', stored).notify) {
    failures++;
    console.error(`  FAIL  enter with stored=${stored} notifies — the synthetic-ENTER bug is back`);
  }
}
console.log('  ok    no enter notifies without a recorded exit');

if (failures) {
  console.error(`[check-geofence-transitions] FAIL — ${failures} check(s).`);
  process.exit(1);
}
console.log(`[check-geofence-transitions] PASS — ${TABLE.length} transitions + record scoping + key legality.`);
