'use client';
// Leaflet + leaflet-draw polygon editor for the SET GEOFENCE modal.
// Loaded via next/dynamic({ ssr: false }) from the parent — Leaflet touches
// window on import. Server payload shape (lat/lng objects, not GeoJSON
// [lng,lat] arrays) matches what validateAtSite already expects, so no API
// change is needed.

import { useEffect, useMemo, useRef, useCallback } from 'react';
import { MapContainer, TileLayer, FeatureGroup, Polygon as LPolygon, Marker, useMap } from 'react-leaflet';
import { EditControl } from 'react-leaflet-draw';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet-draw/dist/leaflet.draw.css';

// Leaflet's default marker icon URLs break under webpack — re-point them at
// the CDN copy so the centre marker renders.
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

export type LatLng = { lat: number; lng: number };

interface Props {
  initialPolygon: LatLng[];
  initialCentre: LatLng | null;
  centreOverride: LatLng | null;
  onChange: (polygon: LatLng[]) => void;
}

const SF_FALLBACK: LatLng = { lat: 37.7749, lng: -122.4194 };

// Refit the map viewport when the polygon vertices change from outside
// (initial load, or after a delete).
function FitToPolygon({ polygon }: { polygon: LatLng[] }) {
  const map = useMap();
  useEffect(() => {
    if (polygon.length >= 3) {
      const bounds = L.latLngBounds(polygon.map((p) => [p.lat, p.lng] as [number, number]));
      map.fitBounds(bounds, { padding: [24, 24], maxZoom: 19 });
    }
  }, [polygon, map]);
  return null;
}

export default function GeofenceMapEditor({ initialPolygon, initialCentre, centreOverride, onChange }: Props) {
  const featureGroupRef = useRef<L.FeatureGroup | null>(null);
  // Pre-seed exactly once. Using a ref guards against React Strict Mode
  // running the ref callback twice or re-renders re-invoking it.
  const seededRef = useRef(false);

  const initialView = useMemo<{ centre: LatLng; zoom: number }>(() => {
    if (initialPolygon.length >= 3) {
      const lat = initialPolygon.reduce((s, p) => s + p.lat, 0) / initialPolygon.length;
      const lng = initialPolygon.reduce((s, p) => s + p.lng, 0) / initialPolygon.length;
      return { centre: { lat, lng }, zoom: 18 };
    }
    if (initialCentre) return { centre: initialCentre, zoom: 18 };
    return { centre: SF_FALLBACK, zoom: 13 };
  }, [initialPolygon, initialCentre]);

  function readPolygonFromGroup(): LatLng[] {
    const group = featureGroupRef.current;
    if (!group) return [];
    let result: LatLng[] = [];
    group.eachLayer((layer) => {
      if (layer instanceof L.Polygon) {
        const ll = layer.getLatLngs();
        const ring = (Array.isArray(ll[0]) ? ll[0] : ll) as L.LatLng[];
        result = ring.map((p) => ({ lat: p.lat, lng: p.lng }));
      }
    });
    return result;
  }

  function handleChange() {
    onChange(readPolygonFromGroup());
  }

  // Pre-seed the FeatureGroup with the initial polygon so EditControl can
  // edit/delete it. We do this inside the ref callback (not a useEffect)
  // because react-leaflet v4's ref attaches AFTER the effect's mount pass —
  // a useEffect with [] deps reads featureGroupRef.current as null.
  // The seededRef guard prevents double-add on Strict Mode / re-render.
  const handleFeatureGroupRef = useCallback(
    (fg: L.FeatureGroup | null) => {
      featureGroupRef.current = fg ?? null;
      if (!fg || seededRef.current || initialPolygon.length < 3) return;
      const layer = L.polygon(
        initialPolygon.map((p) => [p.lat, p.lng] as [number, number]),
        { color: '#fbbf24', weight: 2, fillOpacity: 0.15 },
      );
      fg.addLayer(layer);
      seededRef.current = true;
    },
    [initialPolygon],
  );

  return (
    <div className="relative h-[400px] w-full rounded-lg overflow-hidden border border-[#1A3050]">
      <MapContainer
        center={[initialView.centre.lat, initialView.centre.lng]}
        zoom={initialView.zoom}
        scrollWheelZoom
        style={{ height: '100%', width: '100%' }}
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxZoom={19}
        />

        <FitToPolygon polygon={initialPolygon} />

        <FeatureGroup ref={handleFeatureGroupRef as never}>
          <EditControl
            position="topright"
            onCreated={handleChange}
            onEdited={handleChange}
            onDeleted={handleChange}
            draw={{
              polygon: {
                allowIntersection: false,
                showArea: true,
                shapeOptions: { color: '#fbbf24', weight: 2, fillOpacity: 0.15 },
              },
              polyline:  false,
              rectangle: false,
              circle:    false,
              marker:    false,
              circlemarker: false,
            }}
            edit={{ remove: true }}
          />
        </FeatureGroup>

        {centreOverride && (
          <Marker position={[centreOverride.lat, centreOverride.lng]} />
        )}
      </MapContainer>
    </div>
  );
}
