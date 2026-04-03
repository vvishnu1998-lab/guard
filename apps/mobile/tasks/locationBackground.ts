/**
 * Background GPS task (Section 5.3 / 11.3)
 * Runs every 2-3 minutes silently while shift is active.
 * Device-side geofence check — fires violation POST immediately if outside boundary.
 * Does NOT wait for the 30-min audit ping.
 */
import * as TaskManager from 'expo-task-manager';
import * as Location from 'expo-location';
import { isPointInPolygon, haversineDistance } from '../utils/geofence';

export const BACKGROUND_LOCATION_TASK = 'GUARD_BACKGROUND_LOCATION';

interface TaskData {
  locations: Location.LocationObject[];
}

TaskManager.defineTask(BACKGROUND_LOCATION_TASK, async ({ data, error }: TaskManager.TaskManagerTaskBody<TaskData>) => {
  if (error) { console.error('[bg-location]', error); return; }

  const location = data.locations?.[0];
  if (!location) return;

  const { latitude: lat, longitude: lng } = location.coords;

  // Read cached geofence + session from SecureStore
  const { default: SecureStore } = await import('expo-secure-store');
  const raw = await SecureStore.getItemAsync('active_geofence');
  const sessionId = await SecureStore.getItemAsync('active_session_id');
  const accessToken = await SecureStore.getItemAsync('access_token');
  if (!raw || !sessionId || !accessToken) return;

  const geofence = JSON.parse(raw);

  // Fast Haversine pre-check, then precise polygon
  const approxDist = haversineDistance(lat, lng, geofence.center_lat, geofence.center_lng);
  const likelyOutside = approxDist > geofence.radius_meters;
  const outside = likelyOutside && !isPointInPolygon({ lat, lng }, geofence.polygon_coordinates);

  if (outside) {
    const apiUrl = await SecureStore.getItemAsync('api_url');
    try {
      await fetch(`${apiUrl}/api/locations/violation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ shift_session_id: sessionId, latitude: lat, longitude: lng }),
      });
    } catch (err) {
      console.error('[bg-location] Failed to post violation', err);
    }
  }
});

export async function startBackgroundLocation() {
  const { status } = await Location.requestBackgroundPermissionsAsync();
  if (status !== 'granted') throw new Error('Background location permission denied');

  await Location.startLocationUpdatesAsync(BACKGROUND_LOCATION_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: 150000,   // 2.5 minutes
    distanceInterval: 50,   // or every 50m
    foregroundService: {
      notificationTitle: 'Guard — Shift Active',
      notificationBody: 'Monitoring location for geofence compliance.',
      notificationColor: '#F59E0B',
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
