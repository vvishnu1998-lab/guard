/**
 * Alerts Tab — guard's geofence violations + inbound swap requests.
 *
 * Two data sources, one screen:
 *   - GET /api/locations/violations      → open/resolved violations
 *   - GET /api/shifts/inbound-swap-requests → pending swap requests
 *
 * Swap cards render at the top (actionable, most-recent thing). Violations
 * follow below.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import * as Sentry from '@sentry/react-native';
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

interface InboundSwap {
  history_id:       string;
  shift_id:         string;
  requested_at:     string;
  reason:           string | null;
  from_guard_id:    string;
  from_guard_name:  string | null;
  scheduled_start:  string;
  scheduled_end:    string;
  site_name:        string;
  site_tz:          string | null;
  // Phase 2b: server now branches copy + confirmation flow on this. Older
  // API versions (pre-Phase 2a) don't return it — treat missing as pre-shift.
  initiated_by?:    'admin' | 'guard_pre_shift' | 'guard_handoff';
}

// Accepted-but-not-arrived pending state — recipient side. Populated
// locally when the user taps ACCEPT on a handoff card so the card mutates
// in place to "PENDING ARRIVAL — OPEN SHIFT" instead of vanishing.
type AcceptedState = 'pre_shift_dismissed' | 'handoff_pending_arrival';

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
    + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtInTz(iso: string, tz: string | null, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz ?? undefined }).format(new Date(iso));
}

export default function AlertsScreen() {
  const [violations, setViolations] = useState<Violation[]>([]);
  const [swaps,      setSwaps]      = useState<InboundSwap[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  // Per-row action-in-flight so tapping ACCEPT on one card doesn't grey out
  // every other card.
  const [busyId,     setBusyId]     = useState<string | null>(null);
  // Handoff cards, once accepted, mutate in place to "PENDING ARRIVAL"
  // instead of vanishing so the recipient can tap OPEN SHIFT → detail →
  // wizard from the same surface. Keyed by history_id.
  const [acceptedHandoffs, setAcceptedHandoffs] = useState<Set<string>>(new Set());

  async function fetchAll() {
    try {
      const [v, s] = await Promise.all([
        apiClient.get<Violation[]>('/locations/violations'),
        apiClient.get<InboundSwap[]>('/shifts/inbound-swap-requests').catch(() => [] as InboundSwap[]),
      ]);
      setViolations(v);
      setSwaps(s);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load alerts');
    }
  }

  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      fetchAll().finally(() => setLoading(false));
    }, [])
  );

  async function onRefresh() {
    setRefreshing(true);
    await fetchAll();
    setRefreshing(false);
  }

  async function respond(swap: InboundSwap, accept: boolean) {
    if (busyId) return;
    const isHandoff = swap.initiated_by === 'guard_handoff';
    // Handoff acceptance is heavier — user commits to traveling and
    // clocking in on-site. Wrap in a confirm dialog before hitting the API.
    if (accept && isHandoff) {
      Alert.alert(
        'Accept handoff?',
        `You'll need to travel to ${swap.site_name} and clock in when you arrive. ${swap.from_guard_name ?? 'They'} will stay on shift until then.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Accept', style: 'default',
            onPress: () => performRespond(swap, true, true),
          },
        ],
        { cancelable: true },
      );
      return;
    }
    performRespond(swap, accept, isHandoff);
  }

  async function performRespond(swap: InboundSwap, accept: boolean, isHandoff: boolean) {
    setBusyId(swap.history_id);
    Sentry.addBreadcrumb({
      category: isHandoff ? 'handoff_wizard' : 'swap_wizard',
      message: `alerts: ${accept ? 'accept' : 'decline'} ${isHandoff ? 'handoff' : 'swap'}`,
      level: 'info',
      data: { history_id: swap.history_id, shift_id: swap.shift_id },
    });
    try {
      const endpoint = isHandoff ? 'handoff-response' : 'swap-response';
      await apiClient.post(`/shifts/${swap.shift_id}/${endpoint}`, {
        history_id: swap.history_id,
        accept,
      });
      if (isHandoff && accept) {
        // Mutate card in place — don't remove — so recipient can tap
        // OPEN SHIFT to walk into the wizard flow.
        setAcceptedHandoffs((prev) => new Set(prev).add(swap.history_id));
      } else {
        // Pre-shift swap or declined handoff: remove from list optimistically.
        setSwaps((prev) => prev.filter((s) => s.history_id !== swap.history_id));
        if (accept) {
          // Pre-shift swap accepted: drop them on the shift page where
          // the new assignment is visible.
          setTimeout(() => router.push(`/shifts/${swap.shift_id}`), 100);
        }
      }
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: 'alerts.performRespond', is_handoff: isHandoff } });
      Alert.alert(
        accept
          ? (isHandoff ? 'Could not accept handoff' : 'Could not accept swap')
          : (isHandoff ? 'Could not decline handoff' : 'Could not decline swap'),
        err?.message ?? 'Please try again.',
      );
    } finally {
      setBusyId(null);
    }
  }

  function renderViolation({ item }: { item: Violation }) {
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

  function renderSwap(swap: InboundSwap) {
    const busy = busyId === swap.history_id;
    const isHandoff = swap.initiated_by === 'guard_handoff';
    const isPendingArrival = isHandoff && acceptedHandoffs.has(swap.history_id);
    const cardBorder = isHandoff ? Colors.warning : Colors.action;
    const badgeText  = isHandoff
      ? (isPendingArrival ? 'PENDING ARRIVAL' : 'HANDOFF REQUEST')
      : 'SWAP REQUEST';
    const headline = isHandoff
      ? (
        <Text style={styles.swapFrom}>
          <Text style={{ color: Colors.warning, fontFamily: Fonts.heading }}>
            {swap.from_guard_name ?? 'A guard'}
          </Text>{' '}
          needs coverage — mid-shift handoff
        </Text>
      )
      : (
        <Text style={styles.swapFrom}>
          <Text style={{ color: Colors.action, fontFamily: Fonts.heading }}>
            {swap.from_guard_name ?? 'A guard'}
          </Text>{' '}
          wants you to cover this shift
        </Text>
      );

    return (
      <View key={swap.history_id} style={[styles.swapCard, { borderColor: cardBorder }]}>
        <View style={styles.swapHeaderRow}>
          <View style={[styles.swapBadge, { backgroundColor: cardBorder }]}>
            <Text style={styles.swapBadgeText}>{badgeText}</Text>
          </View>
          <Text style={styles.swapTs}>{fmtDateTime(swap.requested_at)}</Text>
        </View>
        {headline}
        <View style={styles.swapShiftBox}>
          <Text style={styles.swapSiteName}>{swap.site_name.toUpperCase()}</Text>
          <Text style={styles.swapShiftTime}>
            {fmtInTz(swap.scheduled_start, swap.site_tz, {
              weekday: 'short', day: 'numeric', month: 'short',
              hour: '2-digit', minute: '2-digit',
            })}
            {' — '}
            {fmtInTz(swap.scheduled_end, swap.site_tz, { hour: '2-digit', minute: '2-digit' })}
          </Text>
          {isHandoff && !isPendingArrival && (
            <Text style={styles.swapTravelHint}>
              Travel to {swap.site_name} and clock in when you arrive.
            </Text>
          )}
        </View>
        {swap.reason ? (
          <Text style={styles.swapReason} numberOfLines={3}>“{swap.reason}”</Text>
        ) : null}
        {isPendingArrival ? (
          <TouchableOpacity
            style={[styles.swapBtn, styles.swapBtnOpenShift]}
            onPress={() => router.push(`/shifts/${swap.shift_id}`)}
          >
            <Text style={styles.swapBtnOpenShiftText}>OPEN SHIFT</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.swapActions}>
            <TouchableOpacity
              style={[styles.swapBtn, styles.swapBtnDecline, busy && styles.swapBtnDisabled]}
              onPress={() => respond(swap, false)}
              disabled={busy}
            >
              {busy ? <ActivityIndicator color={Colors.danger} /> : <Text style={styles.swapBtnDeclineText}>DECLINE</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.swapBtn, styles.swapBtnAccept, busy && styles.swapBtnDisabled]}
              onPress={() => respond(swap, true)}
              disabled={busy}
            >
              {busy ? <ActivityIndicator color="#070D1A" /> : <Text style={styles.swapBtnAcceptText}>ACCEPT</Text>}
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  const openCount = violations.filter((v) => !v.resolved_at && !v.supervisor_override).length;

  const listHeader = (
    <>
      {openCount > 0 && (
        <View style={styles.warningBanner}>
          <Text style={styles.warningText}>
            ⚠  You have {openCount} open violation{openCount > 1 ? 's' : ''}.
            Return inside the site boundary immediately.
          </Text>
        </View>
      )}
      {swaps.length > 0 && (
        <>
          <Text style={styles.sectionHead}>PENDING SWAP REQUESTS</Text>
          {swaps.map(renderSwap)}
          <Text style={[styles.sectionHead, { marginTop: Spacing.md }]}>GEOFENCE HISTORY</Text>
        </>
      )}
    </>
  );

  const hasContent = swaps.length > 0 || violations.length > 0;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>ALERTS</Text>
        {(openCount > 0 || swaps.length > 0) && (
          <View style={styles.openBadge}>
            <Text style={styles.openBadgeText}>
              {swaps.length > 0
                ? `${swaps.length} SWAP${swaps.length > 1 ? 'S' : ''}`
                : `${openCount} OPEN`}
            </Text>
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
      ) : !hasContent ? (
        <View style={styles.center}>
          <Text style={styles.emptyIcon}>✅</Text>
          <Text style={styles.emptyText}>No alerts right now</Text>
          <Text style={styles.emptySub}>You'll see swap requests and geofence issues here</Text>
        </View>
      ) : (
        <FlatList
          data={violations}
          keyExtractor={(item) => item.id}
          renderItem={renderViolation}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={{ height: Spacing.sm }} />}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={Colors.action} />
          }
          ListHeaderComponent={listHeader}
          ListEmptyComponent={
            violations.length === 0 && swaps.length > 0 ? (
              <Text style={[styles.emptySub, { textAlign: 'left', paddingLeft: 2 }]}>
                No geofence violations.
              </Text>
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
  openBadge:      { backgroundColor: Colors.action, borderRadius: Radius.sm, paddingHorizontal: Spacing.sm, paddingVertical: 3 },
  openBadgeText:  { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 11, letterSpacing: 1 },

  warningBanner: {
    backgroundColor: '#7F1D1D', borderRadius: Radius.md,
    padding: Spacing.md, marginBottom: Spacing.md,
    borderWidth: 1, borderColor: '#EF4444',
  },
  warningText: { color: '#FCA5A5', fontSize: 13, lineHeight: 20 },

  sectionHead: {
    color: Colors.muted, fontFamily: Fonts.heading,
    fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm, marginTop: 2,
  },

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

  // Swap card
  swapCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.action,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  swapHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: Spacing.sm },
  swapBadge: { backgroundColor: Colors.action, borderRadius: Radius.xs, paddingHorizontal: Spacing.sm, paddingVertical: 2 },
  swapBadgeText: { color: '#070D1A', fontFamily: Fonts.heading, fontSize: 10, letterSpacing: 1 },
  swapTs: { color: Colors.muted, fontSize: 11 },
  swapFrom: { color: Colors.textPrimary, fontSize: 14, marginBottom: Spacing.sm },
  swapShiftBox: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.md,
    padding: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  swapSiteName: { fontFamily: Fonts.heading, color: Colors.textPrimary, fontSize: 14, letterSpacing: 2, marginBottom: 2 },
  swapShiftTime: { color: Colors.muted, fontSize: 12 },
  swapReason: { color: Colors.muted, fontSize: 12, fontStyle: 'italic', marginBottom: Spacing.sm },
  swapActions: { flexDirection: 'row', gap: Spacing.sm },
  swapBtn: {
    flex: 1, borderRadius: Radius.md,
    paddingVertical: Spacing.sm + 2,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
  },
  swapBtnDecline: { borderColor: Colors.danger, backgroundColor: 'transparent' },
  swapBtnAccept:  { borderColor: Colors.success, backgroundColor: Colors.success },
  swapBtnDeclineText: { fontFamily: Fonts.heading, color: Colors.danger, fontSize: 13, letterSpacing: 2 },
  swapBtnAcceptText:  { fontFamily: Fonts.heading, color: '#070D1A', fontSize: 13, letterSpacing: 2 },
  swapBtnDisabled: { opacity: 0.45 },
  // Post-accept handoff state: single OPEN SHIFT button (yellow) — the
  // recipient continues into the shift-detail → wizard flow from there.
  swapBtnOpenShift: {
    flex: 0,
    borderColor: Colors.warning,
    backgroundColor: Colors.warning,
    paddingHorizontal: Spacing.xl,
    alignSelf: 'stretch',
  },
  swapBtnOpenShiftText: {
    fontFamily: Fonts.heading, color: '#070D1A', fontSize: 13, letterSpacing: 2,
  },
  swapTravelHint: {
    color: Colors.warning,
    fontSize: 11,
    fontStyle: 'italic',
    marginTop: 4,
  },

  center:    { flex: 1, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  emptyIcon: { fontSize: 48, marginBottom: Spacing.md },
  emptyText: { color: Colors.base, fontSize: 18, marginBottom: Spacing.xs },
  emptySub:  { color: Colors.muted, fontSize: 13, textAlign: 'center' },
  errorText: { color: Colors.base, fontSize: 15, textAlign: 'center', marginBottom: Spacing.lg },
  retryBtn:  { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  retryText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 14, letterSpacing: 2 },
});
