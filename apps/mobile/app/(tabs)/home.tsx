import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  ActivityIndicator, Dimensions,
} from 'react-native';
import MapView, { Marker, Circle } from 'react-native-maps';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useShiftStore } from '../../store/shiftStore';
import { useClockInStore } from '../../store/clockInStore';
import { useOfflineStore } from '../../store/offlineStore';
import { useDrawerStore } from '../../store/drawerStore';
import { useAuthStore } from '../../store/authStore';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface ApiShift {
  id: string;
  site_id: string;
  site_name: string;
  scheduled_start: string;
  scheduled_end: string;
  status: string;
}

interface ActiveSessionResponse {
  shift:   { id: string; site_id: string; site_name: string; scheduled_start: string; scheduled_end: string };
  session: { id: string; shift_id: string; clocked_in_at: string };
}

function formatDuration(ms: number) {
  const totalMins = Math.floor(ms / 60000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function getCurrentTimeStr() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function HomeScreen() {
  const { activeSession, activeShift, setPendingShift, setActiveSession } = useShiftStore();
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

  // Clock tick every minute
  useEffect(() => {
    const id = setInterval(() => setCurrentTime(getCurrentTimeStr()), 60000);
    return () => clearInterval(id);
  }, []);

  // Working hours ticker
  useEffect(() => {
    if (!activeSession?.clocked_in_at) { setElapsed(0); return; }
    const compute = () => Date.now() - new Date(activeSession.clocked_in_at).getTime();
    setElapsed(compute());
    const id = setInterval(() => setElapsed(compute()), 10000);
    return () => clearInterval(id);
  }, [activeSession?.clocked_in_at]);

  useEffect(() => {
    Location.getLastKnownPositionAsync()
      .then((pos) => { if (pos) setUserLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }); })
      .catch(() => {});
    Location.watchPositionAsync(
      { accuracy: Location.Accuracy.Balanced, timeInterval: 30000, distanceInterval: 10 },
      (pos) => setUserLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })
    );
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
        return;
      }
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

  function handleClockIn() {
    if (!upcomingShift) return;
    resetClockIn();
    setPendingShift({
      id: upcomingShift.id,
      site_id: upcomingShift.site_id,
      site_name: upcomingShift.site_name,
      scheduled_start: upcomingShift.scheduled_start,
      scheduled_end: upcomingShift.scheduled_end,
    });
    setClockInPendingShift(upcomingShift.id);
    router.push('/clock-in/step1');
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

        <Text style={styles.logo}>V·WING</Text>

        <Text style={styles.timeDisplay}>{currentTime}</Text>
      </View>

      <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Map */}
        {userLocation ? (
          <MapView
            style={styles.map}
            region={{
              latitude: userLocation.latitude,
              longitude: userLocation.longitude,
              latitudeDelta: 0.005,
              longitudeDelta: 0.005,
            }}
            showsUserLocation
            showsMyLocationButton={false}
          >
            <Marker coordinate={userLocation} title="You are here" pinColor={Colors.warning} />
            <Circle
              center={userLocation}
              radius={100}
              strokeColor="rgba(245,158,11,0.6)"
              fillColor="rgba(245,158,11,0.1)"
            />
          </MapView>
        ) : (
          <View style={styles.mapPlaceholder}>
            <Ionicons name="location-outline" size={32} color={Colors.muted} />
            <Text style={styles.mapText}>LIVE MAP</Text>
            <Text style={styles.mapSub}>Acquiring location…</Text>
          </View>
        )}

        {isOnShift ? (
          <>
            {/* Stat bar */}
            <View style={styles.statBar}>
              <View style={styles.statCol}>
                <Text style={styles.statValue}>{formatDuration(elapsed)}</Text>
                <Text style={styles.statLabel}>Working Hours</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCol}>
                <Text style={styles.statValue}>{formatDuration(timeLeftMs)}</Text>
                <Text style={styles.statLabel}>Time Left</Text>
              </View>
              <View style={styles.statDivider} />
              <View style={styles.statCol}>
                <Text style={styles.statValue}>0m</Text>
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
                <Text style={styles.actionLabel}>ADD REPORT</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => router.push('/(tabs)/tasks')}
              >
                <Text style={styles.actionIcon}>✅</Text>
                <Text style={styles.actionLabel}>TASKS</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.actionBtn}
                onPress={() => router.push('/ping')}
              >
                <Text style={styles.actionIcon}>📍</Text>
                <Text style={styles.actionLabel}>PING</Text>
              </TouchableOpacity>
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
                  {fmtTime(upcomingShift.scheduled_start)} – {fmtTime(upcomingShift.scheduled_end)}
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
    </View>
  );
}

function PingCountdownBanner({ clockedInAt }: { clockedInAt?: string }) {
  const PING_MS = 30 * 60 * 1000;
  const [remaining, setRemaining] = useState(PING_MS);
  const ref = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!clockedInAt) return;
    function compute() {
      const elapsed = Date.now() - new Date(clockedInAt!).getTime();
      return PING_MS - (elapsed % PING_MS);
    }
    setRemaining(compute());
    ref.current = setInterval(() => setRemaining(compute()), 1000);
    return () => { if (ref.current) clearInterval(ref.current); };
  }, [clockedInAt]);

  const elapsedMs = clockedInAt ? Date.now() - new Date(clockedInAt).getTime() : 0;
  const pingIndex = Math.floor(elapsedMs / PING_MS);
  const pingType  = pingIndex % 2 === 0 ? 'GPS + PHOTO' : 'GPS ONLY';
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  const label = `Next ping in ${mins}:${String(secs).padStart(2, '0')} · ${pingType}`;

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
