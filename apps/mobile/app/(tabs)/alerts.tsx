/**
 * Alerts Tab — guard's geofence violation history.
 * Fetches GET /api/locations/violations (guard-scoped).
 * Shows open violations (no resolved_at) in red, resolved in muted.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from 'expo-router';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

interface Violation {
  id:                 string;
  occurred_at:        string;
  resolved_at:        string | null;
  duration_minutes:   number | null;
  violation_lat:      number;
  violation_lng:      number;
  supervisor_override:boolean;
  site_name:          string;
}

export default function AlertsScreen() {
  const [violations, setViolations] = useState<Violation[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  async function fetchViolations() {
    try {
      const data = await apiClient.get<Violation[]>('/locations/violations');
      setViolations(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load alerts');
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchViolations().finally(() => setLoading(false));
    }, [])
  );

  async function onRefresh() {
    setRefreshing(true);
    await fetchViolations();
    setRefreshing(false);
  }

  function fmtDateTime(iso: string) {
    const d = new Date(iso);
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
      + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderItem({ item }: { item: Violation }) {
    const isOpen     = !item.resolved_at;
    const isExcused  = item.supervisor_override;
    const borderColor = isExcused ? Colors.muted : isOpen ? '#EF4444' : Colors.border;
    const statusColor = isExcused ? Colors.muted : isOpen ? '#EF4444' : Colors.success;
    const statusLabel = isExcused ? 'EXCUSED' : isOpen ? 'OPEN' : 'RESOLVED';

    return (
      <View style={[styles.card, { borderLeftColor: borderColor }]}>
        <View style={styles.cardTop}>
          <View style={{ flex: 1 }}>
            <Text style={styles.siteName}>{item.site_name.toUpperCase()}</Text>
            <Text style={styles.timeText}>{fmtDateTime(item.occurred_at)}</Text>
          </View>
          <View style={[styles.statusBadge, { borderColor: statusColor }]}>
            <Text style={[styles.statusText, { color: statusColor }]}>{statusLabel}</Text>
          </View>
        </View>

        <View style={styles.cardBottom}>
          {item.resolved_at ? (
            <Text style={styles.resolvedText}>
              Resolved: {fmtDateTime(item.resolved_at)}
              {item.duration_minutes != null
                ? `  ·  ${Math.round(item.duration_minutes)} min outside`
                : ''}
            </Text>
          ) : (
            <Text style={[styles.resolvedText, { color: '#EF4444' }]}>
              Still unresolved — you may be outside the boundary
            </Text>
          )}
        </View>
      </View>
    );
  }

  const openCount = violations.filter((v) => !v.resolved_at && !v.supervisor_override).length;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>ALERTS</Text>
        {openCount > 0 && (
          <View style={styles.openBadge}>
            <Text style={styles.openBadgeText}>{openCount} OPEN</Text>
          </View>
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
      ) : violations.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>✅</Text>
          <Text style={styles.emptyText}>No geofence violations</Text>
          <Text style={styles.emptySub}>You've stayed within all site boundaries</Text>
        </View>
      ) : (
        <FlatList
          data={violations}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.action} />
          }
          ListHeaderComponent={
            openCount > 0 ? (
              <View style={styles.warningBanner}>
                <Text style={styles.warningText}>
                  ⚠  You have {openCount} open violation{openCount > 1 ? 's' : ''}.
                  Return inside the site boundary immediately.
                </Text>
              </View>
            ) : null
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: Spacing.xl,
    paddingTop: 60, paddingBottom: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title:          { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, letterSpacing: 4 },
  openBadge:      { backgroundColor: '#EF4444', borderRadius: Radius.sm, paddingHorizontal: Spacing.sm, paddingVertical: 3 },
  openBadgeText:  { fontFamily: Fonts.heading, color: '#fff', fontSize: 11, letterSpacing: 1 },

  warningBanner: {
    backgroundColor: '#7F1D1D', borderRadius: Radius.md,
    padding: Spacing.md, marginBottom: Spacing.md,
    borderWidth: 1, borderColor: '#EF4444',
  },
  warningText: { color: '#FCA5A5', fontSize: 13, lineHeight: 20 },

  listContent: { padding: Spacing.md },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    borderLeftWidth: 3,
    padding: Spacing.md,
  },
  cardTop:     { flexDirection: 'row', alignItems: 'flex-start', marginBottom: Spacing.sm },
  siteName:    { fontFamily: Fonts.heading, color: Colors.base, fontSize: 15, letterSpacing: 2 },
  timeText:    { color: Colors.muted, fontSize: 12, marginTop: 2 },
  statusBadge: { borderWidth: 1, borderRadius: Radius.xs, paddingHorizontal: Spacing.sm, paddingVertical: 2 },
  statusText:  { fontSize: 10, letterSpacing: 1, fontFamily: Fonts.heading },
  cardBottom:  { marginTop: 4 },
  resolvedText:{ color: Colors.muted, fontSize: 12 },

  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  emptyIcon: { fontSize: 48, marginBottom: Spacing.md },
  emptyText: { color: Colors.base, fontSize: 18, marginBottom: Spacing.xs },
  emptySub:  { color: Colors.muted, fontSize: 13, textAlign: 'center' },
  errorText: { color: Colors.base, fontSize: 15, textAlign: 'center', marginBottom: Spacing.lg },
  retryBtn:  { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  retryText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 14, letterSpacing: 2 },
});
