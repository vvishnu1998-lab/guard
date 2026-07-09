/**
 * Shift Detail — /shifts/[id]
 *
 * Guard-facing detail page reached by tapping a card on the schedule tab
 * or a swap-related notification. Renders differently by status:
 *   scheduled → REQUEST SWAP button (opens RequestSwapModal)
 *   active    → CLOCK-OUT hint (deep-link into the clock-out flow is
 *               not available; guard goes to home)
 *   completed / missed / cancelled → read-only summary
 *
 * Server enforces guard-owns-shift; a foreign shift comes back 404 and
 * we surface a "Not available" empty state (no leaking of foreign ids).
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, RefreshControl, Linking,
} from 'react-native';
import { router, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import RequestSwapModal from '../../components/RequestSwapModal';

type ShiftStatus = 'scheduled' | 'active' | 'completed' | 'missed' | 'cancelled';

interface SwapHistoryRow {
  id:               string;
  requested_at:     string;
  accepted_at:      string | null;
  declined_at:      string | null;
  status:           'pending' | 'accepted' | 'declined' | 'expired';
  initiated_by:     'admin' | 'guard_pre_shift' | 'guard_handoff';
  reason:           string | null;
  from_guard_name:  string | null;
  to_guard_name:    string | null;
}

interface ReassignRow {
  id:                 string;
  created_at:         string;
  reason:             string | null;
  old_guard_name:     string | null;
  new_guard_name:     string | null;
  reassigned_by_name: string | null;
}

interface ShiftDetail {
  id:               string;
  guard_id:         string | null;
  site_id:          string;
  site_name:        string;
  site_address:     string | null;
  site_tz:          string | null;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           ShiftStatus;
  guard_name:       string | null;
  badge_number:     string | null;
  reassignment_history: ReassignRow[];
  swap_history:         SwapHistoryRow[];
}

const STATUS_COLOR: Record<ShiftStatus, string> = {
  scheduled: Colors.action,
  active:    Colors.success,
  completed: Colors.muted,
  missed:    Colors.danger,
  cancelled: Colors.muted,
};

function fmtInTz(iso: string, tz: string | null, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', {
    ...opts, timeZone: tz ?? undefined,
  }).format(new Date(iso));
}

function duration(start: string, end: string): string {
  const h = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return `${h.toFixed(1)}h`;
}

export default function ShiftDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [shift,      setShift]      = useState<ShiftDetail | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [swapOpen,   setSwapOpen]   = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await apiClient.get<ShiftDetail>(`/shifts/${id}`);
      setShift(data);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load shift');
    }
  }, [id]);

  useFocusEffect(useCallback(() => {
    setLoading(true);
    load().finally(() => setLoading(false));
  }, [load]));

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  function goBack() {
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)/schedule');
  }

  // Header renders in every state so the back button is always there.
  const header = (
    <View style={styles.header}>
      <TouchableOpacity onPress={goBack} style={styles.backBtn} hitSlop={8}>
        <Ionicons name="chevron-back" size={22} color={Colors.action} />
        <Text style={styles.backText}>SCHEDULE</Text>
      </TouchableOpacity>
      <Text style={styles.title}>SHIFT</Text>
    </View>
  );

  if (loading) {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.center}><ActivityIndicator color={Colors.action} size="large" /></View>
      </View>
    );
  }

  if (error || !shift) {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.center}>
          <Text style={styles.errorText}>{error ?? 'Shift not available'}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={onRefresh}>
            <Text style={styles.retryText}>RETRY</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const statusColor = STATUS_COLOR[shift.status] ?? Colors.muted;
  const startDate   = fmtInTz(shift.scheduled_start, shift.site_tz, {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
  const startTime   = fmtInTz(shift.scheduled_start, shift.site_tz, {
    hour: '2-digit', minute: '2-digit',
  });
  const endTime     = fmtInTz(shift.scheduled_end, shift.site_tz, {
    hour: '2-digit', minute: '2-digit',
  });

  return (
    <View style={styles.container}>
      {header}
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.action} />
        }
      >
        {/* Site name + status pill */}
        <View style={[styles.card, { borderLeftColor: statusColor }]}>
          <View style={styles.rowTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.siteName}>{shift.site_name.toUpperCase()}</Text>
              {shift.site_address ? (
                <TouchableOpacity onPress={() => Linking.openURL(
                  `https://maps.apple.com/?q=${encodeURIComponent(shift.site_address!)}`
                )}>
                  <Text style={styles.address} numberOfLines={2}>{shift.site_address}</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            <View style={[styles.statusBadge, { borderColor: statusColor }]}>
              <Text style={[styles.statusText, { color: statusColor }]}>
                {shift.status.toUpperCase()}
              </Text>
            </View>
          </View>

          <View style={styles.divider} />

          <Text style={styles.label}>SCHEDULED</Text>
          <Text style={styles.dateText}>{startDate}</Text>
          <Text style={styles.timeText}>
            {startTime} — {endTime}
            {'  ·  '}{duration(shift.scheduled_start, shift.scheduled_end)}
            {shift.site_tz ? `  ·  ${shift.site_tz.split('/').pop()}` : ''}
          </Text>

          {shift.guard_name ? (
            <>
              <View style={styles.divider} />
              <Text style={styles.label}>ASSIGNED</Text>
              <Text style={styles.dateText}>{shift.guard_name}</Text>
              {shift.badge_number
                ? <Text style={styles.timeText}>Badge #{shift.badge_number}</Text>
                : null}
            </>
          ) : null}
        </View>

        {/* Actions by status */}
        {shift.status === 'scheduled' && (
          <TouchableOpacity
            style={styles.actionBtn}
            onPress={() => setSwapOpen(true)}
          >
            <Ionicons name="swap-horizontal" size={18} color="#070D1A" />
            <Text style={styles.actionText}>REQUEST SWAP</Text>
          </TouchableOpacity>
        )}
        {shift.status === 'active' && (
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: Colors.success }]}
            onPress={() => router.push('/(tabs)/home')}
          >
            <Ionicons name="log-out-outline" size={18} color="#070D1A" />
            <Text style={styles.actionText}>GO TO CLOCK OUT</Text>
          </TouchableOpacity>
        )}
        {(shift.status === 'completed' || shift.status === 'missed' || shift.status === 'cancelled') && (
          <View style={styles.readOnlyBanner}>
            <Text style={styles.readOnlyText}>
              {shift.status === 'completed' ? 'This shift has ended.'
                : shift.status === 'missed' ? 'This shift was missed.'
                : 'This shift was cancelled.'}
            </Text>
          </View>
        )}

        {/* Merged history: reassigns + swaps, newest first */}
        {(shift.reassignment_history.length + shift.swap_history.length > 0) && (
          <View style={styles.historyCard}>
            <Text style={styles.sectionTitle}>HISTORY</Text>
            {(() => {
              type Entry =
                | { kind: 'reassign'; ts: string; row: ReassignRow }
                | { kind: 'swap';     ts: string; row: SwapHistoryRow };
              const merged: Entry[] = [
                ...shift.reassignment_history.map((r): Entry => ({ kind: 'reassign', ts: r.created_at, row: r })),
                ...shift.swap_history.map((r): Entry => ({ kind: 'swap', ts: r.requested_at, row: r })),
              ].sort((a, b) => (a.ts < b.ts ? 1 : -1));
              return merged.map((e, idx) => (
                <View
                  key={`${e.kind}-${e.kind === 'reassign' ? e.row.id : e.row.id}-${idx}`}
                  style={[
                    styles.histRow,
                    idx === merged.length - 1 && { borderBottomWidth: 0 },
                  ]}
                >
                  <Text style={[
                    styles.histBadge,
                    e.kind === 'reassign'
                      ? { color: Colors.warning, borderColor: Colors.warning }
                      : { color: Colors.action,  borderColor: Colors.action  },
                  ]}>
                    {e.kind === 'reassign' ? 'ADMIN' : 'SWAP'}
                  </Text>
                  <View style={{ flex: 1 }}>
                    {e.kind === 'reassign' ? (
                      <Text style={styles.histLine}>
                        Reassigned{e.row.old_guard_name ? ` from ${e.row.old_guard_name}` : ''}
                        {e.row.new_guard_name ? ` to ${e.row.new_guard_name}` : ''}
                      </Text>
                    ) : (
                      <Text style={styles.histLine}>
                        {e.row.from_guard_name ?? '?'} → {e.row.to_guard_name ?? '?'}
                        {'  '}
                        <Text style={{ color: swapStatusColor(e.row.status) }}>
                          [{e.row.status.toUpperCase()}]
                        </Text>
                      </Text>
                    )}
                    {(e.kind === 'reassign' ? e.row.reason : e.row.reason) ? (
                      <Text style={styles.histReason} numberOfLines={2}>
                        “{e.kind === 'reassign' ? e.row.reason : e.row.reason}”
                      </Text>
                    ) : null}
                    <Text style={styles.histTs}>
                      {fmtInTz(e.ts, shift.site_tz, {
                        day: '2-digit', month: 'short',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </Text>
                  </View>
                </View>
              ));
            })()}
          </View>
        )}
      </ScrollView>

      {swapOpen && (
        <RequestSwapModal
          shiftId={shift.id}
          siteName={shift.site_name}
          scheduledStart={shift.scheduled_start}
          scheduledEnd={shift.scheduled_end}
          siteTz={shift.site_tz}
          onClose={() => setSwapOpen(false)}
          onSubmitted={() => { setSwapOpen(false); onRefresh(); }}
        />
      )}
    </View>
  );
}

function swapStatusColor(s: SwapHistoryRow['status']): string {
  switch (s) {
    case 'accepted': return Colors.success;
    case 'declined': return Colors.danger;
    case 'expired':  return Colors.muted;
    case 'pending':  return Colors.warning;
  }
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  header: {
    paddingHorizontal: Spacing.lg,
    paddingTop: 60,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: Spacing.xs,
  },
  backBtn: { flexDirection: 'row', alignItems: 'center', marginBottom: 2 },
  backText: { color: Colors.action, fontFamily: Fonts.heading, fontSize: 12, letterSpacing: 2, marginLeft: 2 },
  title: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 24, letterSpacing: 4 },

  scrollContent: { padding: Spacing.md, paddingBottom: Spacing.xl },

  card: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    borderLeftWidth: 3,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start' },
  siteName: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 18, letterSpacing: 2, marginBottom: 4 },
  address: { color: Colors.action, fontSize: 13, textDecorationLine: 'underline' },
  statusBadge: { borderWidth: 1, borderRadius: Radius.xs, paddingHorizontal: Spacing.sm, paddingVertical: 2, marginLeft: Spacing.sm },
  statusText: { fontSize: 10, letterSpacing: 1, fontFamily: Fonts.heading },

  divider: { height: 1, backgroundColor: Colors.border, marginVertical: Spacing.md },

  label: { color: Colors.muted, fontFamily: Fonts.heading, fontSize: 10, letterSpacing: 2, marginBottom: 4 },
  dateText: { color: Colors.textPrimary, fontSize: 15, marginBottom: 2 },
  timeText: { color: Colors.muted, fontSize: 13 },

  actionBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: Spacing.sm,
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    marginBottom: Spacing.md,
  },
  actionText: { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 14, letterSpacing: 2 },

  readOnlyBanner: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    padding: Spacing.md,
    marginBottom: Spacing.md,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  readOnlyText: { color: Colors.muted, fontSize: 13, textAlign: 'center' },

  historyCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md,
    marginBottom: Spacing.md,
  },
  sectionTitle: {
    color: Colors.muted, fontFamily: Fonts.heading,
    fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm,
  },
  histRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.sm,
    paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  histBadge: {
    fontFamily: Fonts.heading, fontSize: 9, letterSpacing: 1,
    borderWidth: 1, paddingHorizontal: 4, paddingVertical: 1,
    borderRadius: Radius.xs,
    marginTop: 2,
  },
  histLine:   { color: Colors.textPrimary, fontSize: 13, marginBottom: 2 },
  histReason: { color: Colors.muted, fontSize: 12, fontStyle: 'italic', marginBottom: 2 },
  histTs:     { color: Colors.muted, fontSize: 11 },

  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  errorText: { color: Colors.textPrimary, fontSize: 15, textAlign: 'center', marginBottom: Spacing.lg },
  retryBtn:  { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  retryText: { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 14, letterSpacing: 2 },
});
