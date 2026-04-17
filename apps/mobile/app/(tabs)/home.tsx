import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, ActivityIndicator } from 'react-native';
import MapView, { Marker, Circle } from 'react-native-maps';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { useClockInStore } from '../../store/clockInStore';
import { useOfflineStore } from '../../store/offlineStore';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

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

export default function HomeScreen() {
  const { activeSession, activeShift, setPendingShift, setActiveSession } = useShiftStore();
  const { setPendingShift: setClockInPendingShift, reset: resetClockIn } = useClockInStore();
  const { startSync, stopSync } = useOfflineStore();
  const isOnShift = !!activeSession;

  const [upcomingShift, setUpcomingShift] = useState<ApiShift | null>(null);
  const [loadingShift, setLoadingShift] = useState(false);
  const [userLocation, setUserLocation] = useState<{ latitude: number; longitude: number } | null>(null);

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
    if (!isOnShift) {
      // First check if there's an active session in the DB (e.g. after app reload)
      restoreOrFetchShift();
    }
  }, [isOnShift]);

  // Start/stop offline queue sync while on shift
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
    // Set the shift in both stores before entering the flow
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

  function fmtTime(iso: string) {
    return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  return (
    <View style={styles.container}>
      {/* Live map */}
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
          <Marker coordinate={userLocation} title="You are here" pinColor="#F59E0B" />
          <Circle
            center={userLocation}
            radius={100}
            strokeColor="rgba(245,158,11,0.6)"
            fillColor="rgba(245,158,11,0.1)"
          />
        </MapView>
      ) : (
        <View style={styles.mapPlaceholder}>
          <Text style={styles.mapText}>LIVE MAP</Text>
          <Text style={styles.mapSub}>Acquiring location…</Text>
        </View>
      )}

      {/* Shift card */}
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {isOnShift ? (
          <TouchableOpacity style={styles.shiftCard} onPress={() => router.push('/active-shift')}>
            <Text style={styles.shiftSite}>{activeShift?.site_name?.toUpperCase()}</Text>
            <Text style={styles.shiftStatus}>SHIFT ACTIVE  ›</Text>
            <PingCountdownBanner clockedInAt={activeSession?.clocked_in_at} />
          </TouchableOpacity>
        ) : (
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
                <TouchableOpacity style={styles.clockInButton} onPress={handleClockIn}>
                  <Text style={styles.clockInText}>CLOCK IN</Text>
                </TouchableOpacity>
              </>
            ) : (
              <>
                <Text style={styles.noShift}>No scheduled shift</Text>
                <TouchableOpacity onPress={fetchUpcomingShift} style={styles.retryButton}>
                  <Text style={styles.retryText}>Refresh</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* Quick actions */}
        <Text style={styles.sectionTitle}>QUICK ACTIONS</Text>
        <View style={styles.actionGrid}>
          <ActionButton label="ADD REPORT" color={Colors.action} onPress={() => router.push('/reports/new')} disabled={!isOnShift} />
          <ActionButton label="TASKS" color={Colors.action} onPress={() => router.push('/(tabs)/tasks')} disabled={!isOnShift} />
          <ActionButton label="INCIDENT" color={Colors.danger} onPress={() => router.push('/reports/new/incident')} disabled={!isOnShift} />
          <ActionButton label="TAKE BREAK" color={Colors.muted} onPress={() => router.push('/break')} disabled={!isOnShift} />
        </View>
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

function ActionButton({ label, color, onPress, disabled }: { label: string; color: string; onPress: () => void; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.actionButton, { borderColor: color, opacity: disabled ? 0.4 : 1 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={[styles.actionLabel, { color }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },
  map: { height: 240, width: '100%' },
  mapPlaceholder: {
    height: 240, backgroundColor: Colors.surface,
    justifyContent: 'center', alignItems: 'center',
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  mapText: { fontFamily: Fonts.heading, color: Colors.action, fontSize: 24, letterSpacing: 4 },
  mapSub: { color: Colors.muted, fontSize: 12, marginTop: 4 },
  content: { flex: 1, padding: Spacing.md },
  shiftCard: {
    backgroundColor: Colors.surface, borderRadius: Radius.lg,
    padding: Spacing.lg, marginBottom: Spacing.lg,
    borderWidth: 1, borderColor: Colors.border,
  },
  shiftLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: 4 },
  shiftSite: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, letterSpacing: 3, marginBottom: 4 },
  shiftTime: { color: Colors.muted, fontSize: 14, marginBottom: Spacing.md },
  shiftStatus: { color: Colors.success, fontSize: 12, letterSpacing: 2, marginTop: 4 },
  noShift: { color: Colors.muted, fontSize: 16, marginBottom: Spacing.sm },
  retryButton: { alignSelf: 'flex-start' },
  retryText: { color: Colors.action, fontSize: 14 },
  clockInButton: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center', marginTop: Spacing.sm,
  },
  clockInText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 2 },
  pingBanner: {
    marginTop: Spacing.md, backgroundColor: Colors.structure,
    borderRadius: Radius.sm, padding: Spacing.sm,
    borderLeftWidth: 3, borderLeftColor: Colors.action,
  },
  pingText: { color: Colors.action, fontSize: 12, letterSpacing: 1 },
  sectionTitle: { fontFamily: Fonts.heading, color: Colors.muted, fontSize: 13, letterSpacing: 3, marginBottom: Spacing.sm },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  actionButton: {
    width: '47%', borderRadius: Radius.md, borderWidth: 1.5,
    padding: Spacing.md, alignItems: 'center',
  },
  actionLabel: { fontFamily: Fonts.heading, fontSize: 14, letterSpacing: 2 },
});
