/**
 * GPS-Only Ping (Section 5.4 — half-hour pings)
 * Blue theme. No camera. Posts location ping to API.
 * Shows accuracy ring and coords, then auto-navigates back to active shift.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Animated, Easing } from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useShiftStore }   from '../../store/shiftStore';
import { useOfflineStore } from '../../store/offlineStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const BLUE = '#3B82F6';

export default function GpsOnlyPing() {
  const [status, setStatus] = useState<'locating' | 'ready' | 'submitting' | 'done'>('locating');
  const [lat, setLat]       = useState<number | null>(null);
  const [lng, setLng]       = useState<number | null>(null);
  const [accuracy, setAcc]  = useState<number | null>(null);

  const { activeSession } = useShiftStore();
  const { submitPing }    = useOfflineStore();

  const pulseAnim = useRef(new Animated.Value(1)).current;

  // Pulsing ring animation
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.4, duration: 900, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,   duration: 900, easing: Easing.in(Easing.ease),  useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // Get location immediately on mount
  useEffect(() => {
    (async () => {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        setLat(loc.coords.latitude);
        setLng(loc.coords.longitude);
        setAcc(loc.coords.accuracy ?? null);
        setStatus('ready');
      } catch {
        Alert.alert('Location Error', 'Could not acquire GPS. Please try again.');
        router.back();
      }
    })();
  }, []);

  async function submit() {
    if (!lat || !lng || !activeSession) return;
    setStatus('submitting');
    try {
      await submitPing({
        shift_session_id: activeSession.id,
        latitude:         lat,
        longitude:        lng,
        ping_type:        'gps_only',
      });
      setStatus('done');
      setTimeout(() => router.replace('/active-shift'), 1200);
    } catch (err: any) {
      Alert.alert('Ping Failed', err?.message ?? 'Could not submit ping.');
      setStatus('ready');
    }
  }

  function fmtCoord(n: number) { return n.toFixed(6); }

  return (
    <View style={styles.container}>
      <Text style={styles.label}>GPS PING</Text>
      <Text style={styles.type}>LOCATION ONLY</Text>

      {/* Pulsing rings */}
      <View style={styles.ringWrap}>
        <Animated.View style={[styles.ring, styles.ringOuter, { transform: [{ scale: pulseAnim }] }]} />
        <View style={styles.ring}>
          <View style={styles.dot} />
        </View>
      </View>

      {/* Coordinates */}
      {lat !== null && (
        <View style={styles.coordCard}>
          <View style={styles.coordRow}>
            <Text style={styles.coordLabel}>LAT</Text>
            <Text style={styles.coordValue}>{fmtCoord(lat)}</Text>
          </View>
          <View style={styles.coordRow}>
            <Text style={styles.coordLabel}>LNG</Text>
            <Text style={styles.coordValue}>{fmtCoord(lng!)}</Text>
          </View>
          {accuracy !== null && (
            <View style={styles.coordRow}>
              <Text style={styles.coordLabel}>ACCURACY</Text>
              <Text style={styles.coordValue}>±{Math.round(accuracy)}m</Text>
            </View>
          )}
        </View>
      )}

      {status === 'done' ? (
        <View style={styles.successRow}>
          <Text style={styles.successText}>✓ PING SUBMITTED</Text>
        </View>
      ) : (
        <TouchableOpacity
          style={[styles.submitBtn, (status === 'locating' || status === 'submitting') && styles.disabled]}
          onPress={submit}
          disabled={status !== 'ready'}
        >
          <Text style={styles.submitText}>
            {status === 'locating' ? 'ACQUIRING GPS…' : status === 'submitting' ? 'SUBMITTING…' : 'SUBMIT PING'}
          </Text>
        </TouchableOpacity>
      )}

      <Text style={styles.timestamp}>{new Date().toLocaleString()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#0F172A',
    alignItems: 'center', justifyContent: 'center',
    padding: Spacing.xl,
  },
  label:   { color: BLUE, fontSize: 11, letterSpacing: 4, marginBottom: 4 },
  type:    { color: '#94A3B8', fontSize: 13, letterSpacing: 3, marginBottom: Spacing.xxl },

  // Rings
  ringWrap:  { width: 180, height: 180, alignItems: 'center', justifyContent: 'center', marginBottom: Spacing.xxl },
  ring: {
    position: 'absolute',
    width: 120, height: 120, borderRadius: 60,
    borderWidth: 2, borderColor: BLUE,
    alignItems: 'center', justifyContent: 'center',
  },
  ringOuter: { width: 160, height: 160, borderRadius: 80, borderColor: BLUE, opacity: 0.3 },
  dot:       { width: 20, height: 20, borderRadius: 10, backgroundColor: BLUE },

  // Coords
  coordCard: {
    width: '100%',
    backgroundColor: '#1E293B',
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: '#334155',
    padding: Spacing.lg,
    gap: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  coordRow:   { flexDirection: 'row', justifyContent: 'space-between' },
  coordLabel: { color: '#64748B', fontSize: 11, letterSpacing: 2 },
  coordValue: { color: '#E2E8F0', fontSize: 13, fontFamily: 'monospace' },

  // Button
  submitBtn: {
    width: '100%',
    backgroundColor: BLUE,
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center',
    marginBottom: Spacing.lg,
  },
  submitText: { fontFamily: Fonts.heading, color: '#FFFFFF', fontSize: 16, letterSpacing: 3 },
  disabled:   { opacity: 0.5 },

  successRow:  { alignItems: 'center', marginBottom: Spacing.lg },
  successText: { color: '#22C55E', fontSize: 18, fontFamily: Fonts.heading, letterSpacing: 3 },

  timestamp: { color: '#475569', fontSize: 11, fontFamily: 'monospace', marginTop: Spacing.md },
});
