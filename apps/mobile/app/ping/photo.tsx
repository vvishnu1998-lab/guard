/**
 * GPS + Photo Ping (Section 5.4 — on-hour pings)
 * Rear camera. Posts location ping + photo to API.
 * Shows 7-day photo deletion notice (Section 11.4 — retain_as_evidence exemption).
 *
 * Camera UX lives in components/CameraCapture (batch/mobile-11 rebuild —
 * full-bleed preview, instant shutter feedback, ref-based double-capture
 * lock, freeze-frame through the whole submit pipeline). This screen owns
 * the ping business logic only:
 *  - active-session gate before capture
 *  - S3 upload ('ping' context) — hard-fail, never offline-queued: a queued
 *    payload referencing a dead local file:// URI can't sync
 *  - POST /locations/ping with GPS coords from capture time
 *  - window_label backfill semantics + markWindowPinged
 *  - PING_OFF_POST / session-closed error mapping
 */
import { View, Text, StyleSheet, Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import CameraCapture, { CapturedPhoto } from '../../components/CameraCapture';
import { useShiftStore }   from '../../store/shiftStore';
import { apiClient, ApiError } from '../../lib/apiClient';
import { isSessionClosed, handleSessionClosed } from '../../lib/sessionClosed';
import { uploadToS3 }      from '../../lib/uploadToS3';
import { pingState }       from '../../lib/pingState';
import { currentPingWindow } from '../../lib/pingSchedule';
import { Colors, Spacing, Radius } from '../../constants/theme';

export default function PhotoPing() {
  const { activeSession, activeShift, markWindowPinged } = useShiftStore();
  // Missed-ping backfill window — set via deep-link from a missed_ping
  // notification tap (navigateForNotification.ts). When present, the
  // server sets submitted_late + resolves the matching missed_pings
  // row on 201. Falsy when the guard opened the screen manually.
  const { window_label } = useLocalSearchParams<{ window_label?: string }>();
  const windowLabel = typeof window_label === 'string' && window_label ? window_label : null;

  function validateBeforeCapture(): boolean {
    if (!activeSession) {
      Alert.alert(
        'No Active Shift',
        'Your shift has ended or hasn’t been clocked into yet. Pings can only be submitted while on shift.',
        [{ text: 'OK', onPress: () => router.replace('/(tabs)/home') }],
      );
      return false;
    }
    return true;
  }

  async function submit(photo: CapturedPhoto, setStatus: (msg: string) => void): Promise<void | 'reset'> {
    if (!activeSession) return 'reset'; // validated pre-capture; belt only
    try {
      // 1) Upload the photo to S3. Hard-fail on error — the API rejects
      //    file:// URLs at the photo validator, so a queued ping pointing
      //    at a local URI would silently dead-letter forever.
      setStatus('UPLOADING…');
      console.log('[ping] uploading photo to S3…');
      const { public_url } = await uploadToS3(photo.uri, 'ping');
      console.log('[ping] photo uploaded:', public_url);

      // 2) Submit directly (not via useOfflineStore.submitPing) so a
      //    failure throws to the catch below and the guard sees it.
      setStatus('SUBMITTING…');
      console.log('[ping] submitting…');
      Sentry.addBreadcrumb({
        category: 'ping_wizard',
        message: windowLabel ? 'late ping submit (missed_ping backfill)' : 'submit initiated',
        level: 'info',
        data: {
          session_id:   activeSession.id,
          accuracy_m:   photo.accuracy ? Math.round(photo.accuracy) : null,
          window_label: windowLabel ?? null,
        },
      });
      await apiClient.post('/locations/ping', {
        shift_session_id: activeSession.id,
        latitude:         photo.latitude,
        longitude:        photo.longitude,
        accuracy:         photo.accuracy ?? 30, // T2-H — server expands fence by (radius + accuracy + 50m safety)
        ping_type:        'gps_photo',
        photo_url:        public_url,
        window_label:     windowLabel ?? undefined,
      });
      console.log('[ping] submit complete');
      Sentry.addBreadcrumb({ category: 'ping_wizard', message: 'submit succeeded', level: 'info' });

      // Record which window this satisfied so the active-shift PING NOW tile
      // greys out instead of inviting a duplicate. A backfill (windowLabel
      // from a missed_ping deep-link) marks the window it backfilled, NOT the
      // current one — answering 21:00 late leaves the 22:30 tile live, which
      // is correct. With no label the ping lands in whatever window is open
      // now, so resolve that one.
      const satisfied =
        windowLabel ??
        (activeShift?.scheduled_start && activeShift?.scheduled_end
          ? (() => {
              const w = currentPingWindow({
                scheduledStart: activeShift.scheduled_start,
                scheduledEnd:   activeShift.scheduled_end,
                clockedInAt:    activeSession.clocked_in_at,
              });
              return w.status === 'open' ? w.window.label : null;
            })()
          : null);
      if (satisfied) markWindowPinged(activeSession.id, satisfied);

      pingState.suppressAlertUntil = Date.now() + 30 * 60 * 1000;
      // Confirmation to the guard (was missing — submit used to silently
      // navigate away which made guards unsure whether the ping landed).
      Alert.alert(
        'Ping Submitted',
        'Photo and location saved.',
        [{ text: 'OK', onPress: () => router.replace('/active-shift') }],
      );
      return; // stay on the freeze-frame behind the confirmation alert
    } catch (err: any) {
      console.error('[ping] submit failed:', err);
      // Shift ended under the guard (usually the autoCompleteShifts cron
      // closing the session at scheduled_end). Repairs local state, tears the
      // region down, and routes home — see lib/sessionClosed.ts.
      if (isSessionClosed(err)) {
        await handleSessionClosed(err, 'ping.photo');
        return;
      }
      // PING_OFF_POST is expected under the Commit A hybrid policy (Q8) —
      // pings prove presence, so the server 422s any offsite submission.
      // Show the user-readable copy instead of the raw enum string, and
      // return to the live camera so the guard can walk back onsite and
      // retry without re-navigating. NOT a Sentry captureException
      // (this is expected behaviour, not a bug — just a breadcrumb).
      if (err instanceof ApiError && err.code === 'PING_OFF_POST') {
        Sentry.addBreadcrumb({
          category: 'ping_wizard',
          message: 'PING_OFF_POST surfaced',
          level: 'warning',
          data: { distance_m: err.details.distance_m, accuracy_m: err.details.accuracy_m },
        });
        Alert.alert(
          'Off-post',
          'Cannot ping while off-post. Return to site to submit.',
        );
        return 'reset';
      }
      Sentry.addBreadcrumb({
        category: 'ping_wizard',
        message: 'submit / capture failed',
        level: 'error',
        data: { error: err?.message ?? String(err) },
      });
      Sentry.captureException(err, { extra: { where: 'ping.photo.capture' } });
      Alert.alert('Ping Failed', err?.message ?? 'Could not submit ping. Try again.');
      return 'reset';
    }
  }

  return (
    <CameraCapture
      facing="back"
      gps="required"
      breadcrumbCategory="ping_wizard"
      breadcrumbPrefix="ping"
      headerTitle="LOCATION PING"
      headerSubtitle="GPS + PHOTO"
      onCaptured={submit}
      validateBeforeCapture={validateBeforeCapture}
      overlayExtra={
        <View style={styles.noticeCard}>
          <Text style={styles.noticeIcon}>🗑</Text>
          <Text style={styles.noticeText}>
            Ping photos are auto-deleted after 7 days unless flagged as evidence by admin.
          </Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  noticeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    backgroundColor: 'rgba(15,25,41,0.85)', // Colors.surface over the preview
    borderRadius: Radius.md,
    borderWidth: 1, borderColor: Colors.border,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  noticeIcon: { fontSize: 18 },
  noticeText: { flex: 1, color: Colors.muted, fontSize: 12, lineHeight: 18 },
});
