/** Ray-casting point-in-polygon check (Section 11.3) */
export function isPointInPolygon(
  point: { lat: number; lng: number },
  polygon: { lat: number; lng: number }[]
): boolean {
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

/** Haversine distance in meters — used for approximate radius pre-check on mobile */
export function haversineDistance(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const R = 6371000; // Earth radius in meters
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Server-side geofence validation for clock-in and clock-in-verification.
 *
 * Closes the audit hole where the mobile client could send
 * `is_within_geofence: true` regardless of actual position. The server now
 * computes the answer itself from the supplied lat/lng/accuracy against the
 * site's polygon and center+radius.
 *
 * Decision rule (per Q11): allowed if inside polygon OR inside
 * (center+radius + accuracy + 50m safety margin). Polygon-first because
 * polygons handle irregular sites accurately; haversine fallback covers
 * sites whose polygon hasn't been remapped yet (legacy sites).
 *
 * Returns enough context for the call site to log a one-line reject record
 * — site, distance, accuracy, reason — without re-querying the geofence.
 */
export interface GeofenceValidationInput {
  lat: number;
  lng: number;
  accuracy_m: number;
}

export interface GeofenceValidationResult {
  allowed: boolean;
  /** Which check(s) decided the outcome. On reject, the set of checks that
   *  failed (polygon-only fences emit 'radius' since polygon isn't applicable). */
  reason: 'polygon' | 'radius' | 'both' | 'no_geofence';
  distance_m: number | null;
  fence_radius_m: number | null;
  polygon_present: boolean;
}

/** Anything with a pg-compatible `.query()` — accepts `pool` or a `PoolClient`. */
type Queryable = {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }>;
};

const SAFETY_MARGIN_M = 50;

export async function validateClockInGeofence(
  point: GeofenceValidationInput,
  siteId: string,
  db: Queryable,
): Promise<GeofenceValidationResult> {
  const r = await db.query(
    `SELECT polygon_coordinates, center_lat, center_lng, radius_meters
     FROM site_geofence WHERE site_id = $1`,
    [siteId],
  );
  const fence = r.rows[0];

  // No fence row at all → legacy site, allow. The admin must define a fence
  // before this site becomes audit-compliant.
  if (!fence) {
    return {
      allowed: true,
      reason: 'no_geofence',
      distance_m: null,
      fence_radius_m: null,
      polygon_present: false,
    };
  }

  const polygon: { lat: number; lng: number }[] = Array.isArray(fence.polygon_coordinates)
    ? fence.polygon_coordinates
    : [];
  const polygonPresent = polygon.length >= 3;

  const polygonOk = polygonPresent && isPointInPolygon({ lat: point.lat, lng: point.lng }, polygon);

  const distance = haversineDistance(point.lat, point.lng, fence.center_lat, fence.center_lng);
  const radiusBudget = fence.radius_meters + Math.max(0, point.accuracy_m) + SAFETY_MARGIN_M;
  const radiusOk = distance <= radiusBudget;

  if (polygonOk || radiusOk) {
    return {
      allowed: true,
      reason: polygonOk && radiusOk ? 'both' : polygonOk ? 'polygon' : 'radius',
      distance_m: distance,
      fence_radius_m: fence.radius_meters,
      polygon_present: polygonPresent,
    };
  }

  return {
    allowed: false,
    reason: polygonPresent ? 'both' : 'radius',
    distance_m: distance,
    fence_radius_m: fence.radius_meters,
    polygon_present: polygonPresent,
  };
}
