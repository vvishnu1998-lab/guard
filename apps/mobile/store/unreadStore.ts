/**
 * Unread-count store — drives the tab-bar badges on the home screen
 * (Notifications icon, Chat icon). Refreshed on app start, on push
 * received, on tab focus, and after any mark-read action.
 *
 * Chat total = sum of unread_count across all rooms (server-side derived
 * from chat_room_reads.last_read_at). Notification total = unread rows
 * in the notifications table for this guard.
 */
import { create } from 'zustand';
import { apiClient } from '../lib/apiClient';

interface ChatRoomLite { unread_count: number | string }

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
      const [notifResult, chatRooms] = await Promise.all([
        apiClient.get<{ count: number }>('/notifications/unread-count'),
        apiClient.get<ChatRoomLite[]>('/chat/rooms'),
      ]);
      const chatTotal = chatRooms.reduce(
        (sum, r) => sum + Number(r.unread_count ?? 0),
        0,
      );
      set({
        notificationUnread: notifResult?.count ?? 0,
        chatUnread:         chatTotal,
      });
    } catch (err) {
      // network failure is fine — keep showing the last value we had
      console.warn('[unread] refresh failed:', err);
    }
  },

  // Optimistic bumps so badges update before the next refresh round-trip
  bumpNotifications: (delta = 1) =>
    set((s) => ({ notificationUnread: Math.max(0, s.notificationUnread + delta) })),
  bumpChat: (delta = 1) =>
    set((s) => ({ chatUnread: Math.max(0, s.chatUnread + delta) })),

  resetNotifications: () => set({ notificationUnread: 0 }),
}));
