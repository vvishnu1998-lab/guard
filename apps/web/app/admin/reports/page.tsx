'use client';
/**
 * Admin — Reports Feed (/admin/reports)
 * All company reports with type / severity / site / date filters.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet } from '../../../lib/adminApi';

interface Report {
  id:               string;
  report_type:      'activity' | 'incident' | 'maintenance';
  severity:         'low' | 'medium' | 'high' | 'critical' | null;
  description:      string;
  guard_name:       string;
  site_name:        string;
  reported_at:      string;
  photos:           string[] | null;
}

interface Site { id: string; name: string; }

const TYPE_BADGE: Record<string, string> = {
  activity:    'bg-amber-900/40 text-amber-400 border-amber-700',
  incident:    'bg-red-900/40 text-red-400 border-red-700',
  maintenance: 'bg-blue-900/40 text-blue-400 border-blue-700',
};

const SEV_BADGE: Record<string, string> = {
  low:      'text-gray-400',
  medium:   'text-yellow-400',
  high:     'text-orange-400',
  critical: 'text-red-400 font-bold',
};

function fmtDT(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ReportsPage() {
  const [reports,   setReports]   = useState<Report[]>([]);
  const [sites,     setSites]     = useState<Site[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [expanded,  setExpanded]  = useState<string | null>(null);

  const [filters, setFilters] = useState({
    type: '', severity: '', site_id: '', date_from: '', date_to: '',
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filters.type)      params.set('type',      filters.type);
      if (filters.severity)  params.set('severity',  filters.severity);
      if (filters.site_id)   params.set('site_id',   filters.site_id);
      if (filters.date_from) params.set('date_from', filters.date_from);
      if (filters.date_to)   params.set('date_to',   filters.date_to + 'T23:59:59');

      const [r, s] = await Promise.all([
        adminGet<Report[]>(`/api/reports${params.size ? '?' + params : ''}`),
        adminGet<Site[]>('/api/sites'),
      ]);
      setReports(Array.isArray(r) ? r : []);
      setSites(Array.isArray(s) ? s : []);
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  function setFilter(key: string, val: string) {
    setFilters((f) => ({ ...f, [key]: val }));
  }

  const filtered = reports;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">REPORTS</h1>
        <span className="text-gray-500 text-xs tracking-widest">{filtered.length} RESULTS</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select value={filters.type} onChange={(e) => setFilter('type', e.target.value)}
          className="bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-300 text-xs tracking-widest focus:outline-none focus:border-amber-400">
          <option value="">ALL TYPES</option>
          <option value="activity">ACTIVITY</option>
          <option value="incident">INCIDENT</option>
          <option value="maintenance">MAINTENANCE</option>
        </select>
        <select value={filters.severity} onChange={(e) => setFilter('severity', e.target.value)}
          className="bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-300 text-xs tracking-widest focus:outline-none focus:border-amber-400">
          <option value="">ALL SEVERITIES</option>
          <option value="low">LOW</option>
          <option value="medium">MEDIUM</option>
          <option value="high">HIGH</option>
          <option value="critical">CRITICAL</option>
        </select>
        <select value={filters.site_id} onChange={(e) => setFilter('site_id', e.target.value)}
          className="bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-300 text-xs tracking-widest focus:outline-none focus:border-amber-400">
          <option value="">ALL SITES</option>
          {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <input type="date" value={filters.date_from} onChange={(e) => setFilter('date_from', e.target.value)}
          placeholder="FROM"
          className="bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-300 text-xs focus:outline-none focus:border-amber-400" />
        <input type="date" value={filters.date_to} onChange={(e) => setFilter('date_to', e.target.value)}
          placeholder="TO"
          className="bg-[#1A1A2E] border border-[#2E2E48] rounded-lg px-3 py-2 text-gray-300 text-xs focus:outline-none focus:border-amber-400" />
        {Object.values(filters).some(Boolean) && (
          <button
            onClick={() => setFilters({ type: '', severity: '', site_id: '', date_from: '', date_to: '' })}
            className="text-xs text-gray-500 tracking-widest hover:text-amber-400 transition-colors"
          >
            CLEAR
          </button>
        )}
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      <div className="space-y-3">
        {loading && <p className="text-center text-gray-500 py-10 text-sm">Loading…</p>}
        {!loading && filtered.length === 0 && <p className="text-center text-gray-500 py-10 text-sm">No reports found</p>}
        {filtered.map((r) => (
          <div key={r.id} className="bg-[#242436] border border-[#2E2E48] rounded-xl overflow-hidden">
            {/* Header row */}
            <button
              className="w-full text-left p-4 flex items-start gap-4 hover:bg-[#1A1A2E] transition-colors"
              onClick={() => setExpanded(expanded === r.id ? null : r.id)}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap mb-1">
                  <span className={`text-xs tracking-widest px-2 py-0.5 rounded border ${TYPE_BADGE[r.report_type]}`}>
                    {r.report_type.toUpperCase()}
                  </span>
                  {r.severity && (
                    <span className={`text-xs tracking-widest ${SEV_BADGE[r.severity]}`}>
                      {r.severity.toUpperCase()}
                    </span>
                  )}
                  {r.photos && r.photos.length > 0 && (
                    <span className="text-xs text-gray-600 tracking-widest">{r.photos.length} PHOTO{r.photos.length > 1 ? 'S' : ''}</span>
                  )}
                </div>
                <p className="text-gray-300 text-sm line-clamp-2">{r.description}</p>
              </div>
              <div className="text-right shrink-0">
                <p className="text-gray-400 text-xs">{r.guard_name}</p>
                <p className="text-gray-600 text-xs">{r.site_name}</p>
                <p className="text-gray-600 text-xs mt-1">{fmtDT(r.reported_at)}</p>
              </div>
            </button>

            {/* Expanded detail */}
            {expanded === r.id && (
              <div className="border-t border-[#2E2E48] px-4 py-3 space-y-3">
                <p className="text-gray-300 text-sm whitespace-pre-wrap">{r.description}</p>
                {r.photos && r.photos.length > 0 && (
                  <div className="flex gap-2 flex-wrap">
                    {r.photos.map((url, i) => (
                      <a key={i} href={url} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={url} alt={`Photo ${i + 1}`} className="w-24 h-24 object-cover rounded-lg border border-[#2E2E48] hover:border-amber-400 transition-colors" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
