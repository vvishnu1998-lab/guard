/**
 * Unread-count store — drives the tab-bar badges on the home screen
 * (Notifications icon, Chat icon). Refreshed on app start, on push
 * received, on tab focus, and after any mark-read action.
 *
 * Chat total = sum of unread_count across all rooms (server-side derived
 * from chat_room_reads.last_read_at).
 *
 * Notification total (post walk-test 2026-07-09 BUG C fix) = unread rows
 * in the notifications table PLUS pending + accepted-not-arrived rows in
 * /shifts/inbound-swap-requests. Without the swap component, tapping
 * ACCEPT on a handoff push left the ALERTS badge stale until the
 * recipient physically clocked in.
 */
import { create } from 'zustand';
import * as Sentry from '@sentry/react-native';
import { apiClient } from '../lib/apiClient';

interface ChatRoomLite { unread_count: number | string }
interface InboundSwapLite { history_id: string }

interface UnreadStore {
  notificationUnread: number;
  chatUnread:         number;
  refresh:            () => Promise<void>;
  bumpNotifications:  (delta?: number) => void;
  bumpChat:           (delta?: number) => void;
  resetNotifications: () => void;
}

export const useUnreadStore = create<UnreadStore>((set) => ({
  notificationUnread: 0,
  chatUnread:         0,

  refresh: async () => {
    try {
      const [notifResult, chatRooms, inboundSwaps] = await Promise.all([
        apiClient.get<{ count: number }>('/notifications/unread-count'),
        apiClient.get<ChatRoomLite[]>('/chat/rooms'),
        apiClient.get<InboundSwapLite[]>('/shifts/inbound-swap-requests').catch(() => [] as InboundSwapLite[]),
      ]);
      const chatTotal = chatRooms.reduce(
        (sum, r) => sum + Number(r.unread_count ?? 0),
        0,
      );
      const notifRaw   = notifResult?.count ?? 0;
      const swapCount  = inboundSwaps.length;
      const notifTotal = notifRaw + swapCount;
      Sentry.addBreadcrumb({
        category: 'unread_store',
        message: 'refresh',
        level: 'info',
        data: {
          notifications_unread: notifRaw,
          inbound_swaps:        swapCount,
          notif_total:          notifTotal,
          chat_total:           chatTotal,
        },
      });
      set({
        notificationUnread: notifTotal,
        chatUnread:         chatTotal,
      });
    } catch (err) {
      // network failure is fine — keep showing the last value we had
      console.warn('[unread] refresh failed:', err);
      Sentry.captureException(err, { extra: { where: 'unreadStore.refresh' } });
    }
  },

  // Optimistic bumps so badges update before the next refresh round-trip
  bumpNotifications: (delta = 1) =>
    set((s) => ({ notificationUnread: Math.max(0, s.notificationUnread + delta) })),
  bumpChat: (delta = 1) =>
    set((s) => ({ chatUnread: Math.max(0, s.chatUnread + delta) })),

  resetNotifications: () => set({ notificationUnread: 0 }),
}));
