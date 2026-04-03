'use client';
/**
 * Vishnu — All Sites (/vishnu/sites)
 * Every site across all companies. Shows effective photo limit with per-site
 * override capability. Guards-on-duty live count.
 */
import { useCallback, useEffect, useState } from 'react';
import { vishnuGet, vishnuPatch } from '../../../lib/vishnuApi';

interface Site {
  id:                    string;
  name:                  string;
  address:               string;
  is_active:             boolean;
  contract_start:        string;
  contract_end:          string;
  photo_limit_override:  number | null;
  company_id:            string;
  company_name:          string;
  default_photo_limit:   number;
  effective_photo_limit: number;
  guards_on_duty:        string;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function contractStatus(end: string): { label: string; color: string } {
  const days = Math.ceil((new Date(end).getTime() - Date.now()) / 86_400_000);
  if (days < 0)   return { label: 'EXPIRED',  color: 'text-red-400' };
  if (days < 30)  return { label: `${days}d`,  color: 'text-orange-400' };
  if (days < 90)  return { label: `${days}d`,  color: 'text-yellow-400' };
  return             { label: `${days}d`,  color: 'text-green-400' };
}

export default function AllSitesPage() {
  const [sites,        setSites]        = useState<Site[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [error,        setError]        = useState('');
  const [search,       setSearch]       = useState('');
  const [companyFilter, setCompanyFilter] = useState('');
  const [editSiteId,   setEditSiteId]   = useState<string | null>(null);
  const [overrideVal,  setOverrideVal]  = useState('');
  const [saving,       setSaving]       = useState(false);

  const load = useCallback(async () => {
    try {
      setSites(await vishnuGet<Site[]>('/api/admin/all-sites'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveOverride(siteId: string) {
    setSaving(true);
    try {
      const val = overrideVal === '' ? null : parseInt(overrideVal);
      await vishnuPatch(`/api/admin/sites/${siteId}/photo-limit`, { photo_limit_override: val });
      setEditSiteId(null); setOverrideVal('');
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  }

  // Unique companies for filter
  const companies = Array.from(new Map(sites.map((s) => [s.company_id, s.company_name])).entries());

  const visible = sites.filter((s) => {
    const matchSearch  = !search  || s.name.toLowerCase().includes(search.toLowerCase()) || s.company_name.toLowerCase().includes(search.toLowerCase());
    const matchCompany = !companyFilter || s.company_id === companyFilter;
    return matchSearch && matchCompany;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-gray-300">ALL SITES</h1>
        <span className="text-gray-600 text-xs tracking-widest">{visible.length} SITES</span>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      <div className="flex gap-3">
        <input
          type="text" placeholder="Search sites or companies…" value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 bg-[#242436] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-300 text-sm focus:outline-none focus:border-gray-500"
        />
        <select
          value={companyFilter} onChange={(e) => setCompanyFilter(e.target.value)}
          className="bg-[#242436] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-300 text-xs tracking-widest focus:outline-none focus:border-gray-500"
        >
          <option value="">ALL COMPANIES</option>
          {companies.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </div>

      <div className="bg-[#242436] border border-[#2E2E48] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-600 text-xs tracking-widest border-b border-[#2E2E48]">
              <th className="text-left p-4">SITE</th>
              <th className="text-left p-4">COMPANY</th>
              <th className="text-center p-4">CONTRACT</th>
              <th className="text-center p-4">ON DUTY</th>
              <th className="text-center p-4">PHOTO LIMIT</th>
              <th className="text-center p-4">OVERRIDE</th>
              <th className="text-center p-4">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center text-gray-500 py-10">Loading…</td></tr>}
            {!loading && visible.length === 0 && <tr><td colSpan={7} className="text-center text-gray-500 py-10">No sites found</td></tr>}
            {visible.map((s) => {
              const cs = contractStatus(s.contract_end);
              return (
                <tr key={s.id} className={`border-b border-[#2E2E48] transition-colors ${s.is_active ? 'hover:bg-[#1A1A2E]' : 'opacity-50'}`}>
                  <td className="p-4">
                    <p className="text-gray-200 font-medium">{s.name}</p>
                    <p className="text-gray-600 text-xs truncate max-w-xs">{s.address}</p>
                  </td>
                  <td className="p-4 text-gray-400 text-xs">{s.company_name}</td>
                  <td className="p-4 text-center">
                    <p className="text-gray-500 text-xs">{fmtDate(s.contract_end)}</p>
                    <p className={`text-xs font-medium ${cs.color}`}>{cs.label}</p>
                  </td>
                  <td className="p-4 text-center">
                    <span className={`text-sm font-bold ${parseInt(s.guards_on_duty) > 0 ? 'text-green-400' : 'text-gray-600'}`}>
                      {s.guards_on_duty}
                    </span>
                  </td>
                  <td className="p-4 text-center">
                    <span className="text-gray-300 font-bold">{s.effective_photo_limit}</span>
                    <p className="text-gray-600 text-xs">per report</p>
                  </td>
                  <td className="p-4 text-center">
                    {editSiteId === s.id ? (
                      <div className="flex items-center gap-1 justify-center">
                        <input
                          autoFocus type="number" min={1} max={20}
                          value={overrideVal}
                          onChange={(e) => setOverrideVal(e.target.value)}
                          placeholder="—"
                          className="w-12 bg-[#1A1A2E] border border-gray-600 rounded px-1 py-0.5 text-gray-200 text-xs text-center focus:outline-none"
                        />
                        <button onClick={() => saveOverride(s.id)} disabled={saving} className="text-xs text-green-400 hover:text-green-300 disabled:opacity-40">✓</button>
                        <button onClick={() => { setEditSiteId(null); setOverrideVal(''); }} className="text-xs text-gray-500 hover:text-gray-300">✕</button>
                      </div>
                    ) : (
                      <button
                        onClick={() => { setEditSiteId(s.id); setOverrideVal(s.photo_limit_override != null ? String(s.photo_limit_override) : ''); }}
                        className="text-xs text-gray-500 hover:text-gray-300 border border-[#2E2E48] hover:border-gray-500 px-2 py-0.5 rounded transition-colors"
                      >
                        {s.photo_limit_override != null ? `${s.photo_limit_override} ✎` : 'SET'}
                      </button>
                    )}
                  </td>
                  <td className="p-4 text-center">
                    <span className={`text-xs tracking-widest ${s.is_active ? 'text-green-400' : 'text-gray-600'}`}>
                      {s.is_active ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="text-xs text-gray-700 text-center">
        Override sets a per-site photo limit. Leave blank to inherit company default. Changes apply immediately.
      </div>
    </div>
  );
}
