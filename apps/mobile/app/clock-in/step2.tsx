/**
 * Clock-In Step 2 — Guard Selfie (Section 5.2)
 * Front camera — simple capture, no overlay.
 * Shows a preview after capture; guard can retake or proceed.
 * GPS and timestamp are embedded in photo metadata before upload.
 */
import { useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Image } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useClockInStore } from '../../store/clockInStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function ClockInStep2() {
  const cameraRef                        = useRef<CameraView>(null);
  const [permission, requestPermission]  = useCameraPermissions();
  const [cameraReady, setCameraReady]    = useState(false);
  const [capturing, setCapturing]        = useState(false);
  // Android: onCameraReady sometimes never fires — force-enable after 3s
  useEffect(() => {
    const t = setTimeout(() => setCameraReady(true), 3000);
    return () => clearTimeout(t);
  }, []);
  const [preview, setPreview]            = useState<{
    uri: string; latitude: number; longitude: number; takenAt: string;
  } | null>(null);
  const { setSelfie } = useClockInStore();

  // ── Permission gate ──────────────────────────────────────────────────────────
  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>CAMERA ACCESS NEEDED</Text>
        <TouchableOpacity style={styles.button} onPress={requestPermission}>
          <Text style={styles.buttonText}>GRANT CAMERA ACCESS</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Capture ──────────────────────────────────────────────────────────────────
  async function capture() {
    if (!cameraRef.current || !cameraReady || capturing) return;
    setCapturing(true);
    try {
      // Take photo first — don't block on GPS
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo?.uri) throw new Error('Camera did not return a photo. Try again.');

      let compressed: { uri: string } = { uri: photo.uri };
      try {
        const result = await ImageManipulator.manipulateAsync(
          photo.uri,
          [{ resize: { width: 1080 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        if (result?.uri) compressed = result;
      } catch {
        // Use original photo if compression fails (e.g. Expo Go native module mismatch)
      }

      // Use cached GPS first (instant), fall back to live with 3s timeout
      const loc = await Location.getLastKnownPositionAsync() ?? await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>(res => setTimeout(() => res(null), 3000)),
      ]);

      setPreview({
        uri:       compressed.uri,
        latitude:  (loc as any)?.coords?.latitude  ?? 0,
        longitude: (loc as any)?.coords?.longitude ?? 0,
        takenAt:   new Date().toISOString(),
      });
    } catch (err: any) {
      Alert.alert('Capture Failed', err?.message ?? 'Could not take photo. Try again.');
    } finally {
      setCapturing(false);
    }
  }

  // ── Confirm preview and proceed ──────────────────────────────────────────────
  function usePhoto() {
    if (!preview?.uri) return;
    setSelfie(preview);
    router.push('/clock-in/step4');
  }

  // ── Preview screen ───────────────────────────────────────────────────────────
  if (preview) {
    return (
      <View style={styles.container}>
        <Text style={styles.step}>CLOCK IN · STEP 2 OF 3</Text>
        <Text style={styles.previewLabel}>PHOTO PREVIEW</Text>

        <Image source={{ uri: preview.uri }} style={styles.previewImage} resizeMode="cover" />

        <View style={styles.previewActions}>
          <TouchableOpacity style={styles.retakeButton} onPress={() => setPreview(null)}>
            <Text style={styles.retakeText}>RETAKE</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.useButton} onPress={usePhoto}>
            <Text style={styles.useText}>USE PHOTO</Text>
          </TouchableOpacity>
        </View>

        <Text style={styles.hint}>GPS + timestamp embedded automatically</Text>
      </View>
    );
  }

  // ── Camera screen ────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Text style={styles.step}>CLOCK IN · STEP 2 OF 3</Text>
      <Text style={styles.instruction}>Take a clear photo of yourself</Text>

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
        {capturing ? 'Taking photo…' : !cameraReady ? 'Waiting for camera…' : 'GPS + timestamp embedded automatically'}
      </Text>
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

  title:       { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, marginTop: Spacing.xxl },
  button:      { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md, marginTop: Spacing.lg },
  buttonText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
