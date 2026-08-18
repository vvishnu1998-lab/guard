/**
 * Notifications Tab — feed of every push the guard has received
 * (ping, activity report, task, chat, geofence breach).
 *
 * Dismissal model (Build 44): read_at means DISMISSED, and only the guard
 * sets it.
 *
 * It used to mean "seen": mark-all-read fired on every focus, so the badge
 * zeroed itself the instant the tab was opened and every alert the guard had
 * ever received stayed in the list forever. A four-day-old "you're 15 min
 * late" sat next to today's. read_at could not mean both "seen" and
 * "dismissed", so the auto-mark is gone and read_at now carries the single
 * meaning the dismissal feature needs.
 *
 * Consequences, deliberately accepted:
 *   * The badge no longer clears on a glance. It clears when the guard
 *     dismisses something, which is the point — a badge that clears itself
 *     communicates nothing.
 *   * GET /notifications returns read AND unread rows, so dismissed items are
 *     filtered out client-side on read_at. No server change, no DELETE route,
 *     and the row survives as the record of what the guard was told.
 *
 * Tap still routes via navigateForNotification (shared with the OS push-tap
 * listener) and deliberately does NOT dismiss — acting on an alert and
 * clearing it are different intentions.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, SectionList, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { apiClient } from '../../lib/apiClient';
import { navigateForNotification } from '../../lib/navigateForNotification';
import { useUnreadStore } from '../../store/unreadStore';
import { visibleNotifications, groupNotifications } from '../../lib/notificationSections';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

type NotificationType =
  | 'ping_reminder'
  | 'activity_report_reminder'
  | 'task_reminder'
  | 'chat'
  | 'geofence_breach'
  // Phase 1A / A2 additions.
  | 'off_post_report'
  | 'off_post_task'
  | 'missed_ping'
  | 'missed_report'
  | 'late_clock_in'
  // Merged from batch/mobile-3 for the unified-feed model (option B).
  // Swap family — pre-shift guard-to-guard swap invites + outcomes.
  | 'swap_request_received'
  | 'swap_request_sent'
  | 'swap_accepted'
  | 'swap_declined'
  | 'swap_expired'
  // Handoff family — mid-shift transfer.
  | 'handoff_request_received'
  | 'handoff_request_sent'
  | 'handoff_accepted'
  | 'handoff_declined'
  | 'handoff_cancelled'
  | 'handoff_complete'
  | 'handoff_nudge'
  | 'handoff_expired';

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

// Amber = user needs to know but nothing is on fire (off-post accepted,
// late clock-in reminder). Red = an obligation is UNMET RIGHT NOW
// (active breach, missed ping/report window).
const AMBER = Colors.action;
const RED   = Colors.danger;

const VISUAL_BY_TYPE: Record<NotificationType, VisualSpec> = {
  ping_reminder:            { icon: '📍', titleColor: AMBER, borderColor: AMBER },
  activity_report_reminder: { icon: '📝', titleColor: AMBER, borderColor: AMBER },
  task_reminder:            { icon: '✅', titleColor: AMBER, borderColor: AMBER },
  chat:                     { icon: '💬', titleColor: AMBER, borderColor: AMBER },
  geofence_breach:          { icon: '🚨', titleColor: RED,   borderColor: RED   },
  off_post_report:          { icon: '⚠️', titleColor: AMBER, borderColor: AMBER },
  off_post_task:            { icon: '⚠️', titleColor: AMBER, borderColor: AMBER },
  missed_ping:              { icon: '📍', titleColor: RED,   borderColor: RED   },
  missed_report:            { icon: '📝', titleColor: RED,   borderColor: RED   },
  late_clock_in:            { icon: '⏰', titleColor: AMBER, borderColor: AMBER },
  // Swap family — 🔄 amber. All variants share the icon so the row
  // header can still say the actual status (title comes from server).
  swap_request_received:    { icon: '🔄', titleColor: AMBER, borderColor: AMBER },
  swap_request_sent:        { icon: '🔄', titleColor: AMBER, borderColor: AMBER },
  swap_accepted:            { icon: '🔄', titleColor: AMBER, borderColor: AMBER },
  swap_declined:            { icon: '🔄', titleColor: AMBER, borderColor: AMBER },
  swap_expired:             { icon: '🔄', titleColor: AMBER, borderColor: AMBER },
  // Handoff family — 🤝 amber. Same convention.
  handoff_request_received: { icon: '🤝', titleColor: AMBER, borderColor: AMBER },
  handoff_request_sent:     { icon: '🤝', titleColor: AMBER, borderColor: AMBER },
  handoff_accepted:         { icon: '🤝', titleColor: AMBER, borderColor: AMBER },
  handoff_declined:         { icon: '🤝', titleColor: AMBER, borderColor: AMBER },
  handoff_cancelled:        { icon: '🤝', titleColor: AMBER, borderColor: AMBER },
  handoff_complete:         { icon: '🤝', titleColor: AMBER, borderColor: AMBER },
  handoff_nudge:            { icon: '🤝', titleColor: AMBER, borderColor: AMBER },
  handoff_expired:          { icon: '🤝', titleColor: AMBER, borderColor: AMBER },
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

export default function NotificationsScreen() {
  const [rows,       setRows]       = useState<NotificationRow[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const { refresh } = useUnreadStore();

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await apiClient.get<NotificationRow[]>('/notifications');
      setRows(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load notifications');
    }
  }, []);

  // Refetch on focus. No mark-all-read here any more — opening the tab is not
  // dismissal, and the badge must survive a glance.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      (async () => {
        await fetchNotifications();
        setLoading(false);
      })();
    }, [fetchNotifications]),
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

  /**
   * Dismiss one row. Optimistic: it leaves the list immediately, because a row
   * that lingers after a deliberate dismiss reads as a failure.
   *
   * A 404 from POST /:id/read means the row was ALREADY read — the endpoint
   * matches on `read_at IS NULL`. That is the desired end state, so it is
   * treated as success rather than rolled back. Any other failure restores the
   * row so the guard is not told something was cleared when it was not.
   */
  async function dismissOne(row: NotificationRow) {
    setRows((prev) => prev.filter((r) => r.id !== row.id));
    try {
      await apiClient.post(`/notifications/${row.id}/read`);
    } catch (err: any) {
      if (err?.status !== 404) {
        setRows((prev) =>
          prev.some((r) => r.id === row.id)
            ? prev
            : [...prev, row].sort(
                (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
              ),
        );
        Alert.alert('Could not dismiss', 'Please try again.');
        return;
      }
    }
    // refresh() rather than resetNotifications(): the badge is unread
    // notifications PLUS pending inbound swap/handoff requests, so it is not
    // this screen's to zero. Ask the server what it should be.
    refresh();
  }

  /** Clear every visible alert — the same mark-all-read that used to fire
   *  automatically on focus, now an explicit choice. */
  function clearAll() {
    const snapshot = visibleRows;
    if (snapshot.length === 0) return;
    Alert.alert(
      'Clear all alerts?',
      `${snapshot.length} alert${snapshot.length === 1 ? '' : 's'} will be cleared from this list.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          onPress: async () => {
            const ids = new Set(snapshot.map((r) => r.id));
            setRows((prev) => prev.filter((r) => !ids.has(r.id)));
            try {
              await apiClient.post('/notifications/mark-all-read');
            } catch {
              await fetchNotifications();
              Alert.alert('Could not clear', 'Please try again.');
              return;
            }
            refresh();
          },
        },
      ],
    );
  }

  // Dismissed rows are filtered out here — see lib/notificationSections.ts.
  const visibleRows = useMemo(() => visibleNotifications(rows), [rows]);
  const sections    = useMemo(() => groupNotifications(visibleRows, Date.now()), [visibleRows]);

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
          {/* Dismiss. A muted ✕ rather than a red swipe-to-delete: this hides
              an alert, it does not destroy the record, and destructive styling
              would misrepresent that. Explicit control rather than swipe so it
              is discoverable — nothing else in this app teaches a swipe
              gesture — and so it cannot fire from a stray horizontal drag on a
              list the guard is scrolling. hitSlop keeps the 20px glyph tappable
              without enlarging the visual. */}
          <TouchableOpacity
            onPress={() => dismissOne(item)}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            accessibilityLabel={`Dismiss ${item.title}`}
            accessibilityRole="button"
            style={styles.dismissBtn}
          >
            <Text style={styles.dismissIcon}>✕</Text>
          </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header. CLEAR ALL only appears when there is something to clear, so
          the affordance never invites a no-op. */}
      <View style={styles.header}>
        <Text style={styles.title}>NOTIFICATIONS</Text>
        {visibleRows.length > 0 && (
          <TouchableOpacity onPress={clearAll} accessibilityRole="button" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
            <Text style={styles.clearAllText}>CLEAR ALL</Text>
          </TouchableOpacity>
        )}
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
          {/* One empty state for both "nothing has arrived yet" and "you
              cleared everything" — the guard cannot tell them apart and does
              not need to. Reads as settled, not broken. */}
          <Text style={styles.emptyIcon}>🔔</Text>
          <Text style={styles.emptyText}>You're all caught up</Text>
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
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  // Cyan (the app's action colour), not danger red — clearing is a normal
  // action, not a destructive one.
  clearAllText: {
    fontFamily: Fonts.heading,
    color: Colors.action,
    fontSize: 12,
    letterSpacing: 2,
    paddingBottom: 3,
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
  dismissBtn: { paddingLeft: Spacing.xs, marginTop: -2 },
  dismissIcon: { color: Colors.muted, fontSize: 20, lineHeight: 22 },
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
