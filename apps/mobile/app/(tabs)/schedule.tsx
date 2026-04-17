/**
 * Schedule Tab — guard's upcoming and recent shifts.
 * Fetches GET /api/shifts (guard-scoped, returns last 50).
 * Groups into UPCOMING (future scheduled) and RECENT (completed/missed).
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

interface Shift {
  id:               string;
  site_id:          string;
  site_name:        string;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'scheduled' | 'active' | 'completed' | 'missed';
}

const STATUS_COLOR: Record<string, string> = {
  scheduled: Colors.action,
  active:    Colors.success,
  completed: Colors.muted,
  missed:    '#EF4444',
};

export default function ScheduleScreen() {
  const [shifts,     setShifts]     = useState<Shift[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  async function fetchShifts() {
    try {
      const data = await apiClient.get<Shift[]>('/shifts');
      setShifts(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load schedule');
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchShifts().finally(() => setLoading(false));
    }, [])
  );

  async function onRefresh() {
    setRefreshing(true);
    await fetchShifts();
    setRefreshing(false);
  }

  const now = new Date();
  // A shift is only "upcoming/active" if its end time is in the future AND status warrants it
  const upcoming = shifts.filter((s) =>
    (s.status === 'scheduled' || s.status === 'active') &&
    new Date(s.scheduled_end) > now
  );
  const recent = shifts.filter((s) =>
    s.status === 'completed' || s.status === 'missed' ||
    // Treat past active/scheduled shifts as completed on the frontend
    ((s.status === 'scheduled' || s.status === 'active') && new Date(s.scheduled_end) <= now)
  );

  function fmtDate(iso: string) {
    return new Date(iso).toLocaleDateString('en-GB', {
      weekday: 'short', day: '2-digit', month: 'short',
    });
  }

  function fmtTime(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function duration(start: string, end: string) {
    const h = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
    return `${h.toFixed(1)}h`;
  }

  function renderShift({ item }: { item: Shift }) {
    const color = STATUS_COLOR[item.status] ?? Colors.muted;
    return (
      <View style={[styles.card, { borderLeftColor: color }]}>
        <View style={styles.cardRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.siteName}>{item.site_name.toUpperCase()}</Text>
            <Text style={styles.dateText}>{fmtDate(item.scheduled_start)}</Text>
          </View>
          <View style={[styles.statusBadge, { borderColor: color }]}>
            <Text style={[styles.statusText, { color }]}>{item.status.toUpperCase()}</Text>
          </View>
        </View>
        <View style={styles.timeRow}>
          <Text style={styles.timeText}>
            {fmtTime(item.scheduled_start)} — {fmtTime(item.scheduled_end)}
          </Text>
          <Text style={styles.durationText}>{duration(item.scheduled_start, item.scheduled_end)}</Text>
        </View>
      </View>
    );
  }

  function SectionHeader({ label, count }: { label: string; count: number }) {
    return (
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>{label}</Text>
        <View style={styles.sectionCount}>
          <Text style={styles.sectionCountText}>{count}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>SCHEDULE</Text>
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
      ) : shifts.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>📅</Text>
          <Text style={styles.emptyText}>No shifts scheduled</Text>
          <Text style={styles.emptySub}>Your admin will assign upcoming shifts</Text>
        </View>
      ) : (
        <FlatList
          data={[
            ...(upcoming.length > 0 ? [{ _header: 'UPCOMING', _count: upcoming.length } as any, ...upcoming] : []),
            ...(recent.length  > 0 ? [{ _header: 'RECENT',   _count: recent.length   } as any, ...recent  ] : []),
          ]}
          keyExtractor={(item, idx) => item.id ?? `header-${idx}`}
          renderItem={({ item }) =>
            item._header
              ? <SectionHeader label={item._header} count={item._count} />
              : renderShift({ item })
          }
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.action} />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },

  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: 60, paddingBottom: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, letterSpacing: 4 },

  listContent: { padding: Spacing.md },

  sectionHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: Spacing.sm, paddingHorizontal: 2,
    marginTop: Spacing.sm, marginBottom: Spacing.xs,
  },
  sectionLabel:     { color: Colors.muted, fontSize: 11, letterSpacing: 3 },
  sectionCount:     { backgroundColor: Colors.surface, borderRadius: Radius.full, paddingHorizontal: Spacing.sm, paddingVertical: 2 },
  sectionCountText: { color: Colors.muted, fontSize: 11 },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    borderLeftWidth: 3,
    padding: Spacing.md,
  },
  cardRow:     { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.sm },
  siteName:    { fontFamily: Fonts.heading, color: Colors.base, fontSize: 16, letterSpacing: 2 },
  dateText:    { color: Colors.muted, fontSize: 12, marginTop: 2 },
  statusBadge: { borderWidth: 1, borderRadius: Radius.xs, paddingHorizontal: Spacing.sm, paddingVertical: 2 },
  statusText:  { fontSize: 10, letterSpacing: 1, fontFamily: Fonts.heading },
  timeRow:     { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  timeText:    { color: Colors.base, fontSize: 14 },
  durationText:{ color: Colors.action, fontSize: 13, fontFamily: Fonts.heading, letterSpacing: 1 },

  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  emptyIcon: { fontSize: 48, marginBottom: Spacing.md },
  emptyText: { color: Colors.base, fontSize: 18, marginBottom: Spacing.xs },
  emptySub:  { color: Colors.muted, fontSize: 13, textAlign: 'center' },
  errorText: { color: Colors.base, fontSize: 15, textAlign: 'center', marginBottom: Spacing.lg },
  retryBtn:  { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  retryText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 14, letterSpacing: 2 },
});
