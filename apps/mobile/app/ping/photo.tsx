/**
 * GPS + Photo Ping (Section 5.4 — on-hour pings)
 * Rear camera. Posts location ping + photo to API.
 *
 * Note: the 7-day photo retention POLICY (Section 11.4 — retain_as_evidence
 * exemption, enforced server-side in retention.ts / nightlyPurge.ts) still
 * applies; only the guard-facing banner was removed (batch/mobile-11).
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
import { Alert } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import CameraCapture, { CapturedPhoto } from '../../components/CameraCapture';
import { useShiftStore }   from '../../store/shiftStore';
import { apiClient, ApiError } from '../../lib/apiClient';
import { isSessionClosed, handleSessionClosed } from '../../lib/sessionClosed';
import { uploadToS3 }      from '../../lib/uploadToS3';
import { currentPingWindow } from '../../lib/pingSchedule';
import {
  dismissWindowNotifications,
  outstandingPingWindow,
  confirmationMessage,
} from '../../lib/pingFollowUp';
import { guardMessage } from '../../lib/errorCopy';

/** POST /locations/ping. `already_recorded` means the window already had a
 *  ping and the server returned the incumbent instead of adding a second
 *  (schema_v49 uq_location_pings_session_window). */
interface PingSubmitResponse {
  status: 'recorded' | 'already_recorded';
  ping:   { id: string } | null;
}

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

      // 2) Submit directly — pings are deliberately NOT offline-queued, so
      //    a failure throws to the catch below and the guard sees it.
      //    Queueing them would need a client-supplied capture timestamp
      //    first: pinged_at is stamped server-side at INSERT, so a replay
      //    twenty minutes after the fact would be graded twenty minutes
      //    late against its window and fabricate a lateness that never
      //    happened. schema_v49's idempotency does not fix that.
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
      const result = await apiClient.post<PingSubmitResponse>('/locations/ping', {
        shift_session_id: activeSession.id,
        latitude:         photo.latitude,
        longitude:        photo.longitude,
        accuracy:         photo.accuracy ?? 30, // T2-H — server expands fence by (radius + accuracy + 50m safety)
        ping_type:        'gps_photo',
        photo_url:        public_url,
        window_label:     windowLabel ?? undefined,
        // Shadow capture (Wave 1) — recorded server-side, never evaluated.
        // Optional: absent or malformed becomes NULL and the ping proceeds.
        ...photo.signals,
      });
      // 200 already_recorded is SUCCESS, not an error: the window was
      // already answered, so the server declined to add a second row and
      // returned the incumbent. The guard did stand at the post and take
      // the photo — treating that as a failure would push them to retry a
      // submission that can never land. It is still not a fresh ping, and
      // the confirmation says so rather than claiming one.
      const recorded = result?.status !== 'already_recorded';
      console.log(`[ping] submit complete (${result?.status ?? 'recorded'})`);
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

      // Clear the delivered OS notification(s) for the window just
      // answered. Nothing in this app has ever called a dismissal API, so
      // a banner for an answered window sat in Notification Center until
      // the guard swiped it. Non-fatal by construction.
      await dismissWindowNotifications(satisfied);

      // Ask the SERVER what is still owed rather than guessing locally —
      // the client cannot see which earlier windows are unresolved, and
      // "you're all caught up" has to be true when we say it.
      const outstanding = await outstandingPingWindow();

      // Confirmation now names the window and what remains, instead of
      // "Photo and location saved." A guard who backfills 17:00 at 17:39
      // needs to be told that 17:30 is still open — the old copy left him
      // to infer it, and the PING NOW tile stays live by design after a
      // backfill (see markWindowPinged above).
      Alert.alert(
        recorded ? 'Ping Submitted' : 'Already Recorded',
        confirmationMessage({
          window:   satisfied ?? null,
          wasLate:  Boolean(windowLabel),
          recorded,
          outstanding,
        }),
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
      // The window this screen was opened for is not one the server will
      // accept — either it is not a window of this shift at all, or it
      // has not started yet. Both mean the app is holding a stale or
      // wrong label (a deep-link from an old notification, a shift that
      // was rescheduled under the guard, a device clock well ahead).
      // Retrying the camera cannot fix it, so route home for a fresh
      // read of the schedule instead of leaving them on a dead screen.
      if (err instanceof ApiError && err.code === 'PING_WINDOW_INVALID') {
        const notYetOpen = err.details?.reason === 'not_yet_open';
        Sentry.addBreadcrumb({
          category: 'ping_wizard',
          message:  'PING_WINDOW_INVALID surfaced',
          level:    'warning',
          data: { window_label: windowLabel, reason: err.details?.reason },
        });
        Alert.alert(
          'Ping Window Unavailable',
          notYetOpen
            ? `The ${windowLabel ?? 'requested'} window hasn't started yet. It will open on schedule — nothing has been lost.`
            : `The ${windowLabel ?? 'requested'} window isn't part of this shift. Open the app fresh and use PING NOW.`,
          [{ text: 'OK', onPress: () => router.replace('/active-shift') }],
        );
        return;
      }
      Sentry.addBreadcrumb({
        category: 'ping_wizard',
        message: 'submit / capture failed',
        level: 'error',
        data: { error: err?.message ?? String(err) },
      });
      Sentry.captureException(err, { extra: { where: 'ping.photo.capture' } });
      Alert.alert('Ping Failed', guardMessage(err, 'Could not submit your ping. Try again before the window closes.', 'ping.submit'));
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
    />
  );
}
