'use client';
/**
 * Activity Log table — shared between the admin reports page and the
 * client portal. Driven by GET /api/activity-log (Express endpoint at
 * apps/api/src/routes/activityLog.ts). Caller passes a fetcher so we
 * don't couple this component to the admin or client auth flow.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

type StatusKind =
  | 'on_time'
  | 'late'
  | 'missed'
  | 'activity_report'
  | 'incident_report'
  | 'maintenance_report';

interface ActivityRow {
  id:             string;
  kind:           'ping' | 'report';
  guard_id:       string;
  guard_name:     string;
  site_id:        string;
  site_name:      string;
  status:         string;
  status_kind:    StatusKind;
  log_time:       string | null;
  log_media_url:  string | null;
  event_time:     string;
  detail_id:      string | null;
}

interface ActivityLogResponse {
  rows:        ActivityRow[];
  total:       number;
  page:        number;
  page_size:   number;
  total_pages: number;
}

const STATUS_COLOR: Record<StatusKind, string> = {
  on_time:             'text-emerald-400',
  late:                'text-amber-400',
  missed:              'text-rose-400',
  activity_report:     'text-sky-400',
  incident_report:     'text-red-400',
  maintenance_report:  'text-violet-400',
};

const PAGE_SIZE = 10;

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtLogTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) +
    ' - ' +
    d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
}

function guardInitial(name: string): string {
  return (name?.trim()?.[0] ?? '?').toUpperCase();
}

export interface ActivityLogTableProps {
  /** Authenticated GET — adminGet or clientGet from the calling page. */
  fetcher: <T>(path: string) => Promise<T>;
  /** Accent / title colour used by the calling portal (admin amber, client blue). */
  accentClass?: string;
  /** Heading shown above the table. */
  heading?: string;
}

export default function ActivityLogTable({
  fetcher,
  accentClass = 'text-amber-400',
  heading     = 'ACTIVITY LOGS',
}: ActivityLogTableProps) {
  const [rows,        setRows]        = useState<ActivityRow[]>([]);
  const [total,       setTotal]       = useState(0);
  const [totalPages,  setTotalPages]  = useState(1);
  const [page,        setPage]        = useState(1);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [guardSearch, setGuardSearch] = useState('');

  const today    = useMemo(() => new Date(), []);
  const weekAgo  = useMemo(() => new Date(today.getTime() - 7 * 86_400_000), [today]);
  const [dateFrom, setDateFrom] = useState(isoDateOnly(weekAgo));
  const [dateTo,   setDateTo]   = useState(isoDateOnly(today));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('from',      `${dateFrom}T00:00:00.000Z`);
      params.set('to',        `${dateTo}T23:59:59.999Z`);
      params.set('page',      String(page));
      params.set('page_size', String(PAGE_SIZE));

      const data = await fetcher<ActivityLogResponse>(`/api/activity-log?${params}`);
      setRows(data.rows ?? []);
      setTotal(data.total ?? 0);
      setTotalPages(data.total_pages ?? 1);
      setError('');
    } catch (e: any) {
      setError(e?.message ?? 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [page, dateFrom, dateTo, fetcher]);

  useEffect(() => { setPage(1); }, [dateFrom, dateTo]);
  useEffect(() => { load(); }, [load]);

  const visibleRows = useMemo(() => {
    const q = guardSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.guard_name.toLowerCase().includes(q));
  }, [rows, guardSearch]);

  const pageWindow = useMemo(() => {
    const ws: (number | '…')[] = [];
    const last = totalPages;
    if (last <= 7) {
      for (let i = 1; i <= last; i++) ws.push(i);
      return ws;
    }
    const around = new Set([1, 2, last - 1, last, page - 1, page, page + 1]);
    let prev = 0;
    for (let i = 1; i <= last; i++) {
      if (around.has(i)) {
        if (i - prev > 1) ws.push('…');
        ws.push(i);
        prev = i;
      }
    }
    return ws;
  }, [page, totalPages]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className={`text-3xl font-bold tracking-widest ${accentClass}`}>{heading}</h1>
        <span className="text-gray-500 text-xs tracking-widest">{total} ENTRIES</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-500 tracking-widest">SEARCH GUARDS</label>
          <input
            type="text"
            value={guardSearch}
            onChange={(e) => setGuardSearch(e.target.value)}
            placeholder="Search guards..."
            className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-300 text-sm focus:outline-none focus:border-amber-400 min-w-[220px]"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-500 tracking-widest">FROM</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-300 text-sm focus:outline-none focus:border-amber-400"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-[10px] text-gray-500 tracking-widest">TO</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-300 text-sm focus:outline-none focus:border-amber-400"
          />
        </div>

        {(guardSearch || dateFrom !== isoDateOnly(weekAgo) || dateTo !== isoDateOnly(today)) && (
          <button
            onClick={() => {
              setGuardSearch('');
              setDateFrom(isoDateOnly(weekAgo));
              setDateTo(isoDateOnly(today));
            }}
            className="text-xs text-gray-500 tracking-widest hover:text-amber-400 transition-colors pb-2"
          >
            CLEAR
          </button>
        )}
      </div>

      {error && (
        <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      {/* Table */}
      <div className="bg-[#0B1526] border border-[#1A3050] rounded-xl overflow-hidden">
        <div className="grid grid-cols-[1fr_180px_220px_100px_60px] gap-4 px-4 py-3 border-b border-[#1A3050] bg-[#0F1E35]">
          <span className="text-[10px] text-gray-500 tracking-widest">GUARD NAME</span>
          <span className="text-[10px] text-gray-500 tracking-widest">STATUS</span>
          <span className="text-[10px] text-gray-500 tracking-widest">LOG TIME</span>
          <span className="text-[10px] text-gray-500 tracking-widest">LOG MEDIA</span>
          <span className="text-[10px] text-gray-500 tracking-widest text-right">ACTIONS</span>
        </div>

        {loading && (
          <div className="text-center text-gray-500 py-12 text-sm">Loading…</div>
        )}

        {!loading && visibleRows.length === 0 && (
          <div className="text-center text-gray-500 py-12 text-sm">No entries in this range</div>
        )}

        {!loading && visibleRows.map((r) => (
          <div
            key={r.id}
            className="grid grid-cols-[1fr_180px_220px_100px_60px] gap-4 px-4 py-3 border-b border-[#1A3050] items-center hover:bg-[#0F1E35] transition-colors"
          >
            {/* Guard */}
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-full bg-[#1A3050] border border-[#2A4A75] flex items-center justify-center shrink-0">
                <span className="text-xs text-gray-300">{guardInitial(r.guard_name)}</span>
              </div>
              <span className="text-sm text-gray-200 truncate">{r.guard_name}</span>
            </div>

            {/* Status */}
            <span className={`text-sm font-medium ${STATUS_COLOR[r.status_kind] ?? 'text-gray-300'}`}>
              {r.status}
            </span>

            {/* Log time */}
            <span className="text-xs text-gray-400">{fmtLogTime(r.log_time)}</span>

            {/* Log media */}
            <div>
              {r.log_media_url ? (
                <a href={r.log_media_url} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={r.log_media_url}
                    alt="log"
                    className="w-12 h-12 object-cover rounded-md border border-[#1A3050] hover:border-amber-400 transition-colors"
                  />
                </a>
              ) : (
                <span className="text-xs text-gray-600">No Media Added</span>
              )}
            </div>

            {/* Action */}
            <div className="text-right">
              <a
                href={r.log_media_url ?? '#'}
                target="_blank"
                rel="noreferrer"
                className={`inline-flex items-center justify-center w-8 h-8 rounded-full border ${
                  r.log_media_url
                    ? 'border-[#2A4A75] text-gray-300 hover:border-amber-400 hover:text-amber-400'
                    : 'border-[#1A3050] text-gray-700 cursor-default'
                } transition-colors`}
                aria-label="View"
                onClick={(e) => { if (!r.log_media_url) e.preventDefault(); }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </a>
            </div>
          </div>
        ))}

        {/* Pagination */}
        {!loading && total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 bg-[#0F1E35]">
            <span className="text-xs text-gray-500">
              Showing {(page - 1) * PAGE_SIZE + 1} to {Math.min(page * PAGE_SIZE, total)} of {total} entries
            </span>
            <div className="flex items-center gap-1">
              <PageBtn disabled={page === 1}            onClick={() => setPage(1)}            >«</PageBtn>
              <PageBtn disabled={page === 1}            onClick={() => setPage((p) => p - 1)} >‹</PageBtn>
              {pageWindow.map((w, i) =>
                w === '…' ? (
                  <span key={`e${i}`} className="text-gray-600 px-1 text-xs">…</span>
                ) : (
                  <button
                    key={w}
                    onClick={() => setPage(w)}
                    className={`min-w-[28px] h-7 px-2 text-xs rounded ${
                      w === page
                        ? 'bg-amber-400 text-[#0B1526] font-semibold'
                        : 'bg-[#0B1526] border border-[#1A3050] text-gray-300 hover:border-amber-400'
                    }`}
                  >
                    {w}
                  </button>
                ),
              )}
              <PageBtn disabled={page === totalPages} onClick={() => setPage((p) => p + 1)} >›</PageBtn>
              <PageBtn disabled={page === totalPages} onClick={() => setPage(totalPages)}   >»</PageBtn>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function PageBtn(props: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      disabled={props.disabled}
      onClick={props.onClick}
      className={`min-w-[28px] h-7 px-2 text-xs rounded border ${
        props.disabled
          ? 'border-[#1A3050] text-gray-700 cursor-not-allowed'
          : 'border-[#1A3050] text-gray-300 hover:border-amber-400 hover:text-amber-400'
      }`}
    >
      {props.children}
    </button>
  );
}
