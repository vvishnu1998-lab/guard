/**
 * Notifications Tab — geofence violations styled as notification feed.
 * Fetches GET /api/locations/violations (guard-scoped).
 * Groups by TODAY / YESTERDAY / EARLIER.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, SectionList, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

interface Violation {
  id:                  string;
  occurred_at:         string;
  resolved_at:         string | null;
  duration_minutes:    number | null;
  violation_lat:       number;
  violation_lng:       number;
  supervisor_override: boolean;
  site_name:           string;
}

interface NotifItem {
  id: string;
  icon: string;
  title: string;
  titleColor: string;
  subtitle: string;
  description: string;
  borderColor: string;
  occurred_at: string;
  isRead: boolean;
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function toNotifItem(v: Violation): NotifItem {
  const isOpen    = !v.resolved_at;
  const isExcused = v.supervisor_override;

  let icon = '🔴';
  let title = 'Geofence Violation';
  let titleColor: string = Colors.danger;
  let description = 'You were detected outside the site boundary.';
  let borderColor: string = Colors.danger;

  if (isExcused) {
    icon = '⚠️';
    title = 'Violation Excused';
    titleColor = Colors.warning;
    description = 'This violation was excused by a supervisor.';
    borderColor = Colors.warning;
  } else if (!isOpen) {
    icon = '✅';
    title = 'Boundary Restored';
    titleColor = Colors.success;
    description = v.duration_minutes != null
      ? `You were outside for ${Math.round(v.duration_minutes)} min. Now resolved.`
      : 'You returned within the boundary. Resolved.';
    borderColor = Colors.success;
  } else {
    description = 'You may still be outside the boundary. Return immediately.';
  }

  return {
    id: v.id,
    icon,
    title,
    titleColor,
    subtitle: `${v.site_name}  ·  ${timeAgo(v.occurred_at)}`,
    description,
    borderColor,
    occurred_at: v.occurred_at,
    isRead: !isOpen,
  };
}

interface Section {
  title: string;
  data: NotifItem[];
}

export default function NotificationsScreen() {
  const [violations,  setViolations]  = useState<Violation[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [allRead,     setAllRead]     = useState(false);

  async function fetchViolations() {
    try {
      const data = await apiClient.get<Violation[]>('/locations/violations');
      setViolations(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load notifications');
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      setAllRead(false);
      fetchViolations().finally(() => setLoading(false));
    }, [])
  );

  async function onRefresh() {
    setRefreshing(true);
    await fetchViolations();
    setRefreshing(false);
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);

  const items = violations.map(toNotifItem);

  const unreadCount = allRead ? 0 : items.filter(i => !i.isRead).length;

  // Group into sections
  const todayItems     = items.filter(i => new Date(i.occurred_at) >= todayStart);
  const yesterdayItems = items.filter(i => {
    const d = new Date(i.occurred_at);
    return d >= yesterdayStart && d < todayStart;
  });
  const earlierItems   = items.filter(i => new Date(i.occurred_at) < yesterdayStart);

  const sections: Section[] = [
    ...(todayItems.length     > 0 ? [{ title: 'TODAY',     data: todayItems     }] : []),
    ...(yesterdayItems.length > 0 ? [{ title: 'YESTERDAY', data: yesterdayItems }] : []),
    ...(earlierItems.length   > 0 ? [{ title: 'EARLIER',   data: earlierItems   }] : []),
  ];

  function renderItem({ item }: { item: NotifItem }) {
    const isUnread = !item.isRead && !allRead;
    return (
      <View style={[styles.card, { borderLeftColor: item.borderColor }, isUnread && styles.cardUnread]}>
        <View style={styles.cardRow}>
          <Text style={styles.cardIcon}>{item.icon}</Text>
          <View style={{ flex: 1 }}>
            <View style={styles.cardTitleRow}>
              <Text style={[styles.cardTitle, { color: item.titleColor }]}>{item.title}</Text>
              {isUnread && <View style={styles.unreadDot} />}
            </View>
            <Text style={styles.cardSubtitle}>{item.subtitle}</Text>
            <Text style={styles.cardDesc}>{item.description}</Text>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.title}>NOTIFICATIONS</Text>
          {unreadCount > 0 && (
            <Text style={styles.unreadCount}>{unreadCount} unread</Text>
          )}
        </View>
        <TouchableOpacity onPress={() => setAllRead(true)}>
          <Text style={styles.markReadBtn}>Mark all read</Text>
        </TouchableOpacity>
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
          <Text style={styles.emptySub}>Geofence alerts will appear here</Text>
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
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
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
  unreadCount: {
    color: Colors.action,
    fontSize: 13,
    marginTop: 2,
    letterSpacing: 0.5,
  },
  markReadBtn: {
    color: Colors.action,
    fontSize: 14,
    letterSpacing: 0.3,
    paddingBottom: 2,
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
