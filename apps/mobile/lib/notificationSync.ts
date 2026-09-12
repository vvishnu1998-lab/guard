/**
 * Keep the OS notification tray and the app icon badge in agreement with the
 * server's view of what the guard still owes.
 *
 * WHY THIS EXISTS. Before this module the app called a dismissal API in
 * exactly one place — lib/pingFollowUp.ts, for ping windows only, from one
 * screen — and never called setBadgeCountAsync at all, while
 * _layout.tsx's handler sets `shouldSetBadge: true`. The result was the
 * 2026-09-12 audit's Bug 1: a guard submits a report, completes a task or
 * clocks in, the action is recorded, and the banner that asked for it sits in
 * Notification Center until swiped by hand. The icon badge only ever counted
 * up.
 *
 * THE AUTHORITY IS THE SERVER, NOT THE CLIENT. `GET /notifications` is
 * already filtered by SHIFT_SCOPED_AND_NOT_COMPLETED, so "what is still
 * outstanding" is a question the API answers. Deriving it locally would be a
 * second source of truth and would get the auto-erase rules wrong — several
 * of them join tables the app cannot see (missed_pings.resolved_at,
 * geofence_violations.resolved_at, task_instances.status).
 *
 * The visible set is `visibleNotifications()` from lib/notificationSections —
 * the same helper the Alerts tab renders through. Reusing it is what makes
 * the tray and the in-app list agree by construction rather than by two
 * implementations that must be kept in step, and it is why dismissing a row
 * in the Alerts tab (which stamps read_at) also clears its tray banner on the
 * next reconcile.
 *
 * FAILS CLOSED. Every dismissal is gated behind a successful read of the live
 * list. A network error, a 401, a malformed body — all throw before any
 * dismissal runs, so the worst case is the stale banner that is already
 * today's behaviour. Wiping a guard's tray because a fetch failed would be a
 * far worse bug than the one this fixes.
 *
 * The decision itself lives in lib/notificationTray.ts, which imports nothing
 * from React Native so it can be proven on a laptop. This module is the I/O
 * half: fetch, dismiss, badge, breadcrumb.
 */
import * as Notifications from 'expo-notifications';
import * as Sentry from '@sentry/react-native';
import { apiClient } from './apiClient';
import { visibleNotifications } from './notificationSections';
import { useUnreadStore } from '../store/unreadStore';
import {
  buildLiveIndex,
  shouldDismiss,
  LiveNotificationRow,
  PresentedLike,
} from './notificationTray';

/** Narrow a real presented notification to what the predicate reads. */
function toPresentedLike(n: Notifications.Notification): PresentedLike {
  return {
    identifier: n.request.identifier,
    data:       n.request?.content?.data as Record<string, unknown> | undefined,
  };
}

/**
 * Clear every delivered notification the server no longer considers
 * outstanding.
 *
 * Never throws. Never dismisses anything unless the live list was read
 * successfully first.
 */
export async function reconcileTray(): Promise<void> {
  try {
    const rows      = await apiClient.get<LiveNotificationRow[]>('/notifications');
    const live      = buildLiveIndex(visibleNotifications(rows));
    const presented = await Notifications.getPresentedNotificationsAsync();

    const doomed = presented.filter((n) => shouldDismiss(toPresentedLike(n), live));
    if (!doomed.length) return;

    await Promise.all(
      doomed.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
    );

    const types = doomed.map(
      (n) => ((n.request?.content?.data as Record<string, unknown> | undefined)?.type as string) ?? 'unknown',
    );
    Sentry.addBreadcrumb({
      category: 'tray_sync',
      message:  `reconcileTray dismissed ${doomed.length}`,
      level:    'info',
      data: {
        dismissed: doomed.length,
        presented: presented.length,
        live_rows: live.ids.size,
        types:     Array.from(new Set(types)).join(','),
      },
    });
  } catch (err) {
    // Best-effort by design: a failed reconcile leaves the tray exactly as it
    // was, which is the pre-fix behaviour. It must never surface to the guard
    // or fail the action that triggered it.
    Sentry.addBreadcrumb({
      category: 'tray_sync',
      message:  'reconcileTray failed — tray left untouched',
      level:    'warning',
      data:     { error: String(err) },
    });
    console.warn('[tray] reconcile failed (non-fatal):', err);
  }
}

/**
 * Point the OS app-icon badge at the same number the in-app badge shows.
 *
 * Deliberately sourced from unreadStore rather than a bare
 * `/notifications/unread-count`: the in-app count is
 * `unread-count + inbound swap requests`, plus a separate chat total
 * (store/unreadStore.ts). Reading only the endpoint would put a different
 * number on the springboard than the one inside the app, for the swap and
 * chat cases — two badges disagreeing is worse than one badge missing.
 *
 * `refresh()` swallows its own network errors and keeps the last known value,
 * so a failure here re-stamps the previous count rather than zeroing it.
 */
export async function syncBadge(): Promise<void> {
  try {
    await useUnreadStore.getState().refresh();
    const { notificationUnread, chatUnread } = useUnreadStore.getState();
    await Notifications.setBadgeCountAsync(notificationUnread + chatUnread);
  } catch (err) {
    console.warn('[tray] badge sync failed (non-fatal):', err);
  }
}

/**
 * Reconcile the tray, then re-stamp the badge. The pair every success path
 * wants, in the order that matters: dismiss first, so the count is taken
 * after the server has been told the action landed.
 *
 * Both halves swallow their own errors, so this never throws and never needs
 * awaiting for correctness — call sites that are about to navigate away can
 * fire it without blocking the transition.
 */
export async function syncTrayAndBadge(): Promise<void> {
  await reconcileTray();
  await syncBadge();
}

/**
 * Clear the delivered chat banners for one room, then re-stamp the badge.
 *
 * Chat is excluded from reconcileTray because an unread message is not a
 * completed action — opening the room is what resolves it. `roomId` is
 * compared as a string because Expo push payload values arrive stringified.
 */
export async function dismissChatRoom(roomId: string): Promise<void> {
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    const doomed = presented.filter((n) => {
      const d = n.request?.content?.data as Record<string, unknown> | undefined;
      return d?.type === 'chat' && String(d?.roomId ?? '') === String(roomId);
    });
    if (doomed.length) {
      await Promise.all(
        doomed.map((n) => Notifications.dismissNotificationAsync(n.request.identifier)),
      );
      Sentry.addBreadcrumb({
        category: 'tray_sync',
        message:  `dismissChatRoom dismissed ${doomed.length}`,
        level:    'info',
        data:     { dismissed: doomed.length, room_id: roomId },
      });
    }
  } catch (err) {
    console.warn('[tray] chat dismissal failed (non-fatal):', err);
  }
  await syncBadge();
}
