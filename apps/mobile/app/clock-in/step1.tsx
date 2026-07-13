/**
 * Clock-In Flow — Step 1: GPS Verification (Section 5.2)
 * Animated GPS check with pulsing rings. Button disabled until inside geofence.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as Location from 'expo-location';
import * as Sentry from '@sentry/react-native';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { useClockInStore } from '../../store/clockInStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import { isPointInPolygon, haversineDistance } from '../../utils/geofence';

type CheckState = 'checking' | 'inside' | 'outside' | 'error';

export default function ClockInStep1() {
  const [state, setState] = useState<CheckState>('checking');
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const { pendingShift } = useShiftStore();
  const { setGpsVerified } = useClockInStore();

  // Walk-test 2026-07-10 BUG J — a live watcher instead of one-shot polling.
  // The prior version called Location.getCurrentPositionAsync({Balanced}) on
  // mount and again on RETRY. On iOS, Balanced accuracy uses wifi/cell
  // triangulation and returns whatever CLLocationManager last cached — which
  // is up to several minutes old and does NOT refresh just because the
  // guard has physically walked to the site. James's Build-30 walk-test:
  // opened wizard outside geofence, walked ~200m onto site, tapped RETRY,
  // still saw OFFSITE. Force-quit + relaunch worked because a fresh process
  // starts CoreLocation from empty. Fix: start watchPositionAsync on mount
  // so the sensor stays warm during the walk; each emission re-runs the
  // boundary check and auto-flips state to 'inside' when the guard crosses
  // in. The RETRY button is retained as a fallback in case the watcher
  // stalls (permission revocation mid-session, hard OS quirks).
  const watcherRef = useRef<Location.LocationSubscription | null>(null);
  // Tracks the last boundary-check outcome so we log a Sentry breadcrumb
  // ONLY on crossing (not every 3s emission while inside/outside is stable).
  // Starts null so the first evaluation is treated as a crossing.
  const lastInsideRef = useRef<boolean | null>(null);

  async function stopWatcher() {
    watcherRef.current?.remove();
    watcherRef.current = null;
  }

  function evaluatePoint(point: { lat: number; lng: number }, accuracy: number) {
    const geofence = pendingShift?.geofence;
    if (!geofence) {
      // Walk-test bug #1: previously we silently allowed clock-in when
      // pendingShift.geofence was missing (which was always, because the
      // /shifts list endpoint didn't return geofence). Home.tsx now
      // fetches /shifts/:id and hydrates geofence before entering the
      // wizard, so a missing geofence here means either the site has no
      // geofence configured or something is very wrong. Hard-fail.
      setState('error');
      return;
    }
    setCoords(point);
    const approxDistance = haversineDistance(point.lat, point.lng, geofence.center_lat, geofence.center_lng);
    if (approxDistance > geofence.radius_meters * 1.5) {
      if (lastInsideRef.current !== false) {
        Sentry.addBreadcrumb({
          category: 'clock_in_wizard',
          message: 'step1: watcher emitted → outside (radius pre-check)',
          level: 'info',
          data: { distance_m: Math.round(approxDistance), radius_m: geofence.radius_meters },
        });
      }
      lastInsideRef.current = false;
      setState('outside');
      return;
    }
    const inside = isPointInPolygon(point, geofence.polygon_coordinates);
    if (inside && lastInsideRef.current !== true) {
      // Boundary crossing from outside/unknown to inside — the key
      // observability point for this bug.
      Sentry.addBreadcrumb({
        category: 'clock_in_wizard',
        message: 'step1: watcher emitted → inside',
        level: 'info',
        data: { distance_m: Math.round(approxDistance), accuracy_m: Math.round(accuracy) },
      });
      setGpsVerified(point.lat, point.lng, accuracy);
    } else if (!inside && lastInsideRef.current !== false) {
      Sentry.addBreadcrumb({
        category: 'clock_in_wizard',
        message: 'step1: watcher emitted → outside (polygon)',
        level: 'info',
        data: { distance_m: Math.round(approxDistance) },
      });
    }
    lastInsideRef.current = inside;
    setState(inside ? 'inside' : 'outside');
  }

  async function startWatcher() {
    await stopWatcher();
    lastInsideRef.current = null;
    setState('checking');
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Sentry.addBreadcrumb({
          category: 'clock_in_wizard',
          message: 'step1: location permission not granted',
          level: 'warning',
          data: { permission_status: status },
        });
        setState('error');
        return;
      }

      // Fast first fix — Balanced usually lands in 1-3s. Runs in parallel
      // with the watcher below so the UI unblocks even if the watcher
      // takes a beat to emit. Failures here are silent — the watcher is
      // the source of truth.
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced })
        .then((loc) => {
          const acc = typeof loc.coords.accuracy === 'number' ? loc.coords.accuracy : 30;
          Sentry.addBreadcrumb({
            category: 'clock_in_wizard',
            message: 'step1: first fix acquired',
            level: 'info',
            data: { accuracy_m: Math.round(acc) },
          });
          evaluatePoint({ lat: loc.coords.latitude, lng: loc.coords.longitude }, acc);
        })
        .catch(() => {});

      // Continuous watcher — 5m or 3s cadence, Balanced accuracy. Keeps
      // CLLocationManager warm so the guard crossing into the polygon
      // auto-transitions to 'inside' without needing a RETRY tap. The
      // retained retry link handles the pathological case where the
      // watcher never emits (permission changed mid-session, etc.).
      watcherRef.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 5, timeInterval: 3000 },
        (loc) => {
          const acc = typeof loc.coords.accuracy === 'number' ? loc.coords.accuracy : 30;
          evaluatePoint({ lat: loc.coords.latitude, lng: loc.coords.longitude }, acc);
        },
      );
    } catch (err) {
      Sentry.addBreadcrumb({
        category: 'clock_in_wizard',
        message: 'step1: watcher start threw',
        level: 'error',
      });
      Sentry.captureException(err, { extra: { where: 'clockin.step1.startWatcher' } });
      setState('error');
    }
  }

  useEffect(() => {
    Sentry.addBreadcrumb({
      category: 'clock_in_wizard',
      message: 'entered step1 (GPS Verification)',
      level: 'info',
      data: { shift_id: pendingShift?.id, site_id: pendingShift?.site_id },
    });
    startWatcher();
    return () => {
      // Effect cleanup — covers unmount from back-nav, route swap, JS
      // error boundary, etc.
      stopWatcher();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View style={styles.container}>
      <Text style={styles.step}>CLOCK IN · STEP 1 OF 3</Text>
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
        onPress={() => {
          // Explicit stop before navigation. Effect-cleanup will run on
          // unmount anyway, but stopping here removes any race where a
          // watcher callback lands after router.replace and setState on
          // an unmounted component throws a warning.
          stopWatcher();
          Sentry.addBreadcrumb({
            category: 'clock_in_wizard',
            message: 'step1 → step2 (watcher stopped)',
            level: 'info',
          });
          router.replace('/clock-in/step2');
        }}
      >
        <Text style={styles.buttonText}>NEXT: TAKE SELFIE</Text>
      </TouchableOpacity>

      {(state === 'outside' || state === 'error') && (
        <TouchableOpacity onPress={startWatcher} style={styles.retryButton}>
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
