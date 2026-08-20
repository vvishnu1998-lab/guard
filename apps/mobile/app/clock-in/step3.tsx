/**
 * Clock-In Step 3 — Site Photo (Section 5.2)
 * Rear camera. Admin-defined instruction text floats over the viewfinder.
 * Preview after capture; guard can retake or proceed.
 *
 * Camera UX lives in components/CameraCapture (batch/mobile-11 rebuild).
 * This screen owns only: the admin instruction, writing the proof into
 * useClockInStore, and advancing to step4 (which uploads).
 */
import { View, Text, StyleSheet } from 'react-native';
import * as Sentry from '@sentry/react-native';
import { router } from 'expo-router';
import CameraCapture, { CapturedPhoto } from '../../components/CameraCapture';
import { useClockInStore } from '../../store/clockInStore';
import { Colors, Spacing, Radius } from '../../constants/theme';

export default function ClockInStep3() {
  const { pendingShiftInstruction, setSitePhoto } = useClockInStore();

  const instruction = pendingShiftInstruction ?? 'Photograph the main entrance of the site.';

  function usePhoto(photo: CapturedPhoto): void {
    setSitePhoto({
      uri:       photo.uri,
      latitude:  photo.latitude  ?? 0,
      longitude: photo.longitude ?? 0,
      takenAt:   photo.takenAt,
    });
    Sentry.addBreadcrumb({
      category: 'clock_in_wizard',
      message: 'step3 → step4',
      level: 'info',
    });
    router.replace('/clock-in/step4');
  }

  return (
    <CameraCapture
      facing="back"
      gps="best-effort"
      confirm
      breadcrumbCategory="clock_in_wizard"
      breadcrumbPrefix="step3"
      headerTitle="CLOCK IN · STEP 3 OF 4"
      headerSubtitle="SITE PHOTO"
      onCaptured={usePhoto}
      overlayExtra={
        <View style={styles.instructionCard}>
          <Text style={styles.instructionLabel}>ADMIN INSTRUCTION</Text>
          <Text style={styles.instructionText}>{instruction}</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  instructionCard: {
    width: '100%',
    backgroundColor: 'rgba(15,25,41,0.85)', // Colors.surface over the preview
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md,
    gap: Spacing.xs,
  },
  instructionLabel: { color: Colors.action, fontSize: 10, letterSpacing: 2 },
  instructionText:  { color: Colors.base, fontSize: 13, lineHeight: 18 },
});
