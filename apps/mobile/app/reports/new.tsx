/**
 * New Report — Type Selector
 * Guard picks one of three report types before entering the form.
 */
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const TYPES = [
  {
    type:    'activity',
    label:   'ACTIVITY REPORT',
    icon:    '📋',
    desc:    'Routine patrol log, observations, completed rounds',
    color:   Colors.action,
  },
  {
    type:    'incident',
    label:   'INCIDENT REPORT',
    icon:    '⚠',
    desc:    'Security breach, injury, unauthorized access, emergency',
    color:   '#EF4444',
  },
  {
    type:    'maintenance',
    label:   'MAINTENANCE REPORT',
    icon:    '🔧',
    desc:    'Equipment fault, facility damage, access issue',
    color:   '#3B82F6',
  },
] as const;

export default function NewReportSelector() {
  return (
    <View style={styles.container}>
      <Text style={styles.step}>NEW REPORT</Text>
      <Text style={styles.title}>SELECT TYPE</Text>

      <View style={styles.list}>
        {TYPES.map((t) => (
          <TouchableOpacity
            key={t.type}
            style={styles.card}
            onPress={() => router.push(`/reports/new/${t.type}` as any)}
          >
            <View style={[styles.iconBox, { borderColor: t.color }]}>
              <Text style={styles.icon}>{t.icon}</Text>
            </View>
            <View style={styles.info}>
              <Text style={[styles.typeLabel, { color: t.color }]}>{t.label}</Text>
              <Text style={styles.desc}>{t.desc}</Text>
            </View>
            <Text style={[styles.chevron, { color: t.color }]}>›</Text>
          </TouchableOpacity>
        ))}
      </View>

      <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
        <Text style={styles.cancelText}>CANCEL</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: Colors.structure,
    alignItems: 'center', paddingTop: 60, padding: Spacing.xl,
  },
  step:  { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: 4 },
  title: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 28, letterSpacing: 4, marginBottom: Spacing.xl },

  list: { width: '100%', gap: Spacing.md },

  card: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg, gap: Spacing.md,
  },
  iconBox: {
    width: 48, height: 48, borderRadius: Radius.md,
    borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  icon:      { fontSize: 24 },
  info:      { flex: 1 },
  typeLabel: { fontFamily: Fonts.heading, fontSize: 14, letterSpacing: 2, marginBottom: 2 },
  desc:      { color: Colors.muted, fontSize: 12, lineHeight: 18 },
  chevron:   { fontSize: 24 },

  cancelBtn:  { marginTop: Spacing.xl, padding: Spacing.sm },
  cancelText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },
});
