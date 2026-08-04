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
 * Server-side geofence validation, shared across every endpoint that
 * accepts a lat/lng/accuracy from a guard: clock-in, clock-in-verification,
 * ping (Wave A — T1-A/B), clock-out, task completion, report submission
 * (Wave A T2-A/C/D).
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

// Reduced from 50 m → 20 m (Phase 1A, Q1). The old 50 m stack made a 30 m
// fence effectively ~95 m once a typical 15 m accuracy reading landed:
// 30 + 15 + 50 = 95. During the 2026-07-12 walk-test the guard read as
// "within" while standing 73 m from a 30 m post. 20 m keeps a small
// safety cushion for GPS jitter without turning the fence into a
// three-times-bigger virtual one.
const SAFETY_MARGIN_M = 20;

/**
 * Per-checkpoint radius validation for checkpoint scans (schema_v44).
 * Standalone by design — checkpoints are radius-only anchors linked by a
 * guard's scan, so no polygon logic and no DB access: the caller fetches
 * the site_checkpoints row and passes the anchor in.
 *
 * Budget = radius_meters + scan accuracy + anchor (link) accuracy. The
 * anchor is not ground truth — it is itself a GPS estimate captured at
 * link time (site_checkpoints.link_accuracy_m). Both positions estimate
 * the same physical point, so BOTH error terms belong in the budget:
 * in the 2026-08-04 prod walk-test a guard standing AT a tag anchored
 * at ±7.9 m was rejected at 19.1 m vs a budget of 13.9 m because the
 * anchor's error was ignored. link_accuracy_m may be NULL on rows
 * anchored before it was recorded — treated as 0, never fail-closed.
 *
 * Checkpoints deliberately do NOT carry validateAtSite's fixed
 * SAFETY_MARGIN_M: that 20 m cushion is proportionate on 60 m+ site
 * fences but at checkpoint scale it dwarfs the admin's setting — a
 * 10 m checkpoint became an effective ~36 m circle and accepted a
 * 33.7 m scan in the same walk-test. The two accuracy terms already
 * scale tolerance to real signal conditions; an admin who sets 10 m
 * must get approximately 10 m. Do not "restore consistency" with
 * validateAtSite here — the scales are different on purpose.
 *
 * Returns distance_m for the persisted admin drift column plus every
 * budget component so the route can log a reject without recomputing.
 *
 * Fails closed on bad anchors (null/non-finite lat/lng/radius — e.g. an
 * unlinked checkpoint that slipped past the route layer) with
 * distance_m: Infinity rather than throwing.
 */
export function validateAtCheckpoint(
  point: GeofenceValidationInput,
  checkpoint: { lat: number; lng: number; radius_meters: number; link_accuracy_m?: number | null },
): {
  allowed: boolean;
  distance_m: number;
  budget_m: number;
  radius_m: number;
  scan_accuracy_m: number;
  link_accuracy_m: number;
} {
  const scanAccuracy =
    Number.isFinite(point.accuracy_m) && point.accuracy_m > 0 ? point.accuracy_m : 0;
  const linkAccuracy =
    typeof checkpoint?.link_accuracy_m === 'number' &&
    Number.isFinite(checkpoint.link_accuracy_m) &&
    checkpoint.link_accuracy_m > 0
      ? checkpoint.link_accuracy_m
      : 0;
  const budget = checkpoint?.radius_meters + scanAccuracy + linkAccuracy;

  if (
    !Number.isFinite(checkpoint?.lat) ||
    !Number.isFinite(checkpoint?.lng) ||
    !Number.isFinite(checkpoint?.radius_meters) ||
    !Number.isFinite(point.lat) ||
    !Number.isFinite(point.lng)
  ) {
    return {
      allowed: false,
      distance_m: Infinity,
      budget_m: Number.isFinite(budget) ? budget : Infinity,
      radius_m: Number.isFinite(checkpoint?.radius_meters) ? checkpoint.radius_meters : Infinity,
      scan_accuracy_m: scanAccuracy,
      link_accuracy_m: linkAccuracy,
    };
  }

  const distance = haversineDistance(point.lat, point.lng, checkpoint.lat, checkpoint.lng);
  return {
    allowed: distance <= budget,
    distance_m: distance,
    budget_m: budget,
    radius_m: checkpoint.radius_meters,
    scan_accuracy_m: scanAccuracy,
    link_accuracy_m: linkAccuracy,
  };
}

export async function validateAtSite(
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
