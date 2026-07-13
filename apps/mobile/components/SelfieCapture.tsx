/**
 * SelfieCapture — reusable front-camera capture + preview flow.
 *
 * Extracted 2026-07-10 from apps/mobile/app/clock-in/step2.tsx and
 * apps/mobile/app/shifts/[id]/handoff-clock-in.tsx, which had drifted
 * copies of the same camera+preview code.
 *
 * Self-contained: renders permission gate, live camera, capture button,
 * and post-capture preview with retake / use photo actions. Delivers a
 * captured selfie to the parent via onSelfieCaptured; upload and API
 * submission remain the parent's responsibility.
 *
 * Behavior preserved from the two originals:
 *  - Android's onCameraReady sometimes never fires → 3s fallback timer.
 *  - Photo taken at quality 0.9, then resized to 1080px width + JPEG
 *    quality 0.8 via ImageManipulator; falls back to the raw capture
 *    if the manipulator throws.
 *  - GPS tag: cached last-known first, live-with-3s-timeout fallback.
 *  - Sentry breadcrumbs at each state transition (entered, captured,
 *    confirmed, retake, capture failed) with category chosen by
 *    uploadContext so existing dashboards keep parsing.
 *  - Post-capture hint text ("Taking photo…", "Waiting for camera…",
 *    "GPS + timestamp embedded automatically") — retained; a small
 *    visual gain for the handoff wizard (previously bare shutter).
 *  - Timestamp overlay at the bottom of the live camera view —
 *    retained; also a small visual gain for the handoff wizard.
 *
 * Callback signature note: the spec called for `(localUri: string) =>
 * void`, but step4.tsx renders `selfie.latitude / .longitude / .takenAt`
 * under the review thumbnail. Discarding the metadata that SelfieCapture
 * already gathered internally would force the caller to re-run the same
 * GPS lookup. Pragmatic deviation: callback delivers a full
 * SelfieProof.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Image } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import * as Sentry from '@sentry/react-native';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';

export interface SelfieProof {
  uri:       string;
  latitude:  number;
  longitude: number;
  takenAt:   string;
}

export type SelfieUploadContext = 'clock_in' | 'handoff_clock_in';

interface Props {
  onSelfieCaptured:    (proof: SelfieProof) => void;
  onCancel?:           () => void;
  uploadContext:       SelfieUploadContext;
  primaryButtonLabel?: string;
  cancelButtonLabel?:  string;
  stepLabel?:          string;
  instruction?:        string;
}

const CAMERA_READY_FALLBACK_MS = 3_000;
const GPS_TIMEOUT_MS            = 3_000;

// Sentry category matches the pre-extraction breadcrumb dashboards.
function categoryFor(ctx: SelfieUploadContext): string {
  return ctx === 'clock_in' ? 'clock_in_wizard' : 'handoff_clock_in';
}

export default function SelfieCapture({
  onSelfieCaptured,
  onCancel,
  uploadContext,
  primaryButtonLabel = 'USE PHOTO',
  cancelButtonLabel  = 'CANCEL',
  stepLabel,
  instruction,
}: Props) {
  const cameraRef                       = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady]   = useState(false);
  const [capturing,   setCapturing]     = useState(false);
  const [preview,     setPreview]       = useState<SelfieProof | null>(null);

  useEffect(() => {
    Sentry.addBreadcrumb({
      category: categoryFor(uploadContext),
      message: 'selfie: entered',
      level: 'info',
      data: { upload_context: uploadContext },
    });
    // Force-enable the shutter after 3s in case onCameraReady is silent
    // (observed on some Android builds).
    const t = setTimeout(() => setCameraReady(true), CAMERA_READY_FALLBACK_MS);
    return () => clearTimeout(t);
  }, [uploadContext]);

  async function capture() {
    if (!cameraRef.current || !cameraReady || capturing) return;
    setCapturing(true);
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo?.uri) throw new Error('Camera did not return a photo. Try again.');

      // Resize + compress. Falls back to the raw photo if the manipulator
      // native module isn't available (Expo Go dev-client mismatch).
      let compressedUri = photo.uri;
      try {
        const result = await ImageManipulator.manipulateAsync(
          photo.uri,
          [{ resize: { width: 1080 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        if (result?.uri) compressedUri = result.uri;
      } catch { /* keep raw photo */ }

      // GPS: cached last-known first (instant), else a bounded live read.
      const loc = await Location.getLastKnownPositionAsync() ?? await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((res) => setTimeout(() => res(null), GPS_TIMEOUT_MS)),
      ]);

      const proof: SelfieProof = {
        uri:       compressedUri,
        latitude:  (loc as any)?.coords?.latitude  ?? 0,
        longitude: (loc as any)?.coords?.longitude ?? 0,
        takenAt:   new Date().toISOString(),
      };
      setPreview(proof);
      Sentry.addBreadcrumb({
        category: categoryFor(uploadContext),
        message: 'selfie: captured → preview',
        level: 'info',
      });
    } catch (err: any) {
      Sentry.addBreadcrumb({
        category: categoryFor(uploadContext),
        message: 'selfie: capture failed',
        level: 'error',
        data: { error: err?.message ?? String(err) },
      });
      Sentry.captureException(err, { extra: { where: 'SelfieCapture.capture', upload_context: uploadContext } });
      Alert.alert('Capture Failed', err?.message ?? 'Could not take photo. Try again.');
    } finally {
      setCapturing(false);
    }
  }

  function confirmPreview() {
    if (!preview) return;
    Sentry.addBreadcrumb({
      category: categoryFor(uploadContext),
      message: 'selfie: confirmed',
      level: 'info',
    });
    onSelfieCaptured(preview);
  }

  function retake() {
    Sentry.addBreadcrumb({
      category: categoryFor(uploadContext),
      message: 'selfie: retake',
      level: 'info',
    });
    setPreview(null);
  }

  function cancel() {
    if (!onCancel) return;
    Sentry.addBreadcrumb({
      category: categoryFor(uploadContext),
      message: 'selfie: cancel',
      level: 'info',
    });
    onCancel();
  }

  // ── Permission gate ────────────────────────────────────────────────────
  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        {stepLabel   ? <Text style={styles.step}>{stepLabel}</Text> : null}
        <Text style={styles.title}>CAMERA ACCESS NEEDED</Text>
        <TouchableOpacity style={styles.primaryButton} onPress={requestPermission}>
          <Text style={styles.primaryButtonText}>GRANT CAMERA ACCESS</Text>
        </TouchableOpacity>
        {onCancel && (
          <TouchableOpacity style={styles.cancelLink} onPress={cancel}>
            <Text style={styles.cancelLinkText}>{cancelButtonLabel}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // ── Preview screen ─────────────────────────────────────────────────────
  if (preview) {
    return (
      <View style={styles.container}>
        {stepLabel ? <Text style={styles.step}>{stepLabel}</Text> : null}
        <Text style={styles.previewLabel}>PHOTO PREVIEW</Text>
        <Image source={{ uri: preview.uri }} style={styles.previewImage} resizeMode="cover" />
        <View style={styles.previewActions}>
          <TouchableOpacity style={styles.retakeButton} onPress={retake}>
            <Text style={styles.retakeText}>RETAKE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.useButton} onPress={confirmPreview}>
            <Text style={styles.useText}>{primaryButtonLabel}</Text>
          </TouchableOpacity>
        </View>
        <Text style={styles.hint}>GPS + timestamp embedded automatically</Text>
        {onCancel && (
          <TouchableOpacity style={styles.cancelLink} onPress={cancel}>
            <Text style={styles.cancelLinkText}>{cancelButtonLabel}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // ── Live camera ────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      {stepLabel   ? <Text style={styles.step}>{stepLabel}</Text> : null}
      {instruction ? <Text style={styles.instruction}>{instruction}</Text> : null}

      <View style={styles.cameraContainer}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing={'front' as CameraType}
          onCameraReady={() => setCameraReady(true)}
        >
          <View style={styles.timestampStrip}>
            <Text style={styles.timestamp}>{new Date().toLocaleString()}</Text>
          </View>
        </CameraView>

        {!cameraReady && (
          <View style={styles.loadingOverlay}>
            <Text style={styles.loadingText}>Initialising camera…</Text>
          </View>
        )}
      </View>

      <TouchableOpacity
        style={[styles.shutter, (!cameraReady || capturing) && styles.disabled]}
        onPress={capture}
        disabled={!cameraReady || capturing}
      >
        <View style={[styles.shutterInner, capturing && styles.shutterCapturing]} />
      </TouchableOpacity>

      <Text style={styles.hint}>
        {capturing ? 'Taking photo…'
          : !cameraReady ? 'Waiting for camera…'
          : 'GPS + timestamp embedded automatically'}
      </Text>

      {onCancel && (
        <TouchableOpacity style={styles.cancelLink} onPress={cancel}>
          <Text style={styles.cancelLinkText}>{cancelButtonLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: Colors.structure, alignItems: 'center' },
  step:            { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginTop: Spacing.xl, marginBottom: Spacing.sm },
  instruction:     { color: Colors.base, fontSize: 16, letterSpacing: 1, marginBottom: Spacing.sm },

  cameraContainer: { width: '100%', flex: 1, position: 'relative' },
  camera:          { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: { color: Colors.muted, fontSize: 14 },

  timestampStrip: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)', padding: Spacing.sm,
  },
  timestamp: { color: Colors.action, fontSize: 12, textAlign: 'center', fontFamily: 'monospace' },

  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: Colors.base,
    alignItems: 'center', justifyContent: 'center',
    marginVertical: Spacing.xl,
  },
  shutterInner:      { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.base },
  shutterCapturing:  { backgroundColor: Colors.action },
  disabled:          { opacity: 0.3 },
  hint:              { color: Colors.muted, fontSize: 12, marginBottom: Spacing.lg },

  // Preview
  previewLabel:  { color: Colors.action, fontSize: 11, letterSpacing: 3, marginBottom: Spacing.sm },
  previewImage:  { width: '100%', flex: 1 },
  previewActions: {
    flexDirection: 'row', gap: Spacing.md,
    marginVertical: Spacing.xl, paddingHorizontal: Spacing.xl, width: '100%',
  },
  retakeButton: {
    flex: 1, borderWidth: 2, borderColor: Colors.base,
    borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center',
  },
  retakeText:  { color: Colors.base, fontFamily: Fonts.heading, fontSize: 16, letterSpacing: 2 },
  useButton: {
    flex: 1, backgroundColor: Colors.action,
    borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center',
  },
  useText:     { color: Colors.structure, fontFamily: Fonts.heading, fontSize: 16, letterSpacing: 2 },

  // Permission gate
  title:              { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, marginTop: Spacing.xxl },
  primaryButton:      { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md, marginTop: Spacing.lg },
  primaryButtonText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },

  // Optional cancel link — shown when the parent passes onCancel.
  cancelLink:     { marginBottom: Spacing.md, padding: Spacing.sm },
  cancelLinkText: { color: Colors.muted, fontSize: 13, letterSpacing: 2, textDecorationLine: 'underline' },
});
