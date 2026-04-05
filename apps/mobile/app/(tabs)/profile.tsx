/**
 * Profile Tab — guard's profile info, logout, and app settings.
 * Fetches GET /api/guards/me on mount.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert,
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

export default function ProfileScreen() {
  const [profile,  setProfile]  = useState<GuardProfile | null>(null);
  const [loading,  setLoading]  = useState(true);
  const logout = useAuthStore((s) => s.logout);

  useFocusEffect(
    useCallback(() => {
      apiClient.get<GuardProfile>('/guards/me')
        .then((data) => setProfile(data))
        .catch(() => { /* show what we have from token */ })
        .finally(() => setLoading(false));
    }, [])
  );

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
});
