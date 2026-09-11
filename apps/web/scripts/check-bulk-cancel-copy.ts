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
  reassign: { unassigned: false, scheduled: true, active: true,  completed: false, missed: false, cancelled: false },
  cancel:   { unassigned: false, scheduled: true, active: false, completed: false, missed: false, cancelled: false },
};
console.log('[check-bulk-cancel-copy] selectability');
for (const verb of ['reassign', 'cancel'] as BulkVerb[]) {
  const row = STATUSES.map((st) => {
    const got = admits(verb, st);
    const want = EXPECT[verb][st];
    if (got !== want) fail(`admits('${verb}','${st}') -> ${got}, expected ${want}`);
    return `${st}=${got ? 'Y' : 'n'}`;
  });
  console.log(`  ${verb.padEnd(8)} ${row.join('  ')}`);
}
// The one that matters, called out so a future edit cannot quietly flip it.
if (admits('reassign', 'active') !== true)  fail("reassign must admit 'active'");
if (admits('cancel', 'active')   !== false) fail("cancel must NOT admit 'active' - the route 409s it");

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
  { label: 'default',   prose: "Shift status 'unassigned' cannot be cancelled.",
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
