/**
 * Background GPS task — runs every 2-3 minutes while a shift is active.
 *
 * On every location tick:
 *   1. Computes geofence containment (Haversine pre-check, then polygon).
 *   2. Transitions state INSIDE ↔ OUTSIDE persisted in SecureStore so we only
 *      fire one notification per "left → returned" cycle (no spam on jitter).
 *   3. On a fresh INSIDE → OUTSIDE transition: schedule a local notification
 *      AND POST /api/locations/violation (which inserts a notification row
 *      server-side for the Notifications tab + alerts admins).
 *
 * Started by the root layout when the guard has an active shift + the shift's
 * geofence is known; stopped on clock-out.
 */
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import { isPointInPolygon, haversineDistance } from '../utils/geofence';

export const BACKGROUND_LOCATION_TASK = 'GUARD_BACKGROUND_LOCATION';

const GEOFENCE_STATE_KEY = 'geofence_state'; // 'inside' | 'outside'

interface TaskData {
  locations: Location.LocationObject[];
}

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody<TaskData>) => {
  if (error) { console.error('[bg-location]', error); return; }

  const location = data.locations?.[0];
  if (!location) return;

  const { latitude: lat, longitude: lng } = location.coords;

  const { default: SecureStore } = await import('expo-secure-store');
  const [raw, sessionId, accessToken, prevState] = await Promise.all([
    SecureStore.getItemAsync('active_geofence'),
    SecureStore.getItemAsync('active_session_id'),
    SecureStore.getItemAsync('guard_access_token'),
    SecureStore.getItemAsync(GEOFENCE_STATE_KEY),
  ]);
  if (!raw || !sessionId || !accessToken) return;

  let geofence;
  try { geofence = JSON.parse(raw); }
  catch { return; }

  // Fast Haversine pre-check (cheap), then precise polygon (only when needed)
  const approxDist = haversineDistance(lat, lng, geofence.center_lat, geofence.center_lng);
  const likelyOutside = approxDist > geofence.radius_meters;
  const insidePolygon = !likelyOutside || isPointInPolygon({ lat, lng }, geofence.polygon_coordinates);
  const nowOutside = !insidePolygon;

  const nextState = nowOutside ? 'outside' : 'inside';
  if (nextState === prevState) return;          // no transition → nothing to do
  await SecureStore.setItemAsync(GEOFENCE_STATE_KEY, nextState);

  if (!nowOutside) return;                       // INSIDE → don't push, just record the transition

  // ── INSIDE → OUTSIDE: fire local push + server POST ──────────────────────
  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Outside post boundary',
      body:  "You've left the permitted radius. Return to the post.",
      sound: 'default',
      data:  { type: 'geofence_breach', sessionId },
    },
    trigger: null,                               // fire immediately
  }).catch((err) => console.warn('[bg-location] local notification failed:', err));

  const apiUrl = process.env.EXPO_PUBLIC_API_URL;
  if (!apiUrl) return;
  try {
    await fetch(`${apiUrl}/api/locations/violation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ shift_session_id: sessionId, latitude: lat, longitude: lng }),
    });
  } catch (err) {
    console.error('[bg-location] Failed to post violation', err);
  }
});

export async function startBackgroundLocation() {
  const { status } = await Location.requestBackgroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Background location permission denied');

  const alreadyRunning = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (alreadyRunning) return;

  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 150_000,                       // 2.5 minutes
    distanceInterval: 50,                        // or every 50m
    foregroundService: {
      notificationTitle: 'NetraOps — Shift active',
      notificationBody:  'Monitoring location for geofence compliance.',
      notificationColor: '#00C8FF',
    },
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
  });
}

export async function stopBackgroundLocation() {
  const isRegistered = await Location.hasStartedLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  if (isRegistered) {
    await Location.stopLocationUpdatesAsync(BACKGROUND_LOCATION_TASK);
  }
}
