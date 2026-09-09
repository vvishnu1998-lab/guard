/**
 * Tests for the ping-interval picker validator
 * (services/pingIntervalPicker.ts).
 *
 * The route is STRICTER than the column: sites.ping_interval_minutes permits
 * 5..240 and this validator admits only {15, 30, 45}. So the interesting
 * assertions are not the malformed inputs — they are 5 and 240, which are
 * perfectly legal COLUMN values and must still be refused by the ROUTE.
 * A test that only covered garbage would pass while the picker boundary
 * silently disappeared.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/services/_pingIntervalPicker.test.ts
 */
import assert from 'node:assert';
import {
  validatePingInterval,
  normalizeReason,
  PING_INTERVAL_PICKER_MINUTES,
  MAX_REASON_LEN,
} from './pingIntervalPicker';

let n = 0;
const ok = (label: string) => { n += 1; console.log(`  ok ${String(n).padStart(2)}  ${label}`); };

console.log(`\npicker set = {${PING_INTERVAL_PICKER_MINUTES.join(', ')}}   column permits 5..240\n`);

// ── ACCEPTED — the picker set, and nothing else ──────────────────────────
for (const v of [15, 30, 45]) {
  const r = validatePingInterval(v);
  assert.strictEqual(r.ok, true, `${v} must be accepted`);
  assert.strictEqual((r as { ok: true; value: number }).value, v, `${v} must round-trip`);
}
ok('15 / 30 / 45 accepted, value round-trips');

// ── REJECTED — every case named in the dispatch ──────────────────────────
const REJECT: Array<[string, unknown]> = [
  ['40 (integer, outside the picker set)', 40],
  ['0',                                     0],
  ['-1',                                   -1],
  ['5 (LEGAL COLUMN VALUE, refused by the route)',   5],
  ['240 (LEGAL COLUMN VALUE, refused by the route)', 240],
  ['null',                                 null],
  ['"30" (string)',                        '30'],
  ['30.5 (non-integer)',                   30.5],
  ['undefined (absent)',                   undefined],
];
for (const [label, v] of REJECT) {
  const r = validatePingInterval(v);
  assert.strictEqual(r.ok, false, `${label} must be REJECTED`);
  assert.ok(
    typeof (r as { ok: false; error: string }).error === 'string'
      && (r as { ok: false; error: string }).error.length > 0,
    `${label} must carry a named error, not a bare false`,
  );
}
ok(`rejected: ${REJECT.length} cases, each with a named 400 message`);

// The two that matter most, asserted individually so a regression names them.
assert.strictEqual(validatePingInterval(5).ok,   false, '5 is a legal column value and must still be refused');
assert.strictEqual(validatePingInterval(240).ok, false, '240 is a legal column value and must still be refused');
ok('the route boundary is narrower than the column boundary');

// ── never throws, on anything ────────────────────────────────────────────
for (const v of [NaN, Infinity, -Infinity, {}, [], [30], true, false, () => 30, Symbol('30'), 30n]) {
  const r = validatePingInterval(v as unknown);
  assert.strictEqual(r.ok, false, `${String(v)} must be rejected without throwing`);
}
ok('hostile / exotic inputs rejected, never thrown');

// ── reason normalisation ─────────────────────────────────────────────────
assert.strictEqual(normalizeReason(undefined), null);
assert.strictEqual(normalizeReason(null), null);
assert.strictEqual(normalizeReason(42), null);
assert.strictEqual(normalizeReason(''), null,     'empty string -> null, never an empty column value');
assert.strictEqual(normalizeReason('   '), null,  'whitespace-only -> null');
assert.strictEqual(normalizeReason('  client asked  '), 'client asked', 'trimmed');
assert.strictEqual(normalizeReason('x'.repeat(MAX_REASON_LEN + 50))!.length, MAX_REASON_LEN, 'length-capped');
ok('reason: trimmed, blank -> null, length-capped');

console.log(`\nPASS — ${n} groups, all assertions held.\n`);
