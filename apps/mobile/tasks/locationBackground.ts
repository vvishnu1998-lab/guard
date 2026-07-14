/**
 * Native geofencing background task — Build 34 (Phase 1B).
 *
 * Replaces the previous periodic-updates task (Location.startLocation
 * UpdatesAsync at 2.5 min OR 50 m) with the platform's native geofencing:
 * Location.startGeofencingAsync. Detection is event-driven, near-zero
 * battery, and the OS keeps the task alive across app kills.
 *
 * Platform notes:
 *   iOS   — CoreLocation region monitoring. Max 20 regions per app; we
 *           register exactly 1 (the guard's active post). Alive across
 *           app kills / device reboots (with Always-Allow granted, which
 *           _layout.tsx requests on first authenticated launch).
 *   Android — Google Play Services GeofencingClient. Requires Play
 *           Services on device (~99% coverage). Enter/Exit event latency
 *           can be 30 s – 2 min on some devices vs iOS's typical <30 s.
 *           Google recommends geofence radius >= 100 m for reliable
 *           detection; our sites are typically 30 m. If a walk-test on
 *           Android misses tight breaches, widening the fence is the
 *           lever — the server's per-request geofence check
 *           (validateAtSite, SAFETY_MARGIN_M=20) remains authoritative
 *           for accept/reject.
 *
 * Semantics:
 *   EXIT   — guard left the post. Fire local push + POST
 *            /api/locations/violation. Server-side fireBreachAlerts
 *            then handles admin email + Notifications tab row (with
 *            the Commit A 5-min per-type rate limit).
 *   ENTER  — guard returned. Fire an informational local push. We do
 *            NOT hit the server here — the server auto-resolves open
 *            violations on the next onsite ping (routes/locations.ts
 *            POST /ping). ENTER-only endpoints would just duplicate
 *            that path.
 *
 * The old inside/outside SecureStore state machine is gone — native
 * geofencing IS the state machine. Only the active session id + access
 * token are read from SecureStore now, both stamped by _layout.tsx
 * before startGeofencingAsync is called.
 */
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import * as Sentry from '@sentry/react-native';

export const GEOFENCE_TASK = 'GUARD_GEOFENCE';

interface GeofenceTaskData {
  eventType: Location.GeofencingEventType;
  region: Location.LocationRegion;
}

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody<GeofenceTaskData>) => {
  if (error) {
    console.error('[geofence]', error);
    Sentry.captureException(error, { tags: { flow: 'geofence_task' } });
    return;
  }

  const { eventType, region } = data;
  const isExit  = eventType === Location.GeofencingEventType.Exit;
  const isEnter = eventType === Location.GeofencingEventType.Enter;

  Sentry.addBreadcrumb({
    category: 'geofence',
    message: isExit ? 'exit event' : isEnter ? 'enter event' : `event ${eventType}`,
    level: 'info',
    data: { identifier: region?.identifier, lat: region?.latitude, lng: region?.longitude },
  });

  // Build 37: guard the SecureStore reads. Default keychainAccessible
  // is WHEN_UNLOCKED — reads while the phone is locked throw
  // "User interaction not allowed", and the throw would previously
  // propagate up unhandled, silently skipping BOTH the local push AND
  // the /violation POST. AFTER_FIRST_UNLOCK is applied to future writes
  // (M4), but this catch is defense-in-depth for existing installs and
  // for any read that predates the migration.
  let sessionId: string | null;
  let accessToken: string | null;
  try {
    [sessionId, accessToken] = await Promise.all([
      SecureStore.getItemAsync('active_session_id'),
      SecureStore.getItemAsync('guard_access_token'),
    ]);
  } catch (err) {
    Sentry.captureException(err, {
      tags: { flow: 'geofence_exit_securestore' },
      extra: {
        eventType: isExit ? 'exit' : isEnter ? 'enter' : `type_${eventType}`,
        region_identifier: region?.identifier,
      },
    });
    return;
  }
  if (!sessionId || !accessToken) return;

  if (isExit) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Outside post boundary',
        body:  "You've left the permitted radius. Return to the post.",
        sound: 'default',
        data:  { type: 'geofence_breach', sessionId },
      },
      trigger: null,
    }).catch((err) => console.warn('[geofence] local notification failed:', err));

    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!apiUrl) return;
    try {
      await fetch(`${apiUrl}/api/locations/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({
          shift_session_id: sessionId,
          latitude:  region.latitude,
          longitude: region.longitude,
        }),
      });
    } catch (err) {
      console.error('[geofence] Failed to post violation', err);
      Sentry.captureException(err, { tags: { flow: 'geofence_exit_post' } });
    }
    return;
  }

  if (isEnter) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Back on post',
        body:  'You are inside the permitted radius.',
        sound: 'default',
        data:  { type: 'geofence_enter', sessionId },
      },
      trigger: null,
    }).catch((err) => console.warn('[geofence] enter notification failed:', err));
    // No server call — server auto-resolves open violations on the next
    // onsite ping via POST /api/locations/ping (Commit A behavior).
  }
});

interface StartGeofenceRegion {
  center_lat: number;
  center_lng: number;
  radius_meters: number;
}

/**
 * Register the guard's active post as a single geofence region. Called
 * from _layout.tsx when activeSession + activeShift.geofence become
 * available. Idempotent — stopGeofencing first so a shift swap or a
 * geofence redefinition takes effect without a stale region lingering.
 */
export async function startBackgroundLocation(region?: StartGeofenceRegion): Promise<void> {
  if (!region) {
    Sentry.addBreadcrumb({
      category: 'geofence', message: 'start skipped — no region', level: 'warning',
    });
    return;
  }

  const { status: bg } = await Location.requestBackgroundPermissionsAsync();
  if (bg !== 'granted') throw new Error('Background location permission denied');

  // Stop before re-registering so a shift swap picks up the new region
  // cleanly (native geofencing coalesces identical registrations but
  // the identifier here is per-app, not per-shift).
  const alreadyRunning = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
  if (alreadyRunning) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK).catch(() => {});
  }

  await Location.startGeofencingAsync(GEOFENCE_TASK, [
    {
      identifier: 'active_post',
      latitude:   region.center_lat,
      longitude:  region.center_lng,
      radius:     region.radius_meters,
      notifyOnEnter: true,
      notifyOnExit:  true,
    },
  ]);
  Sentry.addBreadcrumb({
    category: 'geofence', message: 'registered', level: 'info',
    data: { center_lat: region.center_lat, center_lng: region.center_lng, radius: region.radius_meters },
  });
  // Standalone event so registration success is greppable in Sentry
  // even when no error is captured on the session. Breadcrumbs only
  // surface attached to a captured event, which meant Build 34 walk-
  // tests could not confirm registration ran without a downstream throw.
  Sentry.captureMessage('geofence registered', {
    level: 'info',
    tags: { flow: 'geofence_register' },
    extra: {
      identifier:    'active_post',
      center_lat:    region.center_lat,
      center_lng:    region.center_lng,
      radius_meters: region.radius_meters,
    },
  });
}

export async function stopBackgroundLocation(): Promise<void> {
  const running = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
  if (running) {
    await Location.stopGeofencingAsync(GEOFENCE_TASK);
    Sentry.addBreadcrumb({ category: 'geofence', message: 'unregistered', level: 'info' });
    Sentry.captureMessage('geofence unregistered', {
      level: 'info',
      tags: { flow: 'geofence_unregister' },
    });
  }
}
