/** Ray-casting point-in-polygon — mirrors server-side implementation (Section 11.3) */
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
 * Ping type logic (Section 11.7)
 * Clock-in ping is always gps_photo regardless of time.
 */
export function getPingType(minutesSinceClockIn: number): 'gps_photo' | 'gps_only' {
  if (minutesSinceClockIn === 0) return 'gps_photo';
  if (minutesSinceClockIn % 60 === 0) return 'gps_photo';
  if (minutesSinceClockIn % 30 === 0) return 'gps_only';
  return 'gps_only';
}
