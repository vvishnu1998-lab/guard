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
  const [exporting,  setExporting]  = useState(false);
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

  async function exportExcel() {
    setExporting(true); setExportError('');
    try {
      const params = new URLSearchParams();
      if (startDate)  params.set('start_date', startDate);
      if (endDate)    params.set('end_date',   endDate);
      if (siteFilter) params.set('site_id',    siteFilter);
      if (guardFilter)params.set('guard_id',   guardFilter);

      const res = await fetch(`${API}/api/billing/hours-export?${params.toString()}`, {
        headers: { Authorization: `Bearer ${getAdminToken()}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error ?? `Export failed: ${res.status}`);
      }

      // Trigger browser download
      const blob = await res.blob();
      const sd = startDate || 'all';
      const ed = endDate   || 'all';
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href     = url;
      a.download = `vwing-hours-${sd}-to-${ed}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: any) { setExportError(e.message); }
    finally { setExporting(false); }
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">BILLING</h1>
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

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">START DATE</label>
            <input
              type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
            />
          </div>
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">END DATE</label>
            <input
              type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
            />
          </div>
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE</label>
            <select
              value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
            >
              <option value="">All Sites</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD</label>
            <select
              value={guardFilter} onChange={(e) => setGuardFilter(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
            >
              <option value="">All Guards</option>
              {guards.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        </div>

        <button
          onClick={exportExcel}
          disabled={exporting || loading}
          className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-6 py-2.5 rounded-lg hover:bg-amber-300 disabled:opacity-40 transition-colors"
        >
          {exporting ? 'GENERATING…' : '⬇ EXPORT EXCEL'}
        </button>
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
                        className="inline-block bg-[#0B1526] border border-[#1A3050] text-amber-400 text-xs tracking-widest px-3 py-1.5 rounded hover:border-amber-400 transition-colors"
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
