import { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Dimensions, Linking,
} from 'react-native';
import MapView, { Marker, Circle } from 'react-native-maps';
import * as Location from 'expo-location';
import * as Sentry from '@sentry/react-native';
import { router, useFocusEffect } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { useClockInStore } from '../../store/clockInStore';
import { useOfflineStore } from '../../store/offlineStore';
import { useDrawerStore } from '../../store/drawerStore';
import { useAuthStore } from '../../store/authStore';
import { apiClient } from '../../lib/apiClient';
import { remainingMsUntilNextPing } from '../../lib/pingSchedule';
import { formatDurationMs, formatHoursHHMM, type ShiftHours } from '../../lib/formatHours';
import { SiteInstructionsModal } from '../../components/SiteInstructionsModal';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import { BreakType } from '../../constants/breakDurations';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface ApiShift {
  id: string;
  site_id: string;
  site_name: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
  instructions_pdf_url?: string | null;
}

interface ActiveSessionResponse {
  shift:   {
    id: string;
    site_id: string;
    site_name: string;
    scheduled_start: string;
    scheduled_end: string;
    /** Per-site ping cadence (Item 8). Optional in the type for backwards
     *  compat with older API versions; consumers fall back to 30. */
    ping_interval_minutes?: number;
  };
  session: { id: string; shift_id: string; clocked_in_at: string };
  /** Phase 1 4-field breakdown (server-truth, computed against NOW). Home
   *  reads break_hours off this so the stat bar's Break Time is the real
   *  cumulative time, not a hard-coded 0m. Refreshed on session fetch —
   *  live-tick between refreshes is a Phase 2.5 story. */
  hours?: ShiftHours;
}

// formatDuration removed 2026-07-18: replaced by formatDurationMs from
// lib/formatHours.ts so the stat bar renders in the same "Nh MMm" style
// (minutes zero-padded) that admin/client/emails use. See D2 contract.

function fmtTime(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function getCurrentTimeStr() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function HomeScreen() {
  const { activeSession, activeShift, setPendingShift, setActiveSession, currentBreak } = useShiftStore();
  const { setPendingShift: setClockInPendingShift, reset: resetClockIn } = useClockInStore();
  const { startSync, stopSync } = useOfflineStore();
  const { open: openDrawer } = useDrawerStore();
  const { guardId } = useAuthStore();
  const isOnShift = !!activeSession;

  const [upcomingShift, setUpcomingShift] = useState<ApiShift | null>(null);
  const [loadingShift, setLoadingShift] = useState(false);
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);
  const [currentTime, setCurrentTime] = useState(getCurrentTimeStr());
  const [elapsed, setElapsed] = useState(0);
  // Phase 1 4-field hours for the active session. Populated from
  // /shifts/active-session on restore/focus. Break Time on the stat bar
  // reads break_hours off this; null while loading or unclocked.
  const [activeHours, setActiveHours] = useState<ShiftHours | null>(null);
  const [showInstructions, setShowInstructions] = useState(false);

  // Walk-test 2026-07-09 BUG D: outbound handoff visibility. After the
  // requester (Deepak/James) sends a handoff, they had no way to see the
  // pending state without navigating into the shift detail's HISTORY.
  // Home surfaces it directly.
  interface OutboundHandoff {
    history_id:      string;
    shift_id:        string;
    requested_at:    string;
    accepted_at:     string | null;
    status:          'pending' | 'accepted' | 'declined' | 'expired' | 'cancelled';
    initiated_by:    'admin' | 'guard_pre_shift' | 'guard_handoff';
    to_session_id:   string | null;
    to_guard_id:     string;
    to_guard_name:   string | null;
    site_name:       string;
    site_tz:         string | null;
    scheduled_end:   string;
  }
  const [outboundHandoff, setOutboundHandoff] = useState<OutboundHandoff | null>(null);
  const [cancellingHandoff, setCancellingHandoff] = useState(false);
  const outboundFetchRef = useRef<AbortController | null>(null);

  async function fetchOutboundHandoff() {
    outboundFetchRef.current?.abort();
    const ctrl = new AbortController();
    outboundFetchRef.current = ctrl;
    try {
      const rows = await apiClient.get<OutboundHandoff[]>('/shifts/outbound-swap-requests');
      if (ctrl.signal.aborted) return;
      // Home only cares about handoffs, not pre-shift swaps.
      const handoff = rows.find((r) => r.initiated_by === 'guard_handoff') ?? null;
      setOutboundHandoff(handoff);
      Sentry.addBreadcrumb({
        category: 'home_tab',
        message: 'outbound_swap_requests_loaded',
        level: 'info',
        data: {
          total_rows:      rows.length,
          handoff_present: !!handoff,
          handoff_status:  handoff?.status ?? null,
        },
      });
    } catch (err: any) {
      if (!ctrl.signal.aborted) {
        Sentry.captureException(err, { extra: { where: 'home.fetchOutboundHandoff' } });
      }
    }
  }

  async function cancelOutboundHandoff() {
    if (!outboundHandoff || cancellingHandoff) return;
    setCancellingHandoff(true);
    try {
      await apiClient.post(`/shifts/${outboundHandoff.shift_id}/handoff-cancel`, {
        history_id: outboundHandoff.history_id,
      });
      setOutboundHandoff(null);
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: 'home.cancelOutboundHandoff' } });
      // eslint-disable-next-line no-alert
      alert(err?.message ?? 'Could not cancel handoff.');
    } finally {
      setCancellingHandoff(false);
    }
  }

  // Clock tick every minute
  useEffect(() => {
    const id = setInterval(() => setCurrentTime(getCurrentTimeStr()), 60000);
    return () => clearInterval(id);
  }, []);

  // BUG D — fetch outbound handoffs on focus AND every 30s so the card
  // stays fresh without the user needing to pull-to-refresh. Push
  // handler in _layout.tsx bumps the unread badge; here we refresh the
  // visible card independently.
  //
  // Walk-test 2026-07-10 BUG H tail — same trigger also runs the shift-
  // store's server reconciliation so the intra-app "user was on alerts
  // tab when the handoff completed and switched to home" path picks up
  // the drift without needing a background trip. The _layout.tsx
  // AppState listener covers the background-then-icon-open case; this
  // covers the tab-switch case.
  useFocusEffect(
    useCallback(() => {
      fetchOutboundHandoff();
      useShiftStore.getState().refreshFromServer();
      const id = setInterval(fetchOutboundHandoff, 30_000);
      return () => clearInterval(id);
    }, []),
  );

  // Working hours ticker.
  // Phase 1 D1 update: elapsed is RAW clocked_in_at → NOW, matching the
  // canonical actual_hours field returned by every /shifts endpoint. The
  // old MAX(clocked_in_at, scheduled_start) "Option C" truncation was
  // dropped so mobile agrees with admin/client. Early arrivals now
  // accumulate before scheduled_start — the same as what the guard sees
  // on the admin dashboard for their own shift.
  useEffect(() => {
    if (!activeSession?.clocked_in_at) { setElapsed(0); return; }
    const clockInMs = new Date(activeSession.clocked_in_at).getTime();
    const compute = () => Math.max(0, Date.now() - clockInMs);
    setElapsed(compute());
    const id = setInterval(() => setElapsed(compute()), 10000);
    return () => clearInterval(id);
  }, [activeSession?.clocked_in_at]);

  // ── Live Map location acquisition ─────────────────────────────────────────
  // Walk-test bug #4 remediation. Previously this effect fired watchPosition
  // *without* requesting foreground permission first, so on cold starts it
  // silently didn't emit until the root layout's permission-request effect
  // won a race. With no initialRegion on the MapView either, the placeholder
  // ("Acquiring location…") could sit for minutes.
  //
  // Fix:
  //   1. Request foreground permission explicitly and surface failure state.
  //   2. Kick a Low-accuracy first-fix in parallel with the Balanced watcher
  //      so the map gets *some* dot fast, then refines.
  //   3. 15-second first-fix timeout → Sentry breadcrumb + user-visible retry.
  //   4. Sentry.captureMessage on permission-denied so we can distinguish
  //      "user tapped Deny" from cold-start latency in production traces.
  const [locError, setLocError] = useState<'denied' | 'timeout' | null>(null);
  const watcherRef  = useRef<Location.LocationSubscription | null>(null);
  const timeoutRef  = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function acquireLocation() {
    setLocError(null);
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    watcherRef.current?.remove();
    watcherRef.current = null;

    const perm = await Location.requestForegroundPermissionsAsync();
    if (perm.status !== 'granted') {
      setLocError('denied');
      Sentry.captureMessage('home.map location permission denied', {
        level: 'warning',
        extra: { status: perm.status, canAskAgain: perm.canAskAgain },
      });
      return;
    }

    // Fire-and-forget: first fix at Low accuracy — usually < 2s. If getCurrent
    // errors (rare, e.g. Location Services disabled at OS level), silently
    // fall through to the watcher.
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Low })
      .then((pos) => setUserLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }))
      .catch(() => {});

    // 15-sec timeout — if the watcher hasn't emitted by then, show retry.
    // Cleared by the watcher's first emit below.
    timeoutRef.current = setTimeout(() => {
      // If we already have a fix from getCurrentPositionAsync above, skip.
      if (userLocation) return;
      setLocError('timeout');
      Sentry.captureMessage('home.map first fix timed out (15s)', {
        level: 'warning',
      });
    }, 15_000);

    watcherRef.current = await Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 30000, distanceInterval: 10 },
      (pos) => {
        setUserLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        setLocError(null);
      },
    );
  }

  useEffect(() => {
    acquireLocation();
    return () => {
      watcherRef.current?.remove();
      watcherRef.current = null;
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isOnShift) restoreOrFetchShift();
  }, [isOnShift]);

  useEffect(() => {
    if (isOnShift) {
      startSync();
      return () => stopSync();
    }
  }, [isOnShift]);

  async function restoreOrFetchShift() {
    setLoadingShift(true);
    try {
      const active = await apiClient.get<ActiveSessionResponse | null>('/shifts/active-session');
      if (active) {
        setActiveSession(active.shift, active.session);
        setActiveHours(active.hours ?? null);
        return;
      }
      // Session ended server-side. Clear the local hours cache too.
      setActiveHours(null);
    } catch { /* not on shift */ }
    fetchUpcomingShift();
  }

  async function fetchUpcomingShift() {
    setLoadingShift(true);
    try {
      const shifts = await apiClient.get<ApiShift[]>('/shifts');
      const next = shifts
        .filter((s) => s.status === 'scheduled')
        .sort((a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime())[0] ?? null;
      setUpcomingShift(next);
    } catch {
      setUpcomingShift(null);
    } finally {
      setLoadingShift(false);
    }
  }

  // Walk-test bug #1 — hydrate the site geofence into pendingShift BEFORE
  // entering the wizard. The list endpoint (/shifts) doesn't return
  // geofence, so we hit /shifts/:id (Phase 2a — guard-callable for own
  // shift) which now includes it. Step1 hard-fails when geofence is null,
  // so we surface the fetch failure here (alert + no route push) instead
  // of letting the guard walk into a broken screen.
  async function handleClockIn() {
    if (!upcomingShift) return;
    resetClockIn();
    Sentry.addBreadcrumb({
      category: 'clock_in_wizard',
      message: 'handleClockIn: hydrating shift',
      level: 'info',
      data: { shift_id: upcomingShift.id, site_id: upcomingShift.site_id, from_screen: 'home' },
    });
    try {
      const detail = await apiClient.get<{
        id: string;
        site_id: string;
        site_name: string;
        scheduled_start: string;
        scheduled_end: string;
        instructions_pdf_url?: string | null;
        geofence: {
          polygon_coordinates: { lat: number; lng: number }[];
          center_lat:     number;
          center_lng:     number;
          radius_meters:  number;
        } | null;
      }>(`/shifts/${upcomingShift.id}`);
      if (!detail.geofence) {
        Sentry.addBreadcrumb({
          category: 'clock_in_wizard',
          message: 'handleClockIn: geofence null (server response)',
          level: 'error',
          data: { shift_id: upcomingShift.id, site_id: upcomingShift.site_id },
        });
        Sentry.captureMessage('home.handleClockIn geofence missing', {
          level: 'error',
          extra: { shift_id: upcomingShift.id, site_id: upcomingShift.site_id },
        });
        // eslint-disable-next-line no-alert
        alert('Site boundary not configured. Please contact your supervisor.');
        return;
      }
      setPendingShift({
        id: detail.id,
        site_id: detail.site_id,
        site_name: detail.site_name,
        scheduled_start: detail.scheduled_start,
        scheduled_end: detail.scheduled_end,
        instructions_pdf_url: detail.instructions_pdf_url ?? null,
        geofence: detail.geofence,
      });
      setClockInPendingShift(detail.id);
      Sentry.addBreadcrumb({
        category: 'clock_in_wizard',
        message: 'handleClockIn: geofence hydrated, → step1',
        level: 'info',
      });
      router.push('/clock-in/step1');
    } catch (err: any) {
      Sentry.addBreadcrumb({
        category: 'clock_in_wizard',
        message: 'handleClockIn: /shifts/:id fetch failed',
        level: 'error',
        data: { error: err?.message ?? String(err) },
      });
      Sentry.captureException(err, { extra: { where: 'home.handleClockIn' } });
      // eslint-disable-next-line no-alert
      alert('Could not load shift details. Check your connection and try again.');
    }
  }

  const initials = guardId ? guardId.slice(0, 1).toUpperCase() : 'G';

  // Compute time-left
  const timeLeftMs = activeShift?.scheduled_end
    ? Math.max(0, new Date(activeShift.scheduled_end).getTime() - Date.now())
    : 0;

  return (
    <View style={styles.container}>
      {/* Fixed header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.avatarBtn} onPress={openDrawer}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
        </TouchableOpacity>

        <Text style={styles.logo}>NETRA</Text>

        <Text style={styles.timeDisplay}>{currentTime}</Text>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Map — MapView always mounts with a default initialRegion
            (SF Bay Area) so tiles render immediately. Once we have a real
            fix it re-centers via `region`. This is walk-test bug #4:
            previously the placeholder blocked the tab for minutes. */}
        <MapView
          style={styles.map}
          initialRegion={{
            latitude: 37.7749, longitude: -122.4194,   // SF fallback
            latitudeDelta: 0.05, longitudeDelta: 0.05, // wider so a real fix noticeably zooms in
          }}
          region={userLocation ? {
            latitude:  userLocation.latitude,
            longitude: userLocation.longitude,
            latitudeDelta:  0.005,
            longitudeDelta: 0.005,
          } : undefined}
          showsUserLocation
          showsMyLocationButton={false}
        >
          {userLocation && (
            <>
              <Marker coordinate={userLocation} title="You are here" pinColor={Colors.warning} />
              <Circle
                center={userLocation}
                radius={100}
                strokeColor="rgba(245,158,11,0.6)"
                fillColor="rgba(245,158,11,0.1)"
              />
            </>
          )}
        </MapView>
        {/* Overlays sit above the map. Only one shows at a time — no location
            fix yet: acquiring / timeout / denied. */}
        {!userLocation && locError === null && (
          <View style={styles.mapOverlay}>
            <ActivityIndicator color={Colors.action} />
            <Text style={styles.mapOverlaySub}>Acquiring location…</Text>
          </View>
        )}
        {!userLocation && locError === 'timeout' && (
          <View style={styles.mapOverlay}>
            <Text style={styles.mapOverlayText}>Location is taking longer than usual</Text>
            <TouchableOpacity style={styles.mapRetryBtn} onPress={acquireLocation}>
              <Text style={styles.mapRetryText}>RETRY</Text>
            </TouchableOpacity>
          </View>
        )}
        {locError === 'denied' && (
          <View style={styles.mapOverlay}>
            <Text style={styles.mapOverlayText}>Location permission is required for shift tracking</Text>
            <TouchableOpacity style={styles.mapRetryBtn} onPress={() => Linking.openSettings()}>
              <Text style={styles.mapRetryText}>OPEN SETTINGS</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* BUG D — outbound pending-handoff card. Renders between the Live
            Map overlay and the shift-state block. Both pending (waiting
            for reply) and accepted-not-arrived (waiting for arrival)
            variants render here, differentiated by copy. Tap on the card
            body routes to shift detail; explicit Cancel button POSTs
            /handoff-cancel. */}
        {outboundHandoff && (
          <TouchableOpacity
            style={styles.pendingOutboundCard}
            onPress={() => router.push(`/shifts/${outboundHandoff.shift_id}`)}
            activeOpacity={0.85}
          >
            <View style={styles.pendingOutboundHeaderRow}>
              <View style={styles.pendingOutboundBadge}>
                <Text style={styles.pendingOutboundBadgeText}>
                  {outboundHandoff.status === 'accepted' ? 'AWAITING ARRIVAL' : 'PENDING HANDOFF'}
                </Text>
              </View>
              <Text style={styles.pendingOutboundElapsed}>
                {(() => {
                  const anchor = outboundHandoff.accepted_at ?? outboundHandoff.requested_at;
                  const mins = Math.max(0, Math.floor((Date.now() - new Date(anchor).getTime()) / 60_000));
                  return mins < 1 ? 'just now' : `${mins}m ago`;
                })()}
              </Text>
            </View>
            <Text style={styles.pendingOutboundBody}>
              {outboundHandoff.status === 'accepted'
                ? `${outboundHandoff.to_guard_name ?? 'They'} accepted — waiting for them to clock in.`
                : `Waiting for ${outboundHandoff.to_guard_name ?? 'a guard'} to respond.`}
            </Text>
            {/* Server (shifts.ts POST /:id/handoff-cancel) allows cancel
                only for pre-arrival accepted handoffs. Rendering the
                button for status==='pending' or an arrived handoff put
                the guard on a path that always 409'd — see Sentry
                NETRAOPS-MOBILE-6. Hide (don't disable) the affordance
                when it wouldn't succeed. */}
            {outboundHandoff.status === 'accepted' && outboundHandoff.to_session_id === null && (
              <TouchableOpacity
                style={[styles.pendingOutboundCancelBtn, cancellingHandoff && styles.pendingOutboundCancelBtnDisabled]}
                onPress={cancelOutboundHandoff}
                disabled={cancellingHandoff}
                hitSlop={8}
              >
                <Text style={styles.pendingOutboundCancelText}>
                  {cancellingHandoff ? 'Cancelling…' : 'CANCEL HANDOFF'}
                </Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        )}

        {isOnShift ? (
          <>
            {/* Phase D — active break strip. Renders only when the store
                has an open currentBreak (populated from /active-session on
                refresh). Derived remaining from break_start + duration so
                the banner stays truthful even after a background trip. */}
            {currentBreak && (
              <BreakBanner
                breakType={currentBreak.break_type}
                breakStartMs={new Date(currentBreak.break_start).getTime()}
                durationMs={currentBreak.planned_duration_minutes * 60_000}
              />
            )}

            {/* Stat bar */}
            <View style={styles.statBar}>
              <View style={styles.statCol}>
                <Text style={styles.statValue}>{formatDurationMs(elapsed)}</Text>
                <Text style={styles.statLabel}>Working Hours</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCol}>
                <Text style={styles.statValue}>{formatDurationMs(timeLeftMs)}</Text>
                <Text style={styles.statLabel}>Time Left</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCol}>
                {/* Phase 3 — cumulative break_hours from /shifts/active-session.
                    Server-truth (open breaks counted up to NOW server-side),
                    refreshed on session fetch. Live-ticking between refreshes
                    would need either a polling loop or a shift-store extension;
                    kept out of scope for now — "—" while unloaded is honest. */}
                <Text style={styles.statValue}>{formatHoursHHMM(activeHours?.break_hours)}</Text>
                <Text style={styles.statLabel}>Break Time</Text>
              </View>
            </View>

            {/* Action buttons row */}
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => router.push('/reports/new')}
              >
                <Text style={styles.actionIcon}>📋</Text>
                <Text style={styles.actionLabel}>REPORTS</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => router.push('/(tabs)/tasks')}
              >
                <Text style={styles.actionIcon}>✅</Text>
                <Text style={styles.actionLabel}>TASKS</Text>
              </TouchableOpacity>
              {!!activeShift?.instructions_pdf_url && (
                <TouchableOpacity
                  style={styles.actionBtn}
                  onPress={() => setShowInstructions(true)}
                >
                  <Text style={styles.actionIcon}>📄</Text>
                  <Text style={styles.actionLabel}>INSTRUCTIONS</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Active shift card */}
            <TouchableOpacity
              style={styles.activeShiftCard}
              onPress={() => router.push('/active-shift')}
            >
              <View style={styles.activeShiftHeader}>
                <Text style={styles.activeShiftSite}>
                  {activeShift?.site_name?.toUpperCase()}
                </Text>
                <View style={styles.activeBadge}>
                  <Text style={styles.activeBadgeText}>SHIFT ACTIVE</Text>
                </View>
              </View>
              <Text style={styles.activeShiftTap}>TAP FOR DETAILS ›</Text>
              <PingCountdownBanner clockedInAt={activeSession?.clocked_in_at} />
            </TouchableOpacity>

            {/* Clock out button */}
            <TouchableOpacity
              style={styles.clockOutBtn}
              onPress={() => router.push('/clock-out')}
            >
              <Text style={styles.clockOutText}>CLOCK OUT</Text>
            </TouchableOpacity>
          </>
        ) : (
          /* Not on shift */
          <View style={styles.shiftCard}>
            {loadingShift ? (
              <ActivityIndicator color={Colors.action} style={{ marginBottom: Spacing.md }} />
            ) : upcomingShift ? (
              <>
                <Text style={styles.shiftLabel}>NEXT SHIFT</Text>
                <Text style={styles.shiftSite}>{upcomingShift.site_name.toUpperCase()}</Text>
                <Text style={styles.shiftTime}>
                  {fmtTime(upcomingShift.scheduled_start)}
                  {upcomingShift.scheduled_end && fmtTime(upcomingShift.scheduled_end)
                    ? ` – ${fmtTime(upcomingShift.scheduled_end)}`
                    : ''}
                </Text>
                <TouchableOpacity style={styles.clockInBtn} onPress={handleClockIn}>
                  <Text style={styles.clockInText}>CLOCK IN</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.noShift}>No scheduled shift</Text>
                <TouchableOpacity onPress={fetchUpcomingShift} style={styles.retryBtn}>
                  <Text style={styles.retryText}>Refresh</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        <View style={{ height: 32 }} />
      </ScrollView>
      {activeShift?.instructions_pdf_url ? (
        <SiteInstructionsModal
          pdfUrl={activeShift.instructions_pdf_url}
          visible={showInstructions}
          onClose={() => setShowInstructions(false)}
        />
      ) : null}
    </View>
  );
}

const BREAK_ICONS: Record<BreakType, string> = { meal: '🍱', rest: '☕', other: '⏸' };
const BREAK_LABELS: Record<BreakType, string> = { meal: 'MEAL BREAK', rest: 'REST BREAK', other: 'BREAK' };

function BreakBanner({ breakType, breakStartMs, durationMs }: {
  breakType: BreakType; breakStartMs: number; durationMs: number;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const remainingMs = Math.max(0, breakStartMs + durationMs - now);
  const mins = Math.floor(remainingMs / 60000);
  const secs = Math.floor((remainingMs % 60000) / 1000);
  const expired = remainingMs === 0;
  const label = expired
    ? 'BREAK EXPIRED — TAP TO END'
    : `${mins}:${String(secs).padStart(2, '0')} REMAINING`;
  return (
    <TouchableOpacity
      style={[styles.breakBanner, expired && styles.breakBannerExpired]}
      onPress={() => router.push('/break')}
      activeOpacity={0.85}
    >
      <Text style={styles.breakBannerIcon}>{BREAK_ICONS[breakType]}</Text>
      <Text style={styles.breakBannerLabel}>{BREAK_LABELS[breakType]}</Text>
      <Text style={styles.breakBannerSpacer}>·</Text>
      <Text style={[styles.breakBannerRemaining, expired && styles.breakBannerRemainingExpired]}>
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function PingCountdownBanner({ clockedInAt }: { clockedInAt?: string }) {
  const [remaining, setRemaining] = useState(0);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!clockedInAt) return;
    const clockedInDate = new Date(clockedInAt);
    const compute = () => remainingMsUntilNextPing(clockedInDate);
    setRemaining(compute());
    ref.current = setInterval(() => setRemaining(compute()), 1000);
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [clockedInAt]);

  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const label = `Next ping in ${mins}:${String(secs).padStart(2, '0')}`;

  return (
    <View style={styles.pingBanner}>
      <Text style={styles.pingText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.bg },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: Spacing.md,
    paddingTop: 54,
    paddingBottom: Spacing.sm,
    backgroundColor: Colors.bg,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  avatarBtn: { padding: 4 },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    fontFamily: Fonts.heading,
    color: '#070D1A',
    fontSize: 18,
    letterSpacing: 1,
  },
  logo: {
    fontFamily: Fonts.heading,
    color: Colors.action,
    fontSize: 24,
    letterSpacing: 6,
  },
  timeDisplay: {
    color: Colors.muted,
    fontSize: 16,
    letterSpacing: 1,
    minWidth: 46,
    textAlign: 'right',
  },

  scroll: { flex: 1 },

  map: { height: 220, width: '100%' },
  mapPlaceholder: {
    height: 220,
    backgroundColor: Colors.surface,
    justifyContent: 'center',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: 6,
  },
  mapText: { fontFamily: Fonts.heading, color: Colors.muted, fontSize: 20, letterSpacing: 4 },
  mapSub: { color: Colors.muted, fontSize: 13 },
  // Overlays sit on top of the map — semi-transparent scrim + centered
  // content — used when location isn't available yet or user has denied.
  mapOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    height: 220,
    backgroundColor: 'rgba(15, 25, 41, 0.88)',
    justifyContent: 'center',
    alignItems: 'center',
    gap: Spacing.sm,
    paddingHorizontal: Spacing.lg,
  },
  mapOverlayText: {
    color: Colors.textPrimary,
    fontSize: 14,
    textAlign: 'center',
  },
  mapOverlaySub: {
    color: Colors.muted,
    fontSize: 13,
  },
  mapRetryBtn: {
    marginTop: Spacing.sm,
    backgroundColor: Colors.action,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.sm,
    borderRadius: Radius.md,
  },
  mapRetryText: {
    fontFamily: Fonts.heading,
    color: '#070D1A',
    fontSize: 13,
    letterSpacing: 2,
  },

  // Pending outbound handoff card (BUG D — walk-test 2026-07-09)
  pendingOutboundCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1.5,
    borderColor: Colors.warning,
    marginTop: Spacing.md,
    marginHorizontal: Spacing.md,
    padding: Spacing.md,
  },
  pendingOutboundHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  pendingOutboundBadge: {
    backgroundColor: Colors.warning,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 2,
    borderRadius: Radius.xs,
  },
  pendingOutboundBadgeText: {
    color: '#070D1A',
    fontFamily: Fonts.heading,
    fontSize: 10,
    letterSpacing: 1,
  },
  pendingOutboundElapsed: {
    color: Colors.muted,
    fontSize: 11,
  },
  pendingOutboundBody: {
    color: Colors.textPrimary,
    fontSize: 13,
    marginBottom: Spacing.sm,
  },
  pendingOutboundCancelBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 4,
  },
  pendingOutboundCancelBtnDisabled: { opacity: 0.5 },
  pendingOutboundCancelText: {
    color: Colors.danger,
    fontFamily: Fonts.heading,
    fontSize: 11,
    letterSpacing: 1.5,
    textDecorationLine: 'underline',
  },

  // Stat bar
  statBar: {
    flexDirection: 'row',
    backgroundColor: Colors.surface,
    borderTopLeftRadius: 0,
    borderTopRightRadius: 0,
    borderBottomLeftRadius: 0,
    borderBottomRightRadius: 0,
    borderTopWidth: 1,
    borderTopColor: Colors.border,
    paddingVertical: Spacing.md,
  },
  statCol: { flex: 1, alignItems: 'center' },
  statValue: {
    fontFamily: Fonts.heading,
    color: Colors.action,
    fontSize: 22,
    letterSpacing: 1,
    marginBottom: 2,
  },
  statLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 1 },
  statDivider: { width: 1, backgroundColor: Colors.border, marginVertical: 4 },

  // Action buttons
  actionRow: {
    flexDirection: 'row',
    paddingHorizontal: Spacing.md,
    paddingVertical: Spacing.md,
    gap: Spacing.sm,
    backgroundColor: Colors.bg,
  },
  actionBtn: {
    flex: 1,
    backgroundColor: Colors.surface,
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: Radius.md,
    paddingVertical: Spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
  actionIcon: { fontSize: 22 },
  actionLabel: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 11,
    letterSpacing: 1.5,
  },

  // Active shift card
  activeShiftCard: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    backgroundColor: Colors.surface2,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.lg,
  },
  activeShiftHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: Spacing.sm,
  },
  activeShiftSite: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 22,
    letterSpacing: 3,
    flex: 1,
  },
  activeBadge: {
    backgroundColor: Colors.success + '22',
    borderWidth: 1,
    borderColor: Colors.success,
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 3,
  },
  activeBadgeText: {
    fontFamily: Fonts.heading,
    color: Colors.success,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  activeShiftTap: {
    color: Colors.action,
    fontSize: 13,
    letterSpacing: 1,
    marginBottom: Spacing.md,
  },
  pingBanner: {
    backgroundColor: Colors.bg,
    borderRadius: Radius.sm,
    padding: Spacing.sm,
    borderLeftWidth: 3,
    borderLeftColor: Colors.action,
  },
  pingText: { color: Colors.action, fontSize: 13, letterSpacing: 0.5 },

  breakBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.surface,
    marginHorizontal: Spacing.md,
    marginTop: Spacing.md,
    marginBottom: 0,
    paddingVertical: Spacing.sm,
    paddingHorizontal: Spacing.md,
    borderRadius: Radius.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.action,
    gap: Spacing.sm,
  },
  breakBannerExpired: { borderLeftColor: Colors.danger },
  breakBannerIcon: { fontSize: 18 },
  breakBannerLabel: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 12,
    letterSpacing: 2,
  },
  breakBannerSpacer: { color: Colors.muted, fontSize: 12 },
  breakBannerRemaining: {
    flex: 1,
    fontFamily: 'monospace',
    color: Colors.action,
    fontSize: 13,
    letterSpacing: 1,
  },
  breakBannerRemainingExpired: {
    fontFamily: Fonts.heading,
    color: Colors.danger,
    letterSpacing: 1.5,
  },

  // Clock out
  clockOutBtn: {
    marginHorizontal: Spacing.md,
    marginBottom: Spacing.md,
    backgroundColor: Colors.danger,
    borderRadius: Radius.md,
    height: 54,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clockOutText: {
    fontFamily: Fonts.heading,
    color: Colors.white,
    fontSize: 18,
    letterSpacing: 3,
  },

  // Not on shift
  shiftCard: {
    margin: Spacing.md,
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    borderWidth: 1,
    borderColor: Colors.border,
  },
  shiftLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: 4 },
  shiftSite: {
    fontFamily: Fonts.heading,
    color: Colors.textPrimary,
    fontSize: 24,
    letterSpacing: 3,
    marginBottom: 4,
  },
  shiftTime: { color: Colors.muted, fontSize: 16, marginBottom: Spacing.md },
  noShift: { color: Colors.muted, fontSize: 16, marginBottom: Spacing.sm },
  retryBtn: { alignSelf: 'flex-start' },
  retryText: { color: Colors.action, fontSize: 14 },
  clockInBtn: {
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    padding: Spacing.md,
    alignItems: 'center',
    marginTop: Spacing.sm,
    height: 54,
    justifyContent: 'center',
  },
  clockInText: {
    fontFamily: Fonts.heading,
    color: '#070D1A',
    fontSize: 18,
    letterSpacing: 3,
  },
});
