/**
 * CameraCapture — shared full-bleed camera component.
 *
 * Generalizes components/SelfieCapture.tsx (the 2026-07-10 extraction) to
 * every photo surface: ping, clock-in site photo, task completion, and the
 * two selfie flows (which keep their SelfieCapture wrapper API).
 *
 * Layout: standard phone-camera shape. The preview fills the screen; the
 * header, timestamp, and controls float over it; the shutter is anchored
 * at the bottom near the thumb. No fixed-height letterbox.
 *
 * NOTE (iOS): the captured photo is center-cropped to the PREVIEW's aspect
 * ratio (AVMakeRect in expo-camera's CameraPhotoCapture). Full-bleed preview
 * therefore captures a taller frame than the old 300px letterbox did —
 * WYSIWYG: the guard gets exactly what the viewfinder showed.
 *
 * Shutter contract:
 *  - INSTANT response on press: haptic + shutter scale/color change + a
 *    brief flash blink, all before takePictureAsync starts.
 *  - Double-capture is a no-op via a SYNCHRONOUS ref lock (state-based
 *    guards proved too slow — see the pre-migration tasks/complete bug).
 *  - After capture the frozen frame stays on screen through compress, GPS,
 *    and the caller's whole pipeline (upload + POST), with a visible status
 *    pill. The guard never stares at a live viewfinder wondering whether
 *    the shot registered.
 *  - Gated on `cameraReady` (onCameraReady + 3s force-enable fallback —
 *    Android's onCameraReady sometimes never fires).
 *  - takePictureAsync wrapped in a 10s Promise.race so a hung native call
 *    can't leave the shutter locked forever.
 *
 * Ownership seam (Phase 0, approved):
 *  - Component owns: permission gate, ready gate, capture, compress
 *    (1080px / JPEG 0.8, EXIF-stripped), GPS tagging strategy, freeze-frame
 *    + status UI, optional confirm/retake step, breadcrumbs.
 *  - Caller owns: S3 upload, API submission + error mapping, offline
 *    queueing, navigation. The caller's async pipeline runs inside
 *    onCaptured/onConfirmed while the component shows progress; return
 *    'reset' to go back to the live viewfinder (e.g. off-post retry),
 *    return nothing when navigating away.
 */
import { useEffect, useRef, useState, ReactElement } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Image,
  Animated, ActivityIndicator,
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import * as Haptics from 'expo-haptics';
import * as Sentry from '@sentry/react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Colors, Spacing, Radius, Fonts } from '../constants/theme';

export interface CapturedPhoto {
  uri:       string;         // compressed 1080px JPEG (EXIF-stripped)
  latitude:  number | null;  // null only under gps="none" or best-effort miss
  longitude: number | null;
  accuracy:  number | null;
  takenAt:   string;         // ISO timestamp at capture
}

/** GPS tagging strategy.
 *  required     — cached-first, live 3s race; no fix → alert + reset (never
 *                 delivers null coords; matches ping's hard-fail).
 *  best-effort  — same reads, but null coords are delivered on miss.
 *  none         — skip GPS entirely (caller reads position itself). */
export type GpsStrategy = 'required' | 'best-effort' | 'none';

export type PipelineResult = void | 'reset';

interface Props {
  facing:             'front' | 'back';
  gps:                GpsStrategy;
  /** Sentry breadcrumb category — keep existing dashboard categories. */
  breadcrumbCategory: string;
  /** Breadcrumb message prefix; SelfieCapture passes 'selfie' so existing
   *  dashboards keep parsing. Defaults to 'camera'. */
  breadcrumbPrefix?:  string;
  /** When true, show a preview with retake/confirm before onCaptured runs. */
  confirm?:           boolean;
  /** Runs the caller's post-capture pipeline. Use setStatus for the
   *  progress pill text. Return 'reset' to go back to the live camera. */
  onCaptured:         (photo: CapturedPhoto, setStatus: (msg: string) => void) => Promise<PipelineResult> | PipelineResult;
  /** Synchronous pre-capture validation (e.g. active-session check). Return
   *  false to abort the press — caller shows its own alert. */
  validateBeforeCapture?: () => boolean;
  onCancel?:          () => void;
  headerTitle?:       string;
  headerSubtitle?:    string;
  instruction?:       string;
  /** Extra caller UI floating above the bottom bar (e.g. admin instruction
   *  card, retention notice). ReactElement (not ReactNode): the repo carries
   *  both @types/react 18 and 19 and their ReactNode definitions conflict. */
  overlayExtra?:      ReactElement<any> | null;
  primaryButtonLabel?: string;  // confirm-mode primary, default USE PHOTO
  cancelButtonLabel?:  string;
  showCornerGuides?:  boolean;
  showTimestamp?:     boolean;
}

const CAMERA_READY_FALLBACK_MS = 3_000;
const TAKE_PICTURE_TIMEOUT_MS  = 10_000;
const GPS_TIMEOUT_MS           = 3_000;

// Amendment A (latency): the final artifact is always re-encoded to 1080px
// JPEG@0.8 below, so capture quality mainly buys intermediate encode time.
// Lowering it is gated on a DEVICE A/B — flip this constant, read the
// [camera] timing logs, and diff the final artifacts before committing a
// lower value. Kept at 0.9 until that comparison is done: evidence quality
// is not worth trading for unmeasured speed.
const CAPTURE_QUALITY = 0.9;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function readGps(strategy: GpsStrategy): Promise<{ lat: number | null; lng: number | null; acc: number | null }> {
  if (strategy === 'none') return { lat: null, lng: null, acc: null };
  // Cached last-known first (instant), bounded live read as fallback.
  try {
    const last = await Location.getLastKnownPositionAsync();
    if (last) return { lat: last.coords.latitude, lng: last.coords.longitude, acc: last.coords.accuracy };
    const live = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
      new Promise<null>((r) => setTimeout(() => r(null), GPS_TIMEOUT_MS)),
    ]);
    if (live) return { lat: live.coords.latitude, lng: live.coords.longitude, acc: live.coords.accuracy };
  } catch (err) {
    console.warn('[camera] GPS read threw:', err);
  }
  return { lat: null, lng: null, acc: null };
}

type Stage =
  | { kind: 'live' }
  | { kind: 'capturing' }                            // shutter pressed, waiting on native capture
  | { kind: 'frozen'; uri: string; status: string }  // freeze-frame + pipeline progress
  | { kind: 'preview'; photo: CapturedPhoto };       // confirm-mode retake/use

export default function CameraCapture({
  facing,
  gps,
  breadcrumbCategory,
  breadcrumbPrefix = 'camera',
  confirm = false,
  onCaptured,
  validateBeforeCapture,
  onCancel,
  headerTitle,
  headerSubtitle,
  instruction,
  overlayExtra,
  primaryButtonLabel = 'USE PHOTO',
  cancelButtonLabel  = 'CANCEL',
  showCornerGuides = true,
  showTimestamp    = true,
}: Props) {
  const cameraRef                       = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraReady, setCameraReady]   = useState(false);
  const [stage, setStage]               = useState<Stage>({ kind: 'live' });
  // SYNCHRONOUS double-capture lock. State re-renders are too slow to stop
  // a fast double-tap; this flips before the first await.
  const busyRef  = useRef(false);
  const flashOpacity = useRef(new Animated.Value(0)).current;
  const insets = useSafeAreaInsets();

  function crumb(message: string, level: 'info' | 'warning' | 'error' = 'info', data?: Record<string, unknown>) {
    Sentry.addBreadcrumb({ category: breadcrumbCategory, message: `${breadcrumbPrefix}: ${message}`, level, data });
  }

  useEffect(() => {
    crumb('entered');
    // Android's onCameraReady sometimes never fires → 3s force-enable.
    const t = setTimeout(() => setCameraReady(true), CAMERA_READY_FALLBACK_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function setFrozenStatus(uri: string) {
    return (msg: string) => setStage({ kind: 'frozen', uri, status: msg });
  }

  async function runPipeline(photo: CapturedPhoto) {
    setStage({ kind: 'frozen', uri: photo.uri, status: 'SAVING…' });
    try {
      const result = await onCaptured(photo, setFrozenStatus(photo.uri));
      if (result === 'reset') {
        busyRef.current = false;
        setStage({ kind: 'live' });
        return;
      }
      // Caller navigated away — leave the freeze-frame in place behind any
      // confirmation alert; unlock in case the screen stays mounted.
      busyRef.current = false;
    } catch (err: any) {
      // Callers are expected to handle their own errors; this is the belt
      // for anything that escapes so the screen never wedges locked.
      crumb('pipeline threw', 'error', { error: err?.message ?? String(err) });
      Sentry.captureException(err, { extra: { where: 'CameraCapture.pipeline', category: breadcrumbCategory } });
      Alert.alert('Something went wrong', err?.message ?? 'Please try again.');
      busyRef.current = false;
      setStage({ kind: 'live' });
    }
  }

  async function capture() {
    // Synchronous lock FIRST — a second press while anything is in flight
    // must be a no-op.
    if (busyRef.current) return;
    if (!cameraReady || !cameraRef.current) {
      Alert.alert('Camera Loading', 'Camera is still initializing — try again in a moment.');
      return;
    }
    if (validateBeforeCapture && !validateBeforeCapture()) return;
    busyRef.current = true;

    // INSTANT feedback, all before any capture work begins: haptic
    // (fire-and-forget), shutter visual state, flash blink.
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setStage({ kind: 'capturing' });
    flashOpacity.setValue(0.55);
    Animated.timing(flashOpacity, { toValue: 0, duration: 180, useNativeDriver: true }).start();

    const t0 = Date.now();
    try {
      const photo = await withTimeout(
        cameraRef.current.takePictureAsync({ quality: CAPTURE_QUALITY }),
        TAKE_PICTURE_TIMEOUT_MS,
        'takePictureAsync',
      );
      if (!photo?.uri) throw new Error('Camera did not return a photo. Try again.');
      const tCapture = Date.now() - t0;
      const takenAt = new Date().toISOString();

      // Freeze-frame immediately on the raw capture — from here the guard
      // never sees the live viewfinder again until the pipeline resolves.
      setStage({ kind: 'frozen', uri: photo.uri, status: 'SAVING…' });

      // Compress (best-effort). EXIF: stripped by ImageManipulator pipeline
      // (iOS UIImage.jpegData, Android Bitmap.compress). Do NOT bypass the
      // manipulator for uploads.
      const t1 = Date.now();
      let compressedUri = photo.uri;
      try {
        const result = await ImageManipulator.manipulateAsync(
          photo.uri,
          [{ resize: { width: 1080 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG },
        );
        if (result?.uri) compressedUri = result.uri;
      } catch (err) {
        console.warn('[camera] compression skipped:', err);
      }
      const tManipulate = Date.now() - t1;
      // Amendment A instrumentation — read these off a device run to A/B
      // CAPTURE_QUALITY. capture_ms is the shutter-freeze component.
      console.log(`[camera] capture_ms=${tCapture} manipulate_ms=${tManipulate} quality=${CAPTURE_QUALITY}`);
      crumb('captured', 'info', { capture_ms: tCapture, manipulate_ms: tManipulate, quality: CAPTURE_QUALITY });

      const pos = await readGps(gps);
      if (gps === 'required' && (pos.lat === null || pos.lng === null)) {
        Alert.alert('GPS Failed', 'GPS lock failed. Move to an area with better signal and try again.');
        busyRef.current = false;
        setStage({ kind: 'live' });
        return;
      }

      const captured: CapturedPhoto = {
        uri:       compressedUri,
        latitude:  pos.lat,
        longitude: pos.lng,
        accuracy:  pos.acc,
        takenAt,
      };

      if (confirm) {
        busyRef.current = false; // preview buttons take over
        setStage({ kind: 'preview', photo: captured });
        return;
      }
      await runPipeline(captured);
    } catch (err: any) {
      crumb('capture failed', 'error', { error: err?.message ?? String(err) });
      Sentry.captureException(err, { extra: { where: 'CameraCapture.capture', category: breadcrumbCategory } });
      Alert.alert('Capture Failed', err?.message ?? 'Could not take photo. Try again.');
      busyRef.current = false;
      setStage({ kind: 'live' });
    }
  }

  function confirmPreview() {
    if (stage.kind !== 'preview' || busyRef.current) return;
    busyRef.current = true;
    crumb('confirmed');
    void runPipeline(stage.photo);
  }

  function retake() {
    if (busyRef.current) return;
    crumb('retake');
    setStage({ kind: 'live' });
  }

  function cancel() {
    if (!onCancel || busyRef.current) return;
    crumb('cancel');
    onCancel();
  }

  // ── Permission gate ────────────────────────────────────────────────────
  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Text style={styles.permTitle}>CAMERA ACCESS NEEDED</Text>
        <TouchableOpacity style={styles.permBtn} onPress={requestPermission}>
          <Text style={styles.permBtnText}>GRANT CAMERA ACCESS</Text>
        </TouchableOpacity>
        {onCancel && (
          <TouchableOpacity style={styles.cancelLink} onPress={cancel}>
            <Text style={styles.cancelLinkText}>{cancelButtonLabel}</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  const topPad    = insets.top + Spacing.md;
  const bottomPad = insets.bottom + Spacing.lg;

  // ── Confirm-mode preview ───────────────────────────────────────────────
  if (stage.kind === 'preview') {
    return (
      <View style={styles.root}>
        <Image source={{ uri: stage.photo.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <View style={[styles.headerScrim, { paddingTop: topPad }]}>
          {headerTitle    ? <Text style={styles.headerTitle}>{headerTitle}</Text> : null}
          <Text style={styles.headerSubtitle}>PHOTO PREVIEW</Text>
        </View>
        <View style={[styles.bottomScrim, { paddingBottom: bottomPad }]}>
          <View style={styles.previewActions}>
            <TouchableOpacity style={styles.retakeButton} onPress={retake}>
              <Text style={styles.retakeText}>RETAKE</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.useButton} onPress={confirmPreview}>
              <Text style={styles.useText}>{primaryButtonLabel}</Text>
            </TouchableOpacity>
          </View>
          {gps !== 'none' && <Text style={styles.hint}>GPS + timestamp embedded automatically</Text>}
          {onCancel && (
            <TouchableOpacity style={styles.cancelLink} onPress={cancel}>
              <Text style={styles.cancelLinkText}>{cancelButtonLabel}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // ── Freeze-frame + pipeline progress ───────────────────────────────────
  if (stage.kind === 'frozen') {
    return (
      <View style={styles.root}>
        <Image source={{ uri: stage.uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        <View style={[styles.headerScrim, { paddingTop: topPad }]}>
          {headerTitle    ? <Text style={styles.headerTitle}>{headerTitle}</Text> : null}
          {headerSubtitle ? <Text style={styles.headerSubtitle}>{headerSubtitle}</Text> : null}
        </View>
        <View style={[styles.bottomScrim, { paddingBottom: bottomPad }]}>
          <View style={styles.statusPill}>
            <ActivityIndicator size="small" color={Colors.action} />
            <Text style={styles.statusText}>{stage.status}</Text>
          </View>
        </View>
      </View>
    );
  }

  // ── Live camera (+ capturing overlay) ──────────────────────────────────
  const capturing = stage.kind === 'capturing';

  return (
    <View style={styles.root}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing={facing as CameraType}
        animateShutter={false} // we provide our own instant feedback; the built-in iOS shutter animation only adds delay
        onCameraReady={() => {
          console.log('[camera] onCameraReady fired');
          setCameraReady(true);
        }}
      />

      {showCornerGuides && (
        <>
          <View style={[styles.cornerTL, { top: topPad + 56 }]} /><View style={[styles.cornerTR, { top: topPad + 56 }]} />
          <View style={styles.cornerBL} /><View style={styles.cornerBR} />
        </>
      )}

      <View style={[styles.headerScrim, { paddingTop: topPad }]}>
        {headerTitle    ? <Text style={styles.headerTitle}>{headerTitle}</Text> : null}
        {headerSubtitle ? <Text style={styles.headerSubtitle}>{headerSubtitle}</Text> : null}
        {instruction    ? <Text style={styles.instruction}>{instruction}</Text> : null}
      </View>

      <View style={[styles.bottomScrim, { paddingBottom: bottomPad }]}>
        {/* Cast: react-native's ViewProps resolve the hoisted @types/react 18
            while this app compiles against 19 — the two ReactNode definitions
            are structurally incompatible for prop-passed elements. */}
        {overlayExtra as any}
        {showTimestamp && (
          <Text style={styles.timestamp}>{new Date().toLocaleString()}</Text>
        )}
        <View style={styles.controlRow}>
          {onCancel ? (
            <TouchableOpacity style={styles.sideSlot} onPress={cancel}>
              <Text style={styles.cancelLinkText}>{cancelButtonLabel}</Text>
            </TouchableOpacity>
          ) : <View style={styles.sideSlot} />}

          <TouchableOpacity
            style={[styles.shutter, (!cameraReady || capturing) && styles.shutterDim]}
            onPress={capture}
            activeOpacity={0.8}
            disabled={!cameraReady}
          >
            <View style={[styles.shutterInner, capturing && styles.shutterInnerPressed]} />
          </TouchableOpacity>

          <View style={styles.sideSlot}>
            {capturing && <ActivityIndicator size="small" color={Colors.action} />}
          </View>
        </View>
        <Text style={styles.hint}>
          {capturing ? 'Taking photo…' : !cameraReady ? 'Camera initializing…' : ' '}
        </Text>
      </View>

      {/* Shutter flash blink — instant press feedback */}
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.flash, { opacity: flashOpacity }]} />
    </View>
  );
}

const CORNER_SIZE  = 24;
const CORNER_WIDTH = 3;
const cornerBase   = { position: 'absolute' as const, width: CORNER_SIZE, height: CORNER_SIZE, borderColor: Colors.action, zIndex: 1 };

const styles = StyleSheet.create({
  root:   { flex: 1, backgroundColor: Colors.black },
  center: { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center' },

  headerScrim: {
    position: 'absolute', top: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingBottom: Spacing.sm, paddingHorizontal: Spacing.md,
    alignItems: 'center', zIndex: 2,
  },
  headerTitle:    { color: Colors.muted, fontSize: 11, letterSpacing: 4 },
  headerSubtitle: { color: Colors.action, fontFamily: Fonts.heading, fontSize: 14, letterSpacing: 3, marginTop: 2 },
  instruction:    { color: Colors.base, fontSize: 14, textAlign: 'center', marginTop: Spacing.xs },

  bottomScrim: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingTop: Spacing.sm, paddingHorizontal: Spacing.md,
    alignItems: 'center', gap: Spacing.sm, zIndex: 2,
  },

  cornerTL: { ...cornerBase, left: 16, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerTR: { ...cornerBase, right: 16, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },
  cornerBL: { ...cornerBase, bottom: 220, left: 16, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerBR: { ...cornerBase, bottom: 220, right: 16, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },

  timestamp: { color: Colors.action, fontSize: 12, textAlign: 'center', fontFamily: 'monospace' },

  controlRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    width: '100%', paddingHorizontal: Spacing.lg,
  },
  sideSlot: { width: 72, alignItems: 'center' },

  shutter: {
    width: 72, height: 72, borderRadius: 36,
    borderWidth: 4, borderColor: Colors.action,
    alignItems: 'center', justifyContent: 'center',
  },
  shutterDim:   { opacity: 0.4 },
  shutterInner: { width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.action },
  shutterInnerPressed: { transform: [{ scale: 0.72 }], backgroundColor: Colors.base },

  flash: { backgroundColor: Colors.white, zIndex: 3 },

  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.full,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    marginVertical: Spacing.md,
  },
  statusText: { color: Colors.base, fontSize: 13, letterSpacing: 2 },

  hint: { color: Colors.muted, fontSize: 12, marginTop: 2 },

  previewActions: {
    flexDirection: 'row', gap: Spacing.md,
    marginVertical: Spacing.sm, paddingHorizontal: Spacing.md, width: '100%',
  },
  retakeButton: {
    flex: 1, borderWidth: 2, borderColor: Colors.base,
    borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  retakeText: { color: Colors.base, fontFamily: Fonts.heading, fontSize: 16, letterSpacing: 2 },
  useButton: {
    flex: 1, backgroundColor: Colors.action,
    borderRadius: Radius.md, padding: Spacing.md, alignItems: 'center',
  },
  useText: { color: Colors.structure, fontFamily: Fonts.heading, fontSize: 16, letterSpacing: 2 },

  cancelLink:     { padding: Spacing.sm },
  cancelLinkText: { color: Colors.base, fontSize: 13, letterSpacing: 2 },

  permTitle:   { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, marginBottom: Spacing.xl, letterSpacing: 3 },
  permBtn:     { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  permBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
