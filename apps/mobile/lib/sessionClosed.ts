/**
 * Shared handler for the server's 409 SESSION_CLOSED.
 *
 * /locations/ping, /locations/clock-in-verification and
 * /tasks/instances/:id/complete reject submissions against a shift_session
 * whose clocked_out_at is set (api commit b703902). The usual cause is the
 * autoCompleteShifts cron closing the session at scheduled_end while the app
 * was backgrounded — the app has no channel to learn that on its own.
 *
 * The copy was never the problem: ApiError.message already carries the
 * server's sentence. The problem is STATE. After a 409 the app still believes
 * the shift is active — activeSession cached, CLOCK OUT still offered, the
 * native geofence region still armed — and the guard is parked on a ping
 * camera or a task form belonging to a shift that ended.
 *
 * Why refreshFromServer() rather than clearing the store directly:
 *
 *   A 409 proves THIS session is closed. It does not prove the guard has no
 *   session — they may have already clocked into a new one (a handoff rotates
 *   sessions mid-shift). Only /shifts/active-session can answer that, and
 *   refreshFromServer is exactly that question. Clearing directly would be
 *   guessing, and guessing wrong tears down geofence monitoring on a LIVE
 *   shift: silent, safety-relevant, and invisible until a real breach goes
 *   unreported.
 *
 *   The tradeoff is refreshFromServer's deliberate silent-fail: on 5xx or a
 *   dropped connection it keeps cached state, so the region stays armed and a
 *   stale exit could still fire. That failure mode is a redundant
 *   notification. The direct-clear failure mode is lost monitoring. Preferring
 *   the noisy failure over the unsafe one is the whole reason for this choice.
 *
 * When the server does confirm the session is gone, refreshFromServer clears
 * activeSession, which flips the dependency of the geofence effect in
 * app/_layout.tsx. That effect takes its `if (!activeSession)` branch and runs
 * stopBackgroundLocation() plus the SecureStore purge of active_session_id /
 * active_geofence / geofence_state — so the region is unregistered and the
 * background task loses the inputs it needs to fire again. That teardown is
 * also what narrows the stale-exit notification bug: any 409 from ping or task
 * completion disarms a region that would otherwise keep alerting.
 */
import { Alert } from 'react-native';
import { router } from 'expo-router';
import * as Sentry from '@sentry/react-native';
import { ApiError } from './apiClient';
import { useShiftStore } from '../store/shiftStore';

/** Narrowing type guard so call sites read as one line. */
export function isSessionClosed(err: unknown): err is ApiError {
  return err instanceof ApiError && err.code === 'SESSION_CLOSED';
}

/**
 * Repair local state, tell the guard, and route them somewhere coherent.
 *
 * `where` identifies the calling screen in the Sentry breadcrumb. Deliberately
 * a breadcrumb and NOT captureException: a shift ending while the guard has a
 * form open is expected behaviour, not a crash. Same treatment PING_OFF_POST
 * already gets in ping/photo.tsx.
 *
 * Awaits the refresh so the store is settled before we navigate; home then
 * renders post-shift state rather than briefly showing a stale CLOCK OUT.
 */
export async function handleSessionClosed(err: ApiError, where: string): Promise<void> {
  Sentry.addBreadcrumb({
    category: 'session_closed',
    message: `SESSION_CLOSED surfaced at ${where}`,
    level: 'warning',
    data: { clocked_out_at: err.details.clocked_out_at ?? null },
  });

  // Server-authoritative reconciliation. Has its own try/catch and keeps
  // cached state on failure, so this cannot throw into the caller's catch.
  await useShiftStore.getState().refreshFromServer();

  // err.message is the server's own sentence ("This shift has already ended.
  // …"). clocked_out_at is available in err.details but deliberately not
  // rendered — formatting it correctly needs the SITE's timezone, which this
  // screen does not have, and a wrong time is worse than no time.
  Alert.alert(
    'Shift Ended',
    err.message,
    [{ text: 'OK', onPress: () => router.replace('/(tabs)/home') }],
    { cancelable: false },
  );
}
