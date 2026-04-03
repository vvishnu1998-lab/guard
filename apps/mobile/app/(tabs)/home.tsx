import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function HomeScreen() {
  const { activeSession, activeShift } = useShiftStore();
  const isOnShift = !!activeSession;

  return (
    <View style={styles.container}>
      {/* Live map placeholder — replaced by MapView with geofence polygon */}
      <View style={styles.mapPlaceholder}>
        <Text style={styles.mapText}>LIVE MAP</Text>
        <Text style={styles.mapSub}>Guard position · Geofence boundary</Text>
      </View>

      {/* Shift card */}
      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {isOnShift ? (
          <View style={styles.shiftCard}>
            <Text style={styles.shiftSite}>{activeShift?.site_name?.toUpperCase()}</Text>
            <Text style={styles.shiftStatus}>SHIFT ACTIVE</Text>
            {/* Ping countdown banner */}
            <PingCountdownBanner />
          </View>
        ) : (
          <View style={styles.shiftCard}>
            <Text style={styles.noShift}>No active shift</Text>
            <TouchableOpacity
              style={styles.clockInButton}
              onPress={() => router.push('/clock-in/step1')}
            >
              <Text style={styles.clockInText}>CLOCK IN</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Quick actions */}
        <Text style={styles.sectionTitle}>QUICK ACTIONS</Text>
        <View style={styles.actionGrid}>
          <ActionButton label="ADD REPORT" color={Colors.action} onPress={() => router.push('/report/type-select')} disabled={!isOnShift} />
          <ActionButton label="TASKS" color={Colors.action} onPress={() => router.push('/(tabs)/tasks')} disabled={!isOnShift} />
          <ActionButton label="INCIDENT" color={Colors.danger} onPress={() => router.push('/report/incident')} disabled={!isOnShift} />
          <ActionButton label="TAKE BREAK" color={Colors.muted} onPress={() => router.push('/break')} disabled={!isOnShift} />
        </View>
      </ScrollView>
    </View>
  );
}

function PingCountdownBanner() {
  return (
    <View style={styles.pingBanner}>
      <Text style={styles.pingText}>Next ping in 28 min · GPS + Photo</Text>
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
  shiftSite: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, letterSpacing: 3 },
  shiftStatus: { color: Colors.success, fontSize: 12, letterSpacing: 2, marginTop: 4 },
  noShift: { color: Colors.muted, fontSize: 16, marginBottom: Spacing.md },
  clockInButton: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    padding: Spacing.md, alignItems: 'center',
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
