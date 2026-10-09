/**
 * check-ping-home — batch/mobile-19 (N173): PING NOW on Home, the "ping due"
 * line, the answered-window memory, and the notifications-off banner.
 *
 *   T  pingTileFor() is the active-shift gate it replaced, minute by minute,
 *      across shifts, clock-ins and answers (reference: the inline rule at
 *      f5a84c4 app/active-shift/index.tsx:252-265, copied verbatim below).
 *   S  pingStatusFor()/pingStatusCopy(): due only while the tile is live and
 *      no break is open; the copy at window edges; everything that is not
 *      due or done reads exactly as Home's old countdown did.
 *   R  answered-window persistence rules.
 *   N  notifications banner states.
 *   W  wiring in the screens and the store (source-level: they import native
 *      modules, so they cannot be loaded here).
 *
 * Run: npm run check:ping-home
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  currentPingWindow, remainingMsUntilNextPing, PING_WINDOW_MS,
  type PingWindowState,
} from '../lib/pingSchedule';
import {
  pingTileFor, pingStatusFor, pingStatusCopy, pingRouteFor, formatMinSec,
  type AnsweredWindow,
} from '../lib/pingTile';
import { serializeAnsweredWindow, parseAnsweredWindow, shouldApplyStored } from '../lib/answeredWindow';
import { notificationsBannerFor } from '../lib/notificationsBanner';

let passed = 0;
let failed = 0;
let reachedEnd = false;
function check(id: string, ok: boolean, detail = ''): void {
  if (ok) { passed += 1; return; }
  failed += 1;
  console.log(`✗ FAIL ${id}${detail ? ` — ${detail}` : ''}`);
}
process.on('exit', () => {
  if (!reachedEnd) {
    console.log('✗ FAIL the check stopped before its last section');
    process.exitCode = 1;
  }
});

// ── Reference: the inline gate this batch moved (f5a84c4, verbatim) ───────
function legacyTile(
  pingWindow: PingWindowState | null,
  lastPingedWindow: { sessionId: string; label: string } | null,
  activeSessionId: string,
) {
  const openWindow = pingWindow?.status === 'open' ? pingWindow.window : null;
  const alreadyPinged =
    openWindow !== null &&
    lastPingedWindow?.sessionId === activeSessionId &&
    lastPingedWindow?.label === openWindow.label;

  const pingTile: { enabled: boolean; label: string; note: string | null } = (() => {
    if (!pingWindow)                          return { enabled: false, label: 'PING',     note: null };
    if (pingWindow.status === 'before_shift')  return { enabled: false, label: 'PING',     note: 'Starts at shift time' };
    if (pingWindow.status === 'shift_ending')  return { enabled: false, label: 'PING',     note: 'Shift ending' };
    if (pingWindow.status === 'before_clock_in') return { enabled: false, label: 'PING',   note: 'Next window' };
    if (alreadyPinged)                        return { enabled: false, label: 'PINGED',   note: `${openWindow!.label} done` };
    return { enabled: true, label: 'PING NOW', note: `${openWindow!.label} window` };
  })();
  return { ...pingTile, openWindow };
}

// Reference: Home's old countdown line (f5a84c4 app/(tabs)/home.tsx:965-993).
function legacyCountdownLabel(remaining: number | null): string | null {
  if (remaining === null) return null;
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  return `Next ping in ${mins}:${String(secs).padStart(2, '0')}`;
}

// ── Fixtures (UTC instants; labels render in America/Los_Angeles) ─────────
const MIN = 60_000;
const SID = 'session-a';
const SHIFTS = [
  { name: '22:00-06:00', start: '2026-10-09T05:00:00Z', end: '2026-10-09T13:00:00Z' },
  { name: '20:15-23:45', start: '2026-10-09T03:15:00Z', end: '2026-10-09T06:45:00Z' },
  { name: '09:50-10:30', start: '2026-10-08T16:50:00Z', end: '2026-10-08T17:30:00Z' },
];
const CLOCK_INS = [-10 * MIN, 0, 1000, 45 * MIN];   // relative to scheduled start

function instants(startMs: number, endMs: number): number[] {
  const out: number[] = [];
  for (let t = startMs - 60 * MIN; t <= endMs + 30 * MIN; t += MIN) out.push(t);
  // Window edges: first and last millisecond of every window, and one before.
  for (let w = startMs; w <= endMs + PING_WINDOW_MS; w += PING_WINDOW_MS) out.push(w - 1, w, w + 1, w + PING_WINDOW_MS - 1000);
  return out;
}

// ── T: the moved gate is the old gate ─────────────────────────────────────
{
  let cases = 0;
  let mismatchCount = 0;
  const mismatches: string[] = [];
  for (const sh of SHIFTS) {
    const startMs = Date.parse(sh.start);
    const endMs = Date.parse(sh.end);
    for (const ci of CLOCK_INS) {
      const clockedInAt = new Date(startMs + ci).toISOString();
      for (const t of instants(startMs, endMs)) {
        const now = new Date(t);
        const pw = currentPingWindow({ scheduledStart: sh.start, scheduledEnd: sh.end, clockedInAt, now });
        const open = pw.status === 'open' ? pw.window.label : '00:00';
        const answers: Array<AnsweredWindow | null> = [
          null,
          { sessionId: SID, label: open },
          { sessionId: SID, label: '01:00' },
          { sessionId: 'session-b', label: open },
        ];
        for (const a of answers) {
          for (const state of [pw, null] as Array<PingWindowState | null>) {
            cases += 1;
            const want = legacyTile(state, a, SID);
            const got = pingTileFor(state, a, SID);
            const same = got.enabled === want.enabled && got.label === want.label && got.note === want.note &&
              (got.openWindow === null ? want.openWindow === null
                : want.openWindow !== null && got.openWindow.label === want.openWindow.label &&
                  got.openWindow.start.getTime() === want.openWindow.start.getTime());
            if (!same) {
              mismatchCount += 1;
              if (mismatches.length < 3) {
                mismatches.push(`${sh.name} ci${ci / MIN}m ${now.toISOString()} ${JSON.stringify(a)}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`);
              }
            }
          }
        }
      }
    }
  }
  check('T1 pingTileFor equals the f5a84c4 active-shift gate at every instant', mismatchCount === 0,
    `${mismatches.join(' | ')} (${mismatchCount} of ${cases})`);
  check('T2 the sweep covered enough cases', cases > 20_000, `${cases}`);

  // The states themselves, named, at one fixture.
  const sh = SHIFTS[0];
  const st = Date.parse(sh.start);
  const at = (minsAfterStart: number, ciMins = -10) => currentPingWindow({
    scheduledStart: sh.start, scheduledEnd: sh.end,
    clockedInAt: new Date(st + ciMins * MIN).toISOString(), now: new Date(st + minsAfterStart * MIN),
  });
  const openTile = pingTileFor(at(40), null, SID);
  check('T3 open, unanswered: PING NOW, enabled, names the window',
    openTile.enabled && openTile.label === 'PING NOW' && openTile.note === '22:30 window', JSON.stringify(openTile));
  const done = pingTileFor(at(40), { sessionId: SID, label: '22:30' }, SID);
  check('T4 open, answered on this session: PINGED, disabled', !done.enabled && done.label === 'PINGED' && done.note === '22:30 done');
  const other = pingTileFor(at(40), { sessionId: 'session-b', label: '22:30' }, SID);
  check('T5 an answer from another session does not count', other.enabled && other.label === 'PING NOW');
  const lateCi = pingTileFor(at(40, 45), null, SID);
  check('T6 the window opened before clock-in: PING, "Next window"', !lateCi.enabled && lateCi.note === 'Next window', JSON.stringify(lateCi));
  check('T7 before the shift: "Starts at shift time"', pingTileFor(at(-20), null, SID).note === 'Starts at shift time');
  check('T8 no whole window left (past scheduled_end): "Shift ending"', pingTileFor(at(485), null, SID).note === 'Shift ending');
  check('T8b an 8-hour shift\'s last whole window is still open at 05:59', pingTileFor(at(479), null, SID).note === '05:30 window');
  check('T9 the route is the deep link\'s: /ping?window_label=22%3A30',
    openTile.openWindow !== null && pingRouteFor(openTile.openWindow) === '/ping?window_label=22%3A30');
}

// ── S: the ping line ──────────────────────────────────────────────────────
{
  const sh = SHIFTS[0];
  const st = Date.parse(sh.start);
  const clockedInAt = new Date(st - 10 * MIN).toISOString();
  const line = (ms: number, answered: AnsweredWindow | null = null, onBreak = false) => {
    const now = new Date(ms);
    const args = { scheduledStart: sh.start, scheduledEnd: sh.end, clockedInAt, now };
    const s = pingStatusFor({
      pingWindow: currentPingWindow(args), nextPingMs: remainingMsUntilNextPing(args),
      answered, sessionId: SID, onBreak, now,
    });
    return { s, copy: pingStatusCopy(s) };
  };

  const mid = line(st + 40 * MIN + 1000);   // 22:40:01, the 22:30 window open
  check('S1 an open, unanswered window is DUE, and says so',
    mid.s.kind === 'due' && mid.copy?.title === 'PING DUE NOW' && mid.copy?.text === '22:30 window closes in 19:59',
    JSON.stringify(mid.copy));
  const first = line(st + 30 * MIN);
  check('S2 at the window\'s first instant it closes in 30:00', first.copy?.text === '22:30 window closes in 30:00', JSON.stringify(first.copy));
  const last = line(st + 60 * MIN - 1000);
  check('S3 at its last second it closes in 0:01', last.copy?.text === '22:30 window closes in 0:01', JSON.stringify(last.copy));

  const answered = line(st + 40 * MIN + 1000, { sessionId: SID, label: '22:30' });
  check('S4 once answered: done, and when the next window opens',
    answered.s.kind === 'done' && answered.copy?.text === '✓ 22:30 done · next window opens in 19:59', JSON.stringify(answered.copy));
  const lastWindow = line(Date.parse(sh.end) - 10 * MIN, { sessionId: SID, label: '05:30' });
  check('S5 the last window answered: done, with no "next"', lastWindow.copy?.text === '✓ 05:30 done', JSON.stringify(lastWindow.copy));

  const onBreak = line(st + 40 * MIN + 1000, null, true);
  check('S6 an open break: never due (the server waives the window)', onBreak.s.kind !== 'due', JSON.stringify(onBreak.s));
  check('S7 an open break: the line reads as the old countdown', onBreak.copy?.text === 'Next ping in 19:59', JSON.stringify(onBreak.copy));
  const breakAnswered = line(st + 40 * MIN + 1000, { sessionId: SID, label: '22:30' }, true);
  check('S8 an open break after answering: still "done"', breakAnswered.s.kind === 'done');

  // Every instant: due ⇔ tile live and no break; anything else reads exactly
  // as the old countdown, which rendered nothing when no window remained.
  const bad: string[] = [];
  for (const shf of SHIFTS) {
    const s0 = Date.parse(shf.start);
    const e0 = Date.parse(shf.end);
    for (const ci of CLOCK_INS) {
      const cia = new Date(s0 + ci).toISOString();
      for (const t of instants(s0, e0)) {
        for (const brk of [false, true]) {
          const now = new Date(t);
          const args = { scheduledStart: shf.start, scheduledEnd: shf.end, clockedInAt: cia, now };
          const pw = currentPingWindow(args);
          const next = remainingMsUntilNextPing(args);
          const s = pingStatusFor({ pingWindow: pw, nextPingMs: next, answered: null, sessionId: SID, onBreak: brk, now });
          const tile = pingTileFor(pw, null, SID);
          if ((s.kind === 'due') !== (tile.enabled && !brk)) bad.push(`due/tile ${shf.name} ${now.toISOString()} brk=${brk}`);
          if (s.kind !== 'due' && s.kind !== 'done') {
            const legacy = legacyCountdownLabel(next);
            const mine = pingStatusCopy(s)?.text ?? null;
            if (mine !== legacy) bad.push(`copy ${shf.name} ${now.toISOString()}: "${mine}" vs "${legacy}"`);
          }
          if (s.kind === 'due' && pw.status === 'open' && s.closesInMs !== pw.window.end.getTime() - t) {
            bad.push(`closesIn ${shf.name} ${now.toISOString()}`);
          }
        }
      }
    }
  }
  check('S9 at every instant: due exactly when the tile is live and no break is open; otherwise the old countdown, word for word',
    bad.length === 0, `${bad.slice(0, 3).join(' | ')} (${bad.length})`);
  check('S10 formatMinSec keeps the old m:ss (minutes unbounded)', formatMinSec(65 * MIN + 5000) === '65:05' && formatMinSec(59_000) === '0:59');
}

// ── R: the answered window survives a restart, safely ─────────────────────
{
  const w = { sessionId: 'sess-1', label: '02:30' };
  check('R1 round trip on the same session', JSON.stringify(parseAnsweredWindow(serializeAnsweredWindow(w), 'sess-1')) === JSON.stringify(w));
  check('R2 another session\'s answer reads as unanswered', parseAnsweredWindow(serializeAnsweredWindow(w), 'sess-2') === null);
  const junk = [null, '', 'not json', '{}', 'null', '[]', '{"sessionId":"sess-1"}', '{"sessionId":"sess-1","label":"2:30"}',
    '{"sessionId":"sess-1","label":"02:30:00"}', '{"sessionId":"sess-1","label":230}'];
  check('R3 anything malformed reads as unanswered (fail open)', junk.every((j) => parseAnsweredWindow(j, 'sess-1') === null));
  check('R4 a stored answer applies to its own session when memory is empty',
    shouldApplyStored({ stored: w, current: null, activeSessionId: 'sess-1' }));
  check('R5 never over a newer in-memory answer',
    !shouldApplyStored({ stored: w, current: { sessionId: 'sess-1', label: '03:00' }, activeSessionId: 'sess-1' }));
  check('R6 never into a different session (a handoff swapped it meanwhile)',
    !shouldApplyStored({ stored: w, current: null, activeSessionId: 'sess-2' }));
  check('R7 nothing stored, nothing applied', !shouldApplyStored({ stored: null, current: null, activeSessionId: 'sess-1' }));
}

// ── N: the notifications banner ───────────────────────────────────────────
{
  check('N1 granted: no banner', notificationsBannerFor({ status: 'granted', canAskAgain: true }) === null);
  check('N2 unknown yet: no banner', notificationsBannerFor(null) === null);
  const und = notificationsBannerFor({ status: 'undetermined', canAskAgain: true });
  check('N3 never asked: banner, tap asks', und?.action === 'request' && und.sub === 'You won’t be reminded when a ping is due. Tap to turn on notifications.');
  const den1 = notificationsBannerFor({ status: 'denied', canAskAgain: true });
  check('N4 denied but the OS will still ask (Android, first denial): tap asks', den1?.action === 'request');
  const den = notificationsBannerFor({ status: 'denied', canAskAgain: false });
  check('N5 denied for good (iOS): tap opens Settings, and says so',
    den?.action === 'settings' && den.sub === 'You won’t be reminded when a ping is due. Tap to turn on notifications in Settings.');
  check('N6 the title', den?.title === '⚠ PING REMINDERS ARE OFF' && und?.title === den?.title);
}

// ── W: wiring ─────────────────────────────────────────────────────────────
{
  const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
  const home = src('app/(tabs)/home.tsx');
  const active = src('app/active-shift/index.tsx');
  const layout = src('app/_layout.tsx');
  const store = src('store/shiftStore.ts');

  check('W1 Home gates its tile and line with lib/pingTile', /pingTileFor\(pingWindow, lastPingedWindow, activeSession!\.id\)/.test(home) && /pingStatusFor\(\{/.test(home));
  check('W2 Home routes through pingRouteFor, never a hand-built /ping URL', home.includes('pingRouteFor(') && !home.includes('/ping?window_label='));
  check('W3 Home\'s old countdown is gone', !home.includes('remainingMsUntilNextPing') && !home.includes('PingCountdownBanner'));
  check('W4 Home pins the notifications banner above the ScrollView',
    home.indexOf('<NotificationsOffBanner />') > -1 && home.indexOf('<NotificationsOffBanner />') < home.indexOf('<ScrollView'));
  check('W5 the PING tile leads the action row', home.indexOf('pingTile.label') > -1 && home.indexOf('pingTile.label') < home.indexOf("router.push('/reports/new')"));
  check('W6 active-shift uses the shared gate and has no inline copy',
    active.includes('pingTileFor(pingWindow, lastPingedWindow, activeSession.id)') && !active.includes('alreadyPinged'));
  check('W7 _layout registers through lib/pushRegistration only', layout.includes('await registerPushToken()') && !layout.includes('getExpoPushTokenAsync'));
  check('W8 markWindowPinged persists the answer', /markWindowPinged: \(sessionId, label\) => \{[\s\S]{0,200}setItemAsync\(ANSWERED_WINDOW_KEY/.test(store));
  check('W9 setActiveSession restores it, guarded', /getItemAsync\(ANSWERED_WINDOW_KEY\)[\s\S]{0,300}shouldApplyStored\(/.test(store));
  check('W10 clearSession deletes it', /clearSession: \(\) => \{[\s\S]{0,300}deleteItemAsync\(ANSWERED_WINDOW_KEY\)/.test(store));
}

reachedEnd = true;
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;
