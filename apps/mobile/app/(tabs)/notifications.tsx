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
 *
 * ── PENDING REQUESTS (restored) ─────────────────────────────────────────
 *
 * Inbound swap/handoff invites render as an actionable block ABOVE the feed,
 * fed by GET /shifts/inbound-swap-requests.
 *
 * This existed on (tabs)/alerts.tsx and was lost in merge bd7e4e2
 * (2026-07-13): that merge kept M3's deletion of alerts.tsx while grafting
 * batch/mobile-3's swap routing on top, re-pointing the two *_request_received
 * cases at /shifts/{id} with a comment claiming shift detail rendered an
 * accept card. It never did. GET /shifts/:id 404s for a recipient whose row is
 * still 'pending' (its tenancy exemption requires status='accepted'), and the
 * only way to reach 'accepted' was the button that had just been deleted — so
 * every invite since has been unactionable on every surface.
 *
 * It is a HEADER, not a fourth section: groupNotifications is typed to
 * DismissableRow{id, read_at, created_at} and these rows have none of those.
 * Forcing them through would corrupt notificationSections.ts for no gain.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, SectionList, TouchableOpacity,
  RefreshControl, ActivityIndicator, Alert,
} from 'react-native';
import { useFocusEffect, router } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import { apiClient } from '../../lib/apiClient';
import { ApiError } from '../../lib/errors';
import { navigateForNotification } from '../../lib/navigateForNotification';
import { useUnreadStore } from '../../store/unreadStore';
import { visibleNotifications, groupNotifications } from '../../lib/notificationSections';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import { guardMessage } from '../../lib/errorCopy';

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
  | 'handoff_expired'
  // Break enforcement package (server jobs/breakExpiryCron.ts).
  | 'break_ended'
  | 'break_return_overdue';

interface NotificationRow {
  id:         string;
  type:       NotificationType;
  title:      string;
  body:       string;
  data:       Record<string, any>;
  read_at:    string | null;
  created_at: string;
}

/**
 * One row of GET /shifts/inbound-swap-requests. Server-scoped to
 * to_guard_id = me, and it already returns BOTH states we render:
 *   status='pending'                                   → accept/decline
 *   status='accepted' + guard_handoff + to_session_id null → travel/clock-in
 *
 * The second case is why there is no local "I just accepted" Set here — the
 * walk-test 2026-07-10 fix put that state on the server precisely so it
 * survives an app kill. Rendering from server state instead of memory is the
 * one deliberate divergence from the 5660d6c original.
 *
 * Every nullable field below is nullable in the query, not defensively typed:
 * site_tz and from_guard_name come off LEFT JOINs, reason is user-optional.
 * The card degrades on each of them rather than rendering "null".
 */
interface InboundRequest {
  history_id:      string;
  shift_id:        string;
  requested_at:    string;
  accepted_at:     string | null;
  status:          'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
  reason:          string | null;
  initiated_by:    'admin' | 'guard_pre_shift' | 'guard_handoff';
  to_session_id:   string | null;
  from_guard_id:   string | null;
  from_guard_name: string | null;
  scheduled_start: string;
  scheduled_end:   string;
  site_name:       string;
  site_tz:         string | null;
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
  // Break family — ended is informational (amber); return_overdue means
  // the guard is off post past break end, an obligation unmet now (red).
  break_ended:              { icon: '☕', titleColor: AMBER, borderColor: AMBER },
  break_return_overdue:     { icon: '☕', titleColor: RED,   borderColor: RED   },
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

/** Shift times render in the SITE's timezone, not the device's — a guard
 *  deciding whether to cover a shift is deciding about the site's clock.
 *  Matches shifts/[id]/index.tsx:95. */
function fmtInTz(iso: string, tz: string | null, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz ?? undefined }).format(new Date(iso));
}

/**
 * Guard-facing copy for a failed accept/decline, keyed on HTTP STATUS.
 *
 * WHY STATUS AND NOT `code`: errors.ts says branch on `.code`, and that is
 * right for routes that emit an enum. swap-response and handoff-response do
 * not — every failure is `{ error: '<English sentence>' }` with no `message`
 * and no enum, so ApiError.code is set to that same prose (errors.ts:72).
 * Branching on it would be branching on prose, which is what breaks the
 * moment someone rewords a server string. Aligning those two routes onto
 * real error codes is a separate API follow-up; until then status is the
 * only stable signal, and for these two routes each status maps to exactly
 * one situation class.
 *
 * 422 is deliberately passed through: it is the eligibility explanation
 * (rest-hours, overlap, site assignment) and the server's sentence is the
 * only place that detail exists.
 */
function respondErrorCopy(err: unknown, accept: boolean, isHandoff: boolean): string {
  const kind = isHandoff ? 'handoff' : 'swap';
  if (err instanceof ApiError) {
    if (err.status === 409) {
      return `This ${kind} was already responded to, or it expired. Pull down to refresh.`;
    }
    if (err.status === 403) {
      return `This ${kind} request isn't addressed to you.`;
    }
    if (err.status === 404) {
      return `This ${kind} request no longer exists. Pull down to refresh.`;
    }
  }
  return guardMessage(
    err,
    `Could not ${accept ? 'accept' : 'decline'} this ${kind}. Try again, or tell your supervisor.`,
    `notifications.${kind}-response`,
  );
}

export default function NotificationsScreen() {
  const [rows,       setRows]       = useState<NotificationRow[]>([]);
  const [inbound,    setInbound]    = useState<InboundRequest[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  // history_id of the invite currently being answered, or null.
  //
  // The SPINNER is per-row — only the card being answered shows it, which is
  // what 5660d6c:71 was after. The LOCK is global: respond() bails while any
  // request is in flight. That is deliberate, not a leftover. Two invites can
  // cover overlapping hours, and accepting both would race two transactions
  // that each individually pass their overlap check.
  const [busyId,     setBusyId]     = useState<string | null>(null);

  const { refresh } = useUnreadStore();

  const fetchNotifications = useCallback(async () => {
    try {
      const data = await apiClient.get<NotificationRow[]>('/notifications');
      setRows(data);
      setError(null);
    } catch (err: any) {
      setError(guardMessage(err, 'Could not load notifications. Pull down to refresh.', 'notifications.list'));
    }
  }, []);

  /**
   * Pending swap/handoff invites. Deliberately independent of the feed fetch:
   * a failure here empties the actionable block but must never blank the
   * notifications list, and vice versa. `?? []` because a stale API is
   * survivable and an unguarded .map is not.
   */
  const fetchInbound = useCallback(async () => {
    try {
      const data = await apiClient.get<InboundRequest[]>('/shifts/inbound-swap-requests');
      setInbound(data ?? []);
    } catch (err: any) {
      // No visible error surface for this block — the feed below is still
      // useful and a red banner over it would misrepresent the failure.
      Sentry.captureException(err, { extra: { where: 'notifications.fetchInbound' } });
    }
  }, []);

  // Refetch on focus. No mark-all-read here any more — opening the tab is not
  // dismissal, and the badge must survive a glance.
  useFocusEffect(
    useCallback(() => {
      setLoading(true);
      (async () => {
        await Promise.all([fetchNotifications(), fetchInbound()]);
        setLoading(false);
      })();
    }, [fetchNotifications, fetchInbound]),
  );

  async function onRefresh() {
    setRefreshing(true);
    await Promise.all([fetchNotifications(), fetchInbound()]);
    await refresh();
    setRefreshing(false);
  }

  function handleTap(row: NotificationRow) {
    navigateForNotification(row.type, row.data);
  }

  /**
   * Accept/decline an invite.
   *
   * Handoff acceptance is gated behind a confirmation because it commits the
   * guard to travelling to the site and clocking in — that dialog is carried
   * over from 5660d6c:109 unchanged in intent.
   */
  function respond(req: InboundRequest, accept: boolean) {
    if (busyId) return;
    const isHandoff = req.initiated_by === 'guard_handoff';
    if (accept && isHandoff) {
      Alert.alert(
        'Accept handoff?',
        `You'll need to travel to ${req.site_name} and clock in when you arrive. ` +
        `${req.from_guard_name ?? 'They'} will stay on shift until then.`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Accept', style: 'default', onPress: () => performRespond(req, true, isHandoff) },
        ],
        { cancelable: true },
      );
      return;
    }
    performRespond(req, accept, isHandoff);
  }

  async function performRespond(req: InboundRequest, accept: boolean, isHandoff: boolean) {
    setBusyId(req.history_id);
    Sentry.addBreadcrumb({
      category: isHandoff ? 'handoff_wizard' : 'swap_wizard',
      message: `notifications: ${accept ? 'accept' : 'decline'} ${isHandoff ? 'handoff' : 'swap'}`,
      level: 'info',
      data: { history_id: req.history_id, shift_id: req.shift_id },
    });
    try {
      const endpoint = isHandoff ? 'handoff-response' : 'swap-response';
      await apiClient.post(`/shifts/${req.shift_id}/${endpoint}`, {
        history_id: req.history_id,
        accept,
      });

      // Refetch rather than mutate locally: an accepted handoff has to come
      // back as an arrival card, and only the server knows whether it did.
      await fetchInbound();
      refresh();

      // Navigation diverges by kind and this is not cosmetic. A pre-shift
      // accept rotates shifts.guard_id server-side (shifts.ts:1766), so the
      // shift is genuinely the guard's and /shifts/{id} resolves. A handoff
      // accept does NOT rotate guard_id — that happens later, inside the
      // handoff clock-in txn — so pushing there would land on the exact 404
      // this change exists to fix. Stay on the list; the row re-renders as
      // the arrival card.
      if (accept && !isHandoff) {
        router.push(`/shifts/${req.shift_id}`);
      }
    } catch (err: any) {
      Sentry.captureException(err, {
        extra: { where: 'notifications.performRespond', is_handoff: isHandoff, accept },
      });
      // The list is refetched on failure too: 409 almost always means the row
      // moved underneath us (expired by the 15-minute cron, or answered on
      // another device), and leaving a dead card on screen invites a retry
      // that cannot succeed.
      await fetchInbound();
      refresh();
      Alert.alert(
        accept
          ? (isHandoff ? 'Could not accept handoff' : 'Could not accept swap')
          : (isHandoff ? 'Could not decline handoff' : 'Could not decline swap'),
        respondErrorCopy(err, accept, isHandoff),
      );
    } finally {
      setBusyId(null);
    }
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

  // The server already restricts this endpoint to pending + accepted-not-
  // arrived rows, but filter defensively: this list drives ACCEPT buttons and
  // a declined/expired row must never render one.
  const actionable = useMemo(
    () => inbound.filter((r) => r.status === 'pending' || r.status === 'accepted'),
    [inbound],
  );

  /**
   * One inbound invite. Two shapes:
   *   pending  → DECLINE / ACCEPT
   *   accepted → GO TO HANDOFF CLOCK-IN (handoff only; the server only ever
   *              returns accepted rows for guard_handoff)
   */
  function renderRequest(req: InboundRequest) {
    const isHandoff = req.initiated_by === 'guard_handoff';
    const isArrival = req.status === 'accepted';
    const busy      = busyId === req.history_id;
    const accent    = isHandoff ? Colors.warning : Colors.action;
    const badge     = isArrival ? 'PENDING ARRIVAL' : isHandoff ? 'HANDOFF' : 'SWAP';
    const who       = req.from_guard_name ?? 'A guard';

    return (
      <View key={req.history_id} style={[styles.reqCard, { borderColor: accent }]}>
        <View style={styles.reqHeaderRow}>
          <View style={[styles.reqBadge, { backgroundColor: accent }]}>
            <Text style={styles.reqBadgeText}>{badge}</Text>
          </View>
          <Text style={styles.reqTs}>{timeAgo(req.requested_at)}</Text>
        </View>

        <Text style={styles.reqHeadline}>
          <Text style={[styles.reqWho, { color: accent }]}>{who}</Text>
          {isHandoff ? ' needs coverage — mid-shift handoff' : ' wants you to cover this shift'}
        </Text>

        <View style={styles.reqShiftBox}>
          <Text style={styles.reqSiteName}>{req.site_name.toUpperCase()}</Text>
          <Text style={styles.reqShiftTime}>
            {fmtInTz(req.scheduled_start, req.site_tz, {
              weekday: 'short', day: 'numeric', month: 'short',
              hour: '2-digit', minute: '2-digit',
            })}
            {' — '}
            {fmtInTz(req.scheduled_end, req.site_tz, { hour: '2-digit', minute: '2-digit' })}
          </Text>
          {isHandoff && (
            <Text style={styles.reqTravelHint}>
              Travel to {req.site_name} and clock in when you arrive.
            </Text>
          )}
        </View>

        {req.reason ? (
          <Text style={styles.reqReason} numberOfLines={3}>“{req.reason}”</Text>
        ) : null}

        {isArrival ? (
          <TouchableOpacity
            style={[styles.reqBtn, styles.reqBtnArrival]}
            onPress={() => {
              Sentry.addBreadcrumb({
                category: 'handoff_clock_in',
                message: 'entry: notifications → handoff-clock-in',
                level: 'info',
                data: { shift_id: req.shift_id },
              });
              // Straight to the wizard. Routing via /shifts/{id} would work
              // for an accepted row (the tenancy exemption passes) but adds a
              // hop the guard does not need.
              router.push(`/shifts/${req.shift_id}/handoff-clock-in`);
            }}
            accessibilityRole="button"
          >
            <Text style={styles.reqBtnArrivalText}>GO TO HANDOFF CLOCK-IN</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.reqActions}>
            <TouchableOpacity
              style={[styles.reqBtn, styles.reqBtnDecline, busy && styles.reqBtnDisabled]}
              onPress={() => respond(req, false)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Decline ${isHandoff ? 'handoff' : 'swap'} from ${who}`}
            >
              {busy
                ? <ActivityIndicator color={Colors.danger} />
                : <Text style={styles.reqBtnDeclineText}>DECLINE</Text>}
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.reqBtn, styles.reqBtnAccept, busy && styles.reqBtnDisabled]}
              onPress={() => respond(req, true)}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`Accept ${isHandoff ? 'handoff' : 'swap'} from ${who}`}
            >
              {busy
                ? <ActivityIndicator color={Colors.structure} />
                : <Text style={styles.reqBtnAcceptText}>ACCEPT</Text>}
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  }

  const listHeader = actionable.length > 0 ? (
    <View style={styles.reqBlock}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionLabel}>PENDING REQUESTS</Text>
      </View>
      {actionable.map(renderRequest)}
    </View>
  ) : null;

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
      ) : sections.length === 0 && actionable.length === 0 ? (
        <View style={styles.center}>
          {/* One empty state for both "nothing has arrived yet" and "you
              cleared everything" — the guard cannot tell them apart and does
              not need to. Reads as settled, not broken.

              Gated on actionable.length too: a guard with a pending swap
              invite and an empty feed must NOT be told they are all caught
              up while an invite quietly expires behind the message. */}
          <Text style={styles.emptyIcon}>🔔</Text>
          <Text style={styles.emptyText}>You're all caught up</Text>
          <Text style={styles.emptySub}>Reminders and alerts will appear here</Text>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          ListHeaderComponent={listHeader}
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

  // ── Pending requests block ────────────────────────────────────────────
  // Full 1px border in the accent colour rather than the feed's 3px left
  // stripe: these are the only cards on this screen that carry actions, and
  // the heavier outline is what separates "do something" from "be told
  // something" at a glance.
  reqBlock: { marginBottom: Spacing.sm },
  reqCard: {
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    borderWidth: 1,
    padding: Spacing.md,
    marginBottom: Spacing.sm,
  },
  reqHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  reqBadge: {
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
    borderRadius: Radius.xs,
  },
  reqBadgeText: {
    fontFamily: Fonts.heading,
    color: Colors.structure,
    fontSize: 11,
    letterSpacing: 1.5,
  },
  reqTs: { color: Colors.muted, fontSize: 12 },
  reqHeadline: {
    color: Colors.textPrimary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: Spacing.sm,
  },
  reqWho: { fontFamily: Fonts.heading },
  reqShiftBox: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.sm,
    marginBottom: Spacing.sm,
  },
  reqSiteName: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 14,
    letterSpacing: 1.5,
    marginBottom: 2,
  },
  reqShiftTime: { color: Colors.textPrimary, fontSize: 13, opacity: 0.85 },
  reqTravelHint: { color: Colors.warning, fontSize: 12, marginTop: 6, lineHeight: 17 },
  reqReason: {
    color: Colors.muted,
    fontSize: 13,
    fontStyle: 'italic',
    lineHeight: 18,
    marginBottom: Spacing.sm,
  },
  reqActions: { flexDirection: 'row', gap: Spacing.sm },
  reqBtn: {
    flex: 1,
    borderRadius: Radius.md,
    paddingVertical: Spacing.sm + 2,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
  },
  reqBtnDisabled: { opacity: 0.5 },
  reqBtnDecline: { borderWidth: 1, borderColor: Colors.danger },
  reqBtnDeclineText: {
    fontFamily: Fonts.heading,
    color: Colors.danger,
    fontSize: 13,
    letterSpacing: 2,
  },
  reqBtnAccept: { backgroundColor: Colors.success },
  reqBtnAcceptText: {
    fontFamily: Fonts.heading,
    color: Colors.structure,
    fontSize: 13,
    letterSpacing: 2,
  },
  reqBtnArrival: { backgroundColor: Colors.warning },
  reqBtnArrivalText: {
    fontFamily: Fonts.heading,
    color: Colors.structure,
    fontSize: 13,
    letterSpacing: 2,
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
