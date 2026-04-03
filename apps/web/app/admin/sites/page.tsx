'use client';
/**
 * Admin — Sites Management (/admin/sites)
 * List sites, create new site, set geofence, toggle client portal access.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost, adminPatch } from '../../../lib/adminApi';

interface Site {
  id:                          string;
  name:                        string;
  address:                     string;
  contract_start:              string;
  contract_end:                string;
  client_star_access_until:    string | null;
  data_delete_at:              string | null;
  client_star_access_disabled: boolean | null;
  has_geofence:                boolean;
  center_lat:                  number | null;
  center_lng:                  number | null;
  radius_meters:               number | null;
}

const EMPTY_FORM = { name: '', address: '', contract_start: '', contract_end: '' };
const EMPTY_GEO  = { center_lat: '', center_lng: '', radius_meters: '' };

/** Generate an N-point circle polygon from a center + radius (in metres). */
function circlePolygon(
  lat: number, lng: number, radiusM: number, points = 16
): { lat: number; lng: number }[] {
  const coords = [];
  const latR   = lat * (Math.PI / 180);
  const dLat   = radiusM / 111_320;
  const dLng   = radiusM / (111_320 * Math.cos(latR));
  for (let i = 0; i < points; i++) {
    const angle = (2 * Math.PI * i) / points;
    coords.push({
      lat: lat + dLat * Math.cos(angle),
      lng: lng + dLng * Math.sin(angle),
    });
  }
  return coords;
}

export default function SitesPage() {
  const [sites,        setSites]        = useState<Site[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');

  // create-site modal
  const [showCreate,   setShowCreate]   = useState(false);
  const [form,         setForm]         = useState(EMPTY_FORM);
  const [saving,       setSaving]       = useState(false);
  const [formError,    setFormError]    = useState('');

  // geofence modal
  const [geoSite,      setGeoSite]      = useState<Site | null>(null);
  const [geo,          setGeo]          = useState(EMPTY_GEO);
  const [geoSaving,    setGeoSaving]    = useState(false);
  const [geoError,     setGeoError]     = useState('');

  const [toggling,     setToggling]     = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSites(await adminGet<Site[]>('/api/sites'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ── Create site ─────────────────────────────────────────────────── */
  async function createSite() {
    if (!form.name || !form.address || !form.contract_start || !form.contract_end) {
      setFormError('All fields are required'); return;
    }
    setSaving(true); setFormError('');
    try {
      await adminPost('/api/sites', form);
      setShowCreate(false); setForm(EMPTY_FORM);
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  /* ── Set geofence ────────────────────────────────────────────────── */
  function openGeo(site: Site) {
    setGeoSite(site);
    setGeo({
      center_lat:    site.center_lat    != null ? String(site.center_lat)    : '',
      center_lng:    site.center_lng    != null ? String(site.center_lng)    : '',
      radius_meters: site.radius_meters != null ? String(site.radius_meters) : '',
    });
    setGeoError('');
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
    setGeoSaving(true); setGeoError('');
    try {
      await adminPatch(`/api/sites/${geoSite!.id}/geofence`, {
        center_lat:          lat,
        center_lng:          lng,
        radius_meters:       rad,
        polygon_coordinates: circlePolygon(lat, lng, rad),
      });
      setGeoSite(null);
      await load();
    } catch (e: any) { setGeoError(e.message); }
    finally { setGeoSaving(false); }
  }

  /* ── Toggle client access ────────────────────────────────────────── */
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
        <button
          onClick={() => { setShowCreate(true); setFormError(''); setForm(EMPTY_FORM); }}
          className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
        >
          + NEW SITE
        </button>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      <div className="bg-[#242436] border border-[#2E2E48] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs tracking-widest border-b border-[#2E2E48]">
              <th className="text-left p-4">SITE</th>
              <th className="text-left p-4">CONTRACT</th>
              <th className="text-left p-4">GEOFENCE</th>
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
              const clientEnabled = !site.client_star_access_disabled;
              return (
                <tr key={site.id} className="border-b border-[#2E2E48] hover:bg-[#1A1A2E] transition-colors">
                  <td className="p-4">
                    <p className="text-gray-200 font-medium">{site.name}</p>
                    <p className="text-gray-500 text-xs">{site.address}</p>
                  </td>
                  <td className="p-4 text-gray-400 text-xs">
                    {fmtDate(site.contract_start)} → {fmtDate(site.contract_end)}
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
                    <span className={`text-xs ${accessIn !== null && accessIn <= 14 ? 'text-red-400' : 'text-gray-400'}`}>
                      {fmtDate(site.client_star_access_until)}
                      {accessIn !== null && accessIn <= 30 && (
                        <span className="ml-1 text-red-400">({accessIn}d)</span>
                      )}
                    </span>
                  </td>
                  <td className="p-4">
                    <span className={`text-xs ${deleteIn !== null && deleteIn <= 30 ? 'text-red-400' : 'text-gray-500'}`}>
                      {fmtDate(site.data_delete_at)}
                      {deleteIn !== null && deleteIn <= 30 && (
                        <span className="ml-1">({deleteIn}d)</span>
                      )}
                    </span>
                  </td>
                  <td className="p-4 text-right">
                    <button
                      onClick={() => toggleClientAccess(site.id, !clientEnabled)}
                      disabled={toggling === site.id}
                      className={`text-xs tracking-widest px-3 py-1 rounded transition-colors ${
                        clientEnabled
                          ? 'bg-green-900/40 text-green-400 border border-green-700 hover:bg-red-900/40 hover:text-red-400 hover:border-red-700'
                          : 'bg-[#1A1A2E] text-gray-500 border border-[#2E2E48] hover:border-green-700 hover:text-green-400'
                      } disabled:opacity-40`}
                    >
                      {toggling === site.id ? '…' : clientEnabled ? 'ENABLED' : 'DISABLED'}
                    </button>
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
          <div className="w-full max-w-md bg-[#242436] border border-[#2E2E48] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">NEW SITE</h2>
              <button onClick={() => setShowCreate(false)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">
              {[
                { key: 'name',           label: 'SITE NAME',       type: 'text', placeholder: 'e.g. Westfield Shopping Centre' },
                { key: 'address',        label: 'ADDRESS',         type: 'text', placeholder: 'Full address' },
                { key: 'contract_start', label: 'CONTRACT START',  type: 'date', placeholder: '' },
                { key: 'contract_end',   label: 'CONTRACT END',    type: 'date', placeholder: '' },
              ].map(({ key, label, type, placeholder }) => (
                <div key={key}>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">{label} <span className="text-amber-400">*</span></label>
                  <input
                    type={type} placeholder={placeholder}
                    value={(form as any)[key]}
                    onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
                    className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
              ))}
            </div>
            <p className="text-gray-500 text-xs mt-3 mb-5">
              Client access runs to contract end + 90 days. Data is hard-deleted at contract end + 150 days.
              <br />
              <span className="text-amber-400/70">You can set the geofence boundary after creating the site.</span>
            </p>
            <div className="flex gap-3">
              <button onClick={() => setShowCreate(false)} className="flex-1 border border-[#2E2E48] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={createSite} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'CREATING…' : 'CREATE SITE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Set Geofence Modal ────────────────────────────────────────── */}
      {geoSite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg bg-[#242436] border border-[#2E2E48] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">SET GEOFENCE</h2>
              <button onClick={() => setGeoSite(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-xs mb-5">
              Site: <span className="text-gray-300">{geoSite.name}</span>
            </p>

            {/* How to find coordinates */}
            <div className="bg-[#1A1A2E] border border-[#2E2E48] rounded-lg p-4 mb-5 text-xs text-gray-400 space-y-1">
              <p className="text-amber-400 font-bold tracking-widest mb-2">HOW TO GET COORDINATES</p>
              <p>1. Open <span className="text-white">Google Maps</span> and search for the site address.</p>
              <p>2. Right-click on the exact centre of the building/property.</p>
              <p>3. Click the coordinates that appear at the top of the menu — they are copied automatically.</p>
              <p>4. Paste them below (they look like: <span className="text-white font-mono">37.7749, -122.4194</span>).</p>
              <p className="pt-1">Set the radius to cover the full property boundary — e.g. <span className="text-white">50m</span> for a small building, <span className="text-white">200m</span> for a large campus.</p>
            </div>

            {geoError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{geoError}</div>}

            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">LATITUDE <span className="text-amber-400">*</span></label>
                <input
                  type="number" step="any" placeholder="e.g. 37.7749"
                  value={geo.center_lat}
                  onChange={(e) => setGeo((g) => ({ ...g, center_lat: e.target.value }))}
                  className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">LONGITUDE <span className="text-amber-400">*</span></label>
                <input
                  type="number" step="any" placeholder="e.g. -122.4194"
                  value={geo.center_lng}
                  onChange={(e) => setGeo((g) => ({ ...g, center_lng: e.target.value }))}
                  className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                />
              </div>
            </div>
            <div className="mb-5">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">RADIUS (METRES) <span className="text-amber-400">*</span></label>
              <input
                type="number" min="10" max="10000" placeholder="e.g. 100"
                value={geo.radius_meters}
                onChange={(e) => setGeo((g) => ({ ...g, radius_meters: e.target.value }))}
                className="w-full bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
              />
              <p className="text-gray-600 text-xs mt-1">
                Guards outside this radius will trigger a geofence violation alert.
                A 16-point circular boundary is auto-generated from your centre + radius.
              </p>
            </div>

            {/* Live preview of what they entered */}
            {geo.center_lat && geo.center_lng && geo.radius_meters && (
              <div className="bg-[#1A1A2E] border border-amber-400/30 rounded-lg p-3 mb-5 text-xs text-gray-400">
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

            <div className="flex gap-3">
              <button onClick={() => setGeoSite(null)} className="flex-1 border border-[#2E2E48] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={saveGeofence} disabled={geoSaving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {geoSaving ? 'SAVING…' : 'SAVE GEOFENCE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
