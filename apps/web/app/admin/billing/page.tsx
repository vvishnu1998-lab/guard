'use client';
/**
 * Admin — Billing (/admin/billing)
 * Download on-demand hours reports (XLSX) and view auto-generated monthly reports.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet } from '../../../lib/adminApi';

interface Guard { id: string; name: string; }
interface Site  { id: string; name: string; }
interface MonthlyReport {
  id:           string;
  month:        number;
  year:         number;
  s3_url:       string;
  generated_at: string;
}

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
function getAdminToken() {
  if (typeof document === 'undefined') return '';
  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';
}

export default function BillingPage() {
  const [guards,   setGuards]   = useState<Guard[]>([]);
  const [sites,    setSites]    = useState<Site[]>([]);
  const [monthly,  setMonthly]  = useState<MonthlyReport[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');

  // Export form state
  const [startDate,  setStartDate]  = useState('');
  const [endDate,    setEndDate]    = useState('');
  const [siteFilter, setSiteFilter] = useState('');
  const [guardFilter,setGuardFilter] = useState('');
  const [exporting,  setExporting]  = useState<'overall' | 'guard' | 'site' | null>(null);
  const [exportError,setExportError] = useState('');

  const load = useCallback(async () => {
    try {
      const [g, s, m] = await Promise.all([
        adminGet<Guard[]>('/api/guards'),
        adminGet<Site[]>('/api/sites'),
        adminGet<MonthlyReport[]>('/api/billing/hours-export/monthly'),
      ]);
      setGuards(g);
      setSites(s);
      setMonthly(m);
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  /**
   * The server names the file. Content-Disposition carries the tenant slug and
   * the real end date for an open range, both of which the client cannot
   * derive — so the page must not invent a name.
   *
   * A blob: URL has no filename of its own, so the anchor's download attribute
   * is what the browser saves as. That means the header has to be READ and
   * copied across; letting the anchor "inherit" it is not a thing. The header
   * is only readable because the API sends
   * Access-Control-Expose-Headers: Content-Disposition (7c7cace) — this fetch
   * is cross-origin, Vercel to Railway, and Content-Disposition is not
   * CORS-safelisted.
   */
  function filenameFromDisposition(header: string | null): string | null {
    if (!header) return null;
    const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (encoded) { try { return decodeURIComponent(encoded[1]); } catch { /* fall through */ } }
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain ? plain[1].trim() : null;
  }

  type Scope = 'overall' | 'guard' | 'site';

  async function exportExcel(scope: Scope) {
    setExporting(scope); setExportError('');
    try {
      const params = new URLSearchParams();
      if (startDate) params.set('start_date', startDate);
      if (endDate)   params.set('end_date',   endDate);
      if (scope === 'guard') {
        if (!guardFilter) throw new Error('Choose a guard first.');
        params.set('guard_id', guardFilter);
      }
      if (scope === 'site') {
        if (!siteFilter) throw new Error('Choose a site first.');
        params.set('site_id', siteFilter);
      }

      const res = await fetch(`${API}/api/billing/hours-export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${getAdminToken()}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? `Export failed: ${res.status}`);
      }

      const serverName = filenameFromDisposition(res.headers.get('content-disposition'));
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url;
      // Only set a name if the server gave one. Left unset the browser saves
      // the blob UUID, so a missing header is worth surfacing rather than
      // papering over with a guess that contradicts the file's own title.
      if (serverName) a.download = serverName;
      else console.warn('[billing] no Content-Disposition filename on the export response');
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setExportError(e.message); }
    finally { setExporting(null); }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-[#C9A84C]">BILLING</h1>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* ── Section 1: Download Hours Report ─────────────────────── */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
        <h2 className="text-white font-bold tracking-widest text-base mb-1">DOWNLOAD HOURS REPORT</h2>
        <p className="text-gray-500 text-xs mb-5">
          Export an Excel spreadsheet of all completed shifts with clock-in/out times, break duration, and total hours.
        </p>

        {exportError && (
          <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{exportError}</div>
        )}

        {/* Date range — applies to all three exports below. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
          <div>
            <label htmlFor="start-date" className="block text-gray-500 text-xs tracking-widest mb-1">START DATE</label>
            <input
              id="start-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-[#00C8FF]"
            />
          </div>
          <div>
            <label htmlFor="end-date" className="block text-gray-500 text-xs tracking-widest mb-1">END DATE</label>
            <input
              id="end-date" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-[#00C8FF]"
            />
          </div>
        </div>
        <p className="text-gray-600 text-xs mb-5">
          Leave END DATE empty for an open range — the report runs to today and says so.
        </p>

        {/* Three scoped exports. Each is its own control so the scope of the
            file is chosen deliberately, rather than inferred from whichever
            filters happen to be set. */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Overall */}
          <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 flex flex-col">
            <h3 className="text-[#C9A84C] font-bold tracking-widest text-xs mb-1">OVERALL</h3>
            <p className="text-gray-500 text-xs mb-4 flex-1">Every guard and every site in the range.</p>
            <button
              onClick={() => exportExcel('overall')}
              disabled={exporting !== null || loading}
              className="w-full bg-[#00C8FF] text-[#0B1526] font-bold tracking-widest text-sm px-4 py-2.5 rounded-lg hover:bg-[#33D4FF] disabled:opacity-40 transition-colors"
            >
              {exporting === 'overall' ? 'GENERATING…' : '⬇ EXPORT'}
            </button>
          </div>

          {/* Per guard */}
          <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 flex flex-col">
            <h3 className="text-[#C9A84C] font-bold tracking-widest text-xs mb-1">PER GUARD</h3>
            <label htmlFor="guard-select" className="sr-only">Guard</label>
            <select
              id="guard-select" value={guardFilter} onChange={(e) => setGuardFilter(e.target.value)}
              className="w-full bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm mb-4 focus:outline-none focus:border-[#00C8FF]"
            >
              <option value="">Choose a guard…</option>
              {guards.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
            <button
              onClick={() => exportExcel('guard')}
              disabled={exporting !== null || loading || !guardFilter}
              className="w-full bg-[#00C8FF] text-[#0B1526] font-bold tracking-widest text-sm px-4 py-2.5 rounded-lg hover:bg-[#33D4FF] disabled:opacity-40 transition-colors"
            >
              {exporting === 'guard' ? 'GENERATING…' : '⬇ EXPORT'}
            </button>
          </div>

          {/* Per site */}
          <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg p-4 flex flex-col">
            <h3 className="text-[#C9A84C] font-bold tracking-widest text-xs mb-1">PER SITE</h3>
            <label htmlFor="site-select" className="sr-only">Site</label>
            <select
              id="site-select" value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}
              className="w-full bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm mb-4 focus:outline-none focus:border-[#00C8FF]"
            >
              <option value="">Choose a site…</option>
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <button
              onClick={() => exportExcel('site')}
              disabled={exporting !== null || loading || !siteFilter}
              className="w-full bg-[#00C8FF] text-[#0B1526] font-bold tracking-widest text-sm px-4 py-2.5 rounded-lg hover:bg-[#33D4FF] disabled:opacity-40 transition-colors"
            >
              {exporting === 'site' ? 'GENERATING…' : '⬇ EXPORT'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Section 2: Monthly Reports ────────────────────────────── */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
        <h2 className="text-white font-bold tracking-widest text-base mb-1">MONTHLY REPORTS</h2>
        <p className="text-gray-500 text-xs mb-5">
          Auto-generated on the 1st of each month for the previous month. Stored in S3.
        </p>

        {loading ? (
          <p className="text-gray-500 text-sm py-4">Loading…</p>
        ) : monthly.length === 0 ? (
          <div className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-4 py-8 text-center">
            <p className="text-gray-500 text-sm">No monthly reports generated yet.</p>
            <p className="text-gray-600 text-xs mt-1">Reports are generated automatically on the 1st of each month.</p>
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-[#1A3050]">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                  <th className="text-left p-4">MONTH</th>
                  <th className="text-left p-4">YEAR</th>
                  <th className="text-left p-4">GENERATED</th>
                  <th className="text-right p-4">DOWNLOAD</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map((r) => (
                  <tr key={r.id} className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors">
                    <td className="p-4 text-gray-200 font-medium">{MONTH_NAMES[r.month - 1]}</td>
                    <td className="p-4 text-gray-400">{r.year}</td>
                    <td className="p-4 text-gray-500 text-xs">
                      {new Date(r.generated_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td className="p-4 text-right">
                      <a
                        href={r.s3_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block bg-[#0B1526] border border-[#1A3050] text-[#00C8FF] text-xs tracking-widest px-3 py-1.5 rounded hover:border-[#00C8FF] transition-colors"
                      >
                        ⬇ DOWNLOAD
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
