'use client';
/**
 * Live map panel for /admin/live-status.
 *
 * Loaded via next/dynamic({ ssr: false }) from the page — Leaflet touches
 * `window` on import, so an SSR import breaks the Next build. Same contract
 * as components/GeofenceMapEditor.tsx, which is the only other Leaflet
 * consumer in this app.
 *
 * Deliberately does NOT import leaflet-draw: this panel is read-only, and
 * pulling the draw plugin in would ship its CSS and edit toolbar to every
 * admin loading the live-status page.
 *
 * Also deliberately does NOT carry GeofenceMapEditor's L.Icon.Default
 * URL fix. That patch exists because webpack mangles the default marker
 * PNG paths — it is only needed by <Marker>, and every layer here is a
 * vector (Polygon / Circle / CircleMarker), so no icon is ever requested.
 *
 * Every field this component reads off the API is optional or nullable.
 * Vercel and Railway never deploy simultaneously, so the web half can be
 * live against an API that predates `last_accuracy_m` /
 * `last_location_mocked` (admin.ts live-guards) — those render as "—" and
 * the MOCKED badge stays hidden rather than throwing.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  MapContainer, TileLayer, Polygon as LPolygon, Circle, CircleMarker, Marker, Popup, useMap,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { computeLateness, isPingStale, PING_STALE_MINUTES } from '../../lib/lateness';
import { hasUsablePolygon, hasUsableCircle, type LatLng } from '../../lib/siteFence';

export type { LatLng };

/** Structural subset of the page's LiveGuard — anything wider is assignable. */
export interface LiveMapGuard {
  id:                    string;
  name:                  string;
  badge_number:          string;
  site_name:             string;
  clocked_in_at:         string;
  last_lat:              number | null;
  last_lng:              number | null;
  last_ping_at:          string | null;
  last_report_at:        string | null;
  has_violation:         boolean;
  last_accuracy_m?:      number | null;
  last_location_mocked?: boolean | null;
  /** Whichever of ping / clock-in supplied last_lat/last_lng. Optional so an
   *  API predating the fallback still renders — there, a pin can only have
   *  come from a ping, so the undefined case reads as 'ping'. */
  last_position_at?:     string | null;
  last_position_source?: 'ping' | 'clock_in' | null;
}

/** Structural subset of GET /api/sites. Geofence fields are LEFT JOINed
 *  server-side (routes/sites.ts), so every one of them is null on a site
 *  that has never had a fence drawn. */
export interface LiveMapSite {
  id:                   string;
  name:                 string;
  center_lat?:          number | null;
  center_lng?:          number | null;
  radius_meters?:       number | null;
  polygon_coordinates?: LatLng[] | null;
}

/** Structural subset of the page's Breach. */
export interface LiveMapBreach {
  id:             string;
  violation_lat:  number;
  violation_lng:  number;
  guard_name:     string;
  badge_number:   string;
  site_name:      string;
  occurred_at:    string;
  is_resolved:    boolean;
  /** IANA zone of the site, for the EXITED time on a site-anchored badge. */
  site_timezone?: string;
  /**
   * Provenance of violation_lat/lng (schema_v65). 'site' means those
   * coordinates ARE the fence centre and locate the post, not the guard.
   * Optional, and undefined is treated as 'site' — during a web-ahead-of-API
   * window the source is unknown, and an unknown source must never be drawn
   * as a position.
   */
  position_source?: 'site' | 'background' | 'foreground' | null;
}

interface Props {
  guards:   LiveMapGuard[];
  sites:    LiveMapSite[];
  breaches: LiveMapBreach[];
  /**
   * Imperatively fly the viewport here. Referential equality matters —
   * pass a fresh object literal per fly request so clicking the same row
   * twice moves the map both times. Mirrors GeofenceMapEditor's FlyTo.
   */
  focus: LatLng | null;
  /** Pin click — the page scrolls the matching table row into view. */
  onGuardSelect: (guardId: string) => void;
  loading: boolean;
}

// Brand palette (docs/03-UX-DESIGN.md §1.1). Cyan is the geofence, gold is
// the "needs attention but not yet a breach" state, red is a live breach.
const FENCE_CYAN    = '#00C8FF';
const PIN_VIOLATION = '#EF4444';
const PIN_STALE     = '#C9A84C';
const PIN_OK        = '#22C55E';
const NAVY          = '#0B1526';

const SF_FALLBACK: LatLng = { lat: 37.7749, lng: -122.4194 };

function hasCoords(g: LiveMapGuard): boolean {
  return Number.isFinite(g.last_lat) && Number.isFinite(g.last_lng);
}

/** The instant last_lat/last_lng was measured, whichever source gave it.
 *  Falls back to the ping timestamp for an API predating the field. */
function positionAt(g: LiveMapGuard): string | null {
  return g.last_position_at ?? g.last_ping_at;
}

/** A clock-in point is a position, but it is not a check-in — it is where
 *  the guard was when the shift started and says nothing about now. Drawn
 *  hollow so it is never mistaken for a live fix. */
function isClockInPin(g: LiveMapGuard): boolean {
  return g.last_position_source === 'clock_in';
}

/** Staleness now measures the POSITION, not the ping: a clock-in-only guard
 *  goes gold 35 minutes in, which is the honest reading — nothing has
 *  confirmed their whereabouts since. */
function pinColour(g: LiveMapGuard): string {
  if (g.has_violation) return PIN_VIOLATION;
  if (isPingStale(positionAt(g))) return PIN_STALE;
  return PIN_OK;
}

/** HH:MM as read AT THE SITE. Without an explicit zone this would render in
 *  whatever zone the admin's browser is in, so a 22:35 exit in California
 *  reads 11:05 the next morning in India — the same bug fmtBreachTime on the
 *  page was written to fix. */
function fmtSiteTime(iso: string, timeZone?: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '--:--';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit',
  }).format(new Date(t));
}

/**
 * "EXITED HH:MM" as a Leaflet divIcon. A divIcon carries our own markup and
 * never touches Leaflet's default marker PNGs, so this stays clear of the
 * webpack icon-path problem GeofenceMapEditor has to patch around.
 * iconAnchor puts the tip of the badge on the coordinate.
 */
function exitBadgeIcon(hhmm: string): L.DivIcon {
  return L.divIcon({
    className: 'livemap-exit-badge',
    html: `<span>EXITED ${hhmm}</span>`,
    iconSize:   [96, 20],
    iconAnchor: [48, 22],
  });
}

/** Undefined source is treated as 'site'. A ring asserts "the guard was
 *  HERE"; on an unknown provenance that assertion is unsupported, and the
 *  whole point of this column is that the map stopped making it. */
function isSiteAnchored(b: LiveMapBreach): boolean {
  return (b.position_source ?? 'site') === 'site';
}


/** "2h 05m ago". Safe in render: this component never server-renders
 *  (ssr: false), so a wall-clock read cannot cause a hydration mismatch. */
function ago(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m ago`;
}

function clockTime(iso: string | null): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
  }).format(new Date(t));
}

/**
 * Fit the viewport to every fence and pin — ONCE. The guards array is a new
 * reference on every 30 s poll, so without the ref this would yank the
 * viewport back from wherever the admin panned to, twice a minute.
 */
function FitOnce({ bounds }: { bounds: L.LatLngBounds | null }) {
  const map  = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !bounds || !bounds.isValid()) return;
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 17 });
    done.current = true;
  }, [bounds, map]);
  return null;
}

/** Same reference-identity trigger as GeofenceMapEditor's FlyTo. */
function FlyTo({ point }: { point: LatLng | null }) {
  const map = useMap();
  useEffect(() => {
    if (point) map.flyTo([point.lat, point.lng], 17, { duration: 0.8 });
  }, [point, map]);
  return null;
}

/**
 * Leaflet builds popup chrome imperatively, outside React's tree, so
 * Tailwind classes on our JSX never reach the wrapper or the tip. The
 * `.livemap` scope keeps this off every other Leaflet surface in the app
 * (the SET GEOFENCE editor keeps its default light popups).
 */
const POPUP_CSS = `
.livemap .leaflet-container { background: ${NAVY}; }
.livemap .leaflet-popup-content-wrapper,
.livemap .leaflet-popup-tip {
  background: #0F1E35; color: #E5E7EB; border: 1px solid #1A3050;
  box-shadow: 0 8px 24px rgba(0,0,0,0.45);
}
.livemap .leaflet-popup-content-wrapper { border-radius: 0.5rem; }
.livemap .leaflet-popup-content { margin: 0.75rem 0.875rem; }
.livemap .leaflet-popup-close-button { color: #6B7280; }
.livemap .leaflet-popup-close-button:hover { color: #E5E7EB; }
.livemap .leaflet-control-attribution {
  background: rgba(11,21,38,0.75); color: #6B7280; font-size: 10px;
}
.livemap .leaflet-control-attribution a { color: #9CA3AF; }
.livemap .livemap-exit-badge { background: none; border: 0; }
.livemap .livemap-exit-badge span {
  display: inline-block; white-space: nowrap;
  background: rgba(127,29,29,0.95); border: 1px solid #EF4444; border-radius: 4px;
  color: #FECACA; font-size: 10px; letter-spacing: 0.12em; font-weight: 700;
  padding: 2px 6px; transform: translateX(-50%); margin-left: 48px;
}
`;

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-gray-500 text-[10px] tracking-widest shrink-0 w-[74px]">{label}</span>
      <span className="text-gray-300 text-xs">{children}</span>
    </div>
  );
}

export default function LiveMap({ guards, sites, breaches, focus, onGuardSelect, loading }: Props) {
  const fenced      = useMemo(() => sites.filter((s) => hasUsablePolygon(s.polygon_coordinates) || hasUsableCircle(s)), [sites]);
  const pinned      = useMemo(() => guards.filter(hasCoords), [guards]);
  const unlocated   = useMemo(() => guards.filter((g) => !hasCoords(g)), [guards]);
  const openBreach  = useMemo(() => breaches.filter((b) => !b.is_resolved &&
    Number.isFinite(b.violation_lat) && Number.isFinite(b.violation_lng)), [breaches]);

  const bounds = useMemo(() => {
    const pts: [number, number][] = [];
    for (const s of fenced) {
      if (hasUsablePolygon(s.polygon_coordinates)) {
        for (const v of s.polygon_coordinates) pts.push([v.lat, v.lng]);
      } else {
        // Circle-only fence. toBounds() takes the box SIDE in metres, so a
        // radius r needs 2r to enclose the circle.
        const b = L.latLng(s.center_lat as number, s.center_lng as number)
          .toBounds((s.radius_meters as number) * 2);
        pts.push([b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]);
      }
    }
    for (const g of pinned)     pts.push([g.last_lat as number, g.last_lng as number]);
    for (const b of openBreach) pts.push([b.violation_lat, b.violation_lng]);
    return pts.length ? L.latLngBounds(pts) : null;
  }, [fenced, pinned, openBreach]);

  // MapContainer reads center/zoom once, at mount, before any data has
  // landed — FitOnce does the real framing as soon as bounds exist.
  const initialCentre = bounds?.getCenter() ?? SF_FALLBACK;

  const handlePinClick = useCallback(
    (id: string) => () => onGuardSelect(id),
    [onGuardSelect],
  );

  return (
    <div className="space-y-2">
      <style>{POPUP_CSS}</style>
      <div className="livemap relative w-full h-[300px] md:h-[420px] rounded-xl overflow-hidden border border-[#1A3050]">
        <MapContainer
          center={[initialCentre.lat, initialCentre.lng]}
          zoom={11}
          scrollWheelZoom
          style={{ height: '100%', width: '100%' }}
        >
          {/* OpenStreetMap standard, identical to GeofenceMapEditor — see
              the swap history there. CARTO's free tier started stamping
              "API KEY REQUIRED" across every tile (2026-09-03). */}
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
            maxZoom={19}
          />

          <FitOnce bounds={bounds} />
          <FlyTo point={focus} />

          {/* Fences first so pins and breach rings stack above them. */}
          {fenced.map((s) => (
            <Fragment key={s.id}>
              {hasUsablePolygon(s.polygon_coordinates) && (
                <LPolygon
                  positions={s.polygon_coordinates.map((v) => [v.lat, v.lng] as [number, number])}
                  pathOptions={{ color: FENCE_CYAN, weight: 2, fillColor: FENCE_CYAN, fillOpacity: 0.15 }}
                />
              )}
              {hasUsableCircle(s) && (
                <Circle
                  center={[s.center_lat as number, s.center_lng as number]}
                  radius={s.radius_meters as number}
                  pathOptions={{ color: FENCE_CYAN, weight: 1.5, fill: false, dashArray: '6 6', opacity: 0.7 }}
                />
              )}
            </Fragment>
          ))}

          {openBreach.map((b) => {
            const siteAnchored = isSiteAnchored(b);
            const popup = (
              <Popup>
                <div className="min-w-[190px]">
                  <p className="text-red-400 text-[10px] tracking-widest font-bold mb-1">OPEN BREACH</p>
                  <p className="text-gray-100 text-sm font-semibold">{b.guard_name}</p>
                  <p className="text-gray-500 font-mono text-[11px] pb-1">{b.badge_number} · {b.site_name}</p>
                  <Field label="OCCURRED">{clockTime(b.occurred_at)} · {ago(b.occurred_at)}</Field>
                  <Field label="MARKER">
                    {siteAnchored
                      ? 'post boundary — the guard\u2019s position at exit was not reported'
                      : b.position_source === 'background'
                        ? 'device fix, background task'
                        : 'device fix, app in use'}
                  </Field>
                </div>
              </Popup>
            );

            // SITE-ANCHORED. violation_lat/lng here IS the fence centre the
            // app registered — the OS region monitor hands the Exit handler
            // region.latitude/longitude, not a device fix. Anchoring the
            // badge at those coordinates is therefore exact AND shows the
            // fence as the app knew it, which is better than looking up the
            // current fence: an admin who moved the boundary mid-shift has
            // not moved the boundary the handset is still watching.
            //
            // Rendered as a labelled badge, never a ring: a ring says "the
            // guard was here", and that is the claim this coordinate cannot
            // support. The label says what is actually known — that they
            // left, and when.
            if (siteAnchored) {
              return (
                <Marker
                  key={`breach-${b.id}`}
                  position={[b.violation_lat, b.violation_lng]}
                  icon={exitBadgeIcon(fmtSiteTime(b.occurred_at, b.site_timezone))}
                >
                  {popup}
                </Marker>
              );
            }

            // A real device fix — draw it as a position, which is what it is.
            return (
              <CircleMarker
                key={`breach-${b.id}`}
                center={[b.violation_lat, b.violation_lng]}
                radius={13}
                pathOptions={{ color: PIN_VIOLATION, weight: 3, fill: false }}
              >
                {popup}
              </CircleMarker>
            );
          })}

          {pinned.map((g) => (
            <CircleMarker
              key={g.id}
              center={[g.last_lat as number, g.last_lng as number]}
              radius={8}
              // Hollow = clock-in point (a stale start-of-shift fix), filled
              // = a ping the guard actually submitted. Colour carries urgency
              // in both cases; fill carries confidence.
              pathOptions={isClockInPin(g)
                ? { color: pinColour(g), weight: 3, fill: true, fillColor: NAVY, fillOpacity: 0.85 }
                : { color: NAVY, weight: 2, fillColor: pinColour(g), fillOpacity: 0.95 }}
              eventHandlers={{ click: handlePinClick(g.id) }}
            >
              <Popup>
                <div className="min-w-[210px] space-y-1">
                  <p className="text-gray-100 text-sm font-semibold">{g.name}</p>
                  <p className="text-gray-500 font-mono text-[11px] pb-1">{g.badge_number} · {g.site_name}</p>
                  <Field label="CLOCKED IN">{clockTime(g.clocked_in_at)}</Field>
                  <Field label="POSITION">
                    <span className={isClockInPin(g) ? 'text-amber-300' : 'text-gray-300'}>
                      {isClockInPin(g) ? 'clock-in' : 'ping'} {clockTime(positionAt(g))}
                    </span>
                    <span className={isPingStale(positionAt(g)) ? 'text-amber-400' : 'text-gray-500'}>
                      {' · '}{ago(positionAt(g))}
                    </span>
                  </Field>
                  <Field label="LAST PING">
                    {computeLateness(g.last_ping_at, [0, 30]).display}
                  </Field>
                  <Field label="ACCURACY">
                    {Number.isFinite(g.last_accuracy_m)
                      ? `±${Math.round(g.last_accuracy_m as number)} m`
                      : '—'}
                    {/* `=== true` on purpose: an API that predates the column
                        sends undefined, and undefined must not accuse anyone. */}
                    {g.last_location_mocked === true && (
                      <span className="ml-2 px-1.5 py-0.5 rounded bg-red-900/60 border border-red-700 text-red-300 text-[10px] tracking-widest font-bold">
                        MOCKED
                      </span>
                    )}
                  </Field>
                  <Field label="LAST RPT">{computeLateness(g.last_report_at, [0]).display}</Field>
                  <Field label="STATUS">
                    {g.has_violation
                      ? <span className="text-red-400 text-[10px] tracking-widest font-bold">VIOLATION</span>
                      : <span className="text-green-400 text-[10px] tracking-widest">OK</span>}
                  </Field>
                </div>
              </Popup>
            </CircleMarker>
          ))}
        </MapContainer>

        {/* Empty state sits over the fences rather than replacing them —
            knowing which posts exist is useful even with nobody on duty.
            pointer-events-none so the map underneath stays draggable. */}
        {!loading && guards.length === 0 && (
          <div className="absolute inset-0 z-[500] flex items-center justify-center pointer-events-none">
            <span className="bg-[#0B1526]/85 border border-[#1A3050] rounded-lg px-4 py-2 text-gray-400 text-xs tracking-widest">
              No guards currently on duty
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-x-4 gap-y-1 text-[10px] tracking-widest">
        <div className="flex items-center gap-3 text-gray-500">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: PIN_OK }} />ON POST
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: PIN_STALE }} />
            PING &gt; {PING_STALE_MINUTES}M
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ background: PIN_VIOLATION }} />BREACH
          </span>
          <span className="flex items-center gap-1.5">
            <span
              className="w-2 h-2 rounded-full border-2"
              style={{ borderColor: PIN_STALE, background: NAVY }}
            />CLOCK-IN POINT
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-0 border-t-2 border-dashed" style={{ borderColor: FENCE_CYAN }} />GEOFENCE
          </span>
        </div>
        {unlocated.length > 0 && (
          <p className="text-gray-600">
            NO LOCATION YET: {unlocated.map((g) => `${g.name} (${g.badge_number})`).join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}
