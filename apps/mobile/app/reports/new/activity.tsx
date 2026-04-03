/**
 * Activity Report Form
 * Routine patrol log — description required, up to 3 optional photos, GPS coords.
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
import { Colors, Spacing, Radius, Fonts } from '../../../constants/theme';

export default function ActivityReportForm() {
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting]   = useState(false);

  const { activeSession } = useShiftStore();
  const { submitReport }  = useOfflineStore();
  const photos            = usePhotoAttachments(3);

  async function submit() {
    if (!description.trim()) {
      Alert.alert('Required', 'Please enter a description.');
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
      } catch { /* GPS optional for activity reports */ }

      await submitReport({
        shift_session_id: activeSession.id,
        report_type:      'activity',
        description:      description.trim(),
        photo_urls:       photos.toPayload(),
        latitude,
        longitude,
      });

      router.replace('/(tabs)/reports');
    } catch (err: any) {
      Alert.alert('Submit Failed', err?.message ?? 'Could not submit report. Saved for later sync.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.bg} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">

        <Text style={styles.step}>NEW REPORT</Text>
        <Text style={styles.title}>ACTIVITY REPORT</Text>
        <Text style={styles.subtitle}>Routine patrol log and observations</Text>

        {/* Description */}
        <View style={styles.field}>
          <Text style={styles.fieldLabel}>DESCRIPTION <Text style={styles.req}>*</Text></Text>
          <TextInput
            style={styles.textArea}
            value={description}
            onChangeText={setDescription}
            placeholder="Describe your patrol observations, completed rounds, access checks…"
            placeholderTextColor={Colors.muted}
            multiline
            numberOfLines={6}
            maxLength={2000}
            textAlignVertical="top"
          />
          <Text style={styles.charCount}>{description.length}/2000</Text>
        </View>

        {/* Photos */}
        <View style={styles.field}>
          <PhotoStrip
            attachments={photos.attachments}
            onAdd={photos.addPhoto}
            onRemove={photos.removePhoto}
            maxPhotos={3}
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
            ? <ActivityIndicator color={Colors.structure} />
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
  title:    { fontFamily: Fonts.heading, color: Colors.base, fontSize: 26, letterSpacing: 4, marginBottom: 4 },
  subtitle: { color: Colors.muted, fontSize: 13, marginBottom: Spacing.xl },

  field:       { width: '92%', marginBottom: Spacing.lg },
  fieldLabel:  { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm },
  req:         { color: Colors.action },

  textArea: {
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    color: Colors.base, fontSize: 14, lineHeight: 22,
    padding: Spacing.md, minHeight: 140,
  },
  charCount: { color: Colors.muted, fontSize: 11, textAlign: 'right', marginTop: 4 },

  submitBtn: {
    width: '92%',
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center', justifyContent: 'center',
    minHeight: 54, marginBottom: Spacing.md,
  },
  submitText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 4 },
  disabled:   { opacity: 0.4 },

  cancelBtn:  { paddingVertical: Spacing.sm },
  cancelText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },
});
