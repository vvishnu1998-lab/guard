/**
 * Ping Router (Section 5.4)
 * Determines ping type based on shift elapsed time:
 *   - On-hour pings (0, 60, 120 min elapsed) → GPS + Photo (amber)
 *   - Half-hour pings (30, 90, 150 min elapsed) → GPS only (blue)
 * Guards can also manually trigger a ping from the active shift screen.
 */
import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { Colors } from '../../constants/theme';

export default function PingRouter() {
  const { activeSession } = useShiftStore();

  useEffect(() => {
    if (!activeSession?.clocked_in_at) {
      router.replace('/(tabs)/home');
      return;
    }

    const elapsedMin = (Date.now() - new Date(activeSession.clocked_in_at).getTime()) / 60_000;
    // Alternating: 0=photo, 30=gps, 60=photo, 90=gps …
    const pingIndex = Math.floor(elapsedMin / 30);
    const isPhotoRequired = pingIndex % 2 === 0;

    router.replace(isPhotoRequired ? '/ping/photo' : '/ping/gps-only');
  }, []);

  return (
    <View style={styles.center}>
      <ActivityIndicator color={Colors.action} size="large" />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center' },
});
