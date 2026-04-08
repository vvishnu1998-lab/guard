/**
 * GPS + Photo Ping (Section 5.4 — on-hour pings)
 * Amber theme. Rear camera. Posts location ping + photo to API.
 * Shows 7-day photo deletion notice (Section 11.4 — retain_as_evidence exemption).
 */
import { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, ScrollView } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useShiftStore }   from '../../store/shiftStore';
import { useOfflineStore } from '../../store/offlineStore';
import { pingState }       from '../../lib/pingState';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

export default function PhotoPing() {
  const cameraRef                       = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [capturing, setCapturing]       = useState(false);

  const { activeSession } = useShiftStore();
  const { submitPing }    = useOfflineStore();

  if (!permission?.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permTitle}>CAMERA ACCESS NEEDED</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>GRANT CAMERA ACCESS</Text>
        </TouchableOpacity>
      </View>
    );
  }

  async function capture() {
    if (!cameraRef.current || capturing || !activeSession) return;
    setCapturing(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') throw new Error('Location permission is required to submit a ping.');
      const loc   = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo) throw new Error('No photo captured');

      const compressed = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );

      await submitPing({
        shift_session_id: activeSession.id,
        latitude:         loc.coords.latitude,
        longitude:        loc.coords.longitude,
        ping_type:        'gps_photo',
        photo_url:        compressed.uri,
      });

      // Suppress ping alert for the rest of this 30-min cycle
      pingState.suppressAlertUntil = Date.now() + 30 * 60 * 1000;
      router.replace('/active-shift');
    } catch (err: any) {
      Alert.alert('Ping Failed', err?.message ?? 'Could not submit ping. Try again.');
    } finally {
      setCapturing(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.step}>LOCATION PING</Text>
      <Text style={styles.type}>GPS + PHOTO</Text>

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

      {/* 7-day deletion notice */}
      <View style={styles.noticeCard}>
        <Text style={styles.noticeIcon}>🗑</Text>
        <Text style={styles.noticeText}>
          Ping photos are auto-deleted after 7 days unless flagged as evidence by admin.
        </Text>
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

const CORNER_SIZE  = 24;
const CORNER_WIDTH = 3;
const cornerBase   = { position: 'absolute' as const, width: CORNER_SIZE, height: CORNER_SIZE, borderColor: Colors.action };

const styles = StyleSheet.create({
  container:       { flex: 1, backgroundColor: Colors.structure, alignItems: 'center' },
  center:          { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center' },
  step:            { color: Colors.muted, fontSize: 11, letterSpacing: 4, marginTop: Spacing.xl, marginBottom: 2 },
  type:            { color: Colors.action, fontFamily: Fonts.heading, fontSize: 14, letterSpacing: 3, marginBottom: Spacing.md },
  cameraContainer: { width: '100%', height: 300 },
  camera:          { flex: 1 },
  cornerTL: { ...cornerBase, top: 16, left: 16, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerTR: { ...cornerBase, top: 16, right: 16, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },
  cornerBL: { ...cornerBase, bottom: 32, left: 16, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerBR: { ...cornerBase, bottom: 32, right: 16, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },
  timestampStrip: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)', padding: Spacing.sm,
  },
  timestamp: { color: Colors.action, fontSize: 12, textAlign: 'center', fontFamily: 'monospace' },

  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md,
    gap: Spacing.sm,
    marginTop: Spacing.md,
  },
  noticeIcon: { fontSize: 18 },
  noticeText: { flex: 1, color: Colors.muted, fontSize: 12, lineHeight: 18 },

  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: Colors.action,
    alignItems: 'center', justifyContent: 'center',
    marginVertical: Spacing.xl,
  },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.action },
  disabled:     { opacity: 0.4 },

  permTitle:   { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, marginBottom: Spacing.xl, letterSpacing: 3 },
  permBtn:     { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  permBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
