#!/usr/bin/env ts-node
/**
 * Prove the /ping deep-link gate routes to the capture screen whenever a
 * session exists — including when it has to be fetched — and goes home only
 * when there genuinely is no open session.
 *
 * WHY THIS EXISTS. The bug this guards against was silent and permanent. The
 * old screen read activeSession once on an empty-deps effect and bounced to
 * home when it was null; the store is not persisted, so on a cold start from
 * a notification tap null is the NORMAL state. A guard tapped "Submit your
 * 13:30 ping" and landed on the home tab (session bb3934c9, 2026-09-12
 * 20:30). Nothing errored, nothing logged, and the empty deps meant the
 * decision was never revisited once the session arrived.
 *
 * The decision is extracted as a pure reducer, `decideDeepLink`, mirroring
 * the screen's effect. app/ping/index.tsx cannot be imported here: it pulls
 * in expo-router and react-native, which ts-node cannot load (the same
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING wall that split
 * notificationTray out of notificationSync). The guard against the reducer
 * drifting from the screen is the SOURCE ASSERTIONS at the bottom, which
 * read app/ping/index.tsx and fail if its branch structure changes.
 *
 * Run:
 *   cd apps/mobile && npm run check:deeplink-gate
 */
import { readFileSync } from 'fs';
import { join } from 'path';

type Session = { clocked_in_at?: string } | null;

/** Where the screen sends the guard. Mirrors app/ping/index.tsx's effect. */
export type Destination =
  | { to: 'capture'; windowLabel: string | null }
  | { to: 'home' };

/**
 * `stored` is the session in the store at mount; `fetched` is what
 * restoreSessionIfMissing resolves to when `stored` is null. `fetched` is
 * never consulted when `stored` is present — that is the fast path, and it
 * must not cost a round trip.
 */
function decideDeepLink(args: {
  stored: Session;
  fetched?: Session;
  windowLabel?: string | null;
}): { dest: Destination; fetchCalled: boolean } {
  const label = args.windowLabel ?? null;
  if (args.stored?.clocked_in_at) {
    return { dest: { to: 'capture', windowLabel: label }, fetchCalled: false };
  }
  const session = args.fetched ?? null;
  if (session?.clocked_in_at) {
    return { dest: { to: 'capture', windowLabel: label }, fetchCalled: true };
  }
  return { dest: { to: 'home' }, fetchCalled: true };
}

/** The URL the screen builds — asserted so the label cannot be dropped or
 *  double-encoded between the two hops. */
function captureHref(windowLabel: string | null): string {
  return windowLabel
    ? `/ping/photo?window_label=${encodeURIComponent(windowLabel)}`
    : '/ping/photo';
}

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
  if (a !== b) throw new Error(`${msg}\n        want ${b}\n        got  ${a}`);
}

const ON_SHIFT = { clocked_in_at: '2026-09-12T18:02:42.733Z' };

console.log('/ping deep-link gate\n');

// ── The three outcomes ────────────────────────────────────────────────────
test('session already in the store -> capture, WITHOUT a fetch', () => {
  const r = decideDeepLink({ stored: ON_SHIFT, windowLabel: '13:30' });
  eq(r.dest, { to: 'capture', windowLabel: '13:30' }, 'destination');
  eq(r.fetchCalled, false, 'fast path must not hit the network');
});

test('store empty, server HAS a session -> hydrate then capture (THE BUG)', () => {
  // Cold start from a notification tap. This returned home before.
  const r = decideDeepLink({ stored: null, fetched: ON_SHIFT, windowLabel: '13:30' });
  eq(r.dest, { to: 'capture', windowLabel: '13:30' }, 'destination');
  eq(r.fetchCalled, true, 'must have asked the server');
});

test('store empty, server has NO session -> home', () => {
  const r = decideDeepLink({ stored: null, fetched: null, windowLabel: '13:30' });
  eq(r.dest, { to: 'home' }, 'genuinely off shift');
});

test('a session without clocked_in_at is not a session', () => {
  // /shifts/active-session returning a malformed row must not be treated as
  // on-shift — the capture screen would post against a session id the server
  // does not consider open.
  eq(decideDeepLink({ stored: {} as Session, fetched: null }).dest, { to: 'home' }, 'stored');
  eq(decideDeepLink({ stored: null, fetched: {} as Session }).dest, { to: 'home' }, 'fetched');
});

// ── window_label survives both hops ───────────────────────────────────────
test('window_label survives the store fast path', () => {
  const r = decideDeepLink({ stored: ON_SHIFT, windowLabel: '13:30' });
  eq(captureHref((r.dest as any).windowLabel), '/ping/photo?window_label=13%3A30', 'href');
});

test('window_label survives the restore path — identical href', () => {
  const fast = decideDeepLink({ stored: ON_SHIFT, windowLabel: '13:30' });
  const slow = decideDeepLink({ stored: null, fetched: ON_SHIFT, windowLabel: '13:30' });
  eq(captureHref((slow.dest as any).windowLabel), '/ping/photo?window_label=13%3A30', 'href');
  eq((slow.dest as any).windowLabel, (fast.dest as any).windowLabel,
     'both hops must produce the same label');
});

test('no window_label (manual PING NOW) -> bare capture route', () => {
  const r = decideDeepLink({ stored: ON_SHIFT });
  eq(captureHref((r.dest as any).windowLabel), '/ping/photo', 'no query string');
});

test('the colon is percent-encoded exactly once', () => {
  // '13:30' -> '13%3A30'. A double-encode ('13%253A30') would reach the
  // server as a label matching no missed_pings row, and the backfill would
  // silently fail to resolve.
  const href = captureHref('13:30');
  eq(href.includes('%3A'), true, 'encoded');
  eq(href.includes('%253A'), false, 'NOT double-encoded');
});

// ── Source assertions: the screen must still have this shape ──────────────
/** Strip block and line comments so source assertions test CODE, not prose.
 *
 *  Necessary, not cosmetic: ping/index.tsx's docblock QUOTES the defective
 *  empty-deps effect verbatim as the explanation of what was fixed, and a
 *  naive regex over the raw file matches that quotation and fails the very
 *  check it is meant to pass. Documenting a bug must not read as having it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('app/ping/index.tsx still asks the server before going home', () => {
  const raw = readFileSync(join(__dirname, '..', 'app', 'ping', 'index.tsx'), 'utf8');
  const src = codeOnly(raw);
  if (!src.includes('restoreSessionIfMissing()')) {
    throw new Error('the screen no longer calls restoreSessionIfMissing — the cold-start bounce is back');
  }
  // The empty-deps effect is the precise defect. Its return would be silent.
  if (/useEffect\([\s\S]*?\}, \[\]\)/.test(src)) {
    throw new Error('an empty-deps useEffect reappeared in ping/index.tsx — a late hydration would not be seen');
  }
  if (!/\}, \[activeSession,/.test(src)) {
    throw new Error('activeSession is no longer an effect dependency');
  }
  // The docblock must keep explaining why, but only in prose.
  if (!raw.includes('}, []);')) {
    throw new Error('the docblock no longer shows the defective empty-deps effect it replaced');
  }
});

test('store still exposes restoreSessionIfMissing and it calls setActiveSession', () => {
  const src = readFileSync(join(__dirname, '..', 'store', 'shiftStore.ts'), 'utf8');
  if (!src.includes('restoreSessionIfMissing:')) throw new Error('action missing from the store');
  const body = src.slice(src.indexOf('restoreSessionIfMissing: async'));
  if (!body.includes('setActiveSession(')) {
    throw new Error('restoreSessionIfMissing no longer hydrates via setActiveSession');
  }
  if (!body.includes('restoreInFlight')) {
    throw new Error('the in-flight guard is gone — home and the deep link would double-fetch');
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(`failed: ${failures.join(', ')}`);
  process.exit(1);
}
