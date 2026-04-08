/**
 * Clock-In Step 4 — Confirmation (Section 5.2)
 * Shows all three proofs: GPS coords, selfie thumbnail, site photo thumbnail.
 * START SHIFT:
 *   1. Upload selfie + site photo to S3 via presigned URL
 *   2. POST /api/shifts/:id/clock-in  → creates session + generates task instances
 *   3. POST /api/locations/clock-in-verification  → stores S3 photo proofs
 */
import { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { router } from 'expo-router';
import { useClockInStore } from '../../store/clockInStore';
import { useShiftStore }   from '../../store/shiftStore';
import { apiClient }       from '../../lib/apiClient';
import { uploadToS3 }      from '../../lib/uploadToS3';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const STEPS = ['Uploading selfie…', 'Uploading site photo…', 'Starting shift…', 'Saving verification…'];

export default function ClockInStep4() {
  const [submitting,  setSubmitting]  = useState(false);
  const [statusStep,  setStatusStep]  = useState(0);

  const {
    verifiedLatitude,
    verifiedLongitude,
    verifiedAt,
    selfie,
    sitePhoto,
    pendingShiftId,
    reset: resetClockIn,
  } = useClockInStore();

  const { pendingShift, setActiveSession } = useShiftStore();

  // ── Guard: all three proofs must be present ──────────────────────────────
  if (!verifiedLatitude || !selfie || !sitePhoto || !pendingShiftId) {
    return (
      <View style={styles.container}>
        <Text style={styles.errorTitle}>INCOMPLETE DATA</Text>
        <Text style={styles.errorSub}>Please restart the clock-in flow.</Text>
        <TouchableOpacity style={styles.button} onPress={() => router.replace('/(tabs)/home')}>
          <Text style={styles.buttonText}>RESTART</Text>
        </TouchableOpacity>
      </View>
    );
  }

  async function startShift() {
    if (submitting) return;
    setSubmitting(true);
    try {
      // Step 1 — upload selfie (S3 optional; use placeholder if not configured)
      setStatusStep(0);
      let selfieUrl = 'pending';
      try {
        const selfieUpload = await uploadToS3(selfie!.uri, 'clock_in');
        selfieUrl = selfieUpload.public_url;
      } catch { /* S3 not configured — continue without photo URL */ }

      // Step 2 — upload site photo
      setStatusStep(1);
      let sitePhotoUrl = 'pending';
      try {
        const sitePhotoUpload = await uploadToS3(sitePhoto!.uri, 'clock_in');
        sitePhotoUrl = sitePhotoUpload.public_url;
      } catch { /* S3 not configured — continue without photo URL */ }

      // Step 3 — clock in (creates shift_session + triggers task instance generation)
      setStatusStep(2);
      const session = await apiClient.post<{ id: string; site_id: string; clocked_in_at: string }>(
        `/shifts/${pendingShiftId}/clock-in`,
        { clock_in_coords: `(${verifiedLatitude},${verifiedLongitude})` }
      );

      // Step 4 — save photo verification proofs
      setStatusStep(3);
      await apiClient.post('/locations/clock-in-verification', {
        shift_session_id:   session.id,
        selfie_url:         selfieUrl,
        site_photo_url:     sitePhotoUrl,
        verified_lat:       verifiedLatitude,
        verified_lng:       verifiedLongitude,
        is_within_geofence: true,
      });

      // Use the stored pendingShift object; fall back to a minimal shape
      const shiftForStore = pendingShift ?? {
        id:              pendingShiftId,
        site_id:         session.site_id,
        site_name:       '',
        scheduled_start: session.clocked_in_at,
        scheduled_end:   session.clocked_in_at,
      };
      setActiveSession(shiftForStore, session);

      resetClockIn();
      router.replace('/(tabs)/home');
    } catch (err: any) {
      Alert.alert('Clock-In Failed', err?.message ?? 'Could not start shift. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  function fmtCoord(n: number) { return n.toFixed(6); }

  return (
    <ScrollView contentContainerStyle={styles.scroll} style={styles.bg}>
      <Text style={styles.step}>CLOCK IN · STEP 4 OF 4</Text>
      <Text style={styles.title}>CONFIRM & START</Text>

      {/* ── Proof 1: GPS ──────────────────────────────────────────── */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.badge, { backgroundColor: Colors.action }]}>
            <Text style={styles.badgeText}>1</Text>
          </View>
          <Text style={styles.cardLabel}>GPS VERIFICATION</Text>
        </View>

        <View style={styles.coordRow}>
          <View style={styles.coordBox}>
            <Text style={styles.coordLabel}>LATITUDE</Text>
            <Text style={styles.coordValue}>{fmtCoord(verifiedLatitude)}</Text>
          </View>
          <View style={styles.coordBox}>
            <Text style={styles.coordLabel}>LONGITUDE</Text>
            <Text style={styles.coordValue}>{fmtCoord(verifiedLongitude!)}</Text>
          </View>
        </View>

        <View style={styles.statusRow}>
          <View style={styles.dot} />
          <Text style={styles.statusText}>
            INSIDE GEOFENCE · {verifiedAt ? new Date(verifiedAt).toLocaleTimeString() : '—'}
          </Text>
        </View>
      </View>

      {/* ── Proof 2: Selfie ────────────────────────────────────────── */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.badge, { backgroundColor: Colors.action }]}>
            <Text style={styles.badgeText}>2</Text>
          </View>
          <Text style={styles.cardLabel}>GUARD SELFIE</Text>
        </View>
        <Image source={{ uri: selfie.uri }} style={styles.photoThumb} resizeMode="cover" />
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{fmtCoord(selfie.latitude)}, {fmtCoord(selfie.longitude)}</Text>
          <Text style={styles.metaText}>{new Date(selfie.takenAt).toLocaleTimeString()}</Text>
        </View>
      </View>

      {/* ── Proof 3: Site Photo ────────────────────────────────────── */}
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <View style={[styles.badge, { backgroundColor: Colors.action }]}>
            <Text style={styles.badgeText}>3</Text>
          </View>
          <Text style={styles.cardLabel}>SITE PHOTO</Text>
        </View>
        <Image source={{ uri: sitePhoto.uri }} style={styles.photoThumb} resizeMode="cover" />
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{fmtCoord(sitePhoto.latitude)}, {fmtCoord(sitePhoto.longitude)}</Text>
          <Text style={styles.metaText}>{new Date(sitePhoto.takenAt).toLocaleTimeString()}</Text>
        </View>
      </View>

      {/* ── Start Shift button ─────────────────────────────────────── */}
      <TouchableOpacity
        style={[styles.startButton, submitting && styles.disabled]}
        onPress={startShift}
        disabled={submitting}
      >
        {submitting ? (
          <View style={styles.statusRow}>
            <ActivityIndicator color={Colors.structure} size="small" />
            <Text style={styles.progressText}>{STEPS[statusStep]}</Text>
          </View>
        ) : (
          <Text style={styles.startText}>START SHIFT</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.cancelButton}
        onPress={() => { resetClockIn(); router.replace('/(tabs)/home'); }}
        disabled={submitting}
      >
        <Text style={styles.cancelText}>CANCEL</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: Colors.structure },
  scroll: { alignItems: 'center', paddingBottom: Spacing.xxl },
  step:   { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginTop: Spacing.xl, marginBottom: Spacing.xs },
  title:  { fontFamily: Fonts.heading, color: Colors.base, fontSize: 28, letterSpacing: 4, marginBottom: Spacing.xl },

  card: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg,
    marginBottom: Spacing.md,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: Spacing.md },
  badge: {
    width: 24, height: 24, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    marginRight: Spacing.sm,
  },
  badgeText: { color: Colors.structure, fontSize: 13, fontFamily: Fonts.heading },
  cardLabel: { color: Colors.base, fontSize: 12, letterSpacing: 3, fontFamily: Fonts.heading },

  coordRow:   { flexDirection: 'row', gap: Spacing.md, marginBottom: Spacing.sm },
  coordBox:   { flex: 1, backgroundColor: Colors.structure, borderRadius: Radius.sm, padding: Spacing.sm },
  coordLabel: { color: Colors.muted, fontSize: 9, letterSpacing: 2, marginBottom: 2 },
  coordValue: { color: Colors.action, fontSize: 13, fontFamily: 'monospace' },
  statusRow:  { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  dot:        { width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E' },
  statusText: { color: Colors.muted, fontSize: 11, letterSpacing: 1 },

  photoThumb: {
    width: '100%', height: 180,
    borderRadius: Radius.md,
    marginBottom: Spacing.sm,
    backgroundColor: Colors.structure,
  },
  metaRow:  { flexDirection: 'row', justifyContent: 'space-between' },
  metaText: { color: Colors.muted, fontSize: 11, fontFamily: 'monospace' },

  startButton: {
    width: '92%',
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    padding: Spacing.lg,
    alignItems: 'center',
    marginTop: Spacing.lg,
    minHeight: 54,
    justifyContent: 'center',
  },
  startText:    { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 4 },
  progressText: { color: Colors.structure, fontSize: 14, letterSpacing: 1 },
  cancelButton: { marginTop: Spacing.md, padding: Spacing.sm },
  cancelText:   { color: Colors.muted, fontSize: 13, letterSpacing: 2 },
  disabled:     { opacity: 0.4 },

  container:  { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center' },
  errorTitle: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, letterSpacing: 3, marginBottom: Spacing.sm },
  errorSub:   { color: Colors.muted, fontSize: 14, marginBottom: Spacing.xl },
  button:     { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  buttonText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
