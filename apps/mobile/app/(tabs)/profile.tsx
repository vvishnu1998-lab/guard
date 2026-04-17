/**
 * Profile Tab — guard's profile info, logout, and app settings.
 * Fetches GET /api/guards/me on mount.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert, FlatList,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { useAuthStore } from '../../store/authStore';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import Constants from 'expo-constants';

interface GuardProfile {
  id:           string;
  name:         string;
  email:        string;
  badge_number: string;
  company_name: string;
  created_at:   string;
}

interface ShiftRecord {
  id:              string;
  site_name:       string;
  scheduled_start: string;
  scheduled_end:   string;
  status:          string;
}

export default function ProfileScreen() {
  const [profile,  setProfile]  = useState<GuardProfile | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [shifts,   setShifts]   = useState<ShiftRecord[]>([]);
  const logout = useAuthStore((s) => s.logout);

  useFocusEffect(
    useCallback(() => {
      Promise.all([
        apiClient.get<GuardProfile>('/guards/me'),
        apiClient.get<ShiftRecord[]>('/shifts'),
      ]).then(([p, s]) => {
        setProfile(p);
        setShifts(s.filter((sh) => sh.status === 'completed' || sh.status === 'active'));
      }).catch(() => {}).finally(() => setLoading(false));
    }, [])
  );

  function hoursWorked(shift: ShiftRecord) {
    return (new Date(shift.scheduled_end).getTime() - new Date(shift.scheduled_start).getTime()) / 3_600_000;
  }

  const now       = new Date();
  const todayStart   = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart    = new Date(todayStart); weekStart.setDate(todayStart.getDate() - todayStart.getDay());
  const monthStart   = new Date(now.getFullYear(), now.getMonth(), 1);
  const month3Start  = new Date(now.getFullYear(), now.getMonth() - 3, 1);

  const completedShifts = shifts.filter((s) => new Date(s.scheduled_start) >= month3Start);
  const todayHours  = completedShifts.filter((s) => new Date(s.scheduled_start) >= todayStart).reduce((a, s) => a + hoursWorked(s), 0);
  const weekHours   = completedShifts.filter((s) => new Date(s.scheduled_start) >= weekStart).reduce((a, s) => a + hoursWorked(s), 0);
  const monthHours  = completedShifts.filter((s) => new Date(s.scheduled_start) >= monthStart).reduce((a, s) => a + hoursWorked(s), 0);
  const recentShifts = completedShifts.slice(0, 20);

  function handleLogout() {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/login');
          },
        },
      ]
    );
  }

  function handleChangePassword() {
    router.push('/(auth)/change-password');
  }

  const appVersion = Constants.expoConfig?.version ?? '1.0.0';

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>PROFILE</Text>
      </View>

      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator color={Colors.action} />
          </View>
        ) : (
          <>
            {/* Avatar / identity card */}
            <View style={styles.identityCard}>
              <View style={styles.avatar}>
                <Text style={styles.avatarText}>
                  {profile?.name?.charAt(0).toUpperCase() ?? '?'}
                </Text>
              </View>
              <Text style={styles.guardName}>{profile?.name ?? '—'}</Text>
              <Text style={styles.companyName}>{profile?.company_name ?? '—'}</Text>
            </View>

            {/* Details */}
            <View style={styles.section}>
              <Row label="BADGE NUMBER" value={profile?.badge_number ?? '—'} mono />
              <Row label="EMAIL"        value={profile?.email        ?? '—'} />
              <Row label="GUARD ID"     value={profile?.id?.slice(0, 8).toUpperCase() ?? '—'} mono />
              <Row
                label="MEMBER SINCE"
                value={profile?.created_at
                  ? new Date(profile.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
                  : '—'}
              />
            </View>

            {/* Hours summary */}
            <View style={styles.section}>
              <View style={styles.hoursGrid}>
                <HoursStat label="TODAY" value={todayHours} />
                <View style={styles.hoursDivider} />
                <HoursStat label="THIS WEEK" value={weekHours} />
                <View style={styles.hoursDivider} />
                <HoursStat label="THIS MONTH" value={monthHours} />
              </View>
            </View>

            {/* Shift history */}
            {recentShifts.length > 0 && (
              <View style={styles.section}>
                <View style={styles.historyHeader}>
                  <Text style={styles.historyTitle}>SHIFT HISTORY</Text>
                  <Text style={styles.historySub}>Last 3 months</Text>
                </View>
                {recentShifts.map((s) => (
                  <View key={s.id} style={styles.historyRow}>
                    <Text style={styles.historyDate}>
                      {new Date(s.scheduled_start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                    </Text>
                    <Text style={styles.historySite} numberOfLines={1}>{s.site_name}</Text>
                    <Text style={styles.historyHours}>{hoursWorked(s).toFixed(1)}h</Text>
                  </View>
                ))}
              </View>
            )}

            {/* Actions */}
            <View style={styles.section}>
              <TouchableOpacity style={styles.actionRow} onPress={handleChangePassword}>
                <Text style={styles.actionText}>Change Password</Text>
                <Text style={styles.chevron}>›</Text>
              </TouchableOpacity>
            </View>

            {/* Sign out */}
            <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
              <Text style={styles.logoutText}>SIGN OUT</Text>
            </TouchableOpacity>

            {/* App version */}
            <Text style={styles.versionText}>Guard v{appVersion}</Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function HoursStat({ label, value }: { label: string; value: number }) {
  return (
    <View style={styles.hoursStat}>
      <Text style={styles.hoursValue}>{value.toFixed(1)}<Text style={styles.hoursUnit}>h</Text></Text>
      <Text style={styles.hoursLabel}>{label}</Text>
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.rowValueMono]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure },

  header: {
    paddingHorizontal: Spacing.xl,
    paddingTop: 60, paddingBottom: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  title: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, letterSpacing: 4 },

  content: { padding: Spacing.md, gap: Spacing.md },

  center: { paddingTop: 60, alignItems: 'center' },

  identityCard: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.xl, alignItems: 'center',
  },
  avatar: {
    width: 72, height: 72, borderRadius: 36,
    backgroundColor: Colors.action, alignItems: 'center', justifyContent: 'center',
    marginBottom: Spacing.md,
  },
  avatarText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 32 },
  guardName:   { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, letterSpacing: 2 },
  companyName: { color: Colors.muted, fontSize: 13, marginTop: 4, letterSpacing: 1 },

  section: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg, borderWidth: 1, borderColor: Colors.border,
    overflow: 'hidden',
  },

  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  rowLabel:     { color: Colors.muted, fontSize: 11, letterSpacing: 2 },
  rowValue:     { color: Colors.base, fontSize: 14, maxWidth: '60%', textAlign: 'right' },
  rowValueMono: { fontFamily: 'monospace', fontSize: 13 },

  actionRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
  },
  actionText: { color: Colors.base, fontSize: 15 },
  chevron:    { color: Colors.muted, fontSize: 20 },

  logoutBtn: {
    backgroundColor: '#7F1D1D',
    borderRadius: Radius.md, borderWidth: 1, borderColor: '#EF4444',
    padding: Spacing.md, alignItems: 'center',
    marginTop: Spacing.sm,
  },
  logoutText: { fontFamily: Fonts.heading, color: '#FCA5A5', fontSize: 16, letterSpacing: 3 },

  versionText: { color: Colors.muted, fontSize: 11, textAlign: 'center', marginTop: Spacing.sm },

  hoursGrid:    { flexDirection: 'row', padding: Spacing.md },
  hoursStat:    { flex: 1, alignItems: 'center', paddingVertical: Spacing.sm },
  hoursValue:   { fontFamily: Fonts.heading, color: Colors.action, fontSize: 28, letterSpacing: 1 },
  hoursUnit:    { fontSize: 16, color: Colors.muted },
  hoursLabel:   { color: Colors.muted, fontSize: 10, letterSpacing: 2, marginTop: 2 },
  hoursDivider: { width: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },

  historyHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  historyTitle:  { color: Colors.muted, fontSize: 11, letterSpacing: 2 },
  historySub:    { color: Colors.muted, fontSize: 11 },
  historyRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderBottomWidth: 1, borderBottomColor: Colors.border,
  },
  historyDate:  { color: Colors.muted, fontSize: 12, width: 52 },
  historySite:  { flex: 1, color: Colors.base, fontSize: 13, marginHorizontal: Spacing.sm },
  historyHours: { color: Colors.action, fontSize: 13, fontFamily: Fonts.heading, letterSpacing: 1 },
});
