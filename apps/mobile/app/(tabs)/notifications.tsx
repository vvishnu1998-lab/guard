/**
 * Notifications Tab — feed of every push the guard has received
 * (ping, activity report, task, chat, geofence breach).
 *
 * Fetches GET /api/notifications. Mark-all-read fires on every focus so
 * the home-tab badge resets the moment the guard opens the tab; the
 * "isRead" visual treatment is preserved on individual rows until refresh.
 * Tap routes to the relevant screen via the shared navigateForNotification
 * helper (also used by the OS push-tap listener).
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, SectionList, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { apiClient } from '../../lib/apiClient';
import { navigateForNotification } from '../../lib/navigateForNotification';
import { useUnreadStore } from '../../store/unreadStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

type NotificationType =
  | 'ping_reminder'
  | 'activity_report_reminder'
  | 'task_reminder'
  | 'chat'
  | 'geofence_breach';

interface NotificationRow {
  id:         string;
  type:       NotificationType;
  title:      string;
  body:       string;
  data:       Record<string, any>;
  read_at:    string | null;
  created_at: string;
}

interface VisualSpec {
  icon:        string;
  titleColor:  string;
  borderColor: string;
}

const VISUAL_BY_TYPE: Record<NotificationType, VisualSpec> = {
  ping_reminder:            { icon: '📍', titleColor: Colors.action,  borderColor: Colors.action },
  activity_report_reminder: { icon: '📝', titleColor: Colors.action,  borderColor: Colors.action },
  task_reminder:            { icon: '✅', titleColor: Colors.action,  borderColor: Colors.action },
  chat:                     { icon: '💬', titleColor: Colors.action,  borderColor: Colors.action },
  geofence_breach:          { icon: '🔴', titleColor: Colors.danger,  borderColor: Colors.danger },
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

interface Section {
  title: string;
  data:  NotificationRow[];
}

export default function NotificationsScreen() {
  const [rows,       setRows]       = useState<NotificationRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const { resetNotifications, refresh } = useUnreadStore();

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await apiClient.get<NotificationRow[]>('/notifications');
      setRows(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load notifications');
    }
  }, []);

  // On every focus: refetch + server-side mark-all-read + reset local badge.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      (async () => {
        await fetchNotifications();
        try {
          await apiClient.post('/notifications/mark-all-read');
          resetNotifications();
        } catch { /* badge will resync on next refresh */ }
        setLoading(false);
      })();
    }, [fetchNotifications, resetNotifications]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await fetchNotifications();
    await refresh();
    setRefreshing(false);
  }

  function handleTap(row: NotificationRow) {
    navigateForNotification(row.type, row.data);
  }

  // Group into TODAY / YESTERDAY / EARLIER
  const now = new Date();
  const todayStart     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86_400_000);

  const todayRows     = rows.filter((r) => new Date(r.created_at) >= todayStart);
  const yesterdayRows = rows.filter((r) => {
    const d = new Date(r.created_at);
    return d >= yesterdayStart && d < todayStart;
  });
  const earlierRows = rows.filter((r) => new Date(r.created_at) < yesterdayStart);

  const sections: Section[] = [
    ...(todayRows.length     > 0 ? [{ title: 'TODAY',     data: todayRows     }] : []),
    ...(yesterdayRows.length > 0 ? [{ title: 'YESTERDAY', data: yesterdayRows }] : []),
    ...(earlierRows.length   > 0 ? [{ title: 'EARLIER',   data: earlierRows   }] : []),
  ];

  function renderItem({ item }: { item: NotificationRow }) {
    const spec = VISUAL_BY_TYPE[item.type] ?? VISUAL_BY_TYPE.chat;
    const isUnread = !item.read_at;
    return (
      <TouchableOpacity
        style={[styles.card, { borderLeftColor: spec.borderColor }, isUnread && styles.cardUnread]}
        onPress={() => handleTap(item)}
        activeOpacity={0.7}
      >
        <View style={styles.cardRow}>
          <Text style={styles.cardIcon}>{spec.icon}</Text>
          <View style={{ flex: 1 }}>
            <View style={styles.cardTitleRow}>
              <Text style={[styles.cardTitle, { color: spec.titleColor }]}>{item.title}</Text>
              {isUnread && <View style={styles.unreadDot} />}
            </View>
            <Text style={styles.cardSubtitle}>{timeAgo(item.created_at)}</Text>
            <Text style={styles.cardDesc}>{item.body}</Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>NOTIFICATIONS</Text>
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={Colors.action} size="large" />
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={onRefresh}>
            <Text style={styles.retryText}>RETRY</Text>
          </TouchableOpacity>
        </View>
      ) : sections.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>🔔</Text>
          <Text style={styles.emptyText}>No notifications</Text>
          <Text style={styles.emptySub}>Reminders and alerts will appear here</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          renderSectionHeader={({ section }) => (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionLabel}>{section.title}</Text>
            </View>
          )}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
          stickySectionHeadersEnabled={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.action} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  header: {
    paddingHorizontal: Spacing.lg,
    paddingTop: 60,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  title: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 24,
    letterSpacing: 4,
  },

  listContent: { padding: Spacing.md },

  sectionHeader: {
    paddingVertical: Spacing.sm,
    paddingHorizontal: 2,
    marginTop: Spacing.sm,
    marginBottom: Spacing.xs,
  },
  sectionLabel: {
    fontFamily: Fonts.heading,
    color: Colors.muted,
    fontSize: 11,
    letterSpacing: 3,
  },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    borderLeftWidth: 3,
    padding: Spacing.md,
  },
  cardUnread: {
    backgroundColor: Colors.surface2,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: Spacing.sm,
  },
  cardIcon: {
    fontSize: 22,
    marginTop: 1,
  },
  cardTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.xs,
    marginBottom: 2,
  },
  cardTitle: {
    fontFamily: Fonts.heading,
    fontSize: 15,
    letterSpacing: 0.5,
  },
  unreadDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: Colors.action,
    marginLeft: 4,
  },
  cardSubtitle: {
    color: Colors.muted,
    fontSize: 12,
    marginBottom: 4,
    letterSpacing: 0.3,
  },
  cardDesc: {
    color: Colors.textPrimary,
    fontSize: 13,
    lineHeight: 19,
    opacity: 0.85,
  },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  emptyIcon: { fontSize: 48, marginBottom: Spacing.md },
  emptyText: { color: Colors.textPrimary, fontSize: 18, marginBottom: Spacing.xs },
  emptySub: { color: Colors.muted, fontSize: 13, textAlign: 'center' },
  errorText: { color: Colors.textPrimary, fontSize: 15, textAlign: 'center', marginBottom: Spacing.lg },
  retryBtn: { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  retryText: { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 14, letterSpacing: 2 },
});
