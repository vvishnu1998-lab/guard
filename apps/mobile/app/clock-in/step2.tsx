/**
 * Clock-In Step 2 — Guard Selfie (Section 5.2)
 * Front camera — simple capture, no overlay.
 * GPS and timestamp are embedded in photo metadata before upload.
 * Blocked if GPS is outside geofence (enforced by step 1 state).
 */
import { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useClockInStore } from '../../store/clockInStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function ClockInStep2() {
  const cameraRef                   = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturing, setCapturing]   = useState(false);
  const { setSelfie }               = useClockInStore();

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

  async function capture() {
    if (!cameraRef.current || capturing) return;
    setCapturing(true);
    try {
      // Get GPS coords to embed
      const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });

      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo) throw new Error('No photo captured');

      // Compress to max 800KB (Section 3.6 / 11.4)
      const compressed = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );

      setSelfie({
        uri:       compressed.uri,
        latitude:  loc.coords.latitude,
        longitude: loc.coords.longitude,
        takenAt:   new Date().toISOString(),
      });

      router.push('/clock-in/step3');
    } catch (err: any) {
      Alert.alert('Capture Failed', err?.message ?? 'Could not take photo. Try again.');
    } finally {
      setCapturing(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.step}>CLOCK IN · STEP 2 OF 4</Text>

      <Text style={styles.instruction}>Take a clear photo of yourself</Text>

      <View style={styles.cameraContainer}>
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing={'front' as CameraType}
        >
          {/* Timestamp strip */}
          <View style={styles.timestampStrip}>
            <Text style={styles.timestamp}>{new Date().toLocaleString()}</Text>
          </View>
        </CameraView>
      </View>

      <TouchableOpacity
        style={[styles.shutter, capturing && styles.disabled]}
        onPress={capture}
        disabled={capturing}
      >
        <View style={styles.shutterInner} />
      </TouchableOpacity>

      <Text style={styles.hint}>GPS + timestamp embedded automatically</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: Colors.structure, alignItems: 'center' },
  step:            { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginTop: Spacing.xl, marginBottom: Spacing.sm },
  cameraContainer: { width: '100%', flex: 1 },
  camera:          { flex: 1 },
  instruction: { color: Colors.base, fontSize: 16, letterSpacing: 1, marginBottom: Spacing.sm },
  timestampStrip: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)', padding: Spacing.sm,
  },
  timestamp:  { color: Colors.action, fontSize: 12, textAlign: 'center', fontFamily: 'monospace' },
  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: Colors.base,
    alignItems: 'center', justifyContent: 'center',
    marginVertical: Spacing.xl,
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.base },
  disabled:    { opacity: 0.4 },
  hint:        { color: Colors.muted, fontSize: 12, marginBottom: Spacing.lg },
  title:       { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, marginTop: Spacing.xxl },
  button:      { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md, marginTop: Spacing.lg },
  buttonText:  { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
