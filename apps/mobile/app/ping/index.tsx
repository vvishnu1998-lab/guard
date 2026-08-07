/**
 * Ping Router — always routes to the photo+GPS capture flow.
 * (Previously alternated between photo and GPS-only every 30 min;
 * product decision moved to "always photo" so admin/client review
 * gets a consistent visual record at every ping.)
 */
import { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { Colors } from '../../constants/theme';

export default function PingRouter() {
  const { activeSession } = useShiftStore();
  const { window_label } = useLocalSearchParams<{ window_label?: string }>();

  useEffect(() => {
    if (!activeSession?.clocked_in_at) {
      router.replace('/(tabs)/home');
      return;
    }
    // Forward the missed-ping backfill window into the capture screen so
    // the submit body carries it through to the server (server sets
    // submitted_late + resolves the matching missed_pings row).
    const target = window_label
      ? `/ping/photo?window_label=${encodeURIComponent(window_label)}`
      : '/ping/photo';
    router.replace(target);
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
