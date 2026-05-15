/**
 * Ping Router — always routes to the photo+GPS capture flow.
 * (Previously alternated between photo and GPS-only every 30 min;
 * product decision moved to "always photo" so admin/client review
 * gets a consistent visual record at every ping.)
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
    router.replace('/ping/photo');
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
