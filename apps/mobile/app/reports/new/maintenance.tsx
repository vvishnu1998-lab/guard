/**
 * Maintenance Report Form
 * Equipment fault / facility damage — description required, up to 3 optional photos.
 */
import { useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity,
  ScrollView, Alert, ActivityIndicator, KeyboardAvoidingView, Platform,
} from 'react-native';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useShiftStore }         from '../../../store/shiftStore';
import { useOfflineStore }       from '../../../store/offlineStore';
import { usePhotoAttachments }   from '../../../hooks/usePhotoAttachments';
import { PhotoStrip }            from '../../../components/reports/PhotoStrip';
import { apiClient }             from '../../../lib/apiClient';
import { Colors, Spacing, Radius, Fonts } from '../../../constants/theme';

const BLUE = '#3B82F6';

const ISSUE_TYPES = [
  'EQUIPMENT FAULT',
  'FACILITY DAMAGE',
  'ACCESS ISSUE',
  'LIGHTING',
  'LOCK / DOOR',
  'OTHER',
] as const;

type IssueType = typeof ISSUE_TYPES[number];

export default function MaintenanceReportForm() {
  const [description,  setDescription]  = useState('');
  const [issueType,    setIssueType]    = useState<IssueType | null>(null);
  const [submitting,   setSubmitting]   = useState(false);
  const [enhancing,    setEnhancing]    = useState(false);
  const [enhanced,     setEnhanced]     = useState<string | null>(null);
  const [originalDesc, setOriginalDesc] = useState<string | null>(null);

  const { activeShift, activeSession } = useShiftStore();
  const { submitReport }  = useOfflineStore();
  const photos            = usePhotoAttachments(activeShift?.effective_photo_limit ?? 5);

  async function handleEnhance() {
    if (description.trim().length < 10) return;
    setEnhancing(true);
    try {
      setOriginalDesc(description);
      const { enhanced: result } = await apiClient.post<{ enhanced: string }>(
        '/ai/enhance-description',
        { text: description, report_type: 'maintenance' }
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
      Alert.alert('Required', 'Please describe the maintenance issue.');
      return;
    }
    if (!photos.allUploaded()) {
      Alert.alert('Upload in progress', 'Please wait for photos to finish uploading.');
      return;
    }
    if (!activeSession) {
      Alert.alert('Error', 'No active session.');
      return;
    }

    setSubmitting(true);
    try {
      let latitude: number | undefined;
      let longitude: number | undefined;
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        latitude  = loc.coords.latitude;
        longitude = loc.coords.longitude;
      } catch { /* GPS optional */ }

      // Prepend issue type to description if selected
      const fullDescription = issueType
        ? `[${issueType}] ${description.trim()}`
        : description.trim();

      await submitReport({
        shift_session_id: activeSession.id,
        report_type:      'maintenance',
        description:      fullDescription,
        photo_urls:       photos.toPayload(),
        latitude,
        longitude,
      });

      router.replace('/(tabs)/reports');
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
        <Text style={styles.title}>MAINTENANCE REPORT</Text>
        <Text style={styles.subtitle}>Equipment fault or facility issue</Text>

        {/* Issue type chips */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>ISSUE TYPE</Text>
          <View style={styles.chipWrap}>
            {ISSUE_TYPES.map((t) => (
              <TouchableOpacity
                key={t}
                style={[styles.chip, issueType === t && styles.chipActive]}
                onPress={() => setIssueType(issueType === t ? null : t)}
              >
                <Text style={[styles.chipText, issueType === t && styles.chipTextActive]}>
                  {t}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Description */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>DESCRIPTION <Text style={styles.req}>*</Text></Text>
          <TextInput
            style={styles.textArea}
            value={description}
            onChangeText={(t) => { setDescription(t); if (enhanced) { setEnhanced(null); setOriginalDesc(null); } }}
            placeholder="Describe the issue, its location, and any immediate action taken…"
            placeholderTextColor={Colors.muted}
            multiline
            numberOfLines={6}
            maxLength={2000}
            textAlignVertical="top"
          />
          <Text style={styles.charCount}>{description.length}/2000</Text>

          {/* Enhance with AI button */}
          {showEnhanceBtn && (
            <TouchableOpacity style={styles.enhanceBtn} onPress={handleEnhance}>
              <Text style={styles.enhanceBtnText}>✦ Enhance with AI</Text>
            </TouchableOpacity>
          )}

          {/* Loading state */}
          {enhancing && (
            <View style={styles.enhancingRow}>
              <ActivityIndicator size="small" color="#F59E0B" />
              <Text style={styles.enhancingText}>Enhancing description…</Text>
            </View>
          )}

          {/* Enhanced preview */}
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
          <PhotoStrip
            attachments={photos.attachments}
            onAdd={photos.addPhoto}
            onRemove={photos.removePhoto}
            maxPhotos={activeShift?.effective_photo_limit ?? 5}
            disabled={submitting}
          />
        </View>

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitBtn, submitting && styles.disabled]}
          onPress={submit}
          disabled={submitting}
        >
          {submitting
            ? <ActivityIndicator color="#FFFFFF" />
            : <Text style={styles.submitText}>SUBMIT REPORT</Text>
          }
        </TouchableOpacity>

        <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
          <Text style={styles.cancelText}>CANCEL</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  bg:       { flex: 1, backgroundColor: Colors.structure },
  scroll:   { alignItems: 'center', paddingTop: 60, paddingBottom: 48 },
  step:     { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: 4 },
  title:    { fontFamily: Fonts.heading, color: BLUE, fontSize: 26, letterSpacing: 4, marginBottom: 4 },
  subtitle: { color: Colors.muted, fontSize: 13, marginBottom: Spacing.xl },

  field:      { width: '92%', marginBottom: Spacing.lg },
  fieldLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm },
  req:        { color: Colors.action },

  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.sm },
  chip: {
    borderRadius: Radius.sm,
    borderWidth: 1, borderColor: Colors.border,
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.xs,
  },
  chipActive:     { backgroundColor: BLUE, borderColor: BLUE },
  chipText:       { color: Colors.muted, fontSize: 11, letterSpacing: 1 },
  chipTextActive: { color: '#FFFFFF' },

  textArea: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    color: Colors.base, fontSize: 14, lineHeight: 22,
    padding: Spacing.md, minHeight: 140,
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

  submitBtn: {
    width: '92%',
    backgroundColor: BLUE,
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center', justifyContent: 'center',
    minHeight: 54, marginBottom: Spacing.md,
  },
  submitText: { fontFamily: Fonts.heading, color: '#FFFFFF', fontSize: 18, letterSpacing: 4 },
  disabled:   { opacity: 0.4 },

  cancelBtn:  { paddingVertical: Spacing.sm },
  cancelText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },
});
