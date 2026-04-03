/**
 * Clock-In Flow — Step 1: GPS Verification (Section 5.2)
 * Animated GPS check with pulsing rings. Button disabled until inside geofence.
 */
import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import { isPointInPolygon, haversineDistance } from '../../utils/geofence';

type CheckState = 'checking' | 'inside' | 'outside' | 'error';

export default function ClockInStep1() {
  const [state, setState] = useState<CheckState>('checking');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const { pendingShift } = useShiftStore();

  useEffect(() => {
    checkGeofence();
  }, []);

  async function checkGeofence() {
    setState('checking');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { setState('error'); return; }

      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const point = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      setCoords(point);

      const geofence = pendingShift?.geofence;
      if (!geofence) { setState('inside'); return; } // no geofence = always allow

      // Fast radius pre-check (Haversine) then precise polygon check (ray casting)
      const approxDistance = haversineDistance(point.lat, point.lng, geofence.center_lat, geofence.center_lng);
      if (approxDistance > geofence.radius_meters * 1.5) {
        setState('outside');
        return;
      }
      const inside = isPointInPolygon(point, geofence.polygon_coordinates);
      setState(inside ? 'inside' : 'outside');
    } catch {
      setState('error');
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.step}>CLOCK IN · STEP 1 OF 4</Text>
      <Text style={styles.title}>GPS VERIFICATION</Text>

      <View style={styles.pulseContainer}>
        {/* Pulsing rings rendered as concentric circles */}
        <View style={[styles.ring, styles.ring3, state === 'inside' && styles.ringGreen]} />
        <View style={[styles.ring, styles.ring2, state === 'inside' && styles.ringGreen]} />
        <View style={[styles.ring, styles.ring1, state === 'inside' && styles.ringGreen]} />
        <View style={[styles.centerDot, state === 'inside' && styles.centerGreen]}>
          {state === 'checking' && <ActivityIndicator color={Colors.action} />}
          {state === 'inside' && <Text style={styles.checkmark}>✓</Text>}
          {state === 'outside' && <Text style={styles.cross}>✗</Text>}
        </View>
      </View>

      <View style={styles.statusCard}>
        <StatusRow label="GPS Signal" value={state === 'error' ? 'No Signal' : 'Strong'} />
        {coords && <StatusRow label="Coordinates" value={`${coords.lat.toFixed(5)}, ${coords.lng.toFixed(5)}`} />}
        <StatusRow
          label="Boundary Check"
          value={state === 'checking' ? 'Checking...' : state === 'inside' ? 'Inside boundary' : state === 'outside' ? 'Outside boundary' : 'Error'}
          valueColor={state === 'inside' ? Colors.success : state === 'outside' ? Colors.danger : Colors.muted}
        />
      </View>

      {state === 'outside' && (
        <Text style={styles.outsideWarning}>You must be inside the site boundary to clock in.</Text>
      )}

      <TouchableOpacity
        style={[styles.button, state !== 'inside' && styles.buttonDisabled]}
        disabled={state !== 'inside'}
        onPress={() => router.push('/clock-in/step2')}
      >
        <Text style={styles.buttonText}>NEXT: TAKE SELFIE</Text>
      </TouchableOpacity>

      {(state === 'outside' || state === 'error') && (
        <TouchableOpacity onPress={checkGeofence} style={styles.retryButton}>
          <Text style={styles.retryText}>Retry GPS Check</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function StatusRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.statusRow}>
      <Text style={styles.statusLabel}>{label}</Text>
      <Text style={[styles.statusValue, valueColor ? { color: valueColor } : {}]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure, padding: Spacing.xl, alignItems: 'center', justifyContent: 'center' },
  step: { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: Spacing.sm },
  title: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 32, letterSpacing: 4, marginBottom: Spacing.xxl },
  pulseContainer: { width: 200, height: 200, justifyContent: 'center', alignItems: 'center', marginBottom: Spacing.xxl },
  ring: { position: 'absolute', borderRadius: Radius.full, borderWidth: 1.5, borderColor: Colors.action + '40' },
  ring3: { width: 200, height: 200 },
  ring2: { width: 140, height: 140 },
  ring1: { width: 80, height: 80 },
  ringGreen: { borderColor: Colors.success + '40' },
  centerDot: {
    width: 48, height: 48, borderRadius: Radius.full,
    backgroundColor: Colors.surface, borderWidth: 2, borderColor: Colors.action,
    justifyContent: 'center', alignItems: 'center',
  },
  centerGreen: { borderColor: Colors.success },
  checkmark: { color: Colors.success, fontSize: 20 },
  cross: { color: Colors.danger, fontSize: 20 },
  statusCard: { width: '100%', backgroundColor: Colors.surface, borderRadius: Radius.lg, padding: Spacing.lg, marginBottom: Spacing.xl },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: Spacing.sm },
  statusLabel: { color: Colors.muted, fontSize: 13 },
  statusValue: { color: Colors.base, fontSize: 13 },
  outsideWarning: { color: Colors.danger, textAlign: 'center', marginBottom: Spacing.md, fontSize: 13 },
  button: {
    width: '100%', backgroundColor: Colors.action,
    borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center',
  },
  buttonDisabled: { opacity: 0.3 },
  buttonText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 2 },
  retryButton: { marginTop: Spacing.md },
  retryText: { color: Colors.action, fontSize: 14 },
});
