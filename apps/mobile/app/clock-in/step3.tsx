/**
 * Clock-In Step 3 — Site Photo (Section 5.2)
 * Rear camera. Admin-defined instruction text shown below viewfinder.
 * Shows a preview after capture; guard can retake or proceed.
 */
import { useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Image, ScrollView } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useClockInStore } from '../../store/clockInStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function ClockInStep3() {
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
  const { pendingShiftInstruction, setSitePhoto } = useClockInStore();

  const instruction = pendingShiftInstruction ?? 'Photograph the main entrance of the site.';

  // ── Permission gate ──────────────────────────────────────────────────────────
  if (!permission?.granted) {
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
    setSitePhoto(preview);
    router.push('/clock-in/step4');
  }

  // ── Preview screen ───────────────────────────────────────────────────────────
  if (preview) {
    return (
      <View style={styles.container}>
        <Text style={styles.step}>CLOCK IN · STEP 3 OF 4</Text>
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
      </View>
    );
  }

  // ── Camera screen ────────────────────────────────────────────────────────────
  return (
    <View style={styles.container}>
      <Text style={styles.step}>CLOCK IN · STEP 3 OF 4</Text>

      <View style={styles.cameraContainer}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing={'back' as CameraType}
          onCameraReady={() => setCameraReady(true)}
        >
          {/* Corner guides */}
          <View style={styles.cornerTL} /><View style={styles.cornerTR} />
          <View style={styles.cornerBL} /><View style={styles.cornerBR} />

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

      {/* Admin instruction */}
      <View style={styles.instructionCard}>
        <Text style={styles.instructionLabel}>ADMIN INSTRUCTION</Text>
        <ScrollView style={styles.instructionScroll}>
          <Text style={styles.instructionText}>{instruction}</Text>
        </ScrollView>
      </View>

      <TouchableOpacity
        style={[styles.shutter, (!cameraReady || capturing) && styles.disabled]}
        onPress={capture}
        disabled={!cameraReady || capturing}
      >
        <View style={[styles.shutterInner, capturing && styles.shutterCapturing]} />
      </TouchableOpacity>

      <Text style={styles.hint}>
        {capturing ? 'Taking photo…' : !cameraReady ? 'Waiting for camera…' : ''}
      </Text>
    </View>
  );
}

const CORNER_SIZE  = 24;
const CORNER_WIDTH = 3;
const CORNER_COLOR = Colors.action;
const cornerBase   = { position: 'absolute' as const, width: CORNER_SIZE, height: CORNER_SIZE, borderColor: CORNER_COLOR };

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: Colors.structure, alignItems: 'center' },
  step:            { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginTop: Spacing.xl, marginBottom: Spacing.sm },

  cameraContainer: { width: '100%', height: 320, position: 'relative' },
  camera:          { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: { color: Colors.muted, fontSize: 14 },

  cornerTL: { ...cornerBase, top: 16, left: 16, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerTR: { ...cornerBase, top: 16, right: 16, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },
  cornerBL: { ...cornerBase, bottom: 32, left: 16, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerBR: { ...cornerBase, bottom: 32, right: 16, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },

  timestampStrip: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)', padding: Spacing.sm,
  },
  timestamp: { color: Colors.action, fontSize: 12, textAlign: 'center', fontFamily: 'monospace' },

  instructionCard: {
    width: '100%', padding: Spacing.lg,
    backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border,
    maxHeight: 120,
  },
  instructionLabel:  { color: Colors.action, fontSize: 11, letterSpacing: 3, marginBottom: Spacing.sm },
  instructionScroll: { flex: 1 },
  instructionText:   { color: Colors.base, fontSize: 15, lineHeight: 22 },

  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: Colors.base,
    alignItems: 'center', justifyContent: 'center',
    marginVertical: Spacing.lg,
  },
  shutterInner:     { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.base },
  shutterCapturing: { backgroundColor: Colors.action },
  disabled:         { opacity: 0.3 },
  hint:             { color: Colors.muted, fontSize: 12, marginBottom: Spacing.sm },

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
