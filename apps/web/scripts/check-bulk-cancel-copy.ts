#!/usr/bin/env ts-node
/**
 * Prove the two contracts the bulk-cancel surface rests on, by running them.
 *
 * 1. SELECTABILITY IS VERB-AWARE. PATCH /shifts/:id/cancel admits 'scheduled'
 *    and nothing else; reassign additionally admits 'active'. If row
 *    selectability stayed fixed on isReassignable, every cancel batch holding
 *    an 'active' row would carry a guaranteed 409 the UI could have
 *    prevented. That is the defect, not the button colour.
 *
 * 2. THE COPY MAP RESOLVES ON THE ENUM, NOT THE PROSE, and does so ADDITIVELY.
 *    Against the API as it was BEFORE the codes landed, cancelFailureLabel
 *    must return exactly what a status-only implementation would have shown -
 *    the server's own sentence. Against the API WITH codes it must resolve to
 *    the mapped label instead. A check that only proved one half would pass
 *    on a change that did nothing.
 *
 * Cancel is one-way and there is no un-cancel path, so "the UI offered a row
 * the route refuses" is not a cosmetic bug here.
 *
 * Run: npm run check:bulk-cancel-copy (from apps/web). Not postinstall.
 */
import { ApiError } from '../lib/adminApi';
import { admits, cancelFailureLabel, REASON_LABEL } from '../lib/bulkShiftCopy';
import type { BulkVerb } from '../lib/bulkShiftCopy';

let failures = 0;
const fail = (m: string) => { failures++; console.error(`  FAIL  ${m}`); };

// ── 1. selectability ──────────────────────────────────────────────────────
const STATUSES = ['unassigned', 'scheduled', 'active', 'completed', 'missed', 'cancelled'];
const EXPECT: Record<BulkVerb, Record<string, boolean>> = {
  assign: { unassigned: true, scheduled: true, active: true,  completed: false, missed: false, cancelled: false },
  cancel: { unassigned: true, scheduled: true, active: false, completed: false, missed: false, cancelled: false },
};
console.log('[check-bulk-cancel-copy] selectability');
for (const verb of ['assign', 'cancel'] as BulkVerb[]) {
  const row = STATUSES.map((st) => {
    const got = admits(verb, st);
    const want = EXPECT[verb][st];
    if (got !== want) fail(`admits('${verb}','${st}') -> ${got}, expected ${want}`);
    return `${st}=${got ? 'Y' : 'n'}`;
  });
  console.log(`  ${verb.padEnd(8)} ${row.join('  ')}`);
}
// The one that matters, called out so a future edit cannot quietly flip it.
//
// CANCEL IS A STRICT SUBSET OF ASSIGN, and 'active' is the single status they
// disagree on. That is the whole content of the distinction now: an in-progress
// shift can have its guard changed, and cannot be cancelled while somebody is
// clocked in on it.
//
// This callout previously read "reassign must NOT admit 'unassigned' - no
// guard to move". That was correct when the verb was REASSIGN and is exactly
// the case the ASSIGN verb exists to enable, so it is rewritten rather than
// flipped - a check whose rationale has expired is worse than no check,
// because the message is what the next reader believes.
if (admits('assign', 'active') !== true)  fail("assign must admit 'active' - an in-progress shift can change hands");
if (admits('cancel', 'active') !== false) fail("cancel must NOT admit 'active' - the route 409s it");

// The subset relation itself, asserted rather than assumed: every status
// cancel admits, assign must admit too. If that stops holding, the per-row
// routing and the selection pruning on verb switch both need revisiting.
for (const st of STATUSES) {
  if (admits('cancel', st) && !admits('assign', st)) {
    fail(`cancel admits '${st}' but assign does not - subset relation broken`);
  }
}

// ── 2. copy map, both halves ──────────────────────────────────────────────
const mk = (status: number, body: Record<string, unknown>) =>
  new ApiError(String(body.error ?? `Request failed: ${status}`), status, body);

/** Bodies the route emitted BEFORE the codes landed. */
const BEFORE: { label: string; err: ApiError; prose: string }[] = [
  { label: 'active',    prose: 'This shift is in progress (guard clocked in). Cancel is not allowed.',
    err: mk(409, { error: 'This shift is in progress (guard clocked in). Cancel is not allowed.' }) },
  { label: 'completed', prose: 'This shift has already completed and cannot be cancelled.',
    err: mk(409, { error: 'This shift has already completed and cannot be cancelled.' }) },
  { label: 'missed',    prose: 'This shift was already marked missed.',
    err: mk(409, { error: 'This shift was already marked missed.' }) },
  { label: 'cancelled', prose: 'This shift is already cancelled.',
    err: mk(409, { error: 'This shift is already cancelled.' }) },
  // HISTORICAL, and deliberately kept. The route no longer emits this: the
  // switch now ADMITS 'unassigned', so this sentence is unreachable for that
  // status and the `default` branch it came from is unreachable for every
  // status shifts_status_check allows. The fixture stays because what it
  // proves is the no-`code` path — an old body must still echo verbatim —
  // and that path is exercised by any 409 predating the codes. Do not
  // re-label it as current behaviour.
  { label: 'default (historical - route now admits unassigned)',
    prose: "Shift status 'unassigned' cannot be cancelled.",
    err: mk(409, { error: "Shift status 'unassigned' cannot be cancelled." }) },
  { label: '400 reason too long', prose: 'reason must be at most 200 characters',
    err: mk(400, { error: 'reason must be at most 200 characters' }) },
];

console.log('[check-bulk-cancel-copy] pre-codes API: must echo the server sentence');
for (const c of BEFORE) {
  const got = cancelFailureLabel(c.err);
  if (got !== c.prose) fail(`${c.label}: got ${JSON.stringify(got)}, expected the server sentence`);
}
console.log(`  ${BEFORE.length}/${BEFORE.length} unchanged`);

/** Bodies the route emits NOW. `error` keeps its prose; `code` is new. */
const AFTER: { label: string; err: ApiError; want: string }[] = [
  { label: 'SHIFT_HAS_OPEN_SESSION', want: REASON_LABEL.SHIFT_HAS_OPEN_SESSION,
    err: mk(409, { code: 'SHIFT_HAS_OPEN_SESSION', error: 'SHIFT_HAS_OPEN_SESSION',
                   message: 'A guard is still clocked in on this shift.' }) },
  { label: "SHIFT_NOT_SCHEDULED (active)", want: REASON_LABEL.SHIFT_NOT_SCHEDULED,
    err: mk(409, { code: 'SHIFT_NOT_SCHEDULED', shift_status: 'active',
                   error: 'This shift is in progress (guard clocked in). Cancel is not allowed.',
                   message: 'This shift is in progress (guard clocked in). Cancel is not allowed.' }) },
  { label: "SHIFT_NOT_SCHEDULED (completed)", want: REASON_LABEL.SHIFT_NOT_SCHEDULED,
    err: mk(409, { code: 'SHIFT_NOT_SCHEDULED', shift_status: 'completed',
                   error: 'This shift has already completed and cannot be cancelled.',
                   message: 'This shift has already completed and cannot be cancelled.' }) },
  { label: 'ALREADY_CANCELLED', want: REASON_LABEL.ALREADY_CANCELLED,
    err: mk(409, { code: 'ALREADY_CANCELLED', shift_status: 'cancelled',
                   error: 'This shift is already cancelled.',
                   message: 'This shift is already cancelled.' }) },
];

console.log('[check-bulk-cancel-copy] post-codes API: must resolve by enum');
let changed = 0;
for (const c of AFTER) {
  const got = cancelFailureLabel(c.err);
  if (got !== c.want) { fail(`${c.label}: got ${JSON.stringify(got)}, expected ${JSON.stringify(c.want)}`); continue; }
  if (got !== c.err.message) changed++;
  console.log(`  ${got === c.err.message ? 'same   ' : 'CHANGED'}  ${c.label} -> ${JSON.stringify(got)}`);
}
if (changed !== AFTER.length) {
  fail(`expected all ${AFTER.length} coded bodies to read differently from the raw sentence, got ${changed}`);
}

// 404 carries no code on this route; status alone is the discriminator.
if (cancelFailureLabel(mk(404, { error: 'Shift not found' })) !== 'No longer exists') {
  fail('404 should map to "No longer exists"');
}
// A transport failure is not an ApiError and must not be mistaken for one.
if (cancelFailureLabel(new TypeError('boom')) !== 'Could not cancel') {
  fail('non-ApiError should fall back to the generic label');
}

if (failures > 0) {
  console.error(`\n[check-bulk-cancel-copy] FAIL - ${failures} assertion(s).`);
  process.exit(1);
}
console.log('\n[check-bulk-cancel-copy] PASS - selectability verb-aware; copy additive pre-codes, enum-resolved after.');
