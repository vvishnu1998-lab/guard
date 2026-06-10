// Web-only polygon math used by the SET GEOFENCE modal.
// Mirrors the server-side payload shape ({lat,lng} objects) — no GeoJSON.
// Keep this file framework-free so it stays trivially testable.

export type LatLng = { lat: number; lng: number };

const EARTH_R_M = 6371000;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return EARTH_R_M * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function centroidOf(polygon: LatLng[]): LatLng {
  const lat = polygon.reduce((s, p) => s + p.lat, 0) / polygon.length;
  const lng = polygon.reduce((s, p) => s + p.lng, 0) / polygon.length;
  return { lat, lng };
}

/** Max distance from centre to any vertex, rounded up to nearest 10 m.
 *  Used as the default radius when admin draws a polygon — preserves the
 *  GPS-drift fallback path in validateAtSite. */
export function boundingRadiusMeters(centre: LatLng, polygon: LatLng[]): number {
  if (polygon.length === 0) return 0;
  const max = Math.max(...polygon.map((p) => haversineMeters(centre, p)));
  return Math.ceil(max / 10) * 10;
}

/** Standard "do two segments cross?" using orientation test. */
function segmentsCross(a: LatLng, b: LatLng, c: LatLng, d: LatLng): boolean {
  const ccw = (p: LatLng, q: LatLng, r: LatLng) =>
    (r.lng - p.lng) * (q.lat - p.lat) > (q.lng - p.lng) * (r.lat - p.lat);
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}

/** True if any pair of non-adjacent edges of the closed polygon cross. */
export function isSelfIntersecting(polygon: LatLng[]): boolean {
  const n = polygon.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      // Skip adjacent edges (share a vertex) — they don't "cross" each other.
      if (j === i || j === (i + 1) % n || (j + 1) % n === i) continue;
      const c = polygon[j];
      const d = polygon[(j + 1) % n];
      if (segmentsCross(a, b, c, d)) return true;
    }
  }
  return false;
}

/** True when the polygon was almost certainly produced by the legacy
 *  circlePolygon() helper (16 equal-radius vertices around a centre).
 *  Used to decide the modal's default mode when re-opening an existing
 *  fence — circle-synth → default to Radius mode, real polygon → Draw. */
export function looksLikeCircleSynth(polygon: LatLng[]): boolean {
  // === BUG 2 DIAGNOSTIC — TEMPORARY ============================================
  /* eslint-disable no-console */
  console.log('[geofence.looksLikeCircleSynth] called with:', {
    isArray: Array.isArray(polygon),
    length: polygon?.length,
    typeofPolygon: typeof polygon,
    first: polygon?.[0],
  });
  /* eslint-enable no-console */
  // === END DIAGNOSTIC ==========================================================
  if (polygon.length !== 16) {
    /* eslint-disable no-console */
    console.log('[geofence.looksLikeCircleSynth] early-returning false (length !== 16):', polygon.length);
    /* eslint-enable no-console */
    return false;
  }
  const centre = centroidOf(polygon);
  const distances = polygon.map((p) => haversineMeters(centre, p));
  const max = Math.max(...distances);
  const min = Math.min(...distances);
  /* eslint-disable no-console */
  console.log('[geofence.looksLikeCircleSynth] distance variance:', { max, min, ratio: max === 0 ? 'div0' : (max - min) / max });
  /* eslint-enable no-console */
  if (max === 0) return false;
  return (max - min) / max < 0.05;
}

/** N-point circle polygon — kept here so the modal can call it from either
 *  mode (radius → synth, draw → no-op). Same math as the existing inline
 *  helper in sites/page.tsx — moved into a shared module. */
export function circlePolygon(
  lat: number,
  lng: number,
  radiusM: number,
  points = 16
): LatLng[] {
  const coords: LatLng[] = [];
  const latR = lat * (Math.PI / 180);
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos(latR));
  for (let i = 0; i < points; i++) {
    const angle = (2 * Math.PI * i) / points;
    coords.push({
      lat: lat + dLat * Math.cos(angle),
      lng: lng + dLng * Math.sin(angle),
    });
  }
  return coords;
}
