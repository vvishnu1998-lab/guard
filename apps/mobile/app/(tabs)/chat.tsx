/**
 * Guard — Chat list screen
 * Shows all chat rooms for the logged-in guard with last message preview and unread badge.
 * Tapping a room navigates to /chat/[roomId].
 */
import { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

interface ChatRoom {
  id:              string;
  site_id:         string;
  site_name:       string;
  guard_id:        string;
  guard_name:      string;
  last_message:    string | null;
  last_message_at: string | null;
  unread_count:    number;
}

function fmtTs(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (diffDays === 0) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return 'Yesterday';
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' });
}

export default function ChatListScreen() {
  const [rooms,   setRooms]   = useState<ChatRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get<ChatRoom[]>('/chat/rooms');
      setRooms(data);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load chats');
    } finally {
      setLoading(false);
    }
  }, []);

  // C4: refetch on every screen focus so last-message preview is always current
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      load();
    }, [load])
  );

  function renderRoom({ item }: { item: ChatRoom }) {
    return (
      <TouchableOpacity
        style={styles.roomRow}
        onPress={() => router.push(`/chat/${item.id}`)}
        activeOpacity={0.7}
      >
        {/* Avatar */}
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {item.site_name.charAt(0).toUpperCase()}
          </Text>
        </View>

        {/* Content */}
        <View style={styles.roomContent}>
          <View style={styles.roomTop}>
            <Text style={styles.siteName} numberOfLines={1}>{item.site_name}</Text>
            <Text style={styles.timestamp}>{fmtTs(item.last_message_at)}</Text>
          </View>
          <View style={styles.roomBottom}>
            <Text style={styles.lastMsg} numberOfLines={1}>
              {item.last_message ?? 'No messages yet'}
            </Text>
            {item.unread_count > 0 && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>{Math.min(item.unread_count, 99)}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>CHAT</Text>
      </View>

      {loading ? (
        <ActivityIndicator color={Colors.action} style={{ marginTop: Spacing.xl }} />
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity onPress={load} style={styles.retryBtn}>
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : rooms.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>💬</Text>
          <Text style={styles.emptyText}>No chats yet</Text>
          <Text style={styles.emptySub}>Your admin will start a conversation with you</Text>
        </View>
      ) : (
        <FlatList
          data={rooms}
          keyExtractor={(item) => item.id}
          renderItem={renderRoom}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          showsVerticalScrollIndicator={false}
          onRefresh={load}
          refreshing={loading}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  header: {
    paddingTop: 54,
    paddingBottom: Spacing.sm,
    paddingHorizontal: Spacing.md,
    backgroundColor: Colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: {
    fontFamily: Fonts.heading,
    color: Colors.action,
    fontSize: 26,
    letterSpacing: 5,
  },

  roomRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    backgroundColor: Colors.bg,
    gap: Spacing.md,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.action + '22',
    borderWidth: 1,
    borderColor: Colors.action + '44',
    alignItems: 'center',
    justifyContent: 'center',
    shrink: 0,
  } as any,
  avatarText: {
    fontFamily: Fonts.heading,
    color: Colors.action,
    fontSize: 18,
  },
  roomContent: { flex: 1, minWidth: 0 },
  roomTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 },
  siteName: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 14,
    letterSpacing: 0.5,
    flex: 1,
    marginRight: Spacing.sm,
  },
  timestamp: { color: Colors.muted, fontSize: 11 },
  roomBottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  lastMsg: { color: Colors.muted, fontSize: 13, flex: 1, marginRight: Spacing.sm },
  badge: {
    backgroundColor: Colors.action,
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 5,
  },
  badgeText: { color: Colors.bg, fontSize: 11, fontFamily: Fonts.heading },

  separator: { height: 1, backgroundColor: Colors.border, marginLeft: 62 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  emptyIcon: { fontSize: 48, marginBottom: Spacing.md },
  emptyText: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 18, letterSpacing: 2, marginBottom: Spacing.sm },
  emptySub: { color: Colors.muted, fontSize: 13, textAlign: 'center' },
  errorText: { color: Colors.danger, fontSize: 14, marginBottom: Spacing.sm, textAlign: 'center' },
  retryBtn: { padding: Spacing.sm },
  retryText: { color: Colors.action, fontSize: 14 },
});
