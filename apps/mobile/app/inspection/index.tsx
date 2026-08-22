/**
 * Vehicle Inspection — /inspection (schema_v48, batch/mobile-11)
 *
 * PROMPTED, NOT BLOCKING: reached from the inspection card on
 * active-shift. The guard can leave at any point and ping / report /
 * scan meanwhile — nothing else gates on this flow.
 *
 * State lives SERVER-SIDE, not in a local cache: the row is created at
 * vehicle selection (POST /inspections, idempotent per session) and each
 * of the five photos PATCHes its own slot the moment its upload lands,
 * as does the typed odometer. On every mount this screen hydrates from
 * GET /inspections/session/:id — a guard who captured two angles and
 * force-quit resumes at 2/5 from the server, on any device.
 *
 * Slots are FIXED: front, rear, driver_side, passenger_side, odometer.
 * completed_at is stamped by the SERVER when all five photos + reading
 * are present; this client only reads it.
 */
import { useCallback, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView,
  TextInput, Image, Alert, ActivityIndicator,
} from 'react-native';
import { router } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import * as Sentry from '@sentry/react-native';
import CameraCapture, { CapturedPhoto } from '../../components/CameraCapture';
import { useShiftStore } from '../../store/shiftStore';
import { apiClient, ApiError } from '../../lib/apiClient';
import { isSessionClosed, handleSessionClosed } from '../../lib/sessionClosed';
import { uploadToS3 } from '../../lib/uploadToS3';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';
import { guardMessage } from '../../lib/errorCopy';

interface Vehicle {
  id:            string;
  label:         string;
  plate:         string | null;
  make_model:    string | null;
  odometer_unit: 'mi' | 'km';
}

export interface Inspection {
  id:                       string;
  shift_session_id:         string;
  vehicle_id:               string;
  odometer_reading:         number | null;
  photo_front_url:          string | null;
  photo_rear_url:           string | null;
  photo_driver_side_url:    string | null;
  photo_passenger_side_url: string | null;
  photo_odometer_url:       string | null;
  completed_at:             string | null;
  // present on GET /inspections/session/:id
  vehicle_label?:            string;
  vehicle_plate?:            string | null;
  vehicle_make_model?:       string | null;
  odometer_unit?:            'mi' | 'km';
}

type PhotoSlot =
  | 'photo_front_url'
  | 'photo_rear_url'
  | 'photo_driver_side_url'
  | 'photo_passenger_side_url'
  | 'photo_odometer_url';

const SLOTS: Array<{ key: PhotoSlot; label: string; hint: string }> = [
  { key: 'photo_front_url',          label: 'FRONT',          hint: 'Stand in front of the vehicle, full body in frame' },
  { key: 'photo_rear_url',           label: 'REAR',           hint: 'Stand behind the vehicle, full body in frame' },
  { key: 'photo_driver_side_url',    label: 'DRIVER SIDE',    hint: 'Full driver side, door to door' },
  { key: 'photo_passenger_side_url', label: 'PASSENGER SIDE', hint: 'Full passenger side, door to door' },
  { key: 'photo_odometer_url',       label: 'ODOMETER',       hint: 'Dashboard close-up — the reading must be legible' },
];

export function photosDone(i: Inspection): number {
  return SLOTS.filter((s) => i[s.key]).length;
}

type Stage =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'pick'; vehicles: Vehicle[]; changing: boolean }   // changing = re-pick on existing row
  | { kind: 'checklist' }
  | { kind: 'camera'; slot: PhotoSlot };

export default function InspectionScreen() {
  const { activeSession } = useShiftStore();
  const [stage,      setStage]      = useState<Stage>({ kind: 'loading' });
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [odoInput,   setOdoInput]   = useState('');
  const [odoSaving,  setOdoSaving]  = useState(false);
  const [busyVehicle, setBusyVehicle] = useState(false);

  const sessionId = activeSession?.id ?? null;

  const hydrate = useCallback(async () => {
    if (!sessionId) {
      setStage({ kind: 'error', message: 'No active shift. Clock in first.' });
      return;
    }
    try {
      const row = await apiClient.get<Inspection>(`/inspections/session/${sessionId}`);
      setInspection(row);
      if (row.odometer_reading !== null) setOdoInput(String(row.odometer_reading));
      setStage({ kind: 'checklist' });
    } catch (err: any) {
      if (err instanceof ApiError && err.status === 404) {
        // No row yet — start at the vehicle picker.
        await loadVehicles(false);
        return;
      }
      Sentry.captureException(err, { extra: { where: 'inspection.hydrate' } });
      setStage({ kind: 'error', message: guardMessage(err, 'Could not load the inspection. Go back and try again.', 'inspection.load') });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Hydrate from the server every time the screen gains focus — this is
  // the restart-survival mechanism (6.4): state is never trusted locally.
  useFocusEffect(
    useCallback(() => {
      hydrate();
    }, [hydrate]),
  );

  async function loadVehicles(changing: boolean) {
    try {
      const vehicles = await apiClient.get<Vehicle[]>('/vehicles/mine');
      setStage({ kind: 'pick', vehicles, changing });
    } catch (err: any) {
      Sentry.captureException(err, { extra: { where: 'inspection.loadVehicles' } });
      setStage({ kind: 'error', message: guardMessage(err, 'Could not load the vehicle roster. Go back and try again.', 'inspection.vehicles') });
    }
  }

  async function pickVehicle(v: Vehicle) {
    if (busyVehicle || !sessionId) return;
    setBusyVehicle(true);
    try {
      if (inspection) {
        // Change-vehicle on an existing (incomplete) inspection.
        const row = await apiClient.patch<Inspection>(`/inspections/${inspection.id}`, { vehicle_id: v.id });
        setInspection({ ...row, vehicle_label: v.label, vehicle_plate: v.plate, vehicle_make_model: v.make_model, odometer_unit: v.odometer_unit });
      } else {
        const row = await apiClient.post<Inspection>('/inspections', {
          shift_session_id: sessionId,
          vehicle_id:       v.id,
        });
        setInspection({ ...row, vehicle_label: v.label, vehicle_plate: v.plate, vehicle_make_model: v.make_model, odometer_unit: v.odometer_unit });
      }
      setStage({ kind: 'checklist' });
    } catch (err: any) {
      if (isSessionClosed(err)) { await handleSessionClosed(err, 'inspection.pickVehicle'); return; }
      Alert.alert('Could not select vehicle', guardMessage(err, 'Could not select that vehicle. Try again.', 'inspection.select-vehicle'));
    } finally {
      setBusyVehicle(false);
    }
  }

  async function saveOdometer() {
    if (!inspection || odoSaving) return;
    const parsed = Number(odoInput);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 9_999_999) {
      Alert.alert('Invalid reading', 'Odometer must be a whole number (0–9,999,999).');
      return;
    }
    setOdoSaving(true);
    try {
      const row = await apiClient.patch<Inspection>(`/inspections/${inspection.id}`, { odometer_reading: parsed });
      setInspection((prev) => ({ ...prev, ...row }));
    } catch (err: any) {
      if (isSessionClosed(err)) { await handleSessionClosed(err, 'inspection.odometer'); return; }
      Alert.alert('Could not save odometer', guardMessage(err, 'Could not save the odometer reading. Try again.', 'inspection.odometer'));
    } finally {
      setOdoSaving(false);
    }
  }

  // Camera pipeline for one slot: upload → PATCH the slot → back to the
  // checklist with the server's row (which may now carry completed_at).
  async function submitSlotPhoto(slot: PhotoSlot, photo: CapturedPhoto, setStatus: (msg: string) => void): Promise<void | 'reset'> {
    if (!inspection) return 'reset';
    try {
      setStatus('UPLOADING…');
      const { public_url } = await uploadToS3(photo.uri, 'inspection');
      setStatus('SAVING…');
      const row = await apiClient.patch<Inspection>(`/inspections/${inspection.id}`, { [slot]: public_url });
      setInspection((prev) => ({ ...prev, ...row }));
      setStage({ kind: 'checklist' });
      return;
    } catch (err: any) {
      if (isSessionClosed(err)) { await handleSessionClosed(err, 'inspection.photo'); return; }
      Sentry.captureException(err, { extra: { where: 'inspection.submitSlotPhoto', slot } });
      Alert.alert('Photo not saved', guardMessage(err, 'Could not save the photo. Try again.', 'inspection.photo'));
      return 'reset';
    }
  }

  // ── Camera stage ───────────────────────────────────────────────────────
  if (stage.kind === 'camera') {
    const slotMeta = SLOTS.find((s) => s.key === stage.slot)!;
    return (
      <CameraCapture
        facing="back"
        gps="none"
        confirm
        breadcrumbCategory="vehicle_inspection"
        breadcrumbPrefix={slotMeta.label.toLowerCase()}
        headerTitle="VEHICLE INSPECTION"
        headerSubtitle={slotMeta.label}
        instruction={slotMeta.hint}
        onCaptured={(photo, setStatus) => submitSlotPhoto(stage.slot, photo, setStatus)}
        onCancel={() => setStage({ kind: 'checklist' })}
        showTimestamp
      />
    );
  }

  // ── Loading / error ────────────────────────────────────────────────────
  if (stage.kind === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={Colors.action} size="large" />
      </View>
    );
  }
  if (stage.kind === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorTitle}>VEHICLE INSPECTION</Text>
        <Text style={styles.errorSub}>{stage.message}</Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => router.back()}>
          <Text style={styles.primaryBtnText}>GO BACK</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Vehicle picker ─────────────────────────────────────────────────────
  if (stage.kind === 'pick') {
    return (
      <ScrollView style={styles.bg} contentContainerStyle={styles.scroll}>
        <Text style={styles.step}>VEHICLE INSPECTION</Text>
        <Text style={styles.title}>{stage.changing ? 'CHANGE VEHICLE' : 'SELECT YOUR VEHICLE'}</Text>
        {stage.vehicles.length === 0 ? (
          <Text style={styles.emptyText}>
            No vehicles are set up for this site yet. Ask your administrator to add the
            vehicle roster, then return here.
          </Text>
        ) : (
          stage.vehicles.map((v) => (
            <TouchableOpacity
              key={v.id}
              style={styles.vehicleRow}
              disabled={busyVehicle}
              onPress={() => pickVehicle(v)}
            >
              <View style={styles.vehicleInfo}>
                <Text style={styles.vehicleLabel}>{v.label}</Text>
                <Text style={styles.vehicleSub}>
                  {v.plate ?? 'No plate'}{v.make_model ? ` · ${v.make_model}` : ''}
                </Text>
              </View>
              <Text style={styles.vehicleChevron}>›</Text>
            </TouchableOpacity>
          ))
        )}
        <TouchableOpacity style={styles.cancelBtn} onPress={() => (stage.changing ? setStage({ kind: 'checklist' }) : router.back())}>
          <Text style={styles.cancelText}>{stage.changing ? 'KEEP CURRENT VEHICLE' : 'NOT NOW'}</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // ── Checklist ──────────────────────────────────────────────────────────
  if (!inspection) return null; // checklist without a row can't happen; belt for TS
  const done = photosDone(inspection);
  const complete = inspection.completed_at !== null;
  const unit = inspection.odometer_unit ?? 'mi';

  return (
    <ScrollView style={styles.bg} contentContainerStyle={styles.scroll}>
      <Text style={styles.step}>VEHICLE INSPECTION</Text>
      <Text style={styles.title}>{complete ? 'INSPECTION COMPLETE' : `${done} OF 5 PHOTOS`}</Text>

      <View style={styles.vehicleCard}>
        <View style={styles.vehicleInfo}>
          <Text style={styles.vehicleLabel}>{inspection.vehicle_label ?? 'Vehicle'}</Text>
          <Text style={styles.vehicleSub}>
            {inspection.vehicle_plate ?? 'No plate'}
            {inspection.vehicle_make_model ? ` · ${inspection.vehicle_make_model}` : ''}
          </Text>
        </View>
        {!complete && (
          <TouchableOpacity onPress={() => loadVehicles(true)} disabled={busyVehicle}>
            <Text style={styles.changeLink}>CHANGE</Text>
          </TouchableOpacity>
        )}
      </View>

      {SLOTS.map(({ key, label }) => {
        const url = inspection[key];
        return (
          <View key={key} style={styles.slotRow}>
            {url ? (
              <Image source={{ uri: url }} style={styles.slotThumb} resizeMode="cover" />
            ) : (
              <View style={[styles.slotThumb, styles.slotThumbEmpty]}>
                <Text style={styles.slotThumbEmptyText}>—</Text>
              </View>
            )}
            <View style={styles.slotInfo}>
              <Text style={styles.slotLabel}>{label}</Text>
              <Text style={url ? styles.slotDone : styles.slotPending}>
                {url ? '✓ CAPTURED' : 'NOT CAPTURED'}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.slotBtn}
              onPress={() => setStage({ kind: 'camera', slot: key })}
            >
              <Text style={styles.slotBtnText}>{url ? 'RETAKE' : 'CAPTURE'}</Text>
            </TouchableOpacity>
          </View>
        );
      })}

      {/* Typed odometer — the photo proves it, the number makes it queryable */}
      <View style={styles.odoCard}>
        <Text style={styles.odoLabel}>ODOMETER READING ({unit.toUpperCase()})</Text>
        <View style={styles.odoRow}>
          <TextInput
            style={styles.odoInput}
            keyboardType="number-pad"
            value={odoInput}
            onChangeText={(t) => setOdoInput(t.replace(/[^0-9]/g, ''))}
            placeholder="e.g. 48213"
            placeholderTextColor={Colors.muted}
            editable={!odoSaving}
          />
          <TouchableOpacity
            style={[styles.odoSaveBtn, odoSaving && styles.disabled]}
            onPress={saveOdometer}
            disabled={odoSaving}
          >
            <Text style={styles.odoSaveText}>
              {odoSaving ? '…' : inspection.odometer_reading !== null ? 'UPDATE' : 'SAVE'}
            </Text>
          </TouchableOpacity>
        </View>
        {inspection.odometer_reading !== null && (
          <Text style={styles.odoSaved}>✓ Saved: {inspection.odometer_reading.toLocaleString()} {unit}</Text>
        )}
      </View>

      {complete ? (
        <View style={styles.completeCard}>
          <Text style={styles.completeText}>✓ ALL FIVE PHOTOS + ODOMETER RECORDED</Text>
        </View>
      ) : (
        <Text style={styles.hint}>
          You can leave and come back — progress is saved as you go.
        </Text>
      )}

      <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
        <Text style={styles.cancelText}>{complete ? 'DONE' : 'BACK TO SHIFT'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  bg:     { flex: 1, backgroundColor: Colors.structure },
  scroll: { alignItems: 'center', paddingTop: 60, paddingBottom: 48, paddingHorizontal: Spacing.lg },
  center: { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center', padding: Spacing.xl },

  step:  { color: Colors.muted, fontSize: 11, letterSpacing: 4, marginBottom: 2 },
  title: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, letterSpacing: 3, marginBottom: Spacing.lg, textAlign: 'center' },

  errorTitle: { fontFamily: Fonts.heading, color: Colors.base, fontSize: 20, letterSpacing: 3, marginBottom: Spacing.sm },
  errorSub:   { color: Colors.muted, fontSize: 14, textAlign: 'center', marginBottom: Spacing.xl },

  emptyText: { color: Colors.muted, fontSize: 14, lineHeight: 21, textAlign: 'center', marginVertical: Spacing.xl },

  vehicleRow: {
    flexDirection: 'row', alignItems: 'center',
    width: '100%', backgroundColor: Colors.surface,
    borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, marginBottom: Spacing.sm,
  },
  vehicleCard: {
    flexDirection: 'row', alignItems: 'center',
    width: '100%', backgroundColor: Colors.surface,
    borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, marginBottom: Spacing.lg,
  },
  vehicleInfo:    { flex: 1 },
  vehicleLabel:   { color: Colors.base, fontSize: 16 },
  vehicleSub:     { color: Colors.muted, fontSize: 12, marginTop: 2 },
  vehicleChevron: { color: Colors.action, fontSize: 24 },
  changeLink:     { color: Colors.action, fontSize: 12, letterSpacing: 2 },

  slotRow: {
    flexDirection: 'row', alignItems: 'center',
    width: '100%', marginBottom: Spacing.sm,
    backgroundColor: Colors.surface,
    borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.sm, gap: Spacing.sm,
  },
  slotThumb:          { width: 56, height: 56, borderRadius: Radius.sm, backgroundColor: Colors.structure },
  slotThumbEmpty:     { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: Colors.border, borderStyle: 'dashed' },
  slotThumbEmptyText: { color: Colors.muted, fontSize: 18 },
  slotInfo:    { flex: 1 },
  slotLabel:   { color: Colors.base, fontSize: 13, letterSpacing: 1 },
  slotDone:    { color: Colors.success, fontSize: 11, marginTop: 2, letterSpacing: 1 },
  slotPending: { color: Colors.muted, fontSize: 11, marginTop: 2, letterSpacing: 1 },
  slotBtn: {
    borderWidth: 1, borderColor: Colors.action, borderRadius: Radius.sm,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  slotBtnText: { color: Colors.action, fontSize: 12, letterSpacing: 2 },

  odoCard: {
    width: '100%', backgroundColor: Colors.surface,
    borderRadius: Radius.md, borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md, marginTop: Spacing.sm, marginBottom: Spacing.md,
  },
  odoLabel: { color: Colors.muted, fontSize: 11, letterSpacing: 2, marginBottom: Spacing.sm },
  odoRow:   { flexDirection: 'row', gap: Spacing.sm },
  odoInput: {
    flex: 1, backgroundColor: Colors.structure,
    borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.sm,
    color: Colors.base, fontSize: 18, fontFamily: 'monospace',
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.md,
  },
  odoSaveBtn: {
    backgroundColor: Colors.action, borderRadius: Radius.sm,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: Spacing.lg,
  },
  odoSaveText: { color: Colors.structure, fontFamily: Fonts.heading, fontSize: 14, letterSpacing: 2 },
  odoSaved:    { color: Colors.success, fontSize: 12, marginTop: Spacing.sm },

  completeCard: {
    width: '100%', borderWidth: 1, borderColor: Colors.success,
    borderRadius: Radius.md, padding: Spacing.md, marginTop: Spacing.sm,
    alignItems: 'center',
  },
  completeText: { color: Colors.success, fontSize: 13, letterSpacing: 2, textAlign: 'center' },

  hint: { color: Colors.muted, fontSize: 12, marginTop: Spacing.sm, textAlign: 'center' },

  primaryBtn:     { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  primaryBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },

  cancelBtn:  { marginTop: Spacing.lg, padding: Spacing.sm },
  cancelText: { color: Colors.muted, fontSize: 13, letterSpacing: 2 },

  disabled: { opacity: 0.5 },
});
