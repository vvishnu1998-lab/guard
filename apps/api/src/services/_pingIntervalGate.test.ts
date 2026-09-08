/**
 * Tests for the ping-cadence capability gate (services/pingIntervalGate.ts).
 *
 * The gate decides what shift_sessions.ping_interval_minutes is stamped with
 * at clock-in. Getting it wrong in the OPEN direction stamps a cadence the
 * handset cannot honour, and the guard is then judged against a grid their
 * own countdown never showed them. So every case below that is not
 * unambiguously a capable client must resolve to 30.
 *
 * Same convention as the sibling tests: no test framework is installed in
 * apps/api, so this is a standalone ts-node script using node:assert.
 *
 * Run:
 *   cd apps/api && npx ts-node src/services/_pingIntervalGate.test.ts
 */
import assert from 'node:assert';
import {
  pingIntervalForNewSession,
  parseRuntime,
  compareVersions,
  LEGACY_PING_INTERVAL_MINUTES,
  MIN_RUNTIME_READING_SESSION_INTERVAL,
} from './pingIntervalGate';

const SITE = 45; // a non-30 site value, so "took the site value" is visible
const LEGACY = LEGACY_PING_INTERVAL_MINUTES;

function req(client?: unknown): { headers: Record<string, unknown> } {
  return { headers: client === undefined ? {} : { 'x-netraops-client': client } };
}
/** A real production client string at the given runtime. */
function mobile(runtime: string, version = '1.0.17'): string {
  return `platform/ios; version/${version}; build/41; runtime/${runtime}; update/embedded`;
}

let n = 0;
const ok = (label: string) => { n += 1; console.log(`  ok ${String(n).padStart(2)}  ${label}`); };

console.log(`\nthreshold = ${MIN_RUNTIME_READING_SESSION_INTERVAL}   legacy = ${LEGACY}   site = ${SITE}\n`);

// ── 1. ABSENT HEADER ─────────────────────────────────────────────────────
assert.strictEqual(pingIntervalForNewSession(req(), SITE), LEGACY);
assert.strictEqual(pingIntervalForNewSession(req(undefined), SITE), LEGACY);
assert.strictEqual(pingIntervalForNewSession({ headers: {} }, SITE), LEGACY);
ok('absent header                 -> 30');

// ── 2. MALFORMED STRING ──────────────────────────────────────────────────
for (const bad of [
  '',                      // empty
  'garbage',               // no structure at all
  'runtime/',              // key with no value
  'runtime/unknown',       // Expo Go / dev build (apiClient.ts:54)
  'runtime/abc',           // non-numeric
  'runtime/1.0.x',         // partially numeric
  'runtime/-1.0.0',        // negative segment
  'runtime/1.0.0.0.0',     // too many segments
  'platform/ios; build/41', // well-formed header, no runtime token
  '{}', '[]', 'null',
]) {
  assert.strictEqual(pingIntervalForNewSession(req(bad), SITE), LEGACY, `malformed: ${bad}`);
}
ok('malformed string              -> 30  (11 shapes)');

// ── 3. NON-MOBILE CALLER ─────────────────────────────────────────────────
// Web admin / curl / server-to-server: no client header at all, or a
// user-agent instead. Nothing here may ever open the gate.
assert.strictEqual(pingIntervalForNewSession({ headers: { 'user-agent': 'Mozilla/5.0' } }, SITE), LEGACY);
assert.strictEqual(pingIntervalForNewSession({ headers: { 'user-agent': 'curl/8.4.0' } }, SITE), LEGACY);
assert.strictEqual(pingIntervalForNewSession({ headers: { 'x-netraops-client': 12345 } }, SITE), LEGACY);
assert.strictEqual(pingIntervalForNewSession({ headers: { 'x-netraops-client': null } }, SITE), LEGACY);
ok('non-mobile caller             -> 30');

// ── 4. BELOW THRESHOLD ───────────────────────────────────────────────────
// Every runtime production has actually recorded is in here.
for (const r of ['1.0.16', '1.0.17', '1.0.99', '1.0.0', '0.9.9', '1.1']) {
  const expected = r === '1.1' ? SITE : LEGACY; // 1.1 == 1.1.0, see case 5
  assert.strictEqual(pingIntervalForNewSession(req(mobile(r)), SITE), expected, `runtime ${r}`);
}
assert.strictEqual(pingIntervalForNewSession(req(mobile('1.0.17')), SITE), LEGACY);
ok('below threshold (incl. live 1.0.16 / 1.0.17) -> 30');

// ── 5. AT THRESHOLD ──────────────────────────────────────────────────────
assert.strictEqual(pingIntervalForNewSession(req(mobile('1.1.0')), SITE), SITE);
assert.strictEqual(pingIntervalForNewSession(req(mobile('1.1')), SITE), SITE, '1.1 == 1.1.0');
ok('at threshold                  -> site value (45)');

// ── 6. ABOVE THRESHOLD ───────────────────────────────────────────────────
for (const r of ['1.1.1', '1.2.0', '1.10.0', '2.0.0']) {
  assert.strictEqual(pingIntervalForNewSession(req(mobile(r)), SITE), SITE, `runtime ${r}`);
}
ok('above threshold               -> site value (45)');

// ── 7. THE ORDERING TRAP: 1.0.9 < 1.0.10 ─────────────────────────────────
// Lexicographic comparison puts '1.0.9' ABOVE '1.0.10' because '9' > '1'.
// Assert the numeric ordering directly, and assert that string compare
// really would have disagreed — so this test fails if someone "simplifies"
// compareVersions into a localeCompare.
assert.ok((compareVersions('1.0.9', '1.0.10') as number) < 0, '1.0.9 must be < 1.0.10');
assert.ok((compareVersions('1.0.10', '1.0.9') as number) > 0, '1.0.10 must be > 1.0.9');
assert.ok('1.0.9' > '1.0.10', 'string compare disagrees — that is the trap');
assert.strictEqual(compareVersions('1.1', '1.1.0'), 0, 'missing segments read as 0');
assert.strictEqual(compareVersions('1.0.9', 'x'), null, 'non-numeric -> null');
// And through the gate, with a threshold either side of the pair.
assert.strictEqual(pingIntervalForNewSession(req(mobile('1.0.9')), SITE), LEGACY);
assert.strictEqual(pingIntervalForNewSession(req(mobile('1.0.10')), SITE), LEGACY);
ok('1.0.9 < 1.0.10 numerically    -> both below 1.1.0, both 30');

// ── extra guards: never throw, never return junk ─────────────────────────
for (const site of [undefined, null, NaN, Infinity, -5, 0, 'forty', {}, [], 30.5]) {
  const v = pingIntervalForNewSession(req(mobile('2.0.0')), site);
  assert.strictEqual(v, LEGACY, `bad site value ${String(site)} must fall back`);
}
assert.strictEqual(pingIntervalForNewSession(req(mobile('2.0.0')), '45'), 45, 'numeric string site value coerces');
// A hostile 100k-char header must not hang or throw.
assert.strictEqual(pingIntervalForNewSession(req('runtime/' + '9'.repeat(100_000)), SITE), LEGACY);
assert.strictEqual(pingIntervalForNewSession(req(('a; ').repeat(50_000)), SITE), LEGACY);
// @ts-expect-error — deliberately malformed request object
assert.strictEqual(pingIntervalForNewSession(undefined, SITE), LEGACY, 'no req at all');
ok('bad site values + hostile input -> 30, no throw');

// ── parseRuntime directly ────────────────────────────────────────────────
assert.strictEqual(parseRuntime(mobile('1.0.17')), '1.0.17');
assert.strictEqual(parseRuntime('platform/android; runtime/1.2.3; update/abc'), '1.2.3');
assert.strictEqual(parseRuntime(['runtime/1.2.3']), '1.2.3', 'array-valued header');
assert.strictEqual(parseRuntime('RUNTIME/1.2.3'), '1.2.3', 'case-insensitive');
assert.strictEqual(parseRuntime('update/runtime/1.2.3'), null, 'must not match mid-token');
assert.strictEqual(parseRuntime('runtime/unknown'), null);
assert.strictEqual(parseRuntime(undefined), null);
ok('parseRuntime extraction');

console.log(`\nPASS — ${n} groups, all assertions held.\n`);
