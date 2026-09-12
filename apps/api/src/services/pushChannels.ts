/**
 * Android notification channel routing, and collapse keys, for every
 * NotificationType.
 *
 * WHY CHANNELS. The mobile app has declared four channels since Build 34
 * (apps/mobile/lib/notifications.ts): `alerts` at AndroidImportance.MAX,
 * `reminders` and `chat` at HIGH, `default` at DEFAULT. The server has never
 * set `channelId` on a single push, so Android has been dropping every
 * notification onto `default` and three declared channels have sat unused —
 * a geofence breach arrived at exactly the weight of a chat message. The
 * mobile file's own comment says so:
 *
 *     "Server-side FCM payloads do not currently set channelId — every
 *      incoming [...] 'chat') are declared now so a future server change to
 *      set channelId per [...]"
 *
 * This is that server change. No mobile deploy is needed: the channels
 * already exist on every device running Build 34 or later, and naming one
 * that does not exist falls back to `default`, which is today's behaviour.
 *
 * WHY COLLAPSE. Reminder crons re-fire for the same window, and a guard who
 * leaves the app closed for an hour finds four identical "ping due" banners
 * stacked. `collapseId` tells Expo/FCM/APNs to coalesce undelivered messages
 * sharing a key, so the guard sees the latest one rather than a pile.
 * Verified against Expo's docs: collapseId is "Identifier for collapsing
 * notifications in transit", supported on BOTH Android and iOS — unlike
 * `channelId`, which is Android-only.
 */
import type { NotificationType } from './notifications';

export type PushChannel = 'alerts' | 'reminders' | 'chat' | 'default';

/**
 * Channel per type.
 *
 * `alerts` (MAX) is reserved for things a guard is expected to act on NOW or
 * has already failed to act on: a breach, a missed window, a late clock-in,
 * an overdue break return. `reminders` (HIGH) is the ordinary prompt — due,
 * not yet missed. `chat` is conversation. Everything absent falls to
 * `default`, which is the correct home for the informational shift-admin
 * types (assigned, cancelled, rescheduled, swap/handoff outcomes).
 */
const CHANNEL_BY_TYPE: Partial<Record<NotificationType, PushChannel>> = {
  // alerts — already-failed or safety-critical
  geofence_breach:      'alerts',
  missed_ping:          'alerts',
  missed_report:        'alerts',
  late_clock_in:        'alerts',
  break_return_overdue: 'alerts',
  off_post_report:      'alerts',
  off_post_task:        'alerts',

  // reminders — due, not yet missed
  ping_reminder:            'reminders',
  activity_report_reminder: 'reminders',
  task_reminder:            'reminders',
  pre_shift_reminder:       'reminders',
  shift_start_reminder:     'reminders',
  clock_out_reminder:       'reminders',
  break_ended:              'reminders',

  chat: 'chat',
};

export function channelForType(type: NotificationType): PushChannel {
  return CHANNEL_BY_TYPE[type] ?? 'default';
}

/** Exported for the channel test, which asserts total coverage of the union. */
export const CHANNEL_MAP_FOR_TEST = CHANNEL_BY_TYPE;

/**
 * The payload keys that identify "the thing this notification is about",
 * in priority order. First one present wins.
 *
 * Order matters where a payload carries more than one: a ping reminder has
 * both `window_label` and a shift id, and the window is what makes two of
 * them distinct — collapsing on shift_id would merge the 17:30 and 18:00
 * reminders into one and the guard would lose a window.
 */
const PRIMARY_ID_KEYS = [
  'window_label',
  'windowLabel',
  'missedPingId',
  'missedReportId',
  'task_instance_id',
  'history_id',
  'roomId',
  'violationId',
  'break_session_id',
  'shift_id',
] as const;

/**
 * `${type}:${primaryId}`, or undefined when the payload carries no id worth
 * collapsing on.
 *
 * Undefined rather than a bare type: collapsing on type alone would make two
 * genuinely different notifications of the same type replace each other —
 * two different chat rooms, two different shifts — and the guard would only
 * ever see the most recent. No key at all is the safe default; it is exactly
 * today's behaviour.
 *
 * Kept under 64 bytes because APNs rejects an `apns-collapse-id` longer than
 * that. The longest real combination is a 24-char type plus a 36-char uuid
 * and a colon = 61. A payload that somehow exceeds it is dropped rather than
 * truncated — a truncated key could collide with an unrelated notification's
 * key, which is worse than not collapsing.
 */
export const COLLAPSE_ID_MAX_BYTES = 64;

export function collapseIdFor(
  type: NotificationType | string,
  data?: Record<string, unknown>,
): string | undefined {
  if (!data) return undefined;
  for (const key of PRIMARY_ID_KEYS) {
    const v = data[key];
    if (v === undefined || v === null) continue;
    const s = String(v);
    if (!s) continue;
    const candidate = `${type}:${s}`;
    if (Buffer.byteLength(candidate, 'utf8') > COLLAPSE_ID_MAX_BYTES) return undefined;
    return candidate;
  }
  return undefined;
}
