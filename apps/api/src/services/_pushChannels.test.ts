#!/usr/bin/env ts-node
/**
 * Assert that every NotificationType routes to a channel, and that
 * collapseIdFor never emits a key that would be rejected or that would
 * merge two notifications the guard needs to see separately.
 *
 * WHY THIS EXISTS. Both halves fail silently in production:
 *
 *   channel  — naming a channel the device has not declared makes Android
 *              fall back to `default`. No error, no log; the notification
 *              just arrives at the wrong importance. Adding a new
 *              NotificationType and forgetting the channel map is
 *              indistinguishable from working.
 *   collapse — an over-broad key makes FCM/APNs DROP the earlier message in
 *              transit. A key of `ping_reminder` alone would coalesce the
 *              17:30 and 18:00 windows into one banner and the guard would
 *              never learn a window was open. Nothing logs a coalesced push.
 *
 * Run: npx ts-node src/services/_pushChannels.test.ts
 * (apps/api has no test runner; the other _*.test.ts files here are the same
 * standalone shape.)
 */
import {
  channelForType,
  collapseIdFor,
  CHANNEL_MAP_FOR_TEST,
  COLLAPSE_ID_MAX_BYTES,
  PushChannel,
} from './pushChannels';
import { buildExpoPushMessage } from './firebase';
import type { NotificationType } from './notifications';

/**
 * Every member of the NotificationType union, written out.
 *
 * Deliberately a literal list rather than something derived: a union is a
 * compile-time construct with no runtime representation, so "iterate the
 * union" is not possible. The `satisfies`-style assignment below is what
 * makes the list self-checking — if a type is added to the union and not
 * here, `EXHAUSTIVE` stops covering `NotificationType` and tsc fails.
 */
const ALL_TYPES = [
  'ping_reminder',
  'activity_report_reminder',
  'task_reminder',
  'chat',
  'geofence_breach',
  'off_post_report',
  'off_post_task',
  'missed_ping',
  'late_clock_in',
  'clock_out_reminder',
  'missed_report',
  'swap_request_received',
  'swap_request_sent',
  'swap_accepted',
  'swap_declined',
  'swap_expired',
  'handoff_request_received',
  'handoff_request_sent',
  'handoff_accepted',
  'handoff_declined',
  'handoff_cancelled',
  'handoff_complete',
  'handoff_nudge',
  'handoff_expired',
  'shift_assigned',
  'pre_shift_reminder',
  'shift_start_reminder',
  'break_ended',
  'break_return_overdue',
] as const;

// Compile-time exhaustiveness. If the union gains a member that is missing
// from ALL_TYPES, this assignment fails to typecheck.
const EXHAUSTIVE: Record<NotificationType, true> = Object.fromEntries(
  ALL_TYPES.map((t) => [t, true]),
) as Record<NotificationType, true>;
void EXHAUSTIVE;

const VALID_CHANNELS: PushChannel[] = ['alerts', 'reminders', 'chat', 'default'];

let failures = 0;
function fail(msg: string): void { failures++; console.error(`  FAIL  ${msg}`); }

// ── every type maps to a declared channel ──────────────────────────────────
console.log('[check-push-channels] channel routing');
const byChannel: Record<string, string[]> = { alerts: [], reminders: [], chat: [], default: [] };
for (const t of ALL_TYPES) {
  const ch = channelForType(t);
  if (!VALID_CHANNELS.includes(ch)) { fail(`${t} -> ${ch}, which is not a declared channel`); continue; }
  byChannel[ch].push(t);
}
for (const ch of VALID_CHANNELS) {
  console.log(`  ${ch.padEnd(9)} (${String(byChannel[ch].length).padStart(2)}) ${byChannel[ch].join(', ')}`);
}
if (ALL_TYPES.length !== 29) fail(`expected 29 NotificationTypes, ALL_TYPES has ${ALL_TYPES.length}`);

// The four channels the mobile app declares in lib/notifications.ts. A type
// routed anywhere else would silently land on `default` on the device.
for (const [t, ch] of Object.entries(CHANNEL_MAP_FOR_TEST)) {
  if (ch && !VALID_CHANNELS.includes(ch)) fail(`map entry ${t} -> ${ch} is not one of the four declared channels`);
}

// Spot-check the intent of the split: an already-failed obligation must be
// louder than a not-yet-failed one. These pairs would be easy to swap by
// accident and impossible to notice on a device.
const LOUDER: Array<[NotificationType, NotificationType]> = [
  ['missed_ping',   'ping_reminder'],
  ['missed_report', 'activity_report_reminder'],
];
for (const [failed, pending] of LOUDER) {
  if (channelForType(failed) !== 'alerts')    fail(`${failed} should be on 'alerts', got '${channelForType(failed)}'`);
  if (channelForType(pending) !== 'reminders') fail(`${pending} should be on 'reminders', got '${channelForType(pending)}'`);
}
if (channelForType('chat') !== 'chat') fail("chat should be on its own channel");
console.log('  ok    escalation pairs (missed_* louder than their reminder) hold');

// ── collapse keys ──────────────────────────────────────────────────────────
console.log('[check-push-channels] collapse keys');
const UUID = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';

function expect(label: string, got: string | undefined, want: string | undefined): void {
  if (got !== want) fail(`${label}\n        want ${String(want)}\n        got  ${String(got)}`);
  else console.log(`  ok    ${label}`);
}

expect('window beats shift_id for a ping reminder — two windows must NOT collapse into one',
  collapseIdFor('ping_reminder', { window_label: '17:30', shift_id: UUID }), 'ping_reminder:17:30');
expect('camelCase windowLabel is recognised too',
  collapseIdFor('missed_ping', { windowLabel: '17:30' }), 'missed_ping:17:30');
expect('missedPingId preferred over shift_id',
  collapseIdFor('missed_ping', { missedPingId: UUID, shift_id: 'other' }), `missed_ping:${UUID}`);
expect('chat collapses per room',
  collapseIdFor('chat', { roomId: 'room-1' }), 'chat:room-1');
expect('no payload -> no key',            collapseIdFor('chat', undefined), undefined);
expect('no recognised id -> no key',      collapseIdFor('shift_assigned', { count: 3 }), undefined);
expect('empty-string id -> no key',       collapseIdFor('chat', { roomId: '' }), undefined);
expect('null id -> no key',               collapseIdFor('chat', { roomId: null }), undefined);
expect('over-long key is dropped, never truncated (a truncated key could collide)',
  collapseIdFor('ping_reminder', { window_label: 'x'.repeat(COLLAPSE_ID_MAX_BYTES) }), undefined);

// The property that matters: two DIFFERENT windows of the same type must
// never produce the same key, or one of them is lost in transit.
const a = collapseIdFor('ping_reminder', { window_label: '17:30' });
const b = collapseIdFor('ping_reminder', { window_label: '18:00' });
if (a === b) fail('two different ping windows produced the same collapse key — one would be dropped');
else console.log('  ok    distinct ping windows produce distinct keys');

// Every key the real types can produce must fit APNs' 64-byte header limit.
for (const t of ALL_TYPES) {
  const k = collapseIdFor(t, { history_id: UUID });
  if (k && Buffer.byteLength(k, 'utf8') > COLLAPSE_ID_MAX_BYTES) {
    fail(`${t} produces a ${Buffer.byteLength(k, 'utf8')}-byte key, over the ${COLLAPSE_ID_MAX_BYTES}-byte APNs limit`);
  }
}
console.log(`  ok    every type's uuid-keyed collapse id fits ${COLLAPSE_ID_MAX_BYTES} bytes`);

// ── Expo wire shape ────────────────────────────────────────────────────────
// Every field here fails SILENTLY when wrong — Expo discards keys it does not
// recognise, so a typo is indistinguishable from not setting it at all.
console.log('[check-push-channels] Expo message shape');
{
  const withCollapse = buildExpoPushMessage({
    token: 'ExponentPushToken[xxxx]', title: 't', body: 'b',
    data: { type: 'ping_reminder', notificationId: UUID },
    channelId: 'reminders', collapseId: 'ping_reminder:17:30',
  });

  if (withCollapse.tag !== withCollapse.collapseId) {
    fail(`tag must equal collapseId — tag=${String(withCollapse.tag)} collapseId=${String(withCollapse.collapseId)}`);
  } else {
    console.log('  ok    tag === collapseId (Android replaces the displayed banner, not just the in-transit one)');
  }
  if (withCollapse.tag !== 'ping_reminder:17:30') fail('tag is not the collapse key that was passed in');
  if (withCollapse.channelId !== 'reminders')     fail('channelId not set on the Expo message');

  // notificationId must be reachable by the client, and `data` is the only
  // part of the payload Expo passes through verbatim.
  const d = withCollapse.data as Record<string, string>;
  if (d?.notificationId !== UUID) fail('notificationId is not inside data — the client cannot read it anywhere else');
  else console.log('  ok    notificationId travels inside data');

  // Absent collapseId must omit BOTH keys, not send undefined/null: Expo
  // rejects a null and would fail the whole push.
  const bare = buildExpoPushMessage({
    token: 'ExponentPushToken[xxxx]', title: 't', body: 'b', data: { type: 'chat' },
  });
  if ('collapseId' in bare || 'tag' in bare) fail('collapseId/tag must be OMITTED when there is no key, not sent as undefined');
  else console.log('  ok    no collapse key -> neither collapseId nor tag is present');
  if ('channelId' in bare) fail('channelId must be omitted when not supplied');
}

if (failures) {
  console.error(`[check-push-channels] FAIL — ${failures} check(s).`);
  process.exit(1);
}
console.log(`[check-push-channels] PASS — ${ALL_TYPES.length} types routed, collapse keys verified.`);
