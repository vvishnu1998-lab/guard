'use client';
/**
 * Admin — Live Guard Status (/admin/live-map)
 * Real-time table of guards currently on shift with last known location + ping time.
 * Auto-refreshes every 30 seconds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { adminGet } from '../../../lib/adminApi';

interface LiveGuard {
  id:             string;
  name:           string;
  badge_number:   string;
  site_name:      string;
  session_id:     string;
  clocked_in_at:  string;
  last_lat:       number | null;
  last_lng:       number | null;
  last_ping_at:   string | null;
  last_ping_type: 'gps_only' | 'gps_photo' | 'clock_in' | null;
  has_violation:  boolean;
}

interface Breach {
  id:               string;
  occurred_at:      string;
  resolved_at:      string | null;
  duration_minutes: number | null;
  violation_lat:    number;
  violation_lng:    number;
  photo_url:        string | null;
  is_resolved:      boolean;
  guard_name:       string;
  badge_number:     string;
  site_name:        string;
}

type SinceFilter  = '24h' | '7d' | '30d';
type StatusFilter = 'all' | 'open' | 'resolved';

const PING_LABEL: Record<string, string> = {
  gps_only:   'GPS',
  gps_photo:  'GPS + PHOTO',
  clock_in:   'CLOCK-IN',
};

function elapsed(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function shiftDuration(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

function pingAge(iso: string | null): { label: string; urgent: boolean } {
  if (!iso) return { label: '—', urgent: false };
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return { label: elapsed(iso), urgent: mins >= 35 };
}

function fmtBreachTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return `${time} today`;
  if (diffDays === 1) return `${time} yesterday`;
  return `${d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${time}`;
}

function fmtDuration(mins: number | null): string {
  if (mins == null) return '—';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

export default function LiveMapPage() {
  const [guards,      setGuards]      = useState<LiveGuard[]>([]);
  const [breaches,    setBreaches]    = useState<Breach[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [breachesLoading, setBreachesLoading] = useState(true);
  const [error,       setError]       = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [countdown,   setCountdown]   = useState(30);
  const [sinceFilter,  setSinceFilter]  = useState<SinceFilter>('24h');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Breach-alert email deep-link: /admin/live-map?breach=<violation_id>
  // Scrolls the matching breach row into view + flashes a highlight ring
  // once the breaches list loads. Filter window is widened to 7d when the
  // deep-link is present so older breaches aren't accidentally hidden.
  const searchParams       = useSearchParams();
  const targetBreachId     = searchParams?.get('breach') ?? null;
  const targetBreachIdRef  = useRef<string | null>(targetBreachId);
  const breachRowRefs      = useRef<Map<string, HTMLTableRowElement>>(new Map());
  const [highlightedBreachId, setHighlightedBreachId] = useState<string | null>(null);
  useEffect(() => {
    // Auto-widen the time filter when arriving from an email so older
    // breaches (>24h) are still reachable. Only fires once on initial
    // mount with a target id; subsequent filter changes are user-driven.
    if (targetBreachIdRef.current) setSinceFilter('7d');
  }, []);

  const loadBreaches = useCallback(async (since: SinceFilter, status: StatusFilter) => {
    try {
      const data = await adminGet<Breach[]>(
        `/api/admin/violations?since=${since}&status=${status}&limit=100`,
      );
      setBreaches(data);
    } catch (e: any) { setError(e.message); }
    finally { setBreachesLoading(false); }
  }, []);

  // Scroll-into-view + flash highlight when the breach-alert deep-link
  // lands on a known breach id. Fires after each breaches load until the
  // target id is found (handles the case where the initial 24h window
  // misses an older breach and the 7d auto-widen kicks in).
  useEffect(() => {
    if (!targetBreachId || breachesLoading) return;
    const match = breaches.find((b) => b.id === targetBreachId);
    if (!match) return;
    const row = breachRowRefs.current.get(targetBreachId);
    if (row) {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedBreachId(targetBreachId);
      const t = setTimeout(() => setHighlightedBreachId(null), 4000);
      return () => clearTimeout(t);
    }
  }, [breaches, breachesLoading, targetBreachId]);

  const load = useCallback(async () => {
    try {
      const [g] = await Promise.all([
        adminGet<LiveGuard[]>('/api/admin/live-guards'),
        loadBreaches(sinceFilter, statusFilter),
      ]);
      setGuards(g);
      setError('');
    } catch (e: any) { setError(e.message); }
    finally {
      setLoading(false);
      setLastRefresh(new Date());
      setCountdown(30);
    }
  }, [loadBreaches, sinceFilter, statusFilter]);

  // `load` is recreated when sinceFilter/statusFilter change, so this effect
  // re-runs: it fires an immediate fetch (taking the new filters into account)
  // and restarts the 30s interval. Cadence drifts slightly on filter change
  // — acceptable for an admin debug view.
  useEffect(() => {
    setBreachesLoading(true);
    load();
    timerRef.current = setInterval(load, 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [load]);

  // Countdown ticker
  useEffect(() => {
    const t = setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1_000);
    return () => clearInterval(t);
  }, [lastRefresh]);

  const violations = guards.filter((g) => g.has_violation);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-widest text-amber-400">LIVE STATUS</h1>
          <p className="text-gray-600 text-xs tracking-widest mt-1">
            Refreshes in {countdown}s · Last updated {lastRefresh.toLocaleTimeString('en-GB')}
          </p>
        </div>
        <div className="flex items-center gap-4">
          {violations.length > 0 && (
            <div className="flex items-center gap-2 bg-red-900/40 border border-red-700 rounded-lg px-3 py-2">
              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse" />
              <span className="text-red-400 text-xs tracking-widest font-bold">
                {violations.length} VIOLATION{violations.length > 1 ? 'S' : ''}
              </span>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-green-400 text-sm font-bold">{guards.length}</span>
            <span className="text-gray-500 text-xs tracking-widest">ON DUTY</span>
          </div>
          <button
            onClick={load}
            className="text-xs text-amber-400 tracking-widest border border-amber-700 rounded-lg px-3 py-2 hover:bg-amber-400/10 transition-colors"
          >
            REFRESH
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Violation banner */}
      {violations.length > 0 && (
        <div className="bg-red-900/20 border border-red-800 rounded-xl p-4">
          <p className="text-red-400 text-xs tracking-widest font-bold mb-2">GEOFENCE VIOLATIONS — UNRESOLVED</p>
          <div className="flex flex-wrap gap-2">
            {violations.map((g) => (
              <span key={g.id} className="text-xs bg-red-900/40 border border-red-700 text-red-300 px-3 py-1 rounded">
                {g.name} @ {g.site_name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left p-4">GUARD</th>
              <th className="text-left p-4">SITE</th>
              <th className="text-left p-4">ON SHIFT</th>
              <th className="text-left p-4">LAST PING</th>
              <th className="text-left p-4">PING TYPE</th>
              <th className="text-left p-4">COORDINATES</th>
              <th className="text-center p-4">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center text-gray-500 py-10">Loading…</td></tr>}
            {!loading && guards.length === 0 && (
              <tr><td colSpan={7} className="text-center text-gray-500 py-10">No guards currently on duty</td></tr>
            )}
            {guards.map((g) => {
              const ping = pingAge(g.last_ping_at);
              return (
                <tr
                  key={g.id}
                  className={`border-b border-[#1A3050] transition-colors ${
                    g.has_violation ? 'bg-red-950/30 hover:bg-red-950/50' : 'hover:bg-[#0B1526]'
                  }`}
                >
                  <td className="p-4">
                    <p className="text-gray-200 font-medium">{g.name}</p>
                    <p className="text-gray-600 text-xs font-mono">{g.badge_number}</p>
                  </td>
                  <td className="p-4 text-gray-400 text-xs">{g.site_name}</td>
                  <td className="p-4 text-gray-400 text-xs">{shiftDuration(g.clocked_in_at)}</td>
                  <td className="p-4">
                    <span className={`text-xs ${ping.urgent ? 'text-red-400 font-medium' : 'text-gray-400'}`}>
                      {ping.label}
                    </span>
                    {ping.urgent && (
                      <span className="ml-1 text-red-400 text-xs animate-pulse">!</span>
                    )}
                  </td>
                  <td className="p-4">
                    {g.last_ping_type ? (
                      <span className="text-xs text-gray-500 tracking-widest">
                        {PING_LABEL[g.last_ping_type] ?? g.last_ping_type}
                      </span>
                    ) : (
                      <span className="text-gray-700 text-xs">—</span>
                    )}
                  </td>
                  <td className="p-4 text-gray-600 text-xs font-mono">
                    {g.last_lat != null && g.last_lng != null
                      ? `${g.last_lat.toFixed(5)}, ${g.last_lng.toFixed(5)}`
                      : '—'}
                  </td>
                  <td className="p-4 text-center">
                    {g.has_violation ? (
                      <span className="text-xs tracking-widest text-red-400 font-bold animate-pulse">VIOLATION</span>
                    ) : (
                      <span className="text-xs tracking-widest text-green-400">OK</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── RECENT BREACHES — geofence violation history ───────────────── */}
      <div className="space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-amber-400 font-bold tracking-widest text-sm">RECENT BREACHES</h2>
            <p className="text-gray-600 text-xs mt-1">Geofence violations across all sites</p>
          </div>
          <div className="flex items-center gap-2">
            {/* Time-range chips */}
            <div className="flex items-center gap-1 bg-[#0F1E35] border border-[#1A3050] rounded-lg p-1">
              {(['24h', '7d', '30d'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSinceFilter(s)}
                  className={`px-3 py-1 rounded text-xs tracking-widest transition-colors ${
                    sinceFilter === s
                      ? 'bg-amber-500 text-black font-bold'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
            {/* Status chips */}
            <div className="flex items-center gap-1 bg-[#0F1E35] border border-[#1A3050] rounded-lg p-1">
              {(['all', 'open', 'resolved'] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setStatusFilter(s)}
                  className={`px-3 py-1 rounded text-xs tracking-widest transition-colors ${
                    statusFilter === s
                      ? 'bg-amber-500 text-black font-bold'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {s.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                <th className="text-left p-4">OCCURRED</th>
                <th className="text-left p-4">GUARD</th>
                <th className="text-left p-4">SITE</th>
                <th className="text-left p-4">COORDS</th>
                <th className="text-left p-4">DURATION</th>
                <th className="text-center p-4">STATUS</th>
                <th className="text-center p-4">PHOTO</th>
              </tr>
            </thead>
            <tbody>
              {breachesLoading && (
                <tr><td colSpan={7} className="text-center text-gray-500 py-10">Loading…</td></tr>
              )}
              {!breachesLoading && breaches.length === 0 && (
                <tr>
                  <td colSpan={7} className="text-center text-gray-500 py-10">
                    No breaches in this range.
                  </td>
                </tr>
              )}
              {!breachesLoading && breaches.map((b) => (
                <tr
                  key={b.id}
                  ref={(el) => {
                    if (el) breachRowRefs.current.set(b.id, el);
                    else    breachRowRefs.current.delete(b.id);
                  }}
                  className={`border-b border-[#1A3050] transition-colors ${
                    !b.is_resolved ? 'bg-red-950/30 hover:bg-red-950/50' : 'hover:bg-[#0B1526]'
                  } ${highlightedBreachId === b.id ? 'ring-2 ring-amber-400 ring-inset' : ''}`}
                >
                  <td className="p-4 text-gray-300 text-xs whitespace-nowrap">
                    {fmtBreachTime(b.occurred_at)}
                  </td>
                  <td className="p-4">
                    <p className="text-gray-200 text-sm">{b.guard_name}</p>
                    <p className="text-gray-600 text-xs font-mono">{b.badge_number}</p>
                  </td>
                  <td className="p-4 text-gray-400 text-xs">{b.site_name}</td>
                  <td className="p-4 text-gray-600 text-xs font-mono whitespace-nowrap">
                    {b.violation_lat.toFixed(5)}, {b.violation_lng.toFixed(5)}
                  </td>
                  <td className="p-4 text-gray-400 text-xs">{fmtDuration(b.duration_minutes)}</td>
                  <td className="p-4 text-center">
                    {b.is_resolved ? (
                      <span className="text-xs tracking-widest text-green-400">RESOLVED</span>
                    ) : (
                      <span className="text-xs tracking-widest text-red-400 font-bold animate-pulse">OPEN</span>
                    )}
                  </td>
                  <td className="p-4 text-center">
                    {b.photo_url ? (
                      <a
                        href={b.photo_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs tracking-widest text-amber-400 hover:text-amber-300 underline"
                      >
                        VIEW
                      </a>
                    ) : (
                      <span className="text-gray-700 text-xs">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
