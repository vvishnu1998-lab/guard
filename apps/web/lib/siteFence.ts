/**
 * Geofence helpers over the rows GET /api/sites returns.
 *
 * Deliberately Leaflet-free and in lib/, not beside LiveMap.tsx. These are
 * pure functions, but importing them from the map component would pull that
 * module — and with it `import L from 'leaflet'` — into the server bundle,
 * defeating the `ssr: false` dynamic import and failing the build with
 * "ReferenceError: window is not defined" at prerender. That is not
 * hypothetical: it is what happened when siteFenceCentre first lived there.
 */

export interface LatLng { lat: number; lng: number }

/** The geofence half of a site row. Every field optional: all four are
 *  LEFT JOINed server-side and are null on a site with no fence drawn, and
 *  absent entirely on an API predating them. */
export interface SiteFenceLike {
  name:                 string;
  center_lat?:          number | null;
  center_lng?:          number | null;
  radius_meters?:       number | null;
  polygon_coordinates?: LatLng[] | null;
}

/**
 * A polygon is only usable with three or more finite vertices. Mirrors the
 * mobile guard in apps/mobile/utils/geofence.ts — polygon_coordinates is a
 * jsonb column with no shape constraint, so a malformed value has to be
 * survivable rather than fatal.
 */
export function hasUsablePolygon(p: LatLng[] | null | undefined): p is LatLng[] {
  return Array.isArray(p) && p.length >= 3 &&
    p.every((v) => Number.isFinite(v?.lat) && Number.isFinite(v?.lng));
}

export function hasUsableCircle(s: SiteFenceLike): boolean {
  return Number.isFinite(s.center_lat) && Number.isFinite(s.center_lng) &&
    Number.isFinite(s.radius_meters) && (s.radius_meters as number) > 0;
}

/**
 * Centre of a site's fence, by name. Used by the live-status row click: a
 * guard with no coordinates at all still belongs somewhere, and their post
 * is the honest place to send the viewport.
 *
 * Matching on name because neither /api/admin/live-guards nor
 * /api/admin/violations returns site_id — live-guards selects s.name only.
 * Names are unique per company in practice, and a collision moves the
 * viewport to the wrong same-named site, which is no worse than the no-op
 * it replaces.
 */
export function siteFenceCentre(sites: SiteFenceLike[], siteName: string): LatLng | null {
  const s = sites.find((x) => x.name === siteName);
  if (!s) return null;
  if (Number.isFinite(s.center_lat) && Number.isFinite(s.center_lng)) {
    return { lat: s.center_lat as number, lng: s.center_lng as number };
  }
  if (hasUsablePolygon(s.polygon_coordinates)) {
    const n = s.polygon_coordinates.length;
    return {
      lat: s.polygon_coordinates.reduce((a, v) => a + v.lat, 0) / n,
      lng: s.polygon_coordinates.reduce((a, v) => a + v.lng, 0) / n,
    };
  }
  return null;
}
