'use client';
/**
 * Admin — Live Guard Status (/admin/live-map)
 * Real-time table of guards currently on shift with last known location + ping time.
 * Auto-refreshes every 30 seconds.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
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

export default function LiveMapPage() {
  const [guards,      setGuards]      = useState<LiveGuard[]>([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [countdown,   setCountdown]   = useState(30);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setGuards(await adminGet<LiveGuard[]>('/api/admin/live-guards'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally {
      setLoading(false);
      setLastRefresh(new Date());
      setCountdown(30);
    }
  }, []);

  useEffect(() => {
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

      <div className="bg-[#242436] border border-[#2E2E48] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs tracking-widest border-b border-[#2E2E48]">
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
                  className={`border-b border-[#2E2E48] transition-colors ${
                    g.has_violation ? 'bg-red-950/30 hover:bg-red-950/50' : 'hover:bg-[#1A1A2E]'
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
    </div>
  );
}
