/**
 * Incident Report Form
 * Security breach / emergency — severity required, at least 1 photo required,
 * triggers immediate SendGrid email to client on submit.
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

type Severity = 'low' | 'medium' | 'high' | 'critical';

const SEVERITIES: { value: Severity; label: string; color: string }[] = [
  { value: 'low',      label: 'LOW',      color: '#22C55E' },
  { value: 'medium',   label: 'MEDIUM',   color: '#F59E0B' },
  { value: 'high',     label: 'HIGH',     color: '#F97316' },
  { value: 'critical', label: 'CRITICAL', color: '#EF4444' },
];

export default function IncidentReportForm() {
  const [description,  setDescription]  = useState('');
  const [severity,     setSeverity]     = useState<Severity | null>(null);
  const [submitting,   setSubmitting]   = useState(false);
  const [enhancing,    setEnhancing]    = useState(false);
  const [enhanced,     setEnhanced]     = useState<string | null>(null);
  const [originalDesc, setOriginalDesc] = useState<string | null>(null);

  const { activeSession } = useShiftStore();
  const { submitReport }  = useOfflineStore();
  const photos            = usePhotoAttachments(5); // incidents allow up to 5 photos

  async function handleEnhance() {
    if (description.trim().length < 10) return;
    setEnhancing(true);
    try {
      setOriginalDesc(description);
      const { enhanced: result } = await apiClient.post<{ enhanced: string }>(
        '/ai/enhance-description',
        { text: description, report_type: 'incident' }
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
      Alert.alert('Required', 'Please describe the incident.');
      return;
    }
    if (!severity) {
      Alert.alert('Required', 'Please select a severity level.');
      return;
    }
    if (photos.attachments.length === 0) {
      Alert.alert('Photo Required', 'At least one photo is required for incident reports.');
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
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        latitude  = loc.coords.latitude;
        longitude = loc.coords.longitude;
      } catch { /* GPS failure — still submit */ }

      await submitReport({
        shift_session_id: activeSession.id,
        report_type:      'incident',
        description:      description.trim(),
        severity,
        photo_urls:       photos.toPayload(),
        latitude,
        longitude,
      });

      // Confirm to guard that email alert has been sent
      Alert.alert(
        'Incident Reported',
        `Report submitted. The client has been notified by email.`,
        [{ text: 'OK', onPress: () => router.replace('/(tabs)/reports') }]
      );
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
        <Text style={styles.title}>INCIDENT REPORT</Text>

        {/* Email notice */}
        <View style={styles.alertBanner}>
          <Text style={styles.alertIcon}>📧</Text>
          <Text style={styles.alertText}>
            Submitting this report will immediately email the client.
          </Text>
        </View>

        {/* Severity selector */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>SEVERITY <Text style={styles.req}>*</Text></Text>
          <View style={styles.severityRow}>
            {SEVERITIES.map((s) => (
              <TouchableOpacity
                key={s.value}
                style={[
                  styles.severityBtn,
                  { borderColor: s.color },
                  severity === s.value && { backgroundColor: s.color },
                ]}
                onPress={() => setSeverity(s.value)}
              >
                <Text style={[
                  styles.severityText,
                  { color: severity === s.value ? Colors.structure : s.color },
                ]}>
                  {s.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Description */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>INCIDENT DESCRIPTION <Text style={styles.req}>*</Text></Text>
          <TextInput
            style={styles.textArea}
            value={description}
            onChangeText={(t) => { setDescription(t); if (enhanced) { setEnhanced(null); setOriginalDesc(null); } }}
            placeholder="Describe exactly what happened: who, what, when, where. Be specific."
            placeholderTextColor={Colors.muted}
            multiline
            numberOfLines={7}
            maxLength={3000}
            textAlignVertical="top"
          />
          <Text style={styles.charCount}>{description.length}/3000</Text>

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

        {/* Photos — required for incidents */}
        <View style={styles.field}>
          <View style={styles.photoHeader}>
            <PhotoStrip
              attachments={photos.attachments}
              onAdd={photos.addPhoto}
              onRemove={photos.removePhoto}
              maxPhotos={5}
              disabled={submitting}
            />
          </View>
          {photos.attachments.length === 0 && (
            <Text style={styles.photoRequired}>⚠ At least 1 photo is required</Text>
          )}
        </View>

        {/* Submit */}
        <TouchableOpacity
          style={[styles.submitBtn, submitting && styles.disabled]}
          onPress={submit}
          disabled={submitting}
        >
          {submitting
            ? <ActivityIndicator color={Colors.structure} />
            : <Text style={styles.submitText}>SUBMIT INCIDENT REPORT</Text>
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
  title:    { fontFamily: Fonts.heading, color: '#EF4444', fontSize: 26, letterSpacing: 4, marginBottom: Spacing.md },

  alertBanner: {
    flexDirection: 'row', alignItems: 'center',
    width: '92%',
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: '#EF4444',
    padding: Spacing.md, gap: Spacing.sm,
    marginBottom: Spacing.xl,
  },
  alertIcon: { fontSize: 18 },
  alertText: { flex: 1, color: '#EF4444', fontSize: 13, lineHeight: 18 },

  field:      { width: '92%', marginBottom: Spacing.lg },
  fieldLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm },
  req:        { color: '#EF4444' },

  severityRow: { flexDirection: 'row', gap: Spacing.sm },
  severityBtn: {
    flex: 1, borderWidth: 1.5, borderRadius: Radius.sm,
    paddingVertical: Spacing.sm, alignItems: 'center',
  },
  severityText: { fontFamily: Fonts.heading, fontSize: 11, letterSpacing: 2 },

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

  photoHeader:    { },
  photoRequired:  { color: '#EF4444', fontSize: 12, marginTop: 4 },

  submitBtn: {
    width: '92%',
    backgroundColor: '#EF4444',
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center', justifyContent: 'center',
    minHeight: 54, marginBottom: Spacing.md,
  },
  submitText: { fontFamily: Fonts.heading, color: '#FFFFFF', fontSize: 16, letterSpacing: 3 },
  disabled:   { opacity: 0.4 },

  cancelBtn:  { paddingVertical: Spacing.sm },
  cancelText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },
});
