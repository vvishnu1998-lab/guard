/**
 * Reports Tab — guard's report history with type filter tabs + New Report button.
 * Fetches from GET /api/reports (guard-scoped to their own sessions).
 */
import { useCallback, useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { apiClient }   from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

type ReportType = 'all' | 'activity' | 'incident' | 'maintenance';

interface Report {
  id:           string;
  report_type:  'activity' | 'incident' | 'maintenance';
  description:  string;
  severity:     string | null;
  reported_at:  string;
  site_id:      string;
}

const TABS: { value: ReportType; label: string }[] = [
  { value: 'all',         label: 'ALL'         },
  { value: 'activity',    label: 'ACTIVITY'    },
  { value: 'incident',    label: 'INCIDENT'    },
  { value: 'maintenance', label: 'MAINTENANCE' },
];

const TYPE_COLORS: Record<string, string> = {
  activity:    Colors.action,
  incident:    '#EF4444',
  maintenance: '#3B82F6',
};

const SEVERITY_COLORS: Record<string, string> = {
  low:      '#22C55E',
  medium:   '#F59E0B',
  high:     '#F97316',
  critical: '#EF4444',
};

export default function ReportsScreen() {
  const [reports,     setReports]     = useState<Report[]>([]);
  const [activeTab,   setActiveTab]   = useState<ReportType>('all');
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  async function fetchReports(tab: ReportType = activeTab) {
    try {
      const params = tab !== 'all' ? `?type=${tab}` : '';
      const res    = await apiClient(`/api/reports${params}`);
      if (!res.ok) throw new Error('Failed to load reports');
      const data = await res.json();
      setReports(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load reports');
    }
  }

  // Reload when tab comes into focus
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchReports(activeTab).finally(() => setLoading(false));
    }, [activeTab])
  );

  async function onRefresh() {
    setRefreshing(true);
    await fetchReports(activeTab);
    setRefreshing(false);
  }

  function onTabChange(tab: ReportType) {
    setActiveTab(tab);
    setLoading(true);
    fetchReports(tab).finally(() => setLoading(false));
  }

  function renderItem({ item }: { item: Report }) {
    const typeColor = TYPE_COLORS[item.report_type] ?? Colors.muted;
    const date      = new Date(item.reported_at);

    return (
      <View style={styles.card}>
        <View style={styles.cardTop}>
          <View style={[styles.typeBadge, { borderColor: typeColor }]}>
            <Text style={[styles.typeText, { color: typeColor }]}>
              {item.report_type.toUpperCase()}
            </Text>
          </View>

          {item.severity && (
            <View style={[styles.severityBadge, { backgroundColor: SEVERITY_COLORS[item.severity] ?? Colors.muted }]}>
              <Text style={styles.severityText}>{item.severity.toUpperCase()}</Text>
            </View>
          )}

          <Text style={styles.dateText}>
            {date.toLocaleDateString()} {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>

        <Text style={styles.desc} numberOfLines={2}>{item.description}</Text>

        <Text style={styles.idText}>#{item.id.slice(0, 8).toUpperCase()}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Text style={styles.title}>REPORTS</Text>
        <TouchableOpacity style={styles.newBtn} onPress={() => router.push('/reports/new')}>
          <Text style={styles.newBtnText}>+ NEW</Text>
        </TouchableOpacity>
      </View>

      {/* Filter tabs */}
      <View style={styles.tabBar}>
        {TABS.map((tab) => (
          <TouchableOpacity
            key={tab.value}
            style={[styles.tab, activeTab === tab.value && styles.tabActive]}
            onPress={() => onTabChange(tab.value)}
          >
            <Text style={[styles.tabText, activeTab === tab.value && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* List */}
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
      ) : (
        <FlatList
          data={reports}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.action} />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyIcon}>📋</Text>
              <Text style={styles.emptyText}>No reports yet</Text>
              <TouchableOpacity style={styles.emptyBtn} onPress={() => router.push('/reports/new')}>
                <Text style={styles.emptyBtnText}>CREATE FIRST REPORT</Text>
              </TouchableOpacity>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },

  header: {
    flexDirection: 'row',
    alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: 60, paddingBottom: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title:      { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, letterSpacing: 4 },
  newBtn:     { backgroundColor: Colors.action, borderRadius: Radius.sm, paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs },
  newBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 13, letterSpacing: 2 },

  tabBar: {
    flexDirection: 'row',
    borderBottomWidth: 1, borderBottomColor: Colors.border,
    paddingHorizontal: Spacing.md,
  },
  tab:          { flex: 1, paddingVertical: Spacing.md, alignItems: 'center' },
  tabActive:    { borderBottomWidth: 2, borderBottomColor: Colors.action },
  tabText:      { color: Colors.muted, fontSize: 10, letterSpacing: 2 },
  tabTextActive:{ color: Colors.action, fontFamily: Fonts.heading },

  listContent: { padding: Spacing.md, gap: Spacing.sm },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md,
  },
  cardTop: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginBottom: Spacing.sm },

  typeBadge: {
    borderWidth: 1, borderRadius: Radius.xs,
    paddingHorizontal: Spacing.sm, paddingVertical: 2,
  },
  typeText:     { fontSize: 10, letterSpacing: 1, fontFamily: Fonts.heading },
  severityBadge:{ borderRadius: Radius.xs, paddingHorizontal: Spacing.sm, paddingVertical: 2 },
  severityText: { color: '#FFFFFF', fontSize: 10, letterSpacing: 1, fontFamily: Fonts.heading },
  dateText:     { color: Colors.muted, fontSize: 11, marginLeft: 'auto' as any },

  desc:         { color: Colors.base, fontSize: 14, lineHeight: 20, marginBottom: Spacing.sm },
  idText:       { color: Colors.muted, fontSize: 10, fontFamily: 'monospace' },

  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  errorText: { color: Colors.base, fontSize: 15, textAlign: 'center', marginBottom: Spacing.lg },
  retryBtn:  { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  retryText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 14, letterSpacing: 2 },

  empty:       { alignItems: 'center', paddingTop: 80, gap: Spacing.md },
  emptyIcon:   { fontSize: 48 },
  emptyText:   { color: Colors.muted, fontSize: 16 },
  emptyBtn:    { backgroundColor: Colors.action, borderRadius: Radius.md, paddingHorizontal: Spacing.xl, paddingVertical: Spacing.md },
  emptyBtnText:{ fontFamily: Fonts.heading, color: Colors.structure, fontSize: 14, letterSpacing: 2 },
});
