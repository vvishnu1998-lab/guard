/**
 * Task Completion Form — /tasks/complete/[id]
 * Loads the task instance, enforces requires_photo, captures GPS,
 * optionally takes a photo (uploaded to S3), then POSTs completion.
 */
import { useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Image,
  ScrollView, Alert, ActivityIndicator,
} from 'react-native';
import { CameraView, CameraType, useCameraPermissions } from 'expo-camera';
import * as ImageManipulator from 'expo-image-manipulator';
import * as Location from 'expo-location';
import { router, useLocalSearchParams } from 'expo-router';
import { useShiftStore } from '../../../store/shiftStore';
import { apiClient }     from '../../../lib/apiClient';
import { uploadToS3 }    from '../../../lib/uploadToS3';
import { Colors, Spacing, Radius, Fonts } from '../../../constants/theme';

interface TaskDetail {
  id:                   string;
  title:                string;
  template_description: string | null;
  due_at:               string | null;
  status:               string;
  requires_photo:       boolean;
}

type Phase = 'loading' | 'review' | 'camera' | 'submitting' | 'done' | 'error';

export default function TaskCompleteScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const cameraRef = useRef<CameraView>(null);
  const [permission, requestPermission] = useCameraPermissions();

  const [phase,      setPhase]      = useState<Phase>('loading');
  const [task,       setTask]       = useState<TaskDetail | null>(null);
  const [photoUri,   setPhotoUri]   = useState<string | null>(null);
  const [errorMsg,   setErrorMsg]   = useState('');
  const [statusMsg,  setStatusMsg]  = useState('');

  const { activeSession } = useShiftStore();

  // Load task details on mount
  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        // Fetch the specific task from the instances list
        const list = await apiClient.get<TaskDetail[]>(
          `/tasks/instances?shift_id=${activeSession?.shift_id ?? ''}`
        );
        const found = list.find((t) => t.id === id);
        if (!found) throw new Error('Task not found');
        if (found.status === 'completed') {
          Alert.alert('Already Completed', 'This task has already been completed.', [
            { text: 'OK', onPress: () => router.back() }
          ]);
          return;
        }
        setTask(found);
        setPhase('review');
      } catch (err: any) {
        setErrorMsg(err?.message ?? 'Could not load task');
        setPhase('error');
      }
    })();
  }, [id]);

  async function capturePhoto() {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9 });
      if (!photo) throw new Error('No photo');
      const compressed = await ImageManipulator.manipulateAsync(
        photo.uri,
        [{ resize: { width: 1080 } }],
        { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
      );
      setPhotoUri(compressed.uri);
      setPhase('review');
    } catch (err: any) {
      Alert.alert('Camera Error', err?.message ?? 'Could not capture photo');
    }
  }

  async function submit() {
    if (!task || !activeSession) return;
    if (task.requires_photo && !photoUri) {
      Alert.alert('Photo Required', 'This task requires a photo to complete.');
      return;
    }

    setPhase('submitting');
    try {
      let uploadedUrl: string | null = null;
      if (photoUri) {
        setStatusMsg('Uploading photo…');
        const { public_url } = await uploadToS3(photoUri, 'report');
        uploadedUrl = public_url;
      }

      setStatusMsg('Getting location…');
      let lat: number | null = null;
      let lng: number | null = null;
      try {
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        lat = loc.coords.latitude;
        lng = loc.coords.longitude;
      } catch { /* GPS optional */ }

      setStatusMsg('Submitting…');
      await apiClient.post(`/tasks/instances/${task.id}/complete`, {
        shift_session_id: activeSession.id,
        completion_lat:   lat,
        completion_lng:   lng,
        photo_url:        uploadedUrl,
      });

      setPhase('done');
      setTimeout(() => router.back(), 1200);
    } catch (err: any) {
      Alert.alert('Error', err?.message ?? 'Could not complete task');
      setPhase('review');
    }
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (phase === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>ERROR</Text>
        <Text style={styles.errorSub}>{errorMsg}</Text>
        <TouchableOpacity style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>GO BACK</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Loading ───────────────────────────────────────────────────────────────
  if (phase === 'loading' || !task) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.action} size="large" />
      </View>
    );
  }

  // ── Camera capture ────────────────────────────────────────────────────────
  if (phase === 'camera') {
    if (!permission?.granted) {
      return (
        <View style={styles.center}>
          <Text style={styles.errorSub}>Camera access needed</Text>
          <TouchableOpacity style={styles.btn} onPress={requestPermission}>
            <Text style={styles.btnText}>GRANT ACCESS</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.cameraContainer}>
        <CameraView ref={cameraRef} style={styles.camera} facing={'back' as CameraType}>
          <View style={styles.cornerTL} /><View style={styles.cornerTR} />
          <View style={styles.cornerBL} /><View style={styles.cornerBR} />
        </CameraView>
        <View style={styles.cameraControls}>
          <TouchableOpacity style={styles.shutterBtn} onPress={capturePhoto}>
            <View style={styles.shutterInner} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.skipBtn} onPress={() => setPhase('review')}>
            <Text style={styles.skipText}>CANCEL</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  if (phase === 'done') {
    return (
      <View style={styles.center}>
        <Text style={styles.doneIcon}>✓</Text>
        <Text style={styles.doneText}>TASK COMPLETE</Text>
      </View>
    );
  }

  // ── Review / Submitting ───────────────────────────────────────────────────
  return (
    <ScrollView style={styles.bg} contentContainerStyle={styles.scroll}>
      <Text style={styles.step}>COMPLETE TASK</Text>
      <Text style={styles.taskTitle}>{task.title}</Text>
      {task.template_description && (
        <Text style={styles.taskDesc}>{task.template_description}</Text>
      )}

      {task.due_at && (
        <View style={styles.infoRow}>
          <Text style={styles.infoLabel}>DUE</Text>
          <Text style={styles.infoValue}>
            {new Date(task.due_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      )}

      {/* Photo section */}
      <View style={styles.photoSection}>
        <View style={styles.photoHeader}>
          <Text style={styles.fieldLabel}>
            PHOTO {task.requires_photo ? <Text style={styles.req}>* REQUIRED</Text> : '(OPTIONAL)'}
          </Text>
        </View>

        {photoUri ? (
          <View>
            <Image source={{ uri: photoUri }} style={styles.photoPreview} resizeMode="cover" />
            <TouchableOpacity style={styles.retakeBtn} onPress={() => setPhase('camera')}>
              <Text style={styles.retakeText}>RETAKE PHOTO</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity style={styles.addPhotoBtn} onPress={() => setPhase('camera')}>
            <Text style={styles.addPhotoIcon}>📷</Text>
            <Text style={styles.addPhotoText}>
              {task.requires_photo ? 'TAP TO TAKE REQUIRED PHOTO' : 'TAP TO ADD PHOTO (OPTIONAL)'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Submit */}
      <TouchableOpacity
        style={[styles.completeBtn, phase === 'submitting' && styles.disabled]}
        onPress={submit}
        disabled={phase === 'submitting'}
      >
        {phase === 'submitting' ? (
          <View style={{ flexDirection: 'row', gap: Spacing.sm, alignItems: 'center' }}>
            <ActivityIndicator color={Colors.structure} size="small" />
            <Text style={styles.completeBtnText}>{statusMsg}</Text>
          </View>
        ) : (
          <Text style={styles.completeBtnText}>MARK COMPLETE</Text>
        )}
      </TouchableOpacity>

      <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
        <Text style={styles.cancelText}>CANCEL</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const CORNER = 20;
const CBORDER = 3;
const cornerBase = {
  position: 'absolute' as const,
  width: CORNER, height: CORNER,
  borderColor: Colors.action,
};

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: Colors.structure },
  scroll: { alignItems: 'center', paddingTop: 60, paddingBottom: 48, padding: Spacing.xl },

  step:      { color: Colors.muted, fontSize: 11, letterSpacing: 3, marginBottom: Spacing.sm },
  taskTitle: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 24, letterSpacing: 3, marginBottom: Spacing.sm, textAlign: 'center' },
  taskDesc:  { color: Colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center', marginBottom: Spacing.lg },

  infoRow:   { flexDirection: 'row', gap: Spacing.sm, marginBottom: Spacing.lg },
  infoLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 2 },
  infoValue: { color: Colors.action, fontSize: 13, fontFamily: 'monospace' },

  photoSection: { width: '100%', marginBottom: Spacing.xl },
  photoHeader:  { marginBottom: Spacing.sm },
  fieldLabel:   { color: Colors.muted, fontSize: 11, letterSpacing: 2 },
  req:          { color: Colors.action },

  photoPreview: {
    width: '100%', height: 220,
    borderRadius: Radius.lg,
    backgroundColor: Colors.surface,
    marginBottom: Spacing.sm,
  },
  retakeBtn:  { alignSelf: 'center' },
  retakeText: { color: Colors.muted, fontSize: 12, letterSpacing: 2 },

  addPhotoBtn: {
    width: '100%', height: 140,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    borderStyle: 'dashed',
    alignItems: 'center', justifyContent: 'center', gap: Spacing.sm,
  },
  addPhotoIcon: { fontSize: 36 },
  addPhotoText: { color: Colors.muted, fontSize: 12, letterSpacing: 2, textAlign: 'center' },

  completeBtn: {
    width: '100%',
    backgroundColor: Colors.action,
    borderRadius: Radius.md,
    paddingVertical: Spacing.lg,
    alignItems: 'center', justifyContent: 'center',
    minHeight: 54, marginBottom: Spacing.md,
  },
  completeBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 18, letterSpacing: 4 },
  disabled:        { opacity: 0.4 },

  cancelBtn:  { paddingVertical: Spacing.sm },
  cancelText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },

  // Camera
  cameraContainer: { flex: 1, backgroundColor: '#000' },
  camera:          { flex: 1 },
  cornerTL: { ...cornerBase, top: 16, left: 16, borderTopWidth: CBORDER, borderLeftWidth: CBORDER },
  cornerTR: { ...cornerBase, top: 16, right: 16, borderTopWidth: CBORDER, borderRightWidth: CBORDER },
  cornerBL: { ...cornerBase, bottom: 120, left: 16, borderBottomWidth: CBORDER, borderLeftWidth: CBORDER },
  cornerBR: { ...cornerBase, bottom: 120, right: 16, borderBottomWidth: CBORDER, borderRightWidth: CBORDER },
  cameraControls: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: 120, backgroundColor: 'rgba(0,0,0,0.6)',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.xl,
  },
  shutterBtn:  { width: 72, height: 72, borderRadius: 36, borderWidth: 4, borderColor: Colors.action, alignItems: 'center', justifyContent: 'center' },
  shutterInner:{ width: 56, height: 56, borderRadius: 28, backgroundColor: Colors.action },
  skipBtn:     { position: 'absolute', right: Spacing.xl },
  skipText:    { color: Colors.muted, fontSize: 13, letterSpacing: 2 },

  // Center states
  center:     { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },
  errorTitle: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, letterSpacing: 3, marginBottom: Spacing.sm },
  errorSub:   { color: Colors.muted, fontSize: 14, textAlign: 'center', marginBottom: Spacing.xl },
  btn:        { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  btnText:    { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },

  doneIcon: { fontSize: 64, color: '#22C55E', marginBottom: Spacing.lg },
  doneText: { fontFamily: Fonts.heading, color: '#22C55E', fontSize: 24, letterSpacing: 4 },
});
