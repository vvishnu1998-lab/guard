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
import { formatHoursHHMM, type ShiftHours } from '../../lib/formatHours';
import {
  RANGE_PRESETS, MAX_RANGE_DAYS, downloadHoursPdf,
} from '../../lib/hoursReport';
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
  id:                 string;
  site_name:          string;
  scheduled_start:    string;
  scheduled_end:      string;
  status:             string;
  // Legacy scalar (MAX(clock_in, scheduled_start) formula). Kept as a
  // fallback for pre-Phase-1 shifts whose row won't carry the new object.
  total_hours_worked: number | string | null;
  // Phase 1 4-field canonical breakdown. Prefer `hours.actual_hours` at
  // read time — matches admin/client (raw clock_out − clock_in).
  hours?:             ShiftHours;
}

export default function ProfileScreen() {
  const [profile,  setProfile]  = useState<GuardProfile | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [shifts,   setShifts]   = useState<ShiftRecord[]>([]);
  const [presetKey,   setPresetKey]   = useState<string>('30');
  const [downloading, setDownloading] = useState(false);
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
    // Phase 1 4-field canonical: prefer hours.actual_hours (raw
    // clock_out − clock_in — matches admin/client). Fall back to the
    // legacy total_hours_worked scalar for pre-Phase-1 rows.
    const fromObj = shift.hours?.actual_hours;
    if (typeof fromObj === 'number' && Number.isFinite(fromObj)) return fromObj;
    const v = shift.total_hours_worked;
    if (v == null) return 0;
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
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

  // Resolved once per render from the selected preset. `new Date()` is read
  // here rather than captured in state so a session left open across midnight
  // does not keep offering yesterday's window.
  const selectedPreset = RANGE_PRESETS.find((p) => p.key === presetKey) ?? RANGE_PRESETS[2];
  const selectedRange  = selectedPreset.range(new Date());
  const rangeLabel = `${fmtShort(selectedRange.from)} — ${fmtShort(selectedRange.to)}`;

  async function handleDownloadHours() {
    setDownloading(true);
    try {
      const r = await downloadHoursPdf(selectedRange.from, selectedRange.to);
      if (r.status === 'saved') return;      // share sheet already handled it
      if (r.status === 'empty') {
        // H2.6 — a period with no shifts is not an error and must not look
        // like one. No file is produced; the guard is told plainly.
        Alert.alert(
          'No shifts in this period',
          `You have no recorded shifts between ${rangeLabel}. Choose a different range.`,
        );
        return;
      }
      Alert.alert('Couldn\'t download hours', r.message);
    } finally {
      setDownloading(false);
    }
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

            {/* Download hours summary — sits directly under the hours grid,
                where a guard who has just looked at their totals is most
                likely to want a copy. */}
            <View style={styles.section}>
              <View style={styles.historyHeader}>
                <Text style={styles.historyTitle}>DOWNLOAD HOURS</Text>
                <Text style={styles.historySub}>Up to {MAX_RANGE_DAYS} days</Text>
              </View>
              <View style={styles.presetWrap}>
                {RANGE_PRESETS.map((p) => (
                  <TouchableOpacity
                    key={p.key}
                    style={[styles.presetChip, presetKey === p.key && styles.presetChipOn]}
                    onPress={() => setPresetKey(p.key)}
                    disabled={downloading}
                  >
                    <Text style={[styles.presetText, presetKey === p.key && styles.presetTextOn]}>
                      {p.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={styles.presetRange}>{rangeLabel}</Text>
              <TouchableOpacity
                style={[styles.downloadBtn, downloading && styles.downloadBtnDisabled]}
                onPress={handleDownloadHours}
                disabled={downloading}
              >
                {downloading
                  ? <ActivityIndicator color={Colors.base} />
                  : <Text style={styles.downloadText}>DOWNLOAD PDF</Text>}
              </TouchableOpacity>
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
                    <Text style={styles.historyHours}>{formatHoursHHMM(hoursWorked(s))}</Text>
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

/** "01 Jul" from a YYYY-MM-DD. Parsed as UTC so the label can never drift a
 *  day on a device east or west of the date it was built from. */
function fmtShort(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  return new Intl.DateTimeFormat('en-GB',
    { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(d);
}

function HoursStat({ label, value }: { label: string; value: number }) {
  // Zero is a legitimate "no shifts in this window" state, not an
  // unknown — render "0h 00m" via the D2 helper (not "—").
  return (
    <View style={styles.hoursStat}>
      <Text style={styles.hoursValue}>{formatHoursHHMM(value)}</Text>
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
  // Phase 3 — dropped fontSize 28 → 22 and letterSpacing 1 → 0 because
  // "10h 25m" is 7 chars vs the old "10.5h" 5 chars, and 3-across on a
  // narrow iPhone SE screen clipped at the old size.
  hoursValue:   { fontFamily: Fonts.heading, color: Colors.action, fontSize: 22 },
  hoursLabel:   { color: Colors.muted, fontSize: 10, letterSpacing: 2, marginTop: 2 },
  hoursDivider: { width: 1, backgroundColor: Colors.border, marginVertical: Spacing.sm },

  presetWrap:   { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm, marginBottom: Spacing.md },
  presetChip:   {
    paddingHorizontal: Spacing.md, paddingVertical: 7,
    borderRadius: Radius.sm, borderWidth: 1, borderColor: Colors.border,
  },
  presetChipOn: { backgroundColor: Colors.action, borderColor: Colors.action },
  presetText:   { color: Colors.muted, fontSize: 12, letterSpacing: 1 },
  presetTextOn: { color: Colors.base, fontWeight: '700' },
  presetRange:  { color: Colors.muted, fontSize: 11, letterSpacing: 1, marginBottom: Spacing.md },
  downloadBtn:  {
    backgroundColor: Colors.action, borderRadius: Radius.sm,
    paddingVertical: 13, alignItems: 'center', justifyContent: 'center', minHeight: 44,
  },
  downloadBtnDisabled: { opacity: 0.5 },
  downloadText: { color: Colors.base, fontFamily: Fonts.heading, fontSize: 13, letterSpacing: 2 },
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
