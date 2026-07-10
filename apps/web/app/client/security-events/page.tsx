'use client';
/**
 * Client Portal — Security Events (/client/security-events)
 * Read-only geofence violation feed scoped to the client's site.
 * No coords, no photos — matches the privacy contract on the guards-on-duty page.
 */
import { useCallback, useEffect, useState } from 'react';
import { clientGet } from '../../../lib/clientApi';

interface Violation {
  id:               string;
  occurred_at:      string;
  resolved_at:      string | null;
  duration_minutes: number | null;
  is_resolved:      boolean;
  guard_name:       string;
}

interface Resp {
  rows:   Violation[];
  total:  number;
  limit:  number;
  offset: number;
}

type StatusFilter = 'ALL' | 'OPEN' | 'RESOLVED';

const PAGE_SIZE = 50;

export default function SecurityEventsPage() {
  const [rows,   setRows]   = useState<Violation[]>([]);
  const [total,  setTotal]  = useState(0);
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<StatusFilter>('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams({
        limit:  String(PAGE_SIZE),
        offset: String(offset),
        status,
      });
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo)   params.set('date_to',   dateTo);
      if (!dateFrom && !dateTo) params.set('since', '30d');
      const r = await clientGet<Resp>(`/api/client/violations?${params.toString()}`);
      setRows(r.rows);
      setTotal(r.total);
      setError('');
    } catch (e: any) {
      if (e.message?.includes('401') || e.message?.includes('Missing')) {
        window.location.href = '/client/login';
        return;
      }
      setError(e.message);
    } finally { setLoading(false); }
  }, [status, dateFrom, dateTo, offset]);

  useEffect(() => { load(); }, [load]);
  // Reset paging whenever the filter changes.
  useEffect(() => { setOffset(0); }, [status, dateFrom, dateTo]);

  const page       = Math.floor(offset / PAGE_SIZE) + 1;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = total === 0 ? 0 : offset + 1;
  const end   = Math.min(offset + PAGE_SIZE, total);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">SECURITY EVENTS</h1>
        <p className="text-gray-500 text-xs tracking-widest mt-1">Geofence events at your site</p>
      </div>

      {/* Filter bar */}
      <div className="flex items-center flex-wrap gap-3 bg-[#0F1E35] border border-[#1A3050] rounded-lg p-3">
        <div className="flex items-center gap-1 bg-[#0F1E35] border border-[#1A3050] rounded-lg p-1">
          {(['ALL', 'OPEN', 'RESOLVED'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded text-xs tracking-widest transition-colors ${
                status === s ? 'bg-amber-500 text-black font-bold' : 'text-gray-500 hover:text-gray-300'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <label className="text-gray-500 text-[10px] tracking-widest">FROM</label>
          <input
            type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="bg-[#0B1526] border border-[#1A3050] text-gray-300 text-xs rounded p-1.5"
          />
          <label className="text-gray-500 text-[10px] tracking-widest">TO</label>
          <input
            type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="bg-[#0B1526] border border-[#1A3050] text-gray-300 text-xs rounded p-1.5"
          />
        </div>
        {(dateFrom || dateTo || status !== 'ALL') && (
          <button
            onClick={() => { setDateFrom(''); setDateTo(''); setStatus('ALL'); }}
            className="text-gray-500 hover:text-gray-300 text-xs tracking-widest px-2 py-1.5 border border-[#1A3050] rounded hover:border-gray-500 transition-colors"
          >
            CLEAR
          </button>
        )}
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Table */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        {loading ? (
          <p className="p-8 text-center text-gray-500">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="p-8 text-center text-gray-500">No security events in the selected period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                  <th className="text-left p-4">OCCURRED</th>
                  <th className="text-left p-4">GUARD</th>
                  <th className="text-left p-4">DURATION</th>
                  <th className="text-center p-4">STATUS</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((v) => (
                  <tr key={v.id} className="border-b border-[#1A3050] last:border-b-0 hover:bg-[#0B1526] transition-colors">
                    <td className="p-4 text-gray-300 text-xs font-mono whitespace-nowrap">
                      {new Date(v.occurred_at).toLocaleString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </td>
                    <td className="p-4 text-gray-300 text-sm">{v.guard_name}</td>
                    <td className="p-4 text-xs">
                      {v.is_resolved ? (
                        <span className="text-gray-300">{v.duration_minutes ?? '?'} min</span>
                      ) : (
                        <span className="text-red-400">ongoing</span>
                      )}
                    </td>
                    <td className="p-4 text-center">
                      {v.is_resolved ? (
                        <span className="text-xs tracking-widest text-green-400 bg-green-400/10 border border-green-400/30 px-2 py-0.5 rounded">RESOLVED</span>
                      ) : (
                        <span className="text-xs tracking-widest text-red-400 bg-red-400/10 border border-red-400/30 px-2 py-0.5 rounded">OPEN</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500">Showing {start}–{end} of {total}</span>
          <div className="flex gap-2 items-center">
            <button
              onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))}
              disabled={offset === 0}
              className="border border-[#1A3050] text-gray-400 rounded px-3 py-1.5 tracking-widest hover:border-amber-400 hover:text-amber-400 disabled:opacity-40 disabled:hover:border-[#1A3050] disabled:hover:text-gray-400 transition-colors"
            >
              ‹ PREV
            </button>
            <span className="text-gray-500">Page {page} of {totalPages}</span>
            <button
              onClick={() => setOffset((o) => o + PAGE_SIZE)}
              disabled={offset + PAGE_SIZE >= total}
              className="border border-[#1A3050] text-gray-400 rounded px-3 py-1.5 tracking-widest hover:border-amber-400 hover:text-amber-400 disabled:opacity-40 disabled:hover:border-[#1A3050] disabled:hover:text-gray-400 transition-colors"
            >
              NEXT ›
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
