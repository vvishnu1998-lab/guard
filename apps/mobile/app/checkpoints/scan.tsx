/**
 * Checkpoint Scanner (C6) — scan mode + link (setup) mode.
 *
 * Scan mode (default): guard scans a physical tag on patrol. The tag
 * identifies the checkpoint SERVER-SIDE — we never send checkpoint_id
 * on /scan. That is a security property: a client that could name its
 * own checkpoint could claim presence at one tag while scanning another.
 *
 * Link mode (?mode=link&checkpoint_id&label): guard anchors an unlinked
 * checkpoint at their current position. Here checkpoint_id IS sent —
 * the guard chose which checkpoint they are standing at.
 *
 * GPS: live read FIRST at highest accuracy (deliberately the reverse of
 * ping/photo.tsx's cached-first order — a scan is a presence proof, so a
 * stale cached fix is worse than a short wait), cached fallback, hard
 * fail if neither. The captured coords ride with the payload, so an
 * offline-queued scan replays the position from SCAN TIME, not retry time.
 *
 * Every server verdict gets its own treatment (no generic off-post toast):
 * 201 fresh / 200 duplicate / 404 unknown tag / 422 too far (anti-fraud,
 * shows label + distance from err.details) / 403 no session / offline.
 */
import { useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { CameraView, CameraType, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as Location from 'expo-location';
import { locationSignals, NO_LOCATION_SIGNALS, type LocationSignals } from '../../lib/locationSignals';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import { apiClient, ApiError } from '../../lib/apiClient';
import { useOfflineStore } from '../../store/offlineStore';
import { Colors, Spacing, Radius, Fonts } from '../../constants/theme';

const GPS_LIVE_TIMEOUT_MS = 8000;

// site_checkpoints.code_value is VARCHAR(512); the API 400s above it. A
// longer payload must NOT be truncated client-side — a truncated code
// would silently never match on future scans.
const MAX_CODE_VALUE_LEN = 512;

// Full symbology set of the installed expo-camera — the customer's
// physical tags are of unknown type; do not narrow this.
const ALL_BARCODE_TYPES = [
  'qr', 'code128', 'code39', 'code93', 'ean13', 'ean8', 'upc_a', 'upc_e',
  'codabar', 'itf14', 'datamatrix', 'pdf417', 'aztec',
] as const;

type Verdict =
  | { kind: 'scanning' }
  | { kind: 'submitting' }
  | { kind: 'success';   label: string; scanned: number; total: number }
  | { kind: 'duplicate'; label: string; scanned: number; total: number }
  | { kind: 'queued' }
  | { kind: 'linked';    label: string }
  | { kind: 'too_far';   label: string; distanceM: number; allowedM: number }
  | { kind: 'weak_gps';  accuracyM: number | null; requiredM: number }
  | { kind: 'error';     title: string; message: string; canRescan: boolean; noSession?: boolean };

interface ScanResponse {
  ok: boolean;
  duplicate: boolean;
  checkpoint_id: string;
  checkpoint_label: string;
  scanned_at: string;
  distance_m: number;
  scanned: number;
  total: number;
}

async function getScanPosition(): Promise<{ lat: number; lng: number; acc: number | null; signals: LocationSignals }> {
  try {
    const live = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Highest }),
      new Promise<null>((r) => setTimeout(() => r(null), GPS_LIVE_TIMEOUT_MS)),
    ]);
    if (live) {
      return { lat: live.coords.latitude, lng: live.coords.longitude, acc: live.coords.accuracy, signals: locationSignals(live) };
    }
  } catch (err) {
    console.warn('[checkpoint] live GPS threw:', err);
  }
  const last = await Location.getLastKnownPositionAsync().catch(() => null);
  if (last) {
    return { lat: last.coords.latitude, lng: last.coords.longitude, acc: last.coords.accuracy, signals: locationSignals(last) };
  }
  throw new Error('GPS lock failed. Move to an area with better signal and try again.');
}

export default function CheckpointScanner() {
  const [permission, requestPermission] = useCameraPermissions();
  const [verdict, setVerdict] = useState<Verdict>({ kind: 'scanning' });
  // Torch for laminated tags mounted indoors under warm low light — the
  // customer scans these at night. Default OFF; persists while open.
  const [torch, setTorch] = useState(false);
  // Ref lock flips synchronously on first detection — state alone is too
  // slow and lets a single tag double-fire onBarcodeScanned.
  const lockRef = useRef(false);

  const params = useLocalSearchParams<{ mode?: string; checkpoint_id?: string; label?: string }>();
  const linkMode = params.mode === 'link' && typeof params.checkpoint_id === 'string';
  const linkLabel = typeof params.label === 'string' ? params.label : 'checkpoint';

  const { submitCheckpointScan } = useOfflineStore();

  function rescan() {
    lockRef.current = false;
    setVerdict({ kind: 'scanning' });
  }

  function done() {
    router.replace('/active-shift');
  }

  async function onBarcode(result: BarcodeScanningResult) {
    if (lockRef.current) return;
    lockRef.current = true;
    setVerdict({ kind: 'submitting' });

    const codeValue = result.data;
    const codeType  = result.type;

    // Amendment B — link flow only: an over-length payload can never be
    // stored, so fail with a specific message instead of a generic 400.
    if (linkMode && codeValue.length > MAX_CODE_VALUE_LEN) {
      setVerdict({
        kind: 'error', title: 'TAG CODE TOO LONG',
        message: "This tag's code is too long to register. Send the code to your administrator.",
        canRescan: true,
      });
      return;
    }
    Sentry.addBreadcrumb({
      category: 'checkpoint',
      message: linkMode ? 'link scan detected' : 'scan detected',
      level: 'info',
      data: { code_type: codeType, link_mode: linkMode },
    });

    try {
      const pos = await getScanPosition();

      if (linkMode) {
        await apiClient.post(`/checkpoints/link`, {
          checkpoint_id: params.checkpoint_id,
          code_value:    codeValue,
          code_type:     codeType,
          latitude:      pos.lat,
          longitude:     pos.lng,
          accuracy:      pos.acc ?? 999, // null accuracy must not pass the 30m gate
          // Shadow capture (Wave 2). /link is the highest-leverage gate:
          // it DEFINES the anchor every future scan is measured against.
          ...pos.signals,
        });
        setVerdict({ kind: 'linked', label: linkLabel });
        return;
      }

      // Scan mode — offline-capable. Coords captured above ride in the
      // payload, so a queued replay submits the SCAN-TIME position.
      const outcome = await submitCheckpointScan({
        code_value: codeValue,
        latitude:   pos.lat,
        longitude:  pos.lng,
        accuracy:   pos.acc ?? undefined,
        // Shadow capture (Wave 2). Frozen into the queued payload at scan
        // time alongside the coords, so a replay submits the SCAN-TIME
        // verdict — it cannot become clean by replaying later.
        ...pos.signals,
      });
      if (!outcome.synced) {
        setVerdict({ kind: 'queued' });
        return;
      }
      const data = outcome.data as ScanResponse;
      if (data.duplicate) {
        setVerdict({ kind: 'duplicate', label: data.checkpoint_label, scanned: data.scanned, total: data.total });
      } else {
        setVerdict({ kind: 'success', label: data.checkpoint_label, scanned: data.scanned, total: data.total });
        setTimeout(done, 2000); // green confirmation auto-dismisses
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        const d = err.details as Record<string, any>;

        // ── BRANCH ON err.code, NEVER ON err.status ALONE ────────────────
        // Both checkpoint routes now return TWO different 422s: their own
        // fence/GPS failure, and MOCK_LOCATION_REJECTED from the Wave 2
        // gate. The link-mode branch below used to key on status alone, so
        // a mock rejection rendered as "GPS signal too weak" — the guard
        // was told to fix their signal when the real cause was a device
        // setting. Found 2026-08-22; it never reached a guard only because
        // the request failed at transport level first.
        //
        // Scan mode escaped the same fate by accident, not design: its
        // branch happened to also test `typeof d.distance_m === 'number'`
        // and the mock body carries no distance_m. Both are now guarded
        // deliberately — by code where the server sends one, and by
        // payload shape as a fallback so this screen is correct whether or
        // not the API half has deployed.
        if (err.code === 'MOCK_LOCATION_REJECTED') {
          Sentry.addBreadcrumb({
            category: 'checkpoint',
            message: 'mock location rejected',
            level: 'warning',
            data: { link_mode: linkMode },
          });
          setVerdict({
            kind: 'error', title: linkMode ? 'LINK FAILED' : 'SCAN FAILED',
            message: err.message, canRescan: true,
          });
          return;
        }

        if (!linkMode && (err.code === 'CHECKPOINT_TOO_FAR'
                          || (err.status === 422 && typeof d.distance_m === 'number'))) {
          // Anti-fraud rejection — NOT the PING_OFF_POST shape.
          Sentry.addBreadcrumb({
            category: 'checkpoint',
            message: 'scan too far',
            level: 'warning',
            data: { distance_m: d.distance_m, allowed_m: d.allowed_m },
          });
          setVerdict({
            kind: 'too_far',
            label:     String(d.checkpoint_label ?? 'the checkpoint'),
            distanceM: Math.round(d.distance_m),
            allowedM:  Math.round(d.allowed_m ?? 0),
          });
          return;
        }
        if (linkMode && (err.code === 'CHECKPOINT_LINK_GPS_WEAK'
                         || (err.status === 422 && typeof d.required_m === 'number'))) {
          setVerdict({
            kind: 'weak_gps',
            accuracyM: typeof d.accuracy_m === 'number' ? Math.round(d.accuracy_m) : null,
            requiredM: typeof d.required_m === 'number' ? d.required_m : 30,
          });
          return;
        }
        if (err.status === 403) {
          setVerdict({
            kind: 'error', title: 'NOT CLOCKED IN',
            message: 'Clock in to scan checkpoints.',
            canRescan: false, noSession: true,
          });
          return;
        }
        if (err.status === 404) {
          setVerdict({
            kind: 'error', title: linkMode ? 'CHECKPOINT NOT FOUND' : 'UNKNOWN TAG',
            message: linkMode
              ? 'This checkpoint no longer exists or belongs to another site.'
              : "This tag isn't registered at this site.",
            canRescan: !linkMode,
          });
          return;
        }
        if (err.status === 409 && linkMode) {
          // 'Already linked' vs 'tag linked to another checkpoint' mean
          // different things — surface the server's own message.
          setVerdict({ kind: 'error', title: 'CANNOT LINK', message: err.message, canRescan: false });
          return;
        }
        // Title followed the route, not the mode — a link failure read
        // "SCAN FAILED". err.message is safe here: this branch is
        // ApiError-only, so the text is server-authored copy.
        setVerdict({
          kind: 'error', title: linkMode ? 'LINK FAILED' : 'SCAN FAILED',
          message: err.message, canRescan: true,
        });
        return;
      }
      // Non-ApiError from link mode = network failure (scan mode queues
      // these inside submitCheckpointScan) or GPS failure — both retryable.
      Sentry.captureException(err, { extra: { where: 'checkpoint.scan', link_mode: linkMode } });
      setVerdict({
        kind: 'error', title: linkMode ? 'LINK FAILED' : 'SCAN FAILED',
        message: err?.message ?? 'Something went wrong. Try again.',
        canRescan: true,
      });
    }
  }

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

  const scanningActive = verdict.kind === 'scanning';

  return (
    <View style={styles.container}>
      <Text style={styles.step}>{linkMode ? 'CHECKPOINT SETUP' : 'CHECKPOINT'}</Text>
      <Text style={styles.type}>{linkMode ? `LINK: ${linkLabel.toUpperCase()}` : 'SCAN TAG'}</Text>

      <View style={styles.cameraContainer}>
        <CameraView
          style={styles.camera}
          facing={'back' as CameraType}
          enableTorch={torch}
          barcodeScannerSettings={{ barcodeTypes: [...ALL_BARCODE_TYPES] }}
          onBarcodeScanned={scanningActive ? onBarcode : undefined}
        >
          <View style={styles.cornerTL} /><View style={styles.cornerTR} />
          <View style={styles.cornerBL} /><View style={styles.cornerBR} />

          {/* Torch toggle — laminated tags in warm low light / night scans */}
          <TouchableOpacity
            style={[styles.torchBtn, torch && styles.torchBtnOn]}
            onPress={() => setTorch((t) => !t)}
            accessibilityLabel={torch ? 'Turn torch off' : 'Turn torch on'}
          >
            <Text style={styles.torchIcon}>{torch ? '🔦' : '💡'}</Text>
          </TouchableOpacity>

          {scanningActive && (
            <View style={styles.hintStrip}>
              {/* Active-scanning indicator: dense codes decode slowly — show
                  it's working so the guard holds steady instead of walking off. */}
              <View style={styles.scanIndicatorRow}>
                <ActivityIndicator size="small" color={Colors.action} />
                <Text style={styles.scanIndicatorText}>SCANNING — HOLD STEADY</Text>
              </View>
              <Text style={styles.hintText}>
                {linkMode
                  ? `Stand AT ${linkLabel} and scan its tag to anchor it here.`
                  : 'Point the camera at the checkpoint tag.'}
              </Text>
            </View>
          )}
        </CameraView>
      </View>

      {verdict.kind === 'submitting' && (
        <View style={styles.panel}>
          <Text style={styles.panelNeutralTitle}>SUBMITTING…</Text>
          <Text style={styles.panelText}>Getting GPS fix and verifying position.</Text>
        </View>
      )}

      {verdict.kind === 'success' && (
        <View style={[styles.panel, styles.panelSuccess]}>
          <Text style={styles.panelSuccessTitle}>✓ {verdict.label.toUpperCase()}</Text>
          <Text style={styles.panelText}>
            Checkpoint scanned — {verdict.scanned} of {verdict.total} this hour.
          </Text>
        </View>
      )}

      {verdict.kind === 'duplicate' && (
        <View style={styles.panel}>
          <Text style={styles.panelNeutralTitle}>{verdict.label.toUpperCase()}</Text>
          <Text style={styles.panelText}>
            Already scanned this hour — {verdict.scanned} of {verdict.total} done.
          </Text>
          <PanelButtons primary="DONE" onPrimary={done} secondary="SCAN ANOTHER" onSecondary={rescan} />
        </View>
      )}

      {verdict.kind === 'queued' && (
        <View style={styles.panel}>
          <Text style={styles.panelNeutralTitle}>SAVED OFFLINE</Text>
          <Text style={styles.panelText}>
            No connection — your scan and position were saved and will sync automatically.
          </Text>
          <PanelButtons primary="DONE" onPrimary={done} secondary="SCAN ANOTHER" onSecondary={rescan} />
        </View>
      )}

      {verdict.kind === 'linked' && (
        <View style={[styles.panel, styles.panelSuccess]}>
          <Text style={styles.panelSuccessTitle}>✓ {verdict.label.toUpperCase()} ANCHORED</Text>
          <Text style={styles.panelText}>
            Tag and location saved. Scans here now count toward patrol rounds.
          </Text>
          <PanelButtons primary="BACK TO SETUP" onPrimary={() => router.back()} />
        </View>
      )}

      {verdict.kind === 'too_far' && (
        <View style={[styles.panel, styles.panelDanger]}>
          <Text style={styles.panelDangerTitle}>TOO FAR FROM CHECKPOINT</Text>
          <Text style={styles.panelText}>
            You're {verdict.distanceM}m from {verdict.label}. Walk to the checkpoint and scan again.
          </Text>
          <Text style={styles.panelSub}>Allowed range: {verdict.allowedM}m</Text>
          <PanelButtons primary="SCAN AGAIN" onPrimary={rescan} secondary="CANCEL" onSecondary={done} />
        </View>
      )}

      {verdict.kind === 'weak_gps' && (
        <View style={[styles.panel, styles.panelWarning]}>
          <Text style={styles.panelWarningTitle}>GPS SIGNAL TOO WEAK</Text>
          <Text style={styles.panelText}>
            GPS signal too weak to anchor this checkpoint. Step into the open and try again.
          </Text>
          <Text style={styles.panelSub}>
            Accuracy: {verdict.accuracyM !== null ? `±${verdict.accuracyM}m` : 'unknown'} · Required: ±{verdict.requiredM}m
          </Text>
          <PanelButtons primary="TRY AGAIN" onPrimary={rescan} secondary="CANCEL" onSecondary={() => router.back()} />
        </View>
      )}

      {verdict.kind === 'error' && (
        <View style={[styles.panel, styles.panelDanger]}>
          <Text style={styles.panelDangerTitle}>{verdict.title}</Text>
          <Text style={styles.panelText}>{verdict.message}</Text>
          <PanelButtons
            primary={verdict.canRescan ? 'SCAN AGAIN' : verdict.noSession ? 'GO HOME' : 'BACK'}
            onPrimary={verdict.canRescan ? rescan : verdict.noSession ? () => router.replace('/(tabs)/home') : () => router.back()}
            secondary={verdict.canRescan ? 'CANCEL' : undefined}
            onSecondary={verdict.canRescan ? done : undefined}
          />
        </View>
      )}

      {scanningActive && (
        <TouchableOpacity style={styles.cancelBtn} onPress={() => router.back()}>
          <Text style={styles.cancelText}>CANCEL</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function PanelButtons({
  primary, onPrimary, secondary, onSecondary,
}: {
  primary: string; onPrimary: () => void;
  secondary?: string; onSecondary?: () => void;
}) {
  return (
    <View style={styles.btnRow}>
      {secondary && onSecondary && (
        <TouchableOpacity style={styles.btnGhost} onPress={onSecondary}>
          <Text style={styles.btnGhostText}>{secondary}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity style={styles.btnPrimary} onPress={onPrimary}>
        <Text style={styles.btnPrimaryText}>{primary}</Text>
      </TouchableOpacity>
    </View>
  );
}

const CORNER_SIZE  = 24;
const CORNER_WIDTH = 3;
const cornerBase   = { position: 'absolute' as const, width: CORNER_SIZE, height: CORNER_SIZE, borderColor: Colors.action };

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.structure, alignItems: 'center' },
  center:    { flex: 1, backgroundColor: Colors.structure, alignItems: 'center', justifyContent: 'center' },
  step:      { color: Colors.muted, fontSize: 11, letterSpacing: 4, marginTop: Spacing.xl, marginBottom: 2 },
  type:      { color: Colors.action, fontFamily: Fonts.heading, fontSize: 14, letterSpacing: 3, marginBottom: Spacing.md },

  cameraContainer: { width: '100%', height: 340 },
  camera:          { flex: 1 },
  cornerTL: { ...cornerBase, top: 16, left: 16, borderTopWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerTR: { ...cornerBase, top: 16, right: 16, borderTopWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },
  cornerBL: { ...cornerBase, bottom: 32, left: 16, borderBottomWidth: CORNER_WIDTH, borderLeftWidth: CORNER_WIDTH },
  cornerBR: { ...cornerBase, bottom: 32, right: 16, borderBottomWidth: CORNER_WIDTH, borderRightWidth: CORNER_WIDTH },

  hintStrip: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)', padding: Spacing.sm,
    gap: 4,
  },
  hintText: { color: Colors.action, fontSize: 12, textAlign: 'center' },
  scanIndicatorRow:  { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: Spacing.sm },
  scanIndicatorText: { color: Colors.base, fontSize: 11, letterSpacing: 2 },

  torchBtn: {
    position: 'absolute', top: 12, right: 12,
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1, borderColor: Colors.border,
    alignItems: 'center', justifyContent: 'center',
  },
  torchBtnOn: { borderColor: Colors.action, backgroundColor: 'rgba(0,200,255,0.25)' },
  torchIcon:  { fontSize: 20 },

  panel: {
    width: '92%',
    backgroundColor: Colors.surface,
    borderRadius: Radius.lg,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.lg,
    marginTop: Spacing.lg,
    alignItems: 'center',
    gap: Spacing.sm,
  },
  panelSuccess: { borderColor: Colors.success },
  panelDanger:  { borderColor: Colors.danger },
  panelWarning: { borderColor: Colors.warning },

  panelSuccessTitle: { color: Colors.success, fontFamily: Fonts.heading, fontSize: 18, letterSpacing: 2, textAlign: 'center' },
  panelNeutralTitle: { color: Colors.base,    fontFamily: Fonts.heading, fontSize: 18, letterSpacing: 2, textAlign: 'center' },
  panelDangerTitle:  { color: Colors.danger,  fontFamily: Fonts.heading, fontSize: 18, letterSpacing: 2, textAlign: 'center' },
  panelWarningTitle: { color: Colors.warning, fontFamily: Fonts.heading, fontSize: 18, letterSpacing: 2, textAlign: 'center' },

  panelText: { color: Colors.base, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  panelSub:  { color: Colors.muted, fontSize: 12, textAlign: 'center' },

  btnRow: { flexDirection: 'row', gap: Spacing.md, marginTop: Spacing.sm },
  btnPrimary: {
    backgroundColor: Colors.action, borderRadius: Radius.md,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
  },
  btnPrimaryText: { color: Colors.structure, fontFamily: Fonts.heading, fontSize: 14, letterSpacing: 2 },
  btnGhost: {
    borderWidth: 1, borderColor: Colors.border, borderRadius: Radius.md,
    paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
  },
  btnGhostText: { color: Colors.muted, fontFamily: Fonts.heading, fontSize: 14, letterSpacing: 2 },

  cancelBtn:  { marginTop: Spacing.lg, padding: Spacing.md },
  cancelText: { color: Colors.muted, fontSize: 12, letterSpacing: 3 },

  permTitle:   { fontFamily: Fonts.heading, color: Colors.base, fontSize: 22, marginBottom: Spacing.xl, letterSpacing: 3 },
  permBtn:     { backgroundColor: Colors.action, borderRadius: Radius.md, padding: Spacing.md },
  permBtnText: { fontFamily: Fonts.heading, color: Colors.structure, fontSize: 16, letterSpacing: 2 },
});
