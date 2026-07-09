'use client';
/**
 * Admin — Sites Management (/admin/sites)
 * List sites, create new site, set geofence, toggle client portal access, PDF instructions.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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

// next/dynamic + ssr:false because Leaflet touches `window` at import time.
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
  contract_end:                string;
  timezone:                    string;
  is_active:                   boolean;
  client_access_disabled_at:   string | null;  // Fix A source of truth
  client_star_access_until:    string | null;
  data_delete_at:              string | null;
  has_geofence:                boolean;
  center_lat:                  number | null;
  center_lng:                  number | null;
  radius_meters:               number | null;
  polygon_coordinates:         LatLng[] | null;
  instructions_pdf_url:        string | null;
}

interface DeactivatePreview {
  scheduled_shifts:   number;
  active_sessions:    number;
  open_assignments:   number;
}

type GeoMode = 'radius' | 'draw';

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

const EMPTY_FORM = {
  name: '',
  address: '',
  contract_start: '',
  contract_end: '' as string,
  timezone: 'America/Los_Angeles',
};
const EMPTY_GEO  = { center_lat: '', center_lng: '', radius_meters: '' };

export default function SitesPage() {
  const [sites,        setSites]        = useState<Site[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');

  // create-site modal
  const [showCreate,   setShowCreate]   = useState(false);
  const [form,         setForm]         = useState(EMPTY_FORM);
  const [saving,       setSaving]       = useState(false);
  const [formError,    setFormError]    = useState('');
  const [pdfFile,      setPdfFile]      = useState<File | null>(null);

  // geofence modal
  const [geoSite,      setGeoSite]      = useState<Site | null>(null);
  const [geo,          setGeo]          = useState(EMPTY_GEO);
  const [geoMode,      setGeoMode]      = useState<GeoMode>('radius');
  const [drawnPolygon, setDrawnPolygon] = useState<LatLng[]>([]);
  const [geoSaving,    setGeoSaving]    = useState(false);
  const [geoError,     setGeoError]     = useState('');

  const [toggling,     setToggling]     = useState<string | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  // deactivate flow — preview counts + confirm modal
  const [deactivateSite,     setDeactivateSite]     = useState<Site | null>(null);
  const [deactivatePreview,  setDeactivatePreview]  = useState<DeactivatePreview | null>(null);
  const [deactivateBusy,     setDeactivateBusy]     = useState(false);
  const [deactivateError,    setDeactivateError]    = useState('');
  const [activeToggling,     setActiveToggling]     = useState<string | null>(null);

  // PDF modal (edit / replace)
  const [pdfSite,      setPdfSite]      = useState<Site | null>(null);
  const [replacePdf,   setReplacePdf]   = useState<File | null>(null);
  const [pdfSaving,    setPdfSaving]    = useState(false);
  const [pdfError,     setPdfError]     = useState('');
  const pdfInputRef                     = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const url = includeInactive ? '/api/sites?include_inactive=1' : '/api/sites';
      setSites(await adminGet<Site[]>(url));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [includeInactive]);

  useEffect(() => { load(); }, [load]);

  /* ── Open deactivate modal → fetch preview counts ────────────────── */
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

  /* ── Confirm deactivate → run cascade ────────────────────────────── */
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

  /* ── Reactivate → single click, no modal ─────────────────────────── */
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

  /* ── Upload PDF to a site ───────────────────────────────────────── */
  async function uploadPdfToSite(siteId: string, file: File): Promise<void> {
    const fd = new FormData();
    fd.append('file', file);
    // Do NOT set Content-Type — browser auto-sets multipart/form-data with boundary
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

  /* ── Create site ─────────────────────────────────────────────────── */
  async function createSite() {
    if (!form.name || !form.address || !form.contract_start) {
      setFormError('Site name, address, and contract start are required'); return;
    }
    if (form.contract_end && new Date(form.contract_end) < new Date(form.contract_start)) {
      setFormError('Contract end must be after contract start'); return;
    }
    setSaving(true); setFormError('');
    try {
      const site = await adminPost<{ id: string }>('/api/sites', form);
      if (pdfFile) {
        try { await uploadPdfToSite(site.id, pdfFile); }
        catch (e: any) { setFormError(`Site created but PDF upload failed: ${e.message}`); }
      }
      setShowCreate(false); setForm(EMPTY_FORM); setPdfFile(null);
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  /* ── Replace PDF on existing site ───────────────────────────────── */
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

  /* ── Set geofence ────────────────────────────────────────────────── */
  function openGeo(site: Site) {
    setGeoSite(site);
    // Defend against the API returning the polygon as a JSON string instead
    // of a parsed array — would happen if node-pg's JSONB type parser were
    // ever overridden. Treat anything non-array as "no polygon".
    const raw = site.polygon_coordinates;
    const existing: LatLng[] = Array.isArray(raw) ? raw : [];
    const validExisting = existing.length >= 3;
    // Re-opening an existing fence: a 16-vertex equal-radius ring looks like
    // the legacy radius synth → default to Radius mode. Anything else → Draw.
    const defaultMode: GeoMode = validExisting && !looksLikeCircleSynth(existing) ? 'draw' : 'radius';
    if (site.has_geofence && !validExisting) {
      // eslint-disable-next-line no-console
      console.warn('[geofence] site marked has_geofence=true but polygon missing/short — defaulting to Radius mode', {
        siteId: site.id, rawType: typeof raw, isArray: Array.isArray(raw), length: Array.isArray(raw) ? raw.length : null,
      });
    }
    setGeoMode(defaultMode);
    setDrawnPolygon(validExisting ? existing : []);
    setGeo({
      center_lat:    site.center_lat    != null ? String(site.center_lat)    : '',
      center_lng:    site.center_lng    != null ? String(site.center_lng)    : '',
      radius_meters: site.radius_meters != null ? String(site.radius_meters) : '',
    });
    setGeoError('');
  }

  // Draw mode: auto-fill centre + radius defaults whenever the polygon
  // changes. Admin can override the inputs after; a re-draw stomps the
  // overrides (acceptable per scope — no preservation across re-draws).
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

  /* ── Toggle client access — Fix A: reads client_access_disabled_at ── */
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

  /* ── Render ──────────────────────────────────────────────────────── */
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">SITES</h1>
        <div className="flex items-center gap-4">
          <label className="text-xs tracking-widest text-gray-500 flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={includeInactive}
              onChange={(e) => setIncludeInactive(e.target.checked)}
              className="accent-amber-400"
            />
            SHOW INACTIVE
          </label>
          <button
            onClick={() => { setShowCreate(true); setFormError(''); setForm(EMPTY_FORM); }}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
          >
            + NEW SITE
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left p-4">SITE</th>
              <th className="text-left p-4">CONTRACT</th>
              <th className="text-left p-4">GEOFENCE</th>
              <th className="text-left p-4">INSTRUCTIONS</th>
              <th className="text-left p-4">CLIENT ACCESS UNTIL</th>
              <th className="text-left p-4">DATA DELETION</th>
              <th className="text-right p-4">CLIENT PORTAL</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center text-gray-500 py-10">Loading…</td></tr>
            )}
            {!loading && sites.length === 0 && (
              <tr><td colSpan={6} className="text-center text-gray-500 py-10">No sites yet</td></tr>
            )}
            {sites.map((site) => {
              const deleteIn    = daysUntil(site.data_delete_at);
              const accessIn    = daysUntil(site.client_star_access_until);
              // Fix A: label reads sites.client_access_disabled_at, the
              // column the PATCH /client-access endpoint actually writes.
              // Previously read drl.client_star_access_disabled (a dead
              // legacy retention flag) and always showed "ENABLED".
              const clientEnabled = !site.client_access_disabled_at;
              const isDeactivated = !site.is_active;
              return (
                <tr key={site.id} className={`border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors ${isDeactivated ? 'opacity-60' : ''}`}>
                  <td className="p-4">
                    <p className="text-gray-200 font-medium">
                      {site.name}
                      {isDeactivated && (
                        <span
                          className="ml-2 inline-flex items-center text-[9px] font-bold tracking-widest text-gray-400 bg-gray-800/60 border border-gray-700 rounded px-1.5 py-0.5"
                          title="Deactivated. History remains visible; future work is blocked."
                        >
                          INACTIVE
                        </span>
                      )}
                    </p>
                    <p className="text-gray-500 text-xs">{site.address}</p>
                  </td>
                  <td className="p-4 text-gray-400 text-xs">
                    {fmtDate(site.contract_start)} → {site.contract_end ? fmtDate(site.contract_end) : <span className="text-gray-600 italic">no end date</span>}
                  </td>
                  <td className="p-4">
                    {site.has_geofence ? (
                      <div className="space-y-1">
                        <span className="inline-flex items-center gap-1 text-xs text-green-400">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-400 inline-block" />
                          SET
                        </span>
                        <p className="text-gray-500 text-xs">
                          {site.center_lat?.toFixed(5)}, {site.center_lng?.toFixed(5)}
                        </p>
                        <p className="text-gray-500 text-xs">{site.radius_meters}m radius</p>
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
                  </td>
                  <td className="p-4">
                    {site.instructions_pdf_url ? (
                      <div className="space-y-1">
                        <a href={site.instructions_pdf_url} target="_blank" rel="noopener noreferrer"
                           className="text-xs text-cyan-400 underline">View PDF</a>
                        <br />
                        <button onClick={() => { setPdfSite(site); setReplacePdf(null); setPdfError(''); }}
                                className="text-xs text-amber-400 hover:text-amber-300 underline">Replace</button>
                      </div>
                    ) : (
                      <button onClick={() => { setPdfSite(site); setReplacePdf(null); setPdfError(''); }}
                              className="text-xs text-gray-500 border border-[#1A3050] px-2 py-1 rounded hover:border-amber-400 hover:text-amber-400 transition-colors">
                        + Upload
                      </button>
                    )}
                  </td>
                  <td className="p-4">
                    {site.client_star_access_until ? (
                      <span className={`text-xs ${accessIn !== null && accessIn <= 14 ? 'text-red-400' : 'text-gray-400'}`}>
                        {fmtDate(site.client_star_access_until)}
                        {accessIn !== null && accessIn <= 30 && (
                          <span className="ml-1 text-red-400">({accessIn}d)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="p-4">
                    {site.data_delete_at ? (
                      <span className={`text-xs ${deleteIn !== null && deleteIn <= 30 ? 'text-red-400' : 'text-gray-500'}`}>
                        {fmtDate(site.data_delete_at)}
                        {deleteIn !== null && deleteIn <= 30 && (
                          <span className="ml-1">({deleteIn}d)</span>
                        )}
                      </span>
                    ) : (
                      <span className="text-gray-600 text-xs">—</span>
                    )}
                  </td>
                  <td className="p-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {isDeactivated ? (
                        <button
                          onClick={() => reactivateSite(site.id)}
                          disabled={activeToggling === site.id}
                          className="text-xs tracking-widest px-3 py-1 rounded transition-colors bg-[#0B1526] text-gray-400 border border-[#1A3050] hover:border-amber-400 hover:text-amber-400 disabled:opacity-40"
                        >
                          {activeToggling === site.id ? '…' : 'REACTIVATE'}
                        </button>
                      ) : (
                        <>
                          <button
                            onClick={() => toggleClientAccess(site.id, !clientEnabled)}
                            disabled={toggling === site.id}
                            className={`text-xs tracking-widest px-3 py-1 rounded transition-colors ${
                              clientEnabled
                                ? 'bg-green-900/40 text-green-400 border border-green-700 hover:bg-red-900/40 hover:text-red-400 hover:border-red-700'
                                : 'bg-[#0B1526] text-gray-500 border border-[#1A3050] hover:border-green-700 hover:text-green-400'
                            } disabled:opacity-40`}
                          >
                            {toggling === site.id ? '…' : clientEnabled ? 'ENABLED' : 'DISABLED'}
                          </button>
                          <button
                            onClick={() => openDeactivate(site)}
                            className="text-xs tracking-widest px-3 py-1 rounded bg-[#0B1526] text-gray-500 border border-[#1A3050] hover:border-red-700 hover:text-red-400 transition-colors"
                          >
                            DEACTIVATE
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Create Site Modal ─────────────────────────────────────────── */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">NEW SITE</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">
              {[
                { key: 'name',           label: 'SITE NAME',       type: 'text', placeholder: 'e.g. Westfield Shopping Centre', required: true },
                { key: 'address',        label: 'ADDRESS',         type: 'text', placeholder: 'Full address',                   required: true },
                { key: 'contract_start', label: 'CONTRACT START',  type: 'date', placeholder: '',                               required: true },
              ].map(({ key, label, type, placeholder }) => (
                <div key={key}>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">{label} <span className="text-amber-400">*</span></label>
                  <input
                    type={type} placeholder={placeholder}
                    value={(form as any)[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
              ))}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">
                  CONTRACT END <span className="text-gray-600 text-xs normal-case">(optional)</span>
                </label>
                <input
                  type="date"
                  value={form.contract_end}
                  onChange={(e) => setForm((f) => ({ ...f, contract_end: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>
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
              When a contract end date is set, client access runs to contract end + 90 days and data is hard-deleted at contract end + 150 days.
              <br />
              <span className="text-amber-400/70">You can set the geofence boundary after creating the site.</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowCreate(false)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
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

      {/* ── Set Geofence Modal ────────────────────────────────────────── */}
      {geoSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 overflow-y-auto py-8">
          <div className="w-full max-w-3xl bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">SET GEOFENCE</h2>
              <button onClick={() => setGeoSite(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-xs mb-4">
              Site: <span className="text-gray-300">{geoSite.name}</span>
            </p>

            {/* Mode toggle */}
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

            {geoMode === 'radius' && (
              <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 mb-5 text-xs text-gray-400 space-y-1">
                <p className="text-amber-400 font-bold tracking-widest mb-2">HOW TO GET COORDINATES</p>
                <p>1. Open <span className="text-white">Google Maps</span> and search for the site address.</p>
                <p>2. Right-click on the exact centre of the building/property.</p>
                <p>3. Click the coordinates that appear at the top of the menu — they are copied automatically.</p>
                <p>4. Paste them below (they look like: <span className="text-white font-mono">37.7749, -122.4194</span>).</p>
                <p className="pt-1">Set the radius to cover the full property boundary — e.g. <span className="text-white">50m</span> for a small building, <span className="text-white">200m</span> for a large campus.</p>
              </div>
            )}

            {geoMode === 'draw' && (
              <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 mb-4 text-xs text-gray-400 space-y-1">
                <p className="text-amber-400 font-bold tracking-widest mb-2">HOW TO DRAW</p>
                <p>1. Use the polygon tool in the map (top-right) to click each corner of the property.</p>
                <p>2. Click the first point again to close the boundary.</p>
                <p>3. Drag the vertices to adjust. Use the edit/delete tools to revise.</p>
                <p className="pt-1">Centre and radius below auto-fill from your drawing — you can override them. Radius is the GPS-drift fallback if the polygon ever loads incorrectly on a guard's device.</p>
              </div>
            )}

            {geoError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{geoError}</div>}

            {geoMode === 'draw' && (
              <div className="mb-4">
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
            )}

            <div className="grid grid-cols-2 gap-4 mb-4">
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
            <div className="mb-5">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">RADIUS (METRES) <span className="text-amber-400">*</span></label>
              <input
                type="number" min="10" max="10000" placeholder="e.g. 100"
                value={geo.radius_meters}
                onChange={(e) => setGeo((g) => ({ ...g, radius_meters: e.target.value }))}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
              />
              <p className="text-gray-600 text-xs mt-1">
                {geoMode === 'radius'
                  ? 'Guards outside this radius will trigger a geofence violation alert. A 16-point circular boundary is auto-generated from your centre + radius.'
                  : 'Radius is the GPS-drift fallback — guards inside the polygon OR within this radius are considered on-post.'}
              </p>
            </div>

            {/* Live preview of what they entered */}
            {geo.center_lat && geo.center_lng && geo.radius_meters && (
              <div className="bg-[#0B1526] border border-amber-400/30 rounded-lg p-3 mb-5 text-xs text-gray-400">
                <p className="text-amber-400 font-bold tracking-widest mb-1">PREVIEW</p>
                <p>Centre: <span className="text-white font-mono">{geo.center_lat}, {geo.center_lng}</span></p>
                <p>Boundary radius: <span className="text-white">{geo.radius_meters}m</span>
                  {Number(geo.radius_meters) > 0 && (
                    <span className="ml-2 text-gray-500">
                      (~{(Number(geo.radius_meters) * 2).toFixed(0)}m diameter)
                    </span>
                  )}
                </p>
                {geoMode === 'draw' && (
                  <p>Polygon: <span className="text-white">{drawnPolygon.length} vertices</span></p>
                )}
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

            <div className="flex gap-3">
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
