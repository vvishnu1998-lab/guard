/**
 * Safety margin added to the radius fallback. Mirrors SAFETY_MARGIN_M in
 * apps/api/src/services/geofence.ts — keep the two in step.
 */
export const GEOFENCE_SAFETY_MARGIN_M = 20;

/**
 * A polygon is only usable at three or more vertices — two points describe a
 * line, not an area, and ray-casting against it is meaningless. Mirrors the
 * server's `polygonPresent = polygon.length >= 3`, and also absorbs the
 * null/undefined the API sends for a site whose polygon was never drawn.
 */
export function hasUsablePolygon(
  polygon: { lat: number; lng: number }[] | null | undefined
): polygon is { lat: number; lng: number }[] {
  return Array.isArray(polygon) && polygon.length >= 3;
}

/** Ray-casting point-in-polygon — mirrors server-side implementation (Section 11.3) */
export function isPointInPolygon(
  point: { lat: number; lng: number },
  polygon: { lat: number; lng: number }[] | null | undefined
): boolean {
  // Previously threw `Cannot read property 'length' of null` here. The server
  // is protected from the same bug by an Array.isArray guard at its call site;
  // this function had none, and mobile calls it directly with a cached
  // pendingShift.geofence that can carry a null polygon.
  if (!hasUsablePolygon(polygon)) return false;
  let inside = false;
  const { lat: px, lng: py } = point;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lat, yi = polygon[i].lng;
    const xj = polygon[j].lat, yj = polygon[j].lng;
    const intersect =
      yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Haversine distance in meters */
export function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Is the guard inside the site's fence?
 *
 * Mirrors the server's decision in apps/api/src/services/geofence.ts, which is
 * the authority — this is only a client-side pre-flight so the guard gets
 * immediate feedback instead of a round trip.
 *
 * Polygon present  → polygon test, unchanged from before.
 * Polygon absent   → radius alone, exactly the server's no-polygon path:
 *                    distance <= radius + accuracy + safety margin. The server
 *                    allows on `polygonOk || radiusOk`, so with no polygon the
 *                    radius check is the whole decision on both sides.
 *
 * Deliberately does NOT fail closed. A site whose polygon was never drawn is a
 * configuration gap, not evidence the guard is off-site; blocking them here
 * would strand a guard who is standing in the right place, and the server will
 * still reject them if they genuinely are not. A false block — or the crash
 * this replaces — is worse than deferring to the authority.
 */
export function isInsideGeofence(
  point: { lat: number; lng: number },
  fence: {
    polygon_coordinates: { lat: number; lng: number }[] | null | undefined;
    center_lat: number;
    center_lng: number;
    radius_meters: number;
  },
  accuracyM: number
): boolean {
  if (hasUsablePolygon(fence.polygon_coordinates)) {
    return isPointInPolygon(point, fence.polygon_coordinates);
  }
  const distance = haversineDistance(point.lat, point.lng, fence.center_lat, fence.center_lng);
  return distance <= fence.radius_meters + Math.max(0, accuracyM) + GEOFENCE_SAFETY_MARGIN_M;
}

/**
 * Ping type logic (Section 11.7)
 * Clock-in ping is always gps_photo regardless of time.
 */
export function getPingType(minutesSinceClockIn: number): 'gps_photo' | 'gps_only' {
  if (minutesSinceClockIn === 0) return 'gps_photo';
  if (minutesSinceClockIn % 60 === 0) return 'gps_photo';
  if (minutesSinceClockIn % 30 === 0) return 'gps_only';
  return 'gps_only';
}
