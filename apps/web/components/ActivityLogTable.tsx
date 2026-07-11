'use client';
/**
 * Activity Log table — shared between the admin activity page and the
 * client portal. Driven by GET /api/activity-log.
 *
 * Columns:
 *   GUARD · STATUS · LOG TIME · LOG MEDIA · ACTIONS
 *
 * ACTIONS toggles an inline accordion under the row with the full
 * detail — Reported By, Report Type, Site, Timestamp, Description,
 * Media grid. Replaces the old <detailPathPrefix>/<id>/photos sub-route.
 * The admin sub-route (`/admin/activity/[reportId]`) has been deleted;
 * the client sub-route (`/client/reports/[reportId]/photos`) is kept
 * so incident-alert emails already in inboxes still land on a page.
 *
 * STATUS taxonomy (see statusPresentation for pill formatting):
 *   clocked_in_on_time      → green "Clocked In at HH:MM"
 *   clocked_in_late         → red   "Clocked In at HH:MM (+Nm late)"
 *   missed_clock_in         → red   "Missed Clock In at HH:MM"
 *   missed_report           → red   "Missed Report at HH:00"
 *   on_time (ping)          → green "Ping (on time)"
 *   late (ping)             → green "Ping (+Nm late)"    (server text
 *                                    is the source; boundary [0, 30])
 *   missed (ping)           → red   "Missed Ping"
 *   activity_report         → blue  "Activity Report"
 *   incident_report         → red   "Incident Report"
 *   maintenance_report      → amber "Maintenance Report"
 *
 * Filter modes:
 *   admin  → search + site + shift + range picker + DOWNLOAD PDF
 *   client → range picker only (site implicit, guard search hidden)
 *
 * Default date range is *today* (00:00 → 23:59 local). Widens to 30 d
 * only when a deep-link `?report=<id>` targets an older row.
 *
 * PDF export (admin only): POSTs the current filter state to
 * /api/admin/activity-log/pdf and triggers a browser download of the
 * streamed application/pdf response.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { adminDownloadPost } from '../lib/adminApi';
import { computeLateness } from '../lib/lateness';

type StatusKind =
  | 'on_time'
  | 'late'
  | 'missed'
  | 'activity_report'
  | 'incident_report'
  | 'maintenance_report'
  | 'clocked_in_on_time'
  | 'clocked_in_late'
  | 'missed_clock_in'
  | 'missed_report';

interface ActivityRow {
  id:              string;
  kind:            'ping' | 'report';
  guard_id:        string;
  guard_name:      string;
  site_id:         string;
  site_name:       string;
  status:          string;
  status_kind:     StatusKind;
  log_time:        string | null;
  log_media_url:   string | null;
  log_media_urls:  string[];
  event_time:      string;
  detail_id:       string | null;
  // Threaded onto every row from apps/api/src/routes/activityLog.ts —
  // enables the SHIFT column and client-side computeLateness().
  shift_id:        string | null;
  scheduled_start: string | null;
  scheduled_end:   string | null;
  // Report-only.
  report_type:     'activity' | 'incident' | 'maintenance' | null;
  severity:        'low' | 'medium' | 'high' | 'critical' | null;
  description:     string | null;
  // Ping-only (server-nulled for client role).
  latitude:           number  | null;
  longitude:          number  | null;
  accuracy_m:         number  | null;
  is_within_geofence: boolean | null;
  ping_type:          string  | null;
}

interface ActivityLogResponse {
  rows:        ActivityRow[];
  total:       number;
  page:        number;
  page_size:   number;
  total_pages: number;
}

interface Site {
  id:              string;
  name:            string;
  site_is_active?: boolean;
}

interface AdminSession {
  id:              string;
  guard_name:      string;
  site_name:       string;
  site_id:         string;
  clocked_in_at:   string;
  clocked_out_at:  string | null;
  scheduled_start: string;
  scheduled_end:   string;
}

const PAGE_SIZE = 10;

// ── Format helpers (Pacific everywhere on this page) ─────────────────────────
const PT_TIME = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
});
const PT_DAY = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
});
const PT_DATE_LONG = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles',
});
const RANGE_LABEL = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
});

function isoDateOnly(d: Date): string {
  // Local YYYY-MM-DD, safe for the browser <input type="date"> element.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function fmtLogTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${PT_TIME.format(d)} · ${PT_DAY.format(d)}`;
}

function fmtSessionLabel(s: AdminSession): string {
  const d = new Date(s.clocked_in_at);
  const date = PT_DAY.format(d);
  const time = PT_TIME.format(d);
  const status = s.clocked_out_at ? 'ended' : 'active';
  return `${s.guard_name} · ${s.site_name} · ${date} ${time} · ${status}`;
}

function guardInitial(name: string): string {
  return (name?.trim()?.[0] ?? '?').toUpperCase();
}

// ── Status → badge label + color ────────────────────────────────────────────
//
// STATUS column runs the raw status through computeLateness for pings so
// on-time/late timing lives in one place (same helper the live-status
// page uses). Reports and missed rows are static labels.
interface StatusPresentation {
  label: string;
  // Tailwind classes — one for text (used on light-on-dark table),
  // one for the pill background.
  textClass: string;
  pillClass: string;
}

const GREEN_PILL = 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300';
const RED_PILL   = 'bg-rose-500/15    border-rose-500/40    text-rose-300';
const BLUE_PILL  = 'bg-sky-500/15     border-sky-500/40     text-sky-300';
const AMBER_PILL = 'bg-amber-500/15   border-amber-500/40   text-amber-300';

function statusPresentation(r: ActivityRow): StatusPresentation {
  switch (r.status_kind) {
    case 'on_time':
    case 'late': {
      const late = computeLateness(r.log_time, [0, 30]);
      // computeLateness returns "HH:MM (on time)" or "HH:MM (+Nm late)" —
      // we only want the parenthesized qualifier since the LOG TIME
      // column already shows the timestamp.
      const paren = late.display.match(/\(([^)]+)\)/)?.[1] ?? '';
      const label = paren ? `Ping (${paren})` : r.status;
      return { label, textClass: 'text-emerald-400', pillClass: GREEN_PILL };
    }
    case 'missed':
      return { label: 'Missed Ping', textClass: 'text-rose-400', pillClass: RED_PILL };
    case 'clocked_in_on_time':
      return {
        label:     `Clocked In at ${PT_TIME.format(new Date(r.log_time ?? r.event_time))}`,
        textClass: 'text-emerald-400',
        pillClass: GREEN_PILL,
      };
    case 'clocked_in_late': {
      const late = r.log_time && r.scheduled_start
        ? Math.max(0, Math.floor(
            (new Date(r.log_time).getTime() - new Date(r.scheduled_start).getTime()) / 60_000,
          ))
        : 0;
      return {
        label:     `Clocked In at ${PT_TIME.format(new Date(r.log_time ?? r.event_time))} (+${late}m late)`,
        textClass: 'text-rose-400',
        pillClass: RED_PILL,
      };
    }
    case 'missed_clock_in':
      return {
        label:     `Missed Clock In at ${PT_TIME.format(new Date(r.scheduled_start ?? r.event_time))}`,
        textClass: 'text-rose-400',
        pillClass: RED_PILL,
      };
    case 'missed_report':
      return {
        label:     `Missed Report at ${PT_TIME.format(new Date(r.event_time))}`,
        textClass: 'text-rose-400',
        pillClass: RED_PILL,
      };
    case 'activity_report':
      return { label: 'Activity Report',    textClass: 'text-sky-400',   pillClass: BLUE_PILL };
    case 'incident_report':
      return { label: 'Incident Report',    textClass: 'text-red-400',   pillClass: RED_PILL };
    case 'maintenance_report':
      return { label: 'Maintenance Report', textClass: 'text-amber-400', pillClass: AMBER_PILL };
    default:
      return {
        label:     r.status,
        textClass: 'text-gray-300',
        pillClass: 'bg-gray-700/40 border-gray-600/50 text-gray-300',
      };
  }
}

export interface ActivityLogTableProps {
  /** Authenticated GET — adminGet or clientGet. */
  fetcher: <T>(path: string) => Promise<T>;
  /** Title accent colour (admin amber, client blue). */
  accentClass?: string;
  /** Heading shown above the table. */
  heading?: string;
  /** 'admin' shows site/shift dropdowns, guard search, PDF export. */
  mode: 'admin' | 'client';
  /**
   * URL prefix for photo lightbox / detail. Kept for client (its
   * sub-route still exists at /client/reports/<id>/photos). Not used
   * on admin any more — the accordion replaces the sub-route.
   */
  detailPathPrefix?: string;
  /**
   * Deep-link highlight (from incident-alert emails):
   * /admin/activity?report=<id> or /client?report=<id>. The row is
   * scrolled into view + auto-expanded + flashed once loaded.
   */
  highlightReportId?: string | null;
}

export default function ActivityLogTable({
  fetcher,
  accentClass = 'text-amber-400',
  heading     = 'ACTIVITY LOGS',
  mode,
  detailPathPrefix,
  highlightReportId = null,
}: ActivityLogTableProps) {
  const [rows,       setRows]       = useState<ActivityRow[]>([]);
  const [total,      setTotal]      = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [page,       setPage]       = useState(1);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');

  // Admin-only filters
  const [sites,    setSites]    = useState<Site[]>([]);
  const [sessions, setSessions] = useState<AdminSession[]>([]);
  const [siteId,   setSiteId]   = useState('');
  const [sessionId, setSessionId] = useState('');
  const [search,   setSearch]   = useState('');

  const today   = useMemo(() => new Date(), []);
  const todayStr = useMemo(() => isoDateOnly(today), [today]);
  // Default range is *today* — audit-trail intent is "what happened
  // during today's shifts". The old 7-day default hid low-signal rows
  // like Clocked In and Missed Ping behind noise. 30 d widen only kicks
  // in when a deep-link `?report=<id>` targets an older row so incident
  // emails still land on the referenced event.
  const [dateFrom, setDateFrom] = useState(() =>
    highlightReportId
      ? isoDateOnly(new Date(today.getTime() - 30 * 86_400_000))
      : todayStr,
  );
  const [dateTo, setDateTo] = useState(todayStr);

  // Compact date-range picker popover
  const [rangeOpen,   setRangeOpen]   = useState(false);
  const [pendingFrom, setPendingFrom] = useState(dateFrom);
  const [pendingTo,   setPendingTo]   = useState(dateTo);

  // Accordion — one open at a time
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // PDF button loading state (admin only)
  const [pdfLoading, setPdfLoading] = useState(false);

  // Row-ref map keyed by row id so highlightReportId can scroll into view.
  const rowRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [flashId, setFlashId] = useState<string | null>(null);

  // Once the current page's rows include the deep-link target, scroll +
  // auto-expand the accordion + flash the ring.
  useEffect(() => {
    if (!highlightReportId || loading) return;
    const el = rowRefs.current.get(highlightReportId);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setExpandedId(highlightReportId);
    setFlashId(highlightReportId);
    const t = window.setTimeout(() => setFlashId(null), 2000);
    return () => window.clearTimeout(t);
  }, [highlightReportId, rows, loading]);

  // Load sites once (admin only). Include inactive sites so admins can
  // filter historical activity at a since-deactivated site.
  useEffect(() => {
    if (mode !== 'admin') return;
    fetcher<Site[]>('/api/sites?include_inactive=1').then(setSites).catch(() => {/* ignore */});
  }, [mode, fetcher]);

  // Load sessions across ALL sites in the date range (admin only). Lifted
  // the old "must pick a site first" gate — sessions are filtered
  // client-side when SITE changes.
  useEffect(() => {
    if (mode !== 'admin') return;
    const from = `${dateFrom}T00:00:00.000Z`;
    const to   = `${dateTo}T23:59:59.999Z`;
    fetcher<AdminSession[]>(`/api/admin/sessions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then(setSessions)
      .catch(() => setSessions([]));
    // Reset the SHIFT selection when the date range shifts — a session that
    // dropped out of the window would silently keep the filter set to a
    // now-missing id.
    setSessionId('');
  }, [mode, dateFrom, dateTo, fetcher]);

  // Client-side session filter when SITE changes — no server refetch.
  const visibleSessions = useMemo(() => {
    if (!siteId) return sessions;
    return sessions.filter((s) => s.site_id === siteId);
  }, [sessions, siteId]);

  // Drop a stale sessionId if the user pivoted to a different site.
  useEffect(() => {
    if (!sessionId) return;
    if (!visibleSessions.some((s) => s.id === sessionId)) setSessionId('');
  }, [visibleSessions, sessionId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('from',      `${dateFrom}T00:00:00.000Z`);
      params.set('to',        `${dateTo}T23:59:59.999Z`);
      params.set('page',      String(page));
      params.set('page_size', String(PAGE_SIZE));
      if (mode === 'admin' && siteId)    params.set('site_id',    siteId);
      if (mode === 'admin' && sessionId) params.set('session_id', sessionId);

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
  }, [page, dateFrom, dateTo, mode, siteId, sessionId, fetcher]);

  // Reset to page 1 whenever any filter changes
  useEffect(() => { setPage(1); }, [dateFrom, dateTo, siteId, sessionId, search]);
  useEffect(() => { load(); }, [load]);

  // Client-side guard search — filters the current page of rows only.
  // Full-corpus search would need a server-side name filter; MVP scope.
  const displayRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.guard_name.toLowerCase().includes(q));
  }, [rows, search]);

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

  // Date-range picker: open popover
  function openRangePicker() {
    setPendingFrom(dateFrom);
    setPendingTo(dateTo);
    setRangeOpen(true);
  }
  function applyRange() {
    // Guard against inverted ranges — swap if user set to earlier than from.
    const from = pendingFrom < pendingTo ? pendingFrom : pendingTo;
    const to   = pendingFrom < pendingTo ? pendingTo   : pendingFrom;
    setDateFrom(from);
    setDateTo(to);
    setRangeOpen(false);
  }
  function resetRange() {
    setPendingFrom(todayStr);
    setPendingTo(todayStr);
  }

  function clearFilters() {
    setSiteId('');
    setSessionId('');
    setSearch('');
    setDateFrom(todayStr);
    setDateTo(todayStr);
  }

  const rangeLabel = useMemo(() => {
    const from = new Date(`${dateFrom}T00:00:00.000Z`);
    const to   = new Date(`${dateTo}T00:00:00.000Z`);
    return `${RANGE_LABEL.format(from)} → ${RANGE_LABEL.format(to)}`;
  }, [dateFrom, dateTo]);

  const hasFilters = mode === 'admin'
    && (siteId || sessionId || search || dateFrom !== todayStr || dateTo !== todayStr);

  async function downloadPdf() {
    if (mode !== 'admin' || pdfLoading) return;
    setPdfLoading(true);
    setError('');
    try {
      const body: Record<string, string> = {
        from: `${dateFrom}T00:00:00.000Z`,
        to:   `${dateTo}T23:59:59.999Z`,
      };
      if (siteId)    body.site_id    = siteId;
      if (sessionId) body.session_id = sessionId;
      const filename = `activity-logs-${dateFrom}_${dateTo}.pdf`;
      await adminDownloadPost('/api/admin/activity-log/pdf', body, filename);
    } catch (e: any) {
      setError(e?.message ?? 'PDF download failed');
    } finally {
      setPdfLoading(false);
    }
  }

  function toggleExpanded(rowId: string) {
    setExpandedId((cur) => (cur === rowId ? null : rowId));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className={`text-3xl font-bold tracking-widest ${accentClass}`}>{heading}</h1>
        <div className="flex items-center gap-3">
          <span className="text-gray-500 text-xs tracking-widest">{total} ENTRIES</span>
          {mode === 'admin' && (
            <button
              onClick={downloadPdf}
              disabled={pdfLoading}
              className="inline-flex items-center gap-2 px-3 py-2 text-xs tracking-widest border border-amber-500/40 text-amber-400 rounded-lg hover:bg-amber-400/10 hover:border-amber-400 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {pdfLoading ? 'PREPARING…' : 'DOWNLOAD PDF'}
            </button>
          )}
        </div>
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap gap-3 items-end">
        {mode === 'admin' && (
          <>
            {/* Guard search */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-gray-500 tracking-widest">SEARCH GUARDS</label>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Type a name…"
                className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-300 text-sm focus:outline-none focus:border-amber-400 min-w-[200px] placeholder-gray-600"
              />
            </div>

            {/* Site */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-gray-500 tracking-widest">SITE</label>
              <select
                value={siteId}
                onChange={(e) => setSiteId(e.target.value)}
                className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-300 text-sm focus:outline-none focus:border-amber-400 min-w-[200px]"
              >
                <option value="">All sites</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.site_is_active === false ? `[INACTIVE] ${s.name}` : s.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Shift (no site-required gate) */}
            <div className="flex flex-col gap-1">
              <label className="text-[10px] text-gray-500 tracking-widest">SHIFT</label>
              <select
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-300 text-sm focus:outline-none focus:border-amber-400 min-w-[260px]"
              >
                <option value="">{siteId ? 'All shifts at this site' : 'All shifts'}</option>
                {visibleSessions.map((s) => (
                  <option key={s.id} value={s.id}>{fmtSessionLabel(s)}</option>
                ))}
              </select>
            </div>
          </>
        )}

        {/* Compact date range trigger + popover */}
        <div className="relative flex flex-col gap-1">
          <label className="text-[10px] text-gray-500 tracking-widest">DATE RANGE</label>
          <button
            onClick={() => (rangeOpen ? setRangeOpen(false) : openRangePicker())}
            className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-300 text-sm focus:outline-none focus:border-amber-400 min-w-[200px] text-left inline-flex items-center justify-between gap-2"
          >
            <span>{rangeLabel}</span>
            <svg width="10" height="10" viewBox="0 0 20 20" fill="currentColor" className="opacity-60">
              <path d="M5 8l5 5 5-5H5z"/>
            </svg>
          </button>
          {rangeOpen && (
            <div className="absolute top-full mt-1 left-0 z-20 bg-[#0F1E35] border border-[#1A3050] rounded-lg p-3 shadow-xl w-[280px]">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-gray-500 tracking-widest">FROM</label>
                  <input
                    type="date"
                    value={pendingFrom}
                    onChange={(e) => setPendingFrom(e.target.value)}
                    className="bg-[#0B1526] border border-[#1A3050] rounded px-2 py-1.5 text-gray-300 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] text-gray-500 tracking-widest">TO</label>
                  <input
                    type="date"
                    value={pendingTo}
                    onChange={(e) => setPendingTo(e.target.value)}
                    className="bg-[#0B1526] border border-[#1A3050] rounded px-2 py-1.5 text-gray-300 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div className="flex items-center justify-between pt-1">
                  <button
                    onClick={resetRange}
                    className="text-[10px] text-gray-500 tracking-widest hover:text-amber-400"
                  >
                    TODAY
                  </button>
                  <div className="flex gap-2">
                    <button
                      onClick={() => setRangeOpen(false)}
                      className="text-xs text-gray-400 tracking-widest px-2 py-1 rounded border border-transparent hover:border-[#1A3050]"
                    >
                      CANCEL
                    </button>
                    <button
                      onClick={applyRange}
                      className="text-xs text-black tracking-widest px-3 py-1 rounded bg-amber-400 hover:bg-amber-300 font-semibold"
                    >
                      APPLY
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {hasFilters && (
          <button
            onClick={clearFilters}
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
        {/* Header row */}
        <div className="grid grid-cols-[1fr_220px_180px_120px_60px] gap-4 px-4 py-3 border-b border-[#1A3050] bg-[#0F1E35]">
          <span className="text-[10px] text-gray-500 tracking-widest">GUARD</span>
          <span className="text-[10px] text-gray-500 tracking-widest">STATUS</span>
          <span className="text-[10px] text-gray-500 tracking-widest">LOG TIME</span>
          <span className="text-[10px] text-gray-500 tracking-widest">LOG MEDIA</span>
          <span className="text-[10px] text-gray-500 tracking-widest text-right">ACTIONS</span>
        </div>

        {loading && (
          <div className="text-center text-gray-500 py-12 text-sm">Loading…</div>
        )}

        {!loading && displayRows.length === 0 && (
          <div className="text-center text-gray-500 py-12 text-sm">
            {search ? `No entries match "${search}"` : 'No entries in this range'}
          </div>
        )}

        {!loading && displayRows.map((r) => {
          const status  = statusPresentation(r);
          const photos  = r.log_media_urls ?? [];
          const isFlash = r.id === flashId;
          const isOpen  = expandedId === r.id;

          return (
            <div key={r.id}>
              <div
                ref={(el) => {
                  if (el) rowRefs.current.set(r.id, el);
                  else    rowRefs.current.delete(r.id);
                }}
                className={`grid grid-cols-[1fr_220px_180px_120px_60px] gap-4 px-4 py-3 border-b border-[#1A3050] items-center transition-colors ${
                  isOpen ? 'bg-[#0F1E35]' : 'hover:bg-[#0F1E35]'
                } ${isFlash ? 'ring-2 ring-inset ring-amber-400 bg-amber-400/5' : ''}`}
              >
                {/* GUARD */}
                <div className="flex items-center gap-2 min-w-0">
                  <div className="w-7 h-7 rounded-full bg-[#1A3050] border border-[#2A4A75] flex items-center justify-center shrink-0">
                    <span className="text-xs text-gray-300">{guardInitial(r.guard_name)}</span>
                  </div>
                  <span className="text-sm text-gray-200 truncate">{r.guard_name}</span>
                </div>

                {/* STATUS pill */}
                <div className="min-w-0">
                  <span
                    className={`inline-block text-[10px] tracking-widest font-semibold px-2 py-0.5 rounded border ${status.pillClass} truncate max-w-full`}
                    title={status.label}
                  >
                    {status.label.toUpperCase()}
                  </span>
                </div>

                {/* LOG TIME */}
                <span className="text-xs text-gray-400">{fmtLogTime(r.log_time)}</span>

                {/* LOG MEDIA (first thumbnail if any, else em-dash) */}
                <div>
                  {photos.length === 0 ? (
                    <span className="text-gray-600 text-xs">—</span>
                  ) : (
                    <button
                      onClick={() => toggleExpanded(r.id)}
                      className="inline-flex items-center gap-1.5 hover:opacity-80 transition-opacity"
                      aria-label="View media"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={photos[0]}
                        alt="thumbnail"
                        className="w-8 h-8 object-cover rounded border border-[#1A3050]"
                      />
                      {photos.length > 1 && (
                        <span className="inline-flex items-center justify-center min-w-[24px] h-8 rounded bg-[#1A3050] border border-[#2A4A75] text-[10px] text-gray-300 font-semibold px-1.5">
                          +{photos.length - 1}
                        </span>
                      )}
                    </button>
                  )}
                </div>

                {/* ACTIONS — accordion toggle */}
                <div className="text-right">
                  <button
                    onClick={() => toggleExpanded(r.id)}
                    className={`inline-flex items-center justify-center w-8 h-8 rounded-full border transition-colors ${
                      isOpen
                        ? 'border-amber-400 text-amber-400 bg-amber-400/10'
                        : 'border-[#2A4A75] text-gray-300 hover:border-amber-400 hover:text-amber-400'
                    }`}
                    aria-label={isOpen ? 'Collapse row' : 'Expand row'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* Accordion — expanded row content */}
              {isOpen && (
                <div className="px-4 py-4 border-b border-[#1A3050] bg-[#0F1E35]/60">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                    <ExpandedField label="Reported By"
                      value={mode === 'admin' ? (
                        <a
                          href={`/admin/guards?highlight=${r.guard_id}`}
                          className="text-amber-400 hover:underline"
                        >
                          {r.guard_name}
                        </a>
                      ) : (
                        <span className="text-gray-200">{r.guard_name}</span>
                      )}
                    />
                    <ExpandedField label="Report Type"
                      value={
                        <span className={`inline-block text-[10px] tracking-widest font-semibold px-2 py-0.5 rounded border ${status.pillClass}`}>
                          {status.label.toUpperCase()}
                        </span>
                      }
                    />
                    <ExpandedField label="Site" value={<span className="text-gray-200">{r.site_name}</span>} />
                    <ExpandedField label="Timestamp" value={
                      <span className="text-gray-400 font-mono">
                        {r.log_time ? PT_DATE_LONG.format(new Date(r.log_time)) + ' PT' : '—'}
                      </span>
                    } />
                  </div>

                  {r.description && (
                    <div className="mt-4">
                      <p className="text-[10px] text-gray-500 tracking-widest mb-2">DESCRIPTION</p>
                      <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">{r.description}</p>
                    </div>
                  )}

                  {photos.length > 0 && (
                    <div className="mt-4">
                      <p className="text-[10px] text-gray-500 tracking-widest mb-2">SITE MEDIA ({photos.length})</p>
                      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 gap-2">
                        {photos.map((url, i) => (
                          <a
                            key={i}
                            href={url}
                            target="_blank"
                            rel="noreferrer"
                            className="block relative aspect-square overflow-hidden rounded border border-[#1A3050] hover:border-amber-400 transition-colors"
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={url} alt={`photo ${i + 1}`} className="w-full h-full object-cover" />
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {!r.description && photos.length === 0 && (
                    <p className="text-xs text-gray-600 italic mt-3">
                      {r.kind === 'ping' && r.status_kind === 'missed'
                        ? 'No ping was received in this half-hour window.'
                        : 'No additional details.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Pagination */}
        {!loading && total > 0 && (
          <div className="flex items-center justify-between px-4 py-3 bg-[#0F1E35]">
            <span className="text-xs text-gray-500">
              Showing {(page - 1) * PAGE_SIZE + 1} to {Math.min(page * PAGE_SIZE, total)} of {total} entries
              {search && ` (filtered to "${search}" on this page)`}
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

function ExpandedField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] text-gray-500 tracking-widest mb-1">{label.toUpperCase()}</p>
      <div>{value}</div>
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
