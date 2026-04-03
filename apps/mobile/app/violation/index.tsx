/**
 * Geofence Violation Screen (Section 5.5)
 * Full-screen red takeover. Cannot be dismissed by swiping.
 * Blocks report submission. Resolves when guard returns inside boundary.
 * Polls GPS every 10 seconds — clears automatically when back inside.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, BackHandler, Animated, Easing } from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useShiftStore }  from '../../store/shiftStore';
import { isPointInPolygon, haversineDistance } from '../../utils/geofence';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const POLL_INTERVAL_MS = 10_000; // 10 seconds

const RED    = '#EF4444';
const DARKRED = '#7F1D1D';

export default function ViolationScreen() {
  const [lat, setLat]         = useState<number | null>(null);
  const [lng, setLng]         = useState<number | null>(null);
  const [distance, setDist]   = useState<number | null>(null);
  const [resolving, setRes]   = useState(false);

  const { activeShift } = useShiftStore();
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pollRef   = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Pulse animation ────────────────────────────────────────────────────
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 700, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1,    duration: 700, easing: Easing.in(Easing.ease),  useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  // ── Block hardware back button (Android) ──────────────────────────────
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // ── GPS polling ────────────────────────────────────────────────────────
  useEffect(() => {
    async function checkLocation() {
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        const { latitude, longitude } = loc.coords;
        setLat(latitude);
        setLng(longitude);

        const geofence = activeShift?.geofence;
        if (!geofence) return;

        // Compute distance to nearest polygon edge (approximate via center)
        const dist = haversineDistance(
          latitude, longitude,
          geofence.center_lat, geofence.center_lng
        );
        setDist(Math.round(dist));

        // Check if back inside
        const inside = isPointInPolygon(
          { lat: latitude, lng: longitude },
          geofence.polygon_coordinates
        );

        if (inside) {
          // Guard is back — clear violation and return to shift
          setRes(true);
          if (pollRef.current) clearInterval(pollRef.current);
          setTimeout(() => router.replace('/active-shift'), 1500);
        }
      } catch {
        // GPS failure — keep polling
      }
    }

    checkLocation();
    pollRef.current = setInterval(checkLocation, POLL_INTERVAL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [activeShift]);

  function fmtCoord(n: number) { return n.toFixed(5); }

  return (
    <View style={styles.container}>

      {/* Pulsing warning icon */}
      <Animated.View style={[styles.iconWrap, { transform: [{ scale: pulseAnim }] }]}>
        <Text style={styles.icon}>⚠</Text>
      </Animated.View>

      <Text style={styles.title}>GEOFENCE VIOLATION</Text>
      <Text style={styles.subtitle}>YOU ARE OUTSIDE THE SITE BOUNDARY</Text>

      {/* Live coordinates */}
      {lat !== null && (
        <View style={styles.coordCard}>
          <Text style={styles.coordHeader}>YOUR CURRENT LOCATION</Text>
          <Text style={styles.coordValue}>{fmtCoord(lat)}, {fmtCoord(lng!)}</Text>
          {distance !== null && (
            <Text style={styles.distText}>≈ {distance}m from site center</Text>
          )}
        </View>
      )}

      {/* Instructions */}
      <View style={styles.instructionCard}>
        <Text style={styles.instructionText}>
          Return to the designated site area to resolve this alert.{'\n\n'}
          Reports and tasks are blocked until the violation is cleared.{'\n\n'}
          Your supervisor has been notified.
        </Text>
      </View>

      {resolving ? (
        <View style={styles.resolvedBanner}>
          <Text style={styles.resolvedText}>✓ BACK ON SITE — RESOLVING…</Text>
        </View>
      ) : (
        <Text style={styles.polling}>Checking location every 10 seconds…</Text>
      )}

      <Text style={styles.timestamp}>{new Date().toLocaleString()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: DARKRED,
    alignItems: 'center',
    justifyContent: 'center',
    padding: Spacing.xl,
  },

  iconWrap: { marginBottom: Spacing.lg },
  icon:     { fontSize: 64, color: RED },

  title:    { fontFamily: Fonts.heading, color: '#FFFFFF', fontSize: 28, letterSpacing: 4, textAlign: 'center', marginBottom: Spacing.sm },
  subtitle: { color: '#FCA5A5', fontSize: 13, letterSpacing: 2, textAlign: 'center', marginBottom: Spacing.xl },

  coordCard: {
    width: '100%',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: RED,
    padding: Spacing.lg,
    alignItems: 'center',
    marginBottom: Spacing.md,
  },
  coordHeader: { color: '#FCA5A5', fontSize: 11, letterSpacing: 3, marginBottom: Spacing.xs },
  coordValue:  { color: '#FFFFFF', fontSize: 15, fontFamily: 'monospace' },
  distText:    { color: '#FCA5A5', fontSize: 12, marginTop: Spacing.xs },

  instructionCard: {
    width: '100%',
    backgroundColor: 'rgba(0,0,0,0.25)',
    borderRadius: Radius.lg,
    padding: Spacing.lg,
    marginBottom: Spacing.xl,
  },
  instructionText: { color: '#FEE2E2', fontSize: 14, lineHeight: 22, textAlign: 'center' },

  resolvedBanner: {
    backgroundColor: '#22C55E',
    borderRadius: Radius.md,
    paddingHorizontal: Spacing.xl,
    paddingVertical: Spacing.md,
    marginBottom: Spacing.lg,
  },
  resolvedText: { color: '#FFFFFF', fontFamily: Fonts.heading, fontSize: 16, letterSpacing: 3 },

  polling:   { color: '#FCA5A5', fontSize: 12, letterSpacing: 1, marginBottom: Spacing.xl },
  timestamp: { color: '#991B1B', fontSize: 11, fontFamily: 'monospace', marginTop: Spacing.lg },
});
