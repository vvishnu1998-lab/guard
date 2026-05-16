/**
 * GPS + Photo Ping (Section 5.4 — on-hour pings)
 * Amber theme. Rear camera. Posts location ping + photo to API.
 * Shows 7-day photo deletion notice (Section 11.4 — retain_as_evidence exemption).
 *
 * Capture flow notes (post-build-#15 rework after the "shutter does nothing"
 * report on 2026-05-15):
 *  - Gated on `cameraReady` (onCameraReady callback + 3s force-enable fallback).
 *    Tapping before the camera is initialized used to silently no-op.
 *  - Photo is taken FIRST. GPS is fetched after with a 3s race timeout so a
 *    stalled location-services call can't hang the shutter.
 *  - takePictureAsync wrapped in a 10s Promise.race so a hung native call
 *    can't leave `capturing=true` forever (which is exactly what made the
 *    shutter look "broken" — it was disabled because capturing was stuck).
 *  - Every branch logs `[ping]` so the next failure is diagnosable from logs.
 */
import { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { router } from 'expo-router';
import { useShiftStore }   from '../../store/shiftStore';
import { useOfflineStore } from '../../store/offlineStore';
import { pingState }       from '../../lib/pingState';
import { getCurrentThrottleReason } from '../../lib/batteryThrottle';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const CAMERA_READY_FALLBACK_MS = 3000;
const TAKE_PICTURE_TIMEOUT_MS  = 10_000;
const GPS_TIMEOUT_MS           = 3000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

export default function PhotoPing() {
  const cameraRef                       = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady]   = useState(false);
  const [capturing, setCapturing]       = useState(false);

  const { activeSession } = useShiftStore();
  const { submitPing }    = useOfflineStore();

  // Android often never fires onCameraReady — force-enable after 3s so the
  // shutter doesn't sit disabled indefinitely.
  useEffect(() => {
    const t = setTimeout(() => setCameraReady(true), CAMERA_READY_FALLBACK_MS);
    return () => clearTimeout(t);
  }, []);

  if (!permission) return null;
  if (!permission.granted) {
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
    if (capturing) {
      console.log('[ping] capture ignored — already capturing');
      return;
    }
    if (!activeSession) {
      Alert.alert(
        'No Active Shift',
        'Your shift has ended or hasn’t been clocked into yet. Pings can only be submitted while on shift.',
        [{ text: 'OK', onPress: () => router.replace('/(tabs)/home') }],
      );
      return;
    }
    if (!cameraRef.current || !cameraReady) {
      console.log('[ping] capture ignored — camera not ready', { hasRef: !!cameraRef.current, cameraReady });
      Alert.alert('Camera Loading', 'Camera is still initializing — try again in a moment.');
      return;
    }

    setCapturing(true);
    try {
      // 1) Take the photo first. Wrap in a timeout so a hung native call
      //    can't leave the shutter spinning forever.
      console.log('[ping] taking picture…');
      const photo = await withTimeout(
        cameraRef.current.takePictureAsync({ quality: 0.9 }),
        TAKE_PICTURE_TIMEOUT_MS,
        'takePictureAsync',
      );
      if (!photo?.uri) throw new Error('Camera did not return a photo. Try again.');
      console.log('[ping] picture taken:', photo.uri);

      // 2) Compress (best-effort)
      let compressed: { uri: string } = { uri: photo.uri };
      try {
        // EXIF: stripped by ImageManipulator pipeline (iOS UIImage.jpegData,
        // Android Bitmap.compress). Do NOT bypass the manipulator for uploads.
        const result = await ImageManipulator.manipulateAsync(
          photo.uri,
          [{ resize: { width: 1080 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        if (result?.uri) compressed = result;
      } catch (err) {
        console.warn('[ping] compression skipped:', err);
      }

      // 3) GPS with a 3s race — never block the submit on a slow GPS fix.
      //    Prefer the cached last-known position; fall back to a live read.
      let lat = 0;
      let lng = 0;
      try {
        const last = await Location.getLastKnownPositionAsync();
        if (last) {
          lat = last.coords.latitude;
          lng = last.coords.longitude;
        } else {
          const live = await Promise.race([
            Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
            new Promise<null>((r) => setTimeout(() => r(null), GPS_TIMEOUT_MS)),
          ]);
          if (live) {
            lat = (live as Location.LocationObject).coords.latitude;
            lng = (live as Location.LocationObject).coords.longitude;
          } else {
            console.warn('[ping] GPS timed out — submitting with 0,0');
          }
        }
      } catch (err) {
        console.warn('[ping] GPS read failed — submitting with 0,0:', err);
      }

      // 4) Submit. submitPing already wraps the network call and queues on
      //    failure, so we don't need an extra timeout here.
      // throttle_reason is null in the normal case; populated when the
      // battery hook on active-shift has the device in low-battery /
      // low-power-mode. Server writes it to location_pings.throttle_reason
      // so the client portal can distinguish a throttled cadence from a
      // missed ping.
      console.log('[ping] submitting…');
      await submitPing({
        shift_session_id: activeSession.id,
        latitude:         lat,
        longitude:        lng,
        ping_type:        'gps_photo',
        photo_url:        compressed.uri,
        throttle_reason:  getCurrentThrottleReason() ?? undefined,
      });
      console.log('[ping] submit complete');

      pingState.suppressAlertUntil = Date.now() + 30 * 60 * 1000;
      // Confirmation to the guard (was missing — submit used to silently
      // navigate away which made guards unsure whether the ping landed).
      Alert.alert(
        'Ping Submitted',
        'Photo and location saved.',
        [{ text: 'OK', onPress: () => router.replace('/active-shift') }],
      );
    } catch (err: any) {
      console.error('[ping] capture failed:', err);
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
          onCameraReady={() => {
            console.log('[ping] onCameraReady fired');
            setCameraReady(true);
          }}
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
        style={[styles.shutter, (capturing || !cameraReady) && styles.disabled]}
        onPress={capture}
        disabled={capturing || !cameraReady}
      >
        <View style={styles.shutterInner} />
      </TouchableOpacity>

      {!cameraReady && (
        <Text style={styles.readyHint}>Camera initializing…</Text>
      )}
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

  readyHint: { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginTop: -Spacing.lg },

  permTitle:   { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, marginBottom: Spacing.xl, letterSpacing: 3 },
  permBtn:     { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  permBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
