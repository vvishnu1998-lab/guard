/**
 * What happens AFTER a ping lands: clear the OS notifications the guard has
 * already acted on, and work out what — if anything — they still owe.
 *
 * Both halves exist because of the 2026-08-20 SFMTA forensics. A guard
 * backfilled the 17:00 window at 17:39 and the app said only "Photo and
 * location saved", leaving him to guess whether the 17:30 window he had
 * NOT answered was still outstanding. Meanwhile the delivered iOS banner
 * for a window he HAD just answered stayed in Notification Center, because
 * nothing in this app has ever called a dismissal API.
 */
import * as Notifications from 'expo-notifications';
import { apiClient } from './apiClient';

/**
 * A ping/missed-ping notification's window, whichever casing the producer
 * used. The API is not consistent: jobs/pingReminder.ts writes snake_case
 * `window_label`, jobs/missedPingCron.ts writes camelCase `windowLabel`.
 * The server-side auto-erase COALESCEs both for the same reason.
 */
function windowOf(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const v = d.window_label ?? d.windowLabel;
  return typeof v === 'string' && v ? v : null;
}

const PING_TYPES = new Set(['ping_reminder', 'missed_ping']);

/**
 * Drop any DELIVERED notification for `label` from the OS tray /
 * Notification Center.
 *
 * Scope, deliberately: this clears notifications the guard has now acted
 * on. It does NOT and cannot clear a banner the OS already showed and the
 * user dismissed, and it is not a substitute for the in-app Alerts feed,
 * which is server-filtered. iOS keeps delivered notifications until
 * something dismisses them — this is that something.
 *
 * Never throws: a ping that succeeded must not surface an error because
 * tray cleanup failed. Worst case the stale banner stays, which is exactly
 * today's behaviour.
 */
export async function dismissWindowNotifications(label: string | null): Promise<void> {
  if (!label) return;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const doomed = presented.filter((n) => {
      const data = n.request?.content?.data;
      const type = (data as Record<string, unknown> | undefined)?.type;
      return (
        typeof type === 'string' &&
        PING_TYPES.has(type) &&
        windowOf(data) === label
      );
    });
    await Promise.all(
      doomed.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
    );
    if (doomed.length) console.log(`[ping] dismissed ${doomed.length} delivered notification(s) for ${label}`);
  } catch (err) {
    console.warn('[ping] notification dismissal failed (non-fatal):', err);
  }
}

export type Outstanding =
  | { kind: 'none' }
  | { kind: 'due'; label: string }
  /** The feed could not be read — say nothing rather than guess. */
  | { kind: 'unknown' };

/**
 * Which ping window the guard still owes, per the SERVER.
 *
 * Deliberately not computed locally. The client knows the current window
 * (lib/pingSchedule) but has no idea which EARLIER windows are still
 * unresolved, so a locally-derived "you're all caught up" would be a claim
 * the app cannot support — and telling a guard they are clear when a
 * missed window is open is the same class of error as the activity log
 * showing a 40-minute-late ping as "+9m".
 *
 * GET /notifications is already the authority here: its ping_reminder arm
 * is window-keyed and its missed_ping arm keys on
 * missed_pings.resolved_at, both stamped in the same transaction as the
 * ping we just submitted — so by the time this runs the feed already
 * reflects it. No race, and no second source of truth.
 *
 * ORDERING NOTE: the window-keyed ping_reminder erase is an API change
 * shipping ahead of this app build. Against an older API the reminder arm
 * is window-BLIND and would under-report what is outstanding, so this must
 * not ship to devices before that API deploy.
 */
export async function outstandingPingWindow(): Promise<Outstanding> {
  try {
    const rows = await apiClient.get<Array<{ type: string; data: unknown }>>('/notifications');
    const labels = rows
      .filter((r) => PING_TYPES.has(r.type))
      .map((r) => windowOf(r.data))
      .filter((l): l is string => l !== null)
      .sort();
    return labels.length ? { kind: 'due', label: labels[0] } : { kind: 'none' };
  } catch (err) {
    console.warn('[ping] outstanding-window lookup failed:', err);
    return { kind: 'unknown' };
  }
}

/**
 * The confirmation body. `recorded` distinguishes a fresh write from the
 * server's already_recorded response — a duplicate is not a failure, but
 * claiming a new ping landed when one did not is exactly the kind of
 * comfortable lie this whole change set is removing.
 */
export function confirmationMessage(args: {
  window:      string | null;
  wasLate:     boolean;
  recorded:    boolean;
  outstanding: Outstanding;
}): string {
  const { window, wasLate, recorded, outstanding } = args;

  const head = !recorded
    ? window
      ? `${window} was already recorded — no second ping was added.`
      : 'That window was already recorded — no second ping was added.'
    : window
      ? `${window} ping recorded${wasLate ? ' (late)' : ''}.`
      : `Ping recorded${wasLate ? ' (late)' : ''}.`;

  const tail =
    outstanding.kind === 'due'     ? `Your ${outstanding.label} ping is still due.`
    : outstanding.kind === 'none'  ? "You're all caught up."
    : '';                          // unknown — assert nothing

  return tail ? `${head} ${tail}` : head;
}
