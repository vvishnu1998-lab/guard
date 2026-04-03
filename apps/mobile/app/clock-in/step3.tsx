/**
 * Clock-In Step 3 — Site Photo (Section 5.2)
 * Rear camera. Admin-defined instruction text shown below viewfinder.
 * Guard photographs the site entrance or defined checkpoint.
 */
import { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useClockInStore } from '../../store/clockInStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function ClockInStep3() {
  const cameraRef                       = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturing, setCapturing]       = useState(false);
  const { pendingShiftInstruction, setSitePhoto } = useClockInStore();

  // Admin-defined checkpoint instruction — fetched with the shift data
  const instruction = pendingShiftInstruction ?? 'Photograph the main entrance of the site.';

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

  async function capture() {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });

      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo) throw new Error('No photo captured');

      const compressed = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );

      setSitePhoto({
        uri:       compressed.uri,
        latitude:  loc.coords.latitude,
        longitude: loc.coords.longitude,
        takenAt:   new Date().toISOString(),
      });

      router.push('/clock-in/step4');
    } catch (err: any) {
      Alert.alert('Capture Failed', err?.message ?? 'Could not take photo. Try again.');
    } finally {
      setCapturing(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.step}>CLOCK IN · STEP 3 OF 4</Text>

      <View style={styles.cameraContainer}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing={'back' as CameraType}
        >
          {/* Corner guides */}
          <View style={styles.cornerTL} /><View style={styles.cornerTR} />
          <View style={styles.cornerBL} /><View style={styles.cornerBR} />

          <View style={styles.timestampStrip}>
            <Text style={styles.timestamp}>{new Date().toLocaleString()}</Text>
          </View>
        </CameraView>
      </View>

      {/* Admin instruction text */}
      <View style={styles.instructionCard}>
        <Text style={styles.instructionLabel}>ADMIN INSTRUCTION</Text>
        <ScrollView style={styles.instructionScroll}>
          <Text style={styles.instructionText}>{instruction}</Text>
        </ScrollView>
      </View>

      <TouchableOpacity
        style={[styles.shutter, capturing && styles.disabled]}
        onPress={capture}
        disabled={capturing}
      >
        <View style={styles.shutterInner} />
      </TouchableOpacity>
    </View>
  );
}

const CORNER_SIZE   = 24;
const CORNER_WIDTH  = 3;
const CORNER_COLOR  = Colors.action;
const cornerBase    = { position: 'absolute' as const, width: CORNER_SIZE, height: CORNER_SIZE, borderColor: CORNER_COLOR };

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: Colors.structure, alignItems: 'center' },
  step:            { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginTop: Spacing.xl, marginBottom: Spacing.sm },
  cameraContainer: { width: '100%', height: 320 },
  camera:          { flex: 1 },
  cornerTL: { ...cornerBase, top: 16, left: 16, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerTR: { ...cornerBase, top: 16, right: 16, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },
  cornerBL: { ...cornerBase, bottom: 32, left: 16, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerBR: { ...cornerBase, bottom: 32, right: 16, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },
  timestampStrip: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)', padding: Spacing.sm,
  },
  timestamp:         { color: Colors.action, fontSize: 12, textAlign: 'center', fontFamily: 'monospace' },
  instructionCard: {
    width: '100%', padding: Spacing.lg,
    backgroundColor: Colors.surface, borderTopWidth: 1, borderTopColor: Colors.border,
    maxHeight: 140,
  },
  instructionLabel:  { color: Colors.action, fontSize: 11, letterSpacing: 3, marginBottom: Spacing.sm },
  instructionScroll: { flex: 1 },
  instructionText:   { color: Colors.base, fontSize: 15, lineHeight: 22 },
  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: Colors.base,
    alignItems: 'center', justifyContent: 'center',
    marginVertical: Spacing.xl,
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.base },
  disabled:     { opacity: 0.4 },
  title:        { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, marginTop: Spacing.xxl },
  button:       { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md, marginTop: Spacing.lg },
  buttonText:   { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
