'use client';
/**
 * Admin — Sites Management (/admin/sites)
 *
 * Compact rows matching the Guards page pattern: search + status chips
 * (ENABLED / DISABLED / ALL) in the header, alphabetical uniform-height
 * rows, and a right-side "Details ▾" pill that expands each row inline
 * to reveal geofence, instructions, client-access-until, data-deletion,
 * and client-portal controls. All create/geofence/PDF/deactivate modals
 * are preserved verbatim.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { adminGet, adminPost, adminPatch } from '../../../lib/adminApi';
import {
  centroidOf,
  boundingRadiusMeters,
  isSelfIntersecting,
  looksLikeCircleSynth,
  circlePolygon,
  type LatLng,
} from '../../../lib/geofenceMath';

const GeofenceMapEditor = dynamic(() => import('../../../components/GeofenceMapEditor'), {
  ssr: false,
  loading: () => (
    <div className="h-[400px] w-full rounded-lg border border-[#1A3050] bg-[#0B1526] flex items-center justify-center text-gray-500 text-sm">
      Loading map…
    </div>
  ),
});

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
function getAdminToken() {
  if (typeof document === 'undefined') return '';
  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';
}

interface Site {
  id:                          string;
  name:                        string;
  address:                     string;
  contract_start:              string;
  contract_end:                string | null;      // FIX 2: nullable, grandfathered for existing rows
  timezone:                    string;
  is_active:                   boolean;
  client_access_disabled_at:   string | null;
  client_star_access_until:    string | null;
  data_delete_at:              string | null;
  has_geofence:                boolean;
  center_lat:                  number | null;
  center_lng:                  number | null;
  radius_meters:               number | null;
  polygon_coordinates:         LatLng[] | null;
  instructions_pdf_url:        string | null;
  company_name?:               string;
  geocoded_lat?:               number | null;      // FIX 4: geocoded on NEW SITE address blur
  geocoded_lng?:               number | null;
}

interface DeactivatePreview {
  scheduled_shifts:   number;
  active_sessions:    number;
  open_assignments:   number;
}

type GeoMode = 'radius' | 'draw';
type StatusFilter = 'enabled' | 'disabled' | 'all';

// Keep in sync with ALLOWED_TIMEZONES in apps/api/src/routes/sites.ts.
const TIMEZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'America/Los_Angeles', label: 'Pacific — Los Angeles (PT)' },
  { value: 'America/Denver',      label: 'Mountain — Denver (MT)' },
  { value: 'America/Phoenix',     label: 'Mountain — Phoenix (no DST)' },
  { value: 'America/Chicago',     label: 'Central — Chicago (CT)' },
  { value: 'America/New_York',    label: 'Eastern — New York (ET)' },
  { value: 'Pacific/Honolulu',    label: 'Hawaii — Honolulu (HST)' },
  { value: 'UTC',                 label: 'UTC' },
];

// FIX 2: contract_end removed from the create form entirely. Existing DB
// rows with a value stay untouched (grandfathered — display still shows
// "start → end" when a value is present).
const EMPTY_FORM = {
  name: '',
  address: '',
  contract_start: '',
  timezone: 'America/Los_Angeles',
};

// FIX 4: address-geocode lookup state. `ok` means we have lat/lng ready to
// send to POST /api/sites; `error` shows an inline message; `idle` renders
// nothing. Reset to idle whenever the modal opens or the admin edits the
// address again.
type GeoLookup =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ok';    lat: number; lng: number; formatted_address: string }
  | { status: 'error'; message: string };
const EMPTY_GEO  = { center_lat: '', center_lng: '', radius_meters: '' };

const STATUS_CHIPS: StatusFilter[] = ['enabled', 'disabled', 'all'];

export default function SitesPage() {
  const [sites,        setSites]        = useState<Site[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');

  // Redesign state
  const [search,       setSearch]       = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('enabled');
  const [expanded,     setExpanded]     = useState<Set<string>>(new Set());

  // create-site modal
  const [showCreate,   setShowCreate]   = useState(false);
  const [form,         setForm]         = useState(EMPTY_FORM);
  const [saving,       setSaving]       = useState(false);
  const [formError,    setFormError]    = useState('');
  const [pdfFile,      setPdfFile]      = useState<File | null>(null);
  const [geoLookup,    setGeoLookup]    = useState<GeoLookup>({ status: 'idle' });

  // geofence modal
  const [geoSite,      setGeoSite]      = useState<Site | null>(null);
  const [geo,          setGeo]          = useState(EMPTY_GEO);
  const [geoMode,      setGeoMode]      = useState<GeoMode>('radius');
  const [drawnPolygon, setDrawnPolygon] = useState<LatLng[]>([]);
  const [geoSaving,    setGeoSaving]    = useState(false);
  const [geoError,     setGeoError]     = useState('');

  // Session A2 — address-search-inside-geofence-modal state.
  //   geoSearch{Input,Status,Result,Error}: driven by the search bar in the
  //     modal's left column. `result` is retained after success so the
  //     "Recenter map" button has something to fly to.
  //   focusPoint: passed to GeofenceMapEditor. New object literal per fly
  //     request — the map's useEffect keys on referential equality.
  //   polygonOffsetWarnDismissed: once dismissed for the current modal open,
  //     stays dismissed until modal reopen (openGeo resets it).
  const [geoSearchInput,  setGeoSearchInput]  = useState('');
  const [geoSearchStatus, setGeoSearchStatus] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [geoSearchResult, setGeoSearchResult] = useState<{ lat: number; lng: number; formatted_address: string } | null>(null);
  const [geoSearchError,  setGeoSearchError]  = useState('');
  const [focusPoint,      setFocusPoint]      = useState<LatLng | null>(null);
  const [polygonOffsetWarnDismissed, setPolygonOffsetWarnDismissed] = useState(false);

  const [toggling,     setToggling]     = useState<string | null>(null);

  // deactivate flow
  const [deactivateSite,     setDeactivateSite]     = useState<Site | null>(null);
  const [deactivatePreview,  setDeactivatePreview]  = useState<DeactivatePreview | null>(null);
  const [deactivateBusy,     setDeactivateBusy]     = useState(false);
  const [deactivateError,    setDeactivateError]    = useState('');
  const [activeToggling,     setActiveToggling]     = useState<string | null>(null);

  // PDF modal
  const [pdfSite,      setPdfSite]      = useState<Site | null>(null);
  const [replacePdf,   setReplacePdf]   = useState<File | null>(null);
  const [pdfSaving,    setPdfSaving]    = useState(false);
  const [pdfError,     setPdfError]     = useState('');
  const pdfInputRef                     = useRef<HTMLInputElement>(null);

  // Always fetch with include_inactive=1 so the chip toggle is a client-side
  // filter with no round-trip. Search across ALL sites regardless of chip.
  const load = useCallback(async () => {
    try {
      setSites(await adminGet<Site[]>('/api/sites?include_inactive=1'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Vishnu multi-company label — show company_name inline when the returned
  // set spans more than one company (same conditional pattern as Guards + Shifts).
  const showCompanyLabel = useMemo(() => {
    const set = new Set<string>();
    for (const s of sites) if (s.company_name) set.add(s.company_name);
    return set.size > 1;
  }, [sites]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sites
      .filter((s) =>
        statusFilter === 'all' ? true
        : statusFilter === 'enabled' ? s.is_active
        : !s.is_active
      )
      .filter((s) => {
        if (!q) return true;
        return s.name.toLowerCase().includes(q)
          || (s.address ?? '').toLowerCase().includes(q);
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [sites, search, statusFilter]);

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /* ── Modal handlers (unchanged from previous version) ────────────── */
  async function openDeactivate(site: Site) {
    setDeactivateSite(site);
    setDeactivatePreview(null);
    setDeactivateError('');
    try {
      const preview = await adminGet<DeactivatePreview>(
        `/api/sites/${site.id}/deactivate-preview`,
      );
      setDeactivatePreview(preview);
    } catch (e: any) {
      setDeactivateError(e.message);
    }
  }

  async function confirmDeactivate() {
    if (!deactivateSite) return;
    setDeactivateBusy(true);
    setDeactivateError('');
    try {
      await adminPatch(`/api/sites/${deactivateSite.id}/active`, { active: false });
      setDeactivateSite(null);
      setDeactivatePreview(null);
      await load();
    } catch (e: any) {
      setDeactivateError(e.message);
    } finally {
      setDeactivateBusy(false);
    }
  }

  async function reactivateSite(id: string) {
    setActiveToggling(id);
    try {
      await adminPatch(`/api/sites/${id}/active`, { active: true });
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setActiveToggling(null);
    }
  }

  async function uploadPdfToSite(siteId: string, file: File): Promise<void> {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch(`${API}/api/sites/${siteId}/instructions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getAdminToken()}` },
      body: fd,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error((err as any).error ?? 'PDF upload failed');
    }
  }

  async function createSite() {
    if (!form.name || !form.address || !form.contract_start) {
      setFormError('Site name, address, and contract start are required'); return;
    }
    setSaving(true); setFormError('');
    try {
      // FIX 4: if the address geocoded successfully, ship those coords with
      // the create call so they land in sites.geocoded_lat/lng and can
      // pre-fill the geofence editor later.
      const body: Record<string, unknown> = { ...form };
      if (geoLookup.status === 'ok') {
        body.geocoded_lat = geoLookup.lat;
        body.geocoded_lng = geoLookup.lng;
      }
      const site = await adminPost<{ id: string }>('/api/sites', body);
      if (pdfFile) {
        try { await uploadPdfToSite(site.id, pdfFile); }
        catch (e: any) { setFormError(`Site created but PDF upload failed: ${e.message}`); }
      }
      setShowCreate(false); setForm(EMPTY_FORM); setPdfFile(null); setGeoLookup({ status: 'idle' });
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  // FIX 4: called on address-field blur in the NEW SITE modal. Returns
  // silently if the address is too short to be worth a lookup.
  async function lookupAddress() {
    const addr = form.address.trim();
    if (addr.length < 5) { setGeoLookup({ status: 'idle' }); return; }
    setGeoLookup({ status: 'loading' });
    try {
      const r = await adminPost<{ lat: number; lng: number; formatted_address: string }>(
        '/api/geocode',
        { address: addr },
      );
      setGeoLookup({ status: 'ok', lat: r.lat, lng: r.lng, formatted_address: r.formatted_address });
    } catch (e: any) {
      setGeoLookup({ status: 'error', message: e?.message ?? 'Coordinates not found for this address.' });
    }
  }

  async function savePdf() {
    if (!replacePdf) { setPdfError('Select a PDF file first'); return; }
    setPdfSaving(true); setPdfError('');
    try {
      await uploadPdfToSite(pdfSite!.id, replacePdf);
      setPdfSite(null); setReplacePdf(null);
      await load();
    } catch (e: any) { setPdfError(e.message); }
    finally { setPdfSaving(false); }
  }

  function openGeo(site: Site) {
    setGeoSite(site);
    const raw = site.polygon_coordinates;
    const existing: LatLng[] = Array.isArray(raw) ? raw : [];
    const validExisting = existing.length >= 3;
    const defaultMode: GeoMode = validExisting && !looksLikeCircleSynth(existing) ? 'draw' : 'radius';
    if (site.has_geofence && !validExisting) {
      // eslint-disable-next-line no-console
      console.warn('[geofence] site marked has_geofence=true but polygon missing/short — defaulting to Radius mode', {
        siteId: site.id, rawType: typeof raw, isArray: Array.isArray(raw), length: Array.isArray(raw) ? raw.length : null,
      });
    }
    setGeoMode(defaultMode);
    setDrawnPolygon(validExisting ? existing : []);
    // FIX 4: pre-populate with the actual fence centre if one exists;
    // otherwise fall back to the geocoded coords captured on site creation.
    // Radius has no analogous fallback — admin picks that.
    setGeo({
      center_lat:    site.center_lat    != null ? String(site.center_lat)
                   : site.geocoded_lat  != null ? String(site.geocoded_lat)
                   : '',
      center_lng:    site.center_lng    != null ? String(site.center_lng)
                   : site.geocoded_lng  != null ? String(site.geocoded_lng)
                   : '',
      radius_meters: site.radius_meters != null ? String(site.radius_meters) : '',
    });
    setGeoError('');
    // Session A2 — reset all search-bar state on each modal open.
    setGeoSearchInput('');
    setGeoSearchStatus('idle');
    setGeoSearchResult(null);
    setGeoSearchError('');
    setFocusPoint(null);
    setPolygonOffsetWarnDismissed(false);
  }

  // Session A2 — search handler for the geofence modal's inline address bar.
  // On success: fills LATITUDE + LONGITUDE inputs, flies the map to the
  // result (via a new focusPoint reference), and keeps the result handy for
  // the "Recenter map" button.
  async function searchGeofenceAddress() {
    const q = geoSearchInput.trim();
    if (q.length < 3) return;
    setGeoSearchStatus('loading');
    setGeoSearchError('');
    try {
      const r = await adminPost<{ lat: number; lng: number; formatted_address: string }>(
        '/api/geocode',
        { address: q },
      );
      setGeoSearchStatus('ok');
      setGeoSearchResult(r);
      setGeo((g) => ({ ...g, center_lat: String(r.lat), center_lng: String(r.lng) }));
      setFocusPoint({ lat: r.lat, lng: r.lng });
      setPolygonOffsetWarnDismissed(false);
    } catch (e: any) {
      setGeoSearchStatus('error');
      setGeoSearchError(e?.message ?? 'Search failed');
    }
  }

  function recenterMapOnSearch() {
    if (!geoSearchResult) return;
    setGeo((g) => ({
      ...g,
      center_lat: String(geoSearchResult.lat),
      center_lng: String(geoSearchResult.lng),
    }));
    // Fresh object literal — GeofenceMapEditor's FlyTo useEffect keys on
    // referential equality, so this fires flyTo even when lat/lng haven't
    // changed since the last fly.
    setFocusPoint({ lat: geoSearchResult.lat, lng: geoSearchResult.lng });
  }

  // Map server-side error strings to concise UI copy per spec.
  function mapGeoSearchError(msg: string): string {
    const lower = msg.toLowerCase();
    if (lower.includes('not configured')) return 'Address search not configured — enter coordinates manually.';
    if (lower.includes('not found') || lower.includes('zero_results')) return 'Address not found — try a more specific query.';
    if (lower.includes('upstream') || lower.includes('request failed') || lower.includes('temporarily')) {
      return 'Search temporarily unavailable — try again in a moment.';
    }
    return msg;
  }

  function handlePolygonChange(poly: LatLng[]) {
    setDrawnPolygon(poly);
    if (poly.length >= 3) {
      const c = centroidOf(poly);
      const r = boundingRadiusMeters(c, poly);
      setGeo({
        center_lat:    c.lat.toFixed(6),
        center_lng:    c.lng.toFixed(6),
        radius_meters: String(r),
      });
    }
  }

  async function saveGeofence() {
    const lat = parseFloat(geo.center_lat);
    const lng = parseFloat(geo.center_lng);
    const rad = parseInt(geo.radius_meters, 10);
    if (isNaN(lat) || isNaN(lng) || isNaN(rad) || rad <= 0) {
      setGeoError('Enter valid latitude, longitude and radius (metres)'); return;
    }
    if (lat < -90 || lat > 90)  { setGeoError('Latitude must be between -90 and 90');   return; }
    if (lng < -180 || lng > 180){ setGeoError('Longitude must be between -180 and 180'); return; }

    let polygon: LatLng[];
    if (geoMode === 'draw') {
      if (drawnPolygon.length < 3) {
        setGeoError('Draw a polygon with at least 3 vertices first.'); return;
      }
      if (isSelfIntersecting(drawnPolygon)) {
        setGeoError('Polygon edges cross. Re-draw without self-intersections.'); return;
      }
      polygon = drawnPolygon;
    } else {
      polygon = circlePolygon(lat, lng, rad);
    }

    setGeoSaving(true); setGeoError('');
    try {
      await adminPatch(`/api/sites/${geoSite!.id}/geofence`, {
        center_lat:          lat,
        center_lng:          lng,
        radius_meters:       rad,
        polygon_coordinates: polygon,
      });
      setGeoSite(null);
      await load();
    } catch (e: any) { setGeoError(e.message); }
    finally { setGeoSaving(false); }
  }

  async function toggleClientAccess(id: string, enabled: boolean) {
    setToggling(id);
    try { await adminPatch(`/api/sites/${id}/client-access`, { enabled }); await load(); }
    catch (e: any) { setError(e.message); }
    finally { setToggling(null); }
  }

  function fmtDate(iso: string | null) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function daysUntil(iso: string | null) {
    if (!iso) return null;
    return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400">SITES</h1>
        <div className="flex flex-wrap gap-3 items-center">
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sites or address…"
            className="bg-[#0F1E35] border border-[#1A3050] text-gray-200 text-sm rounded-lg px-3 py-2 min-w-[220px] focus:outline-none focus:border-amber-400"
          />
          <div className="flex items-center gap-1 bg-[#0F1E35] border border-[#1A3050] rounded-lg p-1">
            {STATUS_CHIPS.map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1.5 rounded text-xs tracking-widest transition-colors ${
                  statusFilter === s ? 'bg-amber-500 text-black font-bold' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {s.toUpperCase()}
              </button>
            ))}
          </div>
          <button
            onClick={() => { setShowCreate(true); setFormError(''); setForm(EMPTY_FORM); }}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors min-h-[40px]"
          >
            + NEW SITE
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Compact list */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        {loading && <p className="p-8 text-center text-gray-500">Loading…</p>}
        {!loading && visible.length === 0 && (
          <p className="p-8 text-center text-gray-500">No sites match your criteria.</p>
        )}
        {!loading && visible.map((site) => {
          const isExpanded    = expanded.has(site.id);
          const isDeactivated = !site.is_active;
          const clientEnabled = !site.client_access_disabled_at;
          const accessIn      = daysUntil(site.client_star_access_until);
          const deleteIn      = daysUntil(site.data_delete_at);
          return (
            <div key={site.id} className={`border-b border-[#1A3050] last:border-b-0 ${isDeactivated ? 'opacity-60' : ''}`}>
              {/* Collapsed row — uniform height */}
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-4 px-4 py-3 hover:bg-[#0B1526] transition-colors">
                <div className="min-w-0">
                  <p className="text-gray-200 font-medium truncate">{site.name}</p>
                  {site.address && <p className="text-gray-500 text-xs truncate">{site.address}</p>}
                  {showCompanyLabel && site.company_name && (
                    <p className="text-gray-600 text-[10px] tracking-widest mt-0.5">{site.company_name.toUpperCase()}</p>
                  )}
                </div>
                {/* FIX 2: no "no end date" filler. When contract_end is null,
                    show just the start date; when present, show start → end. */}
                <div className="text-gray-400 text-xs text-right whitespace-nowrap hidden md:block">
                  {fmtDate(site.contract_start)}
                  {site.contract_end && (
                    <>
                      <span className="text-gray-600"> → </span>
                      {fmtDate(site.contract_end)}
                    </>
                  )}
                </div>
                {site.is_active ? (
                  <span className="text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded">ENABLED</span>
                ) : (
                  <span className="text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded">DISABLED</span>
                )}
                <button
                  onClick={() => toggleExpand(site.id)}
                  className="px-2.5 py-1 rounded-full text-[11px] font-bold tracking-widest bg-blue-500/20 border border-blue-500/40 text-blue-300 hover:bg-blue-500/30 transition-colors"
                >
                  DETAILS {isExpanded ? '▲' : '▾'}
                </button>
              </div>

              {/* Expanded detail section */}
              {isExpanded && (
                <div className="bg-[#0B1526] px-4 py-4 border-t border-[#1A3050] space-y-4">
                  {/* Contract dates — mirrored inside for mobile where they were hidden on the row */}
                  <div className="md:hidden">
                    <p className="text-gray-500 text-xs tracking-widest mb-1">CONTRACT</p>
                    <p className="text-gray-300 text-sm">
                      {fmtDate(site.contract_start)}
                      {site.contract_end && (
                        <>
                          <span className="text-gray-600"> → </span>
                          {fmtDate(site.contract_end)}
                        </>
                      )}
                    </p>
                  </div>

                  {/* GEOFENCE */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">GEOFENCE</p>
                    {site.has_geofence ? (
                      <div className="flex items-center flex-wrap gap-3">
                        <span className="inline-flex items-center gap-1.5 text-xs text-green-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                          SET
                        </span>
                        <span className="text-gray-500 text-xs font-mono">
                          {site.center_lat?.toFixed(5)}, {site.center_lng?.toFixed(5)}
                        </span>
                        <span className="text-gray-500 text-xs">{site.radius_meters}m radius</span>
                        <button
                          onClick={() => openGeo(site)}
                          className="text-xs text-amber-400 hover:text-amber-300 underline"
                        >
                          Edit
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => openGeo(site)}
                        className="text-xs text-red-400 border border-red-700 px-2 py-1 rounded hover:border-amber-400 hover:text-amber-400 transition-colors"
                      >
                        NOT SET — Configure
                      </button>
                    )}
                  </div>

                  {/* INSTRUCTIONS */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">INSTRUCTIONS</p>
                    {site.instructions_pdf_url ? (
                      <div className="flex items-center gap-3">
                        <a href={site.instructions_pdf_url} target="_blank" rel="noopener noreferrer"
                           className="text-xs text-cyan-400 underline">View PDF</a>
                        <button onClick={() => { setPdfSite(site); setReplacePdf(null); setPdfError(''); }}
                                className="text-xs text-amber-400 hover:text-amber-300 underline">Replace</button>
                      </div>
                    ) : (
                      <button onClick={() => { setPdfSite(site); setReplacePdf(null); setPdfError(''); }}
                              className="text-xs text-gray-400 border border-[#1A3050] px-2 py-1 rounded hover:border-amber-400 hover:text-amber-400 transition-colors">
                        + Upload
                      </button>
                    )}
                  </div>

                  {/* CLIENT ACCESS UNTIL */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">CLIENT ACCESS UNTIL</p>
                    {site.client_star_access_until ? (
                      <span className={`text-xs ${accessIn !== null && accessIn <= 14 ? 'text-red-400' : 'text-gray-300'}`}>
                        {fmtDate(site.client_star_access_until)}
                        {accessIn !== null && accessIn <= 30 && (
                          <span className="ml-1 text-red-400">({accessIn}d)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </div>

                  {/* DATA DELETION */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">DATA DELETION</p>
                    {site.data_delete_at ? (
                      <span className={`text-xs ${deleteIn !== null && deleteIn <= 30 ? 'text-red-400' : 'text-gray-300'}`}>
                        {fmtDate(site.data_delete_at)}
                        {deleteIn !== null && deleteIn <= 30 && (
                          <span className="ml-1">({deleteIn}d)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </div>

                  {/* CLIENT PORTAL — status pill + verb-form action button.
                      FIX 1: pill shows ENABLED/DISABLED at a glance; the
                      button label is a verb ("DISABLE PORTAL" / "ENABLE PORTAL")
                      so the admin can't mistake it for the whole-site toggle. */}
                  <div>
                    <p className="text-gray-500 text-xs tracking-widest mb-1">CLIENT PORTAL</p>
                    <div className="flex items-center gap-3 flex-wrap">
                      {isDeactivated ? (
                        <button
                          onClick={() => reactivateSite(site.id)}
                          disabled={activeToggling === site.id}
                          className="text-xs tracking-widest px-3 py-1 rounded transition-colors bg-[#0B1526] text-gray-400 border border-[#1A3050] hover:border-amber-400 hover:text-amber-400 disabled:opacity-40"
                        >
                          {activeToggling === site.id ? '…' : 'REACTIVATE SITE'}
                        </button>
                      ) : (
                        <>
                          {clientEnabled ? (
                            <span className="inline-flex items-center gap-1.5 text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded">
                              <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                              ENABLED
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded">
                              <span className="w-1.5 h-1.5 rounded-full bg-red-400 inline-block" />
                              DISABLED
                            </span>
                          )}
                          <button
                            onClick={() => toggleClientAccess(site.id, !clientEnabled)}
                            disabled={toggling === site.id}
                            className={`text-xs tracking-widest px-3 py-1 rounded transition-colors bg-[#0B1526] text-gray-400 border border-[#1A3050] disabled:opacity-40 ${
                              clientEnabled
                                ? 'hover:border-red-500 hover:text-red-400'
                                : 'hover:border-green-500 hover:text-green-400'
                            }`}
                          >
                            {toggling === site.id ? '…' : clientEnabled ? 'DISABLE PORTAL' : 'ENABLE PORTAL'}
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {/* FIX 1: DEACTIVATE SITE — its own section, destructive red,
                      only shown for active sites. Reactivate is handled inside
                      CLIENT PORTAL above. */}
                  {!isDeactivated && (
                    <div className="pt-3 border-t border-[#1A3050]">
                      <p className="text-gray-500 text-xs tracking-widest mb-2">SITE STATUS</p>
                      <button
                        onClick={() => openDeactivate(site)}
                        className="text-xs tracking-widest px-3 py-1.5 rounded bg-red-500/10 text-red-400 border border-red-500/40 hover:bg-red-500/20 hover:border-red-500 transition-colors"
                      >
                        ⚠ DEACTIVATE SITE
                      </button>
                      <p className="text-gray-600 text-[10px] mt-1">Cancels future shifts, closes client portal, marks the site inactive. History stays visible.</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── Create Site Modal ─────────────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">NEW SITE</h2>
              <button onClick={() => { setShowCreate(false); setGeoLookup({ status: 'idle' }); }} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">
              {/* NAME */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE NAME <span className="text-amber-400">*</span></label>
                <input
                  type="text" placeholder="e.g. Westfield Shopping Centre"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>

              {/* ADDRESS — FIX 4: geocode on blur; status shown inline below */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">ADDRESS <span className="text-amber-400">*</span></label>
                <input
                  type="text" placeholder="Full address"
                  value={form.address}
                  onChange={(e) => {
                    setForm((f) => ({ ...f, address: e.target.value }));
                    // Any edit invalidates the last lookup — force a re-geocode on next blur.
                    setGeoLookup({ status: 'idle' });
                  }}
                  onBlur={lookupAddress}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
                {geoLookup.status === 'loading' && (
                  <p className="text-gray-500 text-xs mt-1">Looking up coordinates…</p>
                )}
                {geoLookup.status === 'ok' && (
                  <p className="text-green-400 text-xs mt-1">
                    ✓ Coordinates found: {geoLookup.lat.toFixed(5)}, {geoLookup.lng.toFixed(5)}
                    <span className="text-gray-500"> — {geoLookup.formatted_address}</span>
                  </p>
                )}
                {geoLookup.status === 'error' && (
                  <p className="text-amber-400/80 text-xs mt-1">
                    {geoLookup.message} You can still create the site and set the geofence manually.
                  </p>
                )}
              </div>

              {/* CONTRACT START */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">CONTRACT START <span className="text-amber-400">*</span></label>
                <input
                  type="date"
                  value={form.contract_start}
                  onChange={(e) => setForm((f) => ({ ...f, contract_start: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>

              {/* TIMEZONE — CONTRACT END field removed per FIX 2 */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">
                  TIMEZONE <span className="text-amber-400">*</span>
                </label>
                <select
                  value={form.timezone}
                  onChange={(e) => setForm((f) => ({ ...f, timezone: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  {TIMEZONE_OPTIONS.map((tz) => (
                    <option key={tz.value} value={tz.value}>{tz.label}</option>
                  ))}
                </select>
                <p className="text-gray-500 text-xs mt-1">Used for shift-time display, breach/report/missed-shift emails, and daily reports.</p>
              </div>
            </div>
            <div className="mt-4">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">
                SITE INSTRUCTIONS <span className="text-gray-600 text-xs normal-case">(PDF, optional)</span>
              </label>
              <input
                type="file" accept="application/pdf,.pdf"
                onChange={(e) => setPdfFile(e.target.files?.[0] ?? null)}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 file:mr-3 file:bg-amber-400 file:text-gray-900 file:border-0 file:rounded file:px-3 file:py-1 file:text-xs file:font-bold file:cursor-pointer"
              />
              {pdfFile && <p className="text-gray-400 text-xs mt-1">Selected: {pdfFile.name}</p>}
            </div>
            <p className="text-gray-500 text-xs mt-3 mb-5">
              <span className="text-amber-400/70">You can set the geofence boundary after creating the site.</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => { setShowCreate(false); setGeoLookup({ status: 'idle' }); }} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={createSite} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'CREATING…' : 'CREATE SITE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── PDF Instructions Modal ───────────────────────────────────── */}
      {pdfSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">SITE INSTRUCTIONS</h2>
              <button onClick={() => setPdfSite(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-xs mb-4">Site: <span className="text-gray-300">{pdfSite.name}</span></p>

            {pdfSite.instructions_pdf_url && (
              <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-3 mb-4">
                <p className="text-gray-400 text-xs mb-1">Current instructions PDF:</p>
                <a href={pdfSite.instructions_pdf_url} target="_blank" rel="noopener noreferrer"
                   className="text-cyan-400 text-sm underline break-all">
                  View instructions.pdf ↗
                </a>
              </div>
            )}

            {pdfError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{pdfError}</div>}

            <div className="mb-5">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">
                {pdfSite.instructions_pdf_url ? 'REPLACE PDF' : 'UPLOAD PDF'} <span className="text-amber-400">*</span>
              </label>
              <input ref={pdfInputRef} type="file" accept="application/pdf,.pdf"
                onChange={(e) => setReplacePdf(e.target.files?.[0] ?? null)}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 file:mr-3 file:bg-amber-400 file:text-gray-900 file:border-0 file:rounded file:px-3 file:py-1 file:text-xs file:font-bold file:cursor-pointer"
              />
              {replacePdf && <p className="text-gray-400 text-xs mt-1">Selected: {replacePdf.name}</p>}
            </div>

            <div className="flex gap-3">
              <button onClick={() => setPdfSite(null)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={savePdf} disabled={pdfSaving || !replacePdf} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {pdfSaving ? 'UPLOADING…' : 'UPLOAD PDF'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Set Geofence Modal ──────────────────────────────────────────
          FIX 3: DRAW mode uses a two-column layout on md+ — left column
          holds instructions + inputs + preview, right column holds the
          map and its vertex counter. RADIUS mode has no map, so it stays
          single-column. Mobile falls back to a single-column stack for
          both modes. Modal width jumps from max-w-3xl → max-w-6xl to
          accommodate the split. */}
      {geoSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 overflow-y-auto py-8">
          <div className="w-full max-w-6xl bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">SET GEOFENCE</h2>
              <button onClick={() => setGeoSite(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-xs mb-4">
              Site: <span className="text-gray-300">{geoSite.name}</span>
            </p>

            <div className="flex gap-2 mb-5" role="radiogroup" aria-label="Geofence mode">
              <button
                type="button"
                role="radio"
                aria-checked={geoMode === 'radius'}
                onClick={() => setGeoMode('radius')}
                className={`flex-1 px-4 py-2 rounded-lg text-xs tracking-widest border transition-colors ${
                  geoMode === 'radius'
                    ? 'bg-amber-400 text-gray-900 border-amber-400 font-bold'
                    : 'bg-[#0B1526] text-gray-400 border-[#1A3050] hover:border-amber-400/50'
                }`}
              >
                RADIUS (CURRENT)
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={geoMode === 'draw'}
                onClick={() => setGeoMode('draw')}
                className={`flex-1 px-4 py-2 rounded-lg text-xs tracking-widest border transition-colors ${
                  geoMode === 'draw'
                    ? 'bg-amber-400 text-gray-900 border-amber-400 font-bold'
                    : 'bg-[#0B1526] text-gray-400 border-[#1A3050] hover:border-amber-400/50'
                }`}
              >
                DRAW BOUNDARY
              </button>
            </div>

            {geoMode === 'radius' ? (
              // Single-column layout for RADIUS mode — no map to place.
              <div className="space-y-4">
                {/* Session A2 — address search bar. Auto-fills LATITUDE +
                    LONGITUDE inputs on success. RECENTER button is
                    map-specific → not shown here (RADIUS has no map). */}
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">SEARCH ADDRESS</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={geoSearchInput}
                      placeholder="Type address, landmark, or place…"
                      onChange={(e) => setGeoSearchInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchGeofenceAddress(); } }}
                      className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                    <button
                      type="button"
                      onClick={searchGeofenceAddress}
                      disabled={geoSearchStatus === 'loading' || geoSearchInput.trim().length < 3}
                      aria-label="Search address"
                      className="bg-[#0B1526] border border-[#1A3050] text-gray-400 hover:border-amber-400 hover:text-amber-400 rounded-lg px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      🔍
                    </button>
                  </div>
                  {geoSearchStatus === 'loading' && <p className="text-gray-500 text-xs mt-1">Searching…</p>}
                  {geoSearchStatus === 'ok' && geoSearchResult && (
                    <p className="text-green-400 text-xs mt-1">✓ Found: <span className="text-gray-300">{geoSearchResult.formatted_address}</span></p>
                  )}
                  {geoSearchStatus === 'error' && (
                    <p className="text-amber-400/80 text-xs mt-1">{mapGeoSearchError(geoSearchError)}</p>
                  )}
                </div>

                <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 text-xs text-gray-400 space-y-1">
                  <p className="text-amber-400 font-bold tracking-widest mb-2">HOW TO GET COORDINATES</p>
                  <p>1. Open <span className="text-white">Google Maps</span> and search for the site address.</p>
                  <p>2. Right-click on the exact centre of the building/property.</p>
                  <p>3. Click the coordinates that appear at the top of the menu — they are copied automatically.</p>
                  <p>4. Paste them below (they look like: <span className="text-white font-mono">37.7749, -122.4194</span>).</p>
                  <p className="pt-1">Set the radius to cover the full property boundary — e.g. <span className="text-white">50m</span> for a small building, <span className="text-white">200m</span> for a large campus.</p>
                </div>

                {geoError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2">{geoError}</div>}

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">LATITUDE <span className="text-amber-400">*</span></label>
                    <input
                      type="number" step="any" placeholder="e.g. 37.7749"
                      value={geo.center_lat}
                      onChange={(e) => setGeo((g) => ({ ...g, center_lat: e.target.value }))}
                      className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                  </div>
                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">LONGITUDE <span className="text-amber-400">*</span></label>
                    <input
                      type="number" step="any" placeholder="e.g. -122.4194"
                      value={geo.center_lng}
                      onChange={(e) => setGeo((g) => ({ ...g, center_lng: e.target.value }))}
                      className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">RADIUS (METRES) <span className="text-amber-400">*</span></label>
                  <input
                    type="number" min="10" max="10000" placeholder="e.g. 100"
                    value={geo.radius_meters}
                    onChange={(e) => setGeo((g) => ({ ...g, radius_meters: e.target.value }))}
                    className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                  <p className="text-gray-600 text-xs mt-1">
                    Guards outside this radius will trigger a geofence violation alert. A 16-point circular boundary is auto-generated from your centre + radius.
                  </p>
                </div>

                {geo.center_lat && geo.center_lng && geo.radius_meters && (
                  <div className="bg-[#0B1526] border border-amber-400/30 rounded-lg p-3 text-xs text-gray-400">
                    <p className="text-amber-400 font-bold tracking-widest mb-1">PREVIEW</p>
                    <p>Centre: <span className="text-white font-mono">{geo.center_lat}, {geo.center_lng}</span></p>
                    <p>Boundary radius: <span className="text-white">{geo.radius_meters}m</span>
                      {Number(geo.radius_meters) > 0 && (
                        <span className="ml-2 text-gray-500">
                          (~{(Number(geo.radius_meters) * 2).toFixed(0)}m diameter)
                        </span>
                      )}
                    </p>
                    <a
                      href={`https://www.google.com/maps?q=${geo.center_lat},${geo.center_lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-amber-400 underline mt-1 inline-block"
                    >
                      Verify on Google Maps ↗
                    </a>
                  </div>
                )}
              </div>
            ) : (
              // Two-halves for DRAW mode on md+; single-column below.
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* LEFT half — instructions + inputs + preview */}
                <div className="space-y-4">
                  {/* Session A2 — address search bar. Auto-fills LATITUDE +
                      LONGITUDE inputs AND flies the map to the result. Once
                      a result is captured, a "RECENTER MAP" button lets the
                      admin jump the viewport back to the searched address
                      after they've panned around. */}
                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">SEARCH ADDRESS</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={geoSearchInput}
                        placeholder="Type address, landmark, or place…"
                        onChange={(e) => setGeoSearchInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); searchGeofenceAddress(); } }}
                        className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                      />
                      <button
                        type="button"
                        onClick={searchGeofenceAddress}
                        disabled={geoSearchStatus === 'loading' || geoSearchInput.trim().length < 3}
                        aria-label="Search address"
                        className="bg-[#0B1526] border border-[#1A3050] text-gray-400 hover:border-amber-400 hover:text-amber-400 rounded-lg px-3 py-2 text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        🔍
                      </button>
                    </div>
                    {geoSearchStatus === 'loading' && <p className="text-gray-500 text-xs mt-1">Searching…</p>}
                    {geoSearchStatus === 'ok' && geoSearchResult && (
                      <p className="text-green-400 text-xs mt-1">✓ Found: <span className="text-gray-300">{geoSearchResult.formatted_address}</span></p>
                    )}
                    {geoSearchStatus === 'error' && (
                      <p className="text-amber-400/80 text-xs mt-1">{mapGeoSearchError(geoSearchError)}</p>
                    )}
                    {geoSearchStatus === 'ok' && geoSearchResult && (
                      <button
                        type="button"
                        onClick={recenterMapOnSearch}
                        className="mt-2 text-xs text-amber-400 tracking-widest hover:text-amber-300 underline"
                      >
                        RECENTER MAP ON THIS ADDRESS
                      </button>
                    )}
                  </div>

                  {/* Dismissable warning when a search fires after a polygon
                      is already drawn — the drawing may now be off-centre. */}
                  {geoSearchStatus === 'ok' && drawnPolygon.length >= 3 && !polygonOffsetWarnDismissed && (
                    <div className="bg-amber-400/10 border border-amber-400/40 rounded-lg px-3 py-2 flex items-start gap-2">
                      <span className="text-amber-400 text-sm leading-tight">⚠</span>
                      <span className="text-amber-300 text-xs flex-1 leading-tight">Polygon is no longer centered on the new address — redraw if needed.</span>
                      <button
                        type="button"
                        onClick={() => setPolygonOffsetWarnDismissed(true)}
                        aria-label="Dismiss warning"
                        className="text-amber-400 hover:text-amber-200 text-sm leading-tight"
                      >✕</button>
                    </div>
                  )}

                  <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 text-xs text-gray-400 space-y-1">
                    <p className="text-amber-400 font-bold tracking-widest mb-2">HOW TO DRAW</p>
                    <p>1. Use the polygon tool in the map to click each corner of the property.</p>
                    <p>2. Click the first point again to close the boundary.</p>
                    <p>3. Drag the vertices to adjust. Use the edit/delete tools to revise.</p>
                    <p className="pt-1">Centre and radius auto-fill from your drawing — you can override them. Radius is the GPS-drift fallback if the polygon ever loads incorrectly on a guard's device.</p>
                  </div>

                  {geoError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2">{geoError}</div>}

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="block text-gray-500 text-xs tracking-widest mb-1">LATITUDE <span className="text-amber-400">*</span></label>
                      <input
                        type="number" step="any" placeholder="e.g. 37.7749"
                        value={geo.center_lat}
                        onChange={(e) => setGeo((g) => ({ ...g, center_lat: e.target.value }))}
                        className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                      />
                    </div>
                    <div>
                      <label className="block text-gray-500 text-xs tracking-widest mb-1">LONGITUDE <span className="text-amber-400">*</span></label>
                      <input
                        type="number" step="any" placeholder="e.g. -122.4194"
                        value={geo.center_lng}
                        onChange={(e) => setGeo((g) => ({ ...g, center_lng: e.target.value }))}
                        className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-gray-500 text-xs tracking-widest mb-1">RADIUS (METRES) <span className="text-amber-400">*</span></label>
                    <input
                      type="number" min="10" max="10000" placeholder="e.g. 100"
                      value={geo.radius_meters}
                      onChange={(e) => setGeo((g) => ({ ...g, radius_meters: e.target.value }))}
                      className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                    <p className="text-gray-600 text-xs mt-1">
                      Radius is the GPS-drift fallback — guards inside the polygon OR within this radius are considered on-post.
                    </p>
                  </div>

                  {geo.center_lat && geo.center_lng && geo.radius_meters && (
                    <div className="bg-[#0B1526] border border-amber-400/30 rounded-lg p-3 text-xs text-gray-400">
                      <p className="text-amber-400 font-bold tracking-widest mb-1">PREVIEW</p>
                      <p>Centre: <span className="text-white font-mono">{geo.center_lat}, {geo.center_lng}</span></p>
                      <p>Boundary radius: <span className="text-white">{geo.radius_meters}m</span>
                        {Number(geo.radius_meters) > 0 && (
                          <span className="ml-2 text-gray-500">
                            (~{(Number(geo.radius_meters) * 2).toFixed(0)}m diameter)
                          </span>
                        )}
                      </p>
                      <p>Polygon: <span className="text-white">{drawnPolygon.length} vertices</span></p>
                      <a
                        href={`https://www.google.com/maps?q=${geo.center_lat},${geo.center_lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-amber-400 underline mt-1 inline-block"
                      >
                        Verify on Google Maps ↗
                      </a>
                    </div>
                  )}
                </div>

                {/* RIGHT half — map + vertex count */}
                <div>
                  <GeofenceMapEditor
                    initialPolygon={drawnPolygon}
                    initialCentre={
                      geoSite.center_lat != null && geoSite.center_lng != null
                        ? { lat: geoSite.center_lat, lng: geoSite.center_lng }
                        : null
                    }
                    centreOverride={
                      geo.center_lat && geo.center_lng && !isNaN(parseFloat(geo.center_lat)) && !isNaN(parseFloat(geo.center_lng))
                        ? { lat: parseFloat(geo.center_lat), lng: parseFloat(geo.center_lng) }
                        : null
                    }
                    focusPoint={focusPoint}
                    onChange={handlePolygonChange}
                  />
                  <p className="text-gray-600 text-xs mt-1">
                    Vertices: <span className="text-gray-300">{drawnPolygon.length}</span>
                    {drawnPolygon.length > 0 && drawnPolygon.length < 3 && (
                      <span className="text-red-400 ml-2">need ≥ 3</span>
                    )}
                    {drawnPolygon.length >= 4 && isSelfIntersecting(drawnPolygon) && (
                      <span className="text-red-400 ml-2">edges cross — re-draw</span>
                    )}
                  </p>
                </div>
              </div>
            )}

            <div className="flex gap-3 mt-6">
              <button onClick={() => setGeoSite(null)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={saveGeofence} disabled={geoSaving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {geoSaving ? 'SAVING…' : 'SAVE GEOFENCE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Deactivate Site Modal ────────────────────────────────────── */}
      {deactivateSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-red-700/50 rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-red-400 font-bold tracking-widest text-lg">DEACTIVATE SITE</h2>
              <button onClick={() => { setDeactivateSite(null); setDeactivatePreview(null); setDeactivateError(''); }} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-400 text-xs mb-1">Site</p>
            <p className="text-gray-200 font-medium mb-4">{deactivateSite.name}</p>

            {!deactivatePreview && !deactivateError && (
              <p className="text-gray-500 text-sm mb-4">Loading preview…</p>
            )}

            {deactivateError && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{deactivateError}</div>
            )}

            {deactivatePreview && (
              <>
                <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 mb-4 space-y-2">
                  <p className="text-gray-500 text-xs tracking-widest mb-2">WHAT WILL HAPPEN</p>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Future shifts to cancel</span>
                    <span className="text-gray-200 font-mono">{deactivatePreview.scheduled_shifts}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Active guard sessions</span>
                    <span className="text-gray-200 font-mono">{deactivatePreview.active_sessions}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Open guard assignments to close</span>
                    <span className="text-gray-200 font-mono">{deactivatePreview.open_assignments}</span>
                  </div>
                </div>
                <p className="text-gray-500 text-xs mb-4 leading-relaxed">
                  Client portal access will be disabled. Historical rows (shift
                  sessions, reports, hours, billing) stay intact and continue to
                  appear with an <span className="text-gray-400">[INACTIVE]</span> label.
                  Active guard sessions are not interrupted — they finish
                  normally.
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => { setDeactivateSite(null); setDeactivatePreview(null); }}
                    className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors"
                  >
                    BACK
                  </button>
                  <button
                    onClick={confirmDeactivate}
                    disabled={deactivateBusy}
                    className="flex-1 bg-red-500 text-white font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-red-400 disabled:opacity-40 transition-colors"
                  >
                    {deactivateBusy
                      ? 'DEACTIVATING…'
                      : deactivatePreview.scheduled_shifts > 0
                        ? 'CANCEL SHIFTS + DEACTIVATE'
                        : 'DEACTIVATE'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
