/**
 * Create Report — unified form for all three report types.
 *
 * Replaces the previous 3-card picker (which routed to separate
 * activity/incident/maintenance forms). The guard picks a type from a
 * dropdown and the same form takes them through description + photos.
 *
 * Notes:
 *  - Severity field has been removed entirely (UX simplification 2026-05-15).
 *  - Photos are required only for incident reports (server still enforces).
 *  - Submitting an incident triggers an immediate client email — we surface
 *    the same banner the old incident form had so the guard understands.
 *  - Old per-type files under /reports/new/* still exist but are no longer
 *    routed to. Activity-report-reminder push notifications now open this
 *    screen with the type pre-selected.
 */
import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, Alert, ActivityIndicator, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useShiftStore } from '../../store/shiftStore';
import { useOfflineStore } from '../../store/offlineStore';
import { usePhotoAttachments } from '../../hooks/usePhotoAttachments';
import { PhotoStrip } from '../../components/reports/PhotoStrip';
import { apiClient } from '../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

type ReportType = 'activity' | 'incident' | 'maintenance';

const TYPES: { value: ReportType; label: string; icon: string; color: string; desc: string }[] = [
  { value: 'activity',    label: 'Activity',    icon: '📋', color: Colors.action, desc: 'Routine patrol log, observations, completed rounds' },
  { value: 'incident',    label: 'Incident',    icon: '⚠',  color: '#EF4444',     desc: 'Security breach, injury, unauthorized access, emergency' },
  { value: 'maintenance', label: 'Maintenance', icon: '🔧', color: '#3B82F6',     desc: 'Equipment fault, facility damage, access issue' },
];

export default function CreateReport() {
  const params = useLocalSearchParams<{ type?: string }>();
  const initialType =
    params.type === 'incident' || params.type === 'maintenance'
      ? (params.type as ReportType)
      : 'activity';

  const [reportType,   setReportType]   = useState<ReportType>(initialType);
  const [typePickerOpen, setTypePickerOpen] = useState(false);
  const [description,  setDescription]  = useState('');
  const [submitting,   setSubmitting]   = useState(false);
  const [enhancing,    setEnhancing]    = useState(false);
  const [enhanced,     setEnhanced]     = useState<string | null>(null);
  const [originalDesc, setOriginalDesc] = useState<string | null>(null);

  const { activeShift, activeSession } = useShiftStore();
  const { submitReport } = useOfflineStore();
  const photos = usePhotoAttachments(activeShift?.effective_photo_limit ?? 5);

  const typeMeta = TYPES.find((t) => t.value === reportType)!;
  const photoRequired = reportType === 'incident';

  function pickType(t: ReportType) {
    setReportType(t);
    setTypePickerOpen(false);
  }

  async function handleEnhance() {
    if (description.trim().length < 10) return;
    setEnhancing(true);
    try {
      setOriginalDesc(description);
      const { enhanced: result } = await apiClient.post<{ enhanced: string }>(
        '/ai/enhance-description',
        { text: description, report_type: reportType },
      );
      setEnhanced(result);
    } catch (err: any) {
      Alert.alert('Enhancement Failed', err?.message ?? 'Could not enhance description. Try again.');
    } finally {
      setEnhancing(false);
    }
  }

  function acceptEnhanced() {
    if (enhanced) {
      setDescription(enhanced);
      setEnhanced(null);
      setOriginalDesc(null);
    }
  }

  function revertEnhanced() {
    if (originalDesc !== null) setDescription(originalDesc);
    setEnhanced(null);
    setOriginalDesc(null);
  }

  async function submit() {
    if (!description.trim()) {
      Alert.alert('Required', 'Please describe what happened.');
      return;
    }
    if (photoRequired && photos.attachments.length === 0) {
      Alert.alert('Photo Required', 'At least one photo is required for incident reports.');
      return;
    }
    if (!photos.allUploaded()) {
      Alert.alert('Upload in progress', 'Please wait for photos to finish uploading.');
      return;
    }
    if (!activeSession) {
      Alert.alert('No Active Shift', 'You can only submit reports while on shift.', [
        { text: 'OK', onPress: () => router.replace('/(tabs)/home') },
      ]);
      return;
    }

    setSubmitting(true);
    try {
      let latitude: number | undefined;
      let longitude: number | undefined;
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        latitude  = loc.coords.latitude;
        longitude = loc.coords.longitude;
      } catch { /* GPS failure — still submit */ }

      await submitReport({
        shift_session_id: activeSession.id,
        report_type:      reportType,
        description:      description.trim(),
        photo_urls:       photos.toPayload(),
        latitude,
        longitude,
      });

      if (reportType === 'incident') {
        Alert.alert(
          'Incident Reported',
          'Report submitted. The client has been notified by email.',
          [{ text: 'OK', onPress: () => router.replace('/(tabs)/reports') }],
        );
      } else {
        router.replace('/(tabs)/reports');
      }
    } catch (err: any) {
      Alert.alert('Submit Failed', err?.message ?? 'Could not submit report.');
    } finally {
      setSubmitting(false);
    }
  }

  const showEnhanceBtn = description.trim().length >= 10 && !enhancing && !enhanced;

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.bg} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        <Text style={styles.step}>NEW REPORT</Text>
        <Text style={[styles.title, { color: typeMeta.color }]}>CREATE REPORT</Text>

        {/* Type dropdown */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>REPORT TYPE <Text style={styles.req}>*</Text></Text>
          <TouchableOpacity
            style={[styles.dropdown, { borderColor: typeMeta.color }]}
            onPress={() => setTypePickerOpen(true)}
          >
            <Text style={styles.dropdownIcon}>{typeMeta.icon}</Text>
            <Text style={[styles.dropdownLabel, { color: typeMeta.color }]}>{typeMeta.label}</Text>
            <Text style={styles.dropdownChevron}>▾</Text>
          </TouchableOpacity>
        </View>

        {/* Email notice — incident only */}
        {reportType === 'incident' && (
          <View style={styles.alertBanner}>
            <Text style={styles.alertIcon}>📧</Text>
            <Text style={styles.alertText}>
              Submitting this report will immediately email the client.
            </Text>
          </View>
        )}

        {/* Description */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>DESCRIPTION <Text style={styles.req}>*</Text></Text>
          <TextInput
            style={styles.textArea}
            value={description}
            onChangeText={(t) => { setDescription(t); if (enhanced) { setEnhanced(null); setOriginalDesc(null); } }}
            placeholder={
              reportType === 'incident'
                ? 'Describe exactly what happened: who, what, when, where. Be specific.'
                : reportType === 'maintenance'
                ? 'Describe the equipment, location, and the issue observed.'
                : 'Describe the patrol, observations, and any noteworthy events.'
            }
            placeholderTextColor={Colors.muted}
            multiline
            numberOfLines={7}
            maxLength={3000}
            textAlignVertical="top"
          />
          <Text style={styles.charCount}>{description.length}/3000</Text>

          {showEnhanceBtn && (
            <TouchableOpacity style={styles.enhanceBtn} onPress={handleEnhance}>
              <Text style={styles.enhanceBtnText}>✦ Enhance with AI</Text>
            </TouchableOpacity>
          )}
          {enhancing && (
            <View style={styles.enhancingRow}>
              <ActivityIndicator size="small" color="#F59E0B" />
              <Text style={styles.enhancingText}>Enhancing description…</Text>
            </View>
          )}
          {enhanced && (
            <View style={styles.enhancedBox}>
              <Text style={styles.enhancedLabel}>✦ AI ENHANCED</Text>
              <Text style={styles.enhancedText}>{enhanced}</Text>
              <View style={styles.enhancedActions}>
                <TouchableOpacity style={styles.acceptBtn} onPress={acceptEnhanced}>
                  <Text style={styles.acceptText}>ACCEPT</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.revertBtn} onPress={revertEnhanced}>
                  <Text style={styles.revertText}>REVERT</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>

        {/* Photos */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>
            SITE MEDIA {photoRequired && <Text style={styles.req}>*</Text>}
          </Text>
          <PhotoStrip
            attachments={photos.attachments}
            onAdd={photos.addPhoto}
            onRemove={photos.removePhoto}
            maxPhotos={activeShift?.effective_photo_limit ?? 5}
            disabled={submitting}
          />
          {photoRequired && photos.attachments.length === 0 && (
            <Text style={styles.photoRequired}>⚠ At least 1 photo is required</Text>
          )}
        </View>

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitBtn, { backgroundColor: typeMeta.color }, submitting && styles.disabled]}
          onPress={submit}
          disabled={submitting}
        >
          {submitting
            ? <ActivityIndicator color={Colors.structure} />
            : <Text style={styles.submitText}>SUBMIT {typeMeta.label.toUpperCase()} REPORT</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
          <Text style={styles.cancelText}>CANCEL</Text>
        </TouchableOpacity>
      </ScrollView>

      {/* Type picker modal */}
      <Modal visible={typePickerOpen} transparent animationType="fade" onRequestClose={() => setTypePickerOpen(false)}>
        <TouchableOpacity style={styles.modalBackdrop} activeOpacity={1} onPress={() => setTypePickerOpen(false)}>
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>SELECT REPORT TYPE</Text>
            {TYPES.map((t) => (
              <TouchableOpacity
                key={t.value}
                style={[styles.modalRow, reportType === t.value && styles.modalRowActive]}
                onPress={() => pickType(t.value)}
              >
                <View style={[styles.modalIconBox, { borderColor: t.color }]}>
                  <Text style={styles.modalIcon}>{t.icon}</Text>
                </View>
                <View style={styles.modalInfo}>
                  <Text style={[styles.modalLabel, { color: t.color }]}>{t.label.toUpperCase()}</Text>
                  <Text style={styles.modalDesc}>{t.desc}</Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bg:       { flex: 1, backgroundColor: Colors.structure },
  scroll:   { alignItems: 'center', paddingTop: 60, paddingBottom: 48 },
  step:     { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: 4 },
  title:    { fontFamily: Fonts.heading, fontSize: 26, letterSpacing: 4, marginBottom: Spacing.lg },

  field:      { width: '92%', marginBottom: Spacing.lg },
  fieldLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm },
  req:        { color: '#EF4444' },

  dropdown: {
    flexDirection: 'row', alignItems: 'center',
    borderWidth: 1.5, borderRadius: Radius.md,
    backgroundColor: Colors.surface,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.md,
    gap: Spacing.md,
  },
  dropdownIcon:    { fontSize: 22 },
  dropdownLabel:   { flex: 1, fontFamily: Fonts.heading, fontSize: 16, letterSpacing: 2 },
  dropdownChevron: { color: Colors.muted, fontSize: 16 },

  alertBanner: {
    flexDirection: 'row', alignItems: 'center',
    width: '92%',
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: '#EF4444',
    padding: Spacing.md, gap: Spacing.sm,
    marginBottom: Spacing.lg,
  },
  alertIcon: { fontSize: 18 },
  alertText: { flex: 1, color: '#EF4444', fontSize: 13, lineHeight: 18 },

  textArea: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    color: Colors.base, fontSize: 14, lineHeight: 22,
    padding: Spacing.md, minHeight: 160,
  },
  charCount: { color: Colors.muted, fontSize: 11, textAlign: 'right', marginTop: 4 },

  enhanceBtn: {
    alignSelf: 'flex-start',
    marginTop: Spacing.sm,
    paddingVertical: 6, paddingHorizontal: Spacing.md,
    borderRadius: Radius.sm,
    borderWidth: 1, borderColor: '#F59E0B',
    backgroundColor: 'rgba(245,158,11,0.08)',
  },
  enhanceBtnText: { color: '#F59E0B', fontSize: 13, letterSpacing: 1 },

  enhancingRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginTop: Spacing.sm },
  enhancingText: { color: Colors.muted, fontSize: 13 },

  enhancedBox: {
    marginTop: Spacing.md,
    backgroundColor: 'rgba(245,158,11,0.08)',
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: '#F59E0B',
    padding: Spacing.md,
  },
  enhancedLabel: { color: '#F59E0B', fontSize: 10, letterSpacing: 2, marginBottom: Spacing.sm },
  enhancedText:  { color: Colors.base, fontSize: 14, lineHeight: 22 },
  enhancedActions: { flexDirection: 'row', gap: Spacing.sm, marginTop: Spacing.md },
  acceptBtn: {
    flex: 1, backgroundColor: '#F59E0B',
    borderRadius: Radius.sm, paddingVertical: Spacing.sm, alignItems: 'center',
  },
  acceptText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 13, letterSpacing: 2 },
  revertBtn: {
    flex: 1, borderWidth: 1, borderColor: Colors.muted,
    borderRadius: Radius.sm, paddingVertical: Spacing.sm, alignItems: 'center',
  },
  revertText: { color: Colors.muted, fontSize: 13, letterSpacing: 1 },

  photoRequired:  { color: '#EF4444', fontSize: 12, marginTop: 4 },

  submitBtn: {
    width: '92%',
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center', justifyContent: 'center',
    minHeight: 54, marginBottom: Spacing.md,
  },
  submitText: { fontFamily: Fonts.heading, color: '#FFFFFF', fontSize: 16, letterSpacing: 3 },
  disabled:   { opacity: 0.4 },

  cancelBtn:  { paddingVertical: Spacing.sm },
  cancelText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },

  modalBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.7)',
    justifyContent: 'flex-end',
  },
  modalCard: {
    backgroundColor: Colors.surface,
    borderTopLeftRadius: Radius.lg, borderTopRightRadius: Radius.lg,
    padding: Spacing.lg, paddingBottom: Spacing.xxl,
    borderTopWidth: 1, borderColor: Colors.border,
  },
  modalTitle: {
    color: Colors.muted, fontSize: 11, letterSpacing: 3,
    textAlign: 'center', marginBottom: Spacing.md,
  },
  modalRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.sm,
    borderRadius: Radius.md, gap: Spacing.md,
  },
  modalRowActive: { backgroundColor: Colors.structure },
  modalIconBox: {
    width: 44, height: 44, borderRadius: Radius.md,
    borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  modalIcon:    { fontSize: 22 },
  modalInfo:    { flex: 1 },
  modalLabel:   { fontFamily: Fonts.heading, fontSize: 13, letterSpacing: 2, marginBottom: 2 },
  modalDesc:    { color: Colors.muted, fontSize: 12, lineHeight: 16 },
});
