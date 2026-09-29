/**
 * Tests for mock-location enforcement and the per-guard exemption
 * (services/mockLocation.ts).
 *
 * THE POINT OF THIS FILE IS THE FAIL-OPEN REGRESSION, not the happy path.
 *
 * checkMockLocation wraps its whole body in a catch that returns
 * { reject: false }. That is correct for its original scope — a telemetry or
 * config failure must never deny a guard at shift start — but it means a throw
 * raised ANYWHERE inside that try silently exempts EVERY guard on EVERY tenant
 * at once, STARNET included. No error surfaces; writes simply stop being
 * refused. So the exemption parser must be incapable of throwing, and the
 * assertions below feed it every malformed value that might tempt it to:
 * empty, whitespace-only, comma-only, trailing comma, padded entries, mixed
 * case, and a 500-entry list. In each case a guard NOT on the list must still
 * be rejected. A test that only proved the exemption works would miss the
 * failure mode that matters.
 *
 * The second property under test is that the shadow path is untouched. The
 * exemption is gated on `reject` rather than on mode, so in shadow mode the
 * branch is skipped entirely — mock.reject still prints with enforced=false
 * and mock.exempt never appears. That is asserted on the log lines, not just
 * on the return value, because the return value is identical either way.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/services/_mockLocation.test.ts
 */
import assert from 'node:assert';
import { checkMockLocation, mockEnforcementMode } from './mockLocation';

const MODE_VAR = 'MOCK_LOCATION_ENFORCEMENT';
const LIST_VAR = 'MOCK_LOCATION_EXEMPT_GUARD_IDS';

/** The reviewer account this exemption exists for. */
const LISTED = 'e555a9b2-509b-41b2-b5f8-1d2e7d0cb946';
/** Any other guard. Must never be exempted by any input in this file. */
const OTHER = '11111111-2222-3333-4444-555555555555';

// Snapshot the ambient environment once, restore after every case, and assert
// at the end that nothing leaked. A test that mutates process.env and leaves it
// mutated would silently change the behaviour of anything imported later.
const ORIGINAL_MODE = process.env[MODE_VAR];
const ORIGINAL_LIST = process.env[LIST_VAR];

function setVar(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

interface Outcome {
  reject: boolean;
  verdict: 'mocked' | 'clean' | 'unknown';
  logs: string[];
}

/**
 * Run one check with the given environment, capturing whatever it logs, and
 * restore the environment afterwards no matter what the call did.
 */
function check(
  mode: string | undefined,
  list: string | undefined,
  mocked: boolean | null,
  guardId?: string,
): Outcome {
  setVar(MODE_VAR, mode);
  setVar(LIST_VAR, list);

  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
  try {
    const r = checkMockLocation(mocked, 'clock-in', { guardId, siteId: 'site-1' });
    return { reject: r.reject, verdict: r.verdict, logs };
  } finally {
    console.log = realLog;
    setVar(MODE_VAR, ORIGINAL_MODE);
    setVar(LIST_VAR, ORIGINAL_LIST);
  }
}

const has = (logs: string[], token: string): boolean => logs.some((l) => l.includes(token));

let n = 0;
const ok = (label: string) => { n += 1; console.log(`  ok ${String(n).padStart(2)}  ${label}`); };

console.log(`\nlisted = ${LISTED}\nother  = ${OTHER}\n`);

// ── 1. THE FOUR PRE-EXISTING TUPLES, LIST UNSET ──────────────────────────
// The contract before the exemption existed. With no list set, every one of
// these must behave exactly as it did.
for (const mocked of [true, false, null] as const) {
  const r = check('off', undefined, mocked, LISTED);
  assert.strictEqual(r.reject, false, `off + ${String(mocked)} must not reject`);
  assert.strictEqual(r.logs.length, 0, 'off mode logs nothing');
}
assert.strictEqual(check('off', undefined, true, LISTED).verdict, 'mocked');
assert.strictEqual(check('off', undefined, false, LISTED).verdict, 'clean');
assert.strictEqual(check('off', undefined, null, LISTED).verdict, 'unknown');
ok('off + true/false/null        -> reject=false, no log');

for (const mode of ['shadow', 'on'] as const) {
  const clean = check(mode, undefined, false, LISTED);
  assert.strictEqual(clean.reject, false, `${mode} + clean must not reject`);
  assert.strictEqual(clean.verdict, 'clean');
  assert.strictEqual(clean.logs.length, 0, 'non-mocked verdict returns before any log');

  const unknown = check(mode, undefined, null, LISTED);
  assert.strictEqual(unknown.reject, false, `${mode} + null must not reject`);
  assert.strictEqual(unknown.verdict, 'unknown');
  assert.strictEqual(unknown.logs.length, 0);
}
ok('shadow|on + false/null       -> reject=false, no log');

{
  const r = check('shadow', undefined, true, LISTED);
  assert.strictEqual(r.reject, false, 'shadow never rejects');
  assert.strictEqual(r.verdict, 'mocked');
  assert.ok(has(r.logs, 'mock.reject'), 'shadow still emits mock.reject');
  assert.ok(has(r.logs, 'enforced=false'), 'shadow records enforced=false');
}
ok('shadow + mocked              -> reject=false, mock.reject enforced=false');

{
  const r = check('on', undefined, true, LISTED);
  assert.strictEqual(r.reject, true, 'on + mocked rejects when no list is set');
  assert.strictEqual(r.verdict, 'mocked');
  assert.ok(has(r.logs, 'mock.reject'), 'on emits mock.reject');
  assert.ok(has(r.logs, 'enforced=true'), 'on records enforced=true');
}
ok('on + mocked, list unset      -> reject=true  (unchanged baseline)');

// Unrecognised mode values all collapse to 'off', including the empty string
// and anything with stray whitespace or casing.
for (const bad of ['', '   ', 'ON ', 'Shadow', 'garbage', 'true', '1']) {
  setVar(MODE_VAR, bad);
  const m = mockEnforcementMode();
  assert.ok(m === 'off' || m === 'on' || m === 'shadow', `mode parse returned ${m}`);
  setVar(MODE_VAR, ORIGINAL_MODE);
}
assert.strictEqual(check('garbage', LISTED, true, LISTED).reject, false, 'unknown mode is off');
ok('mode parsing                 -> unrecognised values collapse to off');

// ── 2. THE EXEMPTION ─────────────────────────────────────────────────────
{
  const r = check('on', LISTED, true, LISTED);
  assert.strictEqual(r.reject, false, 'listed guard is not rejected');
  assert.strictEqual(r.verdict, 'mocked', 'verdict stays mocked so the spoof is auditable');
  assert.ok(has(r.logs, 'mock.exempt'), 'exemption emits mock.exempt');
  assert.ok(has(r.logs, 'reason=guard_exempt'), 'log carries the reason token');
  assert.ok(has(r.logs, 'enforced=false'), 'log records enforced=false');
  assert.ok(has(r.logs, LISTED), 'log names the guard');
  assert.ok(!has(r.logs, 'mock.reject'), 'exempted write does not also log mock.reject');
  assert.strictEqual(r.logs.length, 1, 'exactly one log line');
}
ok('on + mocked + IN list        -> reject=false, verdict=mocked, one mock.exempt');

{
  const r = check('on', OTHER, true, LISTED);
  assert.strictEqual(r.reject, true, 'a list naming someone else does not exempt this guard');
  assert.ok(has(r.logs, 'mock.reject'), 'non-exempt still logs mock.reject');
  assert.ok(!has(r.logs, 'mock.exempt'));
}
ok('on + mocked + NOT in list    -> reject=true');

{
  const r = check('on', LISTED, true, undefined);
  assert.strictEqual(r.reject, true, 'absent guardId is never exempt');
  assert.ok(!has(r.logs, 'mock.exempt'));
  assert.ok(has(r.logs, 'guard=unknown'), 'log degrades to guard=unknown');
}
ok('on + mocked + guardId undef  -> reject=true  (fails toward enforcement)');

// An empty or whitespace-only guardId is the same case as undefined.
for (const id of ['', '   ', '\t']) {
  const r = check('on', LISTED, true, id);
  assert.strictEqual(r.reject, true, `guardId ${JSON.stringify(id)} must not be exempt`);
  assert.ok(!has(r.logs, 'mock.exempt'));
}
ok('on + mocked + guardId blank  -> reject=true');

// ── 3. SHADOW PATH IS UNALTERED ──────────────────────────────────────────
// The return value is reject=false either way, so the proof is in the log:
// the exemption branch is gated on `reject`, so in shadow it is never reached
// and mock.exempt must not appear.
{
  const r = check('shadow', LISTED, true, LISTED);
  assert.strictEqual(r.reject, false, 'shadow + listed still does not reject');
  assert.strictEqual(r.verdict, 'mocked');
  assert.ok(has(r.logs, 'mock.reject'), 'shadow takes the ordinary path');
  assert.ok(!has(r.logs, 'mock.exempt'), 'the exemption branch is not reached in shadow');
  assert.ok(has(r.logs, 'mode=shadow'));
}
ok('shadow + mocked + IN list    -> mock.reject, never mock.exempt');

// Nor is the exemption consulted when the verdict is not mocked, whatever the
// list says — those paths return before the branch.
for (const mocked of [false, null] as const) {
  const r = check('on', LISTED, mocked, LISTED);
  assert.strictEqual(r.reject, false);
  assert.strictEqual(r.logs.length, 0, 'no log on a non-mocked verdict');
}
ok('on + listed + false/null     -> returns before the exemption branch');

// ── 4. MALFORMED LIST VALUES — THE FAIL-OPEN REGRESSION ──────────────────
// Every value here is fed with a guard that is NOT on the list. None may
// throw, and none may exempt. If the parser ever throws, checkMockLocation's
// catch turns that into reject=false and this group fails loudly — which is
// the entire reason the file exists.
const MALFORMED: Array<[string, string | undefined]> = [
  ['unset',                 undefined],
  ['empty string',          ''],
  ['single space',          ' '],
  ['whitespace only',       '   \t  '],
  ['newlines only',         '\n\n'],
  ['single comma',          ','],
  ['commas only',           ',,,,'],
  ['comma + spaces',        ' , , '],
  ['trailing comma',        `${OTHER},`],
  ['leading comma',         `,${OTHER}`],
  ['double comma',          `${OTHER},,${OTHER}`],
  ['embedded spaces',       ` ${OTHER} , ${OTHER} `],
  ['tabs and newlines',     `\t${OTHER}\n,\n${OTHER}\t`],
  ['mixed case, other id',  OTHER.toUpperCase()],
  ['semicolon separated',   `${OTHER};${LISTED}`],   // wrong separator: no match
  ['json-ish',              `["${LISTED}"]`],        // not parsed as JSON
  ['quoted',                `"${LISTED}"`],
  ['very long single entry', 'x'.repeat(100_000)],
  ['500 entries, no target', Array.from({ length: 500 }, (_, i) => `0000${String(i).padStart(4, '0')}-0000-0000-0000-000000000000`).join(',')],
];

for (const [label, value] of MALFORMED) {
  let r: Outcome;
  assert.doesNotThrow(() => { r = check('on', value, true, LISTED); }, `threw on: ${label}`);
  r = check('on', value, true, LISTED);
  assert.strictEqual(r.reject, true, `MUST still reject with list = ${label}`);
  assert.ok(!has(r.logs, 'mock.exempt'), `must not exempt with list = ${label}`);
  assert.ok(has(r.logs, 'mock.reject'), `must log the rejection with list = ${label}`);
}
ok(`malformed list values        -> reject=true, no throw  (${MALFORMED.length} shapes)`);

// The same malformed values must also leave an UNLISTED guard rejected when
// the list does name somebody — i.e. a stray comma cannot widen the match.
for (const value of [`${LISTED},`, ` ${LISTED} `, `,${LISTED},`, `${LISTED},,`]) {
  const r = check('on', value, true, OTHER);
  assert.strictEqual(r.reject, true, `a list naming ${LISTED} must not exempt ${OTHER}`);
  assert.ok(!has(r.logs, 'mock.exempt'));
}
ok('list names A, guard is B     -> reject=true  (no accidental widening)');

// ── 5. WELL-FORMED VARIATIONS THAT SHOULD MATCH ──────────────────────────
// Case and surrounding whitespace are tolerated on both sides, per the
// trim+toLowerCase comparison.
const MATCHING: Array<[string, string]> = [
  ['exact',                 LISTED],
  ['uppercase entry',       LISTED.toUpperCase()],
  ['mixed case entry',      LISTED.slice(0, 18).toUpperCase() + LISTED.slice(18)],
  ['padded entry',          `  ${LISTED}  `],
  ['trailing comma',        `${LISTED},`],
  ['leading comma',         `,${LISTED}`],
  ['first of two',          `${LISTED},${OTHER}`],
  ['last of two',           `${OTHER},${LISTED}`],
  ['middle of three',       `${OTHER},${LISTED},${OTHER}`],
  ['spaces around commas',  `${OTHER} , ${LISTED} , ${OTHER}`],
  ['500 entries, target last', Array.from({ length: 499 }, (_, i) => `0000${String(i).padStart(4, '0')}-0000-0000-0000-000000000000`).concat([LISTED]).join(',')],
];

for (const [label, value] of MATCHING) {
  const r = check('on', value, true, LISTED);
  assert.strictEqual(r.reject, false, `should exempt: ${label}`);
  assert.strictEqual(r.verdict, 'mocked', `verdict must stay mocked: ${label}`);
  assert.ok(has(r.logs, 'mock.exempt'), `should log mock.exempt: ${label}`);
}
// And the caller's guardId is matched case-insensitively too.
{
  const r = check('on', LISTED, true, LISTED.toUpperCase());
  assert.strictEqual(r.reject, false, 'uppercase guardId matches a lowercase list');
}
ok(`case + whitespace tolerance  -> exempt  (${MATCHING.length} shapes + uppercase caller)`);

// ── 6. NO MODULE-SCOPE CACHING ───────────────────────────────────────────
// The variable is read per call. Flipping it between calls must change the
// outcome without reloading the module — otherwise it could not be toggled
// on a running service.
{
  assert.strictEqual(check('on', undefined, true, LISTED).reject, true,  'list absent -> reject');
  assert.strictEqual(check('on', LISTED,    true, LISTED).reject, false, 'list added  -> exempt');
  assert.strictEqual(check('on', undefined, true, LISTED).reject, true,  'list removed -> reject again');
  assert.strictEqual(check('on', LISTED,    true, LISTED).reject, false, 'list re-added -> exempt again');
}
ok('per-call env read            -> toggles without a reload');

// ── 7. ENVIRONMENT RESTORED ──────────────────────────────────────────────
assert.strictEqual(process.env[MODE_VAR], ORIGINAL_MODE, `${MODE_VAR} leaked`);
assert.strictEqual(process.env[LIST_VAR], ORIGINAL_LIST, `${LIST_VAR} leaked`);
ok('process.env restored         -> no leakage from any case');

console.log(`\nPASS — ${n} groups, all assertions held.\n`);
