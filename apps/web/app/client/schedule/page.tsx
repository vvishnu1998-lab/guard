'use client';
/**
 * Client Portal — Guards on Duty (/client/schedule)
 * Shows guards currently clocked in at this site. Read-only.
 * Personal details beyond first name are intentionally omitted (Section 10).
 */
import { useCallback, useEffect, useState } from 'react';
import { clientGet } from '../../../lib/clientApi';
import { formatHoursHHMM, formatOffPostHours, formatScheduledHours } from '../../../lib/formatHours';

interface ShiftHours {
  scheduled_hours: number;
  actual_hours:    number;
  break_hours:     number;
  violation_hours: number;
}

interface GuardOnDuty {
  name:           string;
  clocked_in_at:  string;
  // Legacy scalar retained on the interface (the API still emits it) but
  // Phase 2 Q3 trusts the `hours` object exclusively. If `hours` is missing
  // the card falls to the empty 4-field object and each cell renders "—".
  hours_on_duty:  number;
  hours?:         ShiftHours;
  last_lat:       number | null;
  last_lng:       number | null;
  last_ping_at:   string | null;
}

function elapsed(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function lastPingLabel(iso: string | null): { text: string; stale: boolean } {
  if (!iso) return { text: 'No ping yet', stale: true };
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  return { text: `${elapsed(iso)} ago`, stale: mins >= 35 };
}

export default function SchedulePage() {
  const [guards,  setGuards]  = useState<GuardOnDuty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [tick,    setTick]    = useState(0);

  const load = useCallback(async () => {
    try {
      setGuards(await clientGet<GuardOnDuty[]>('/api/client/guards-on-duty'));
      setError('');
    } catch (e: any) {
      if (e.message?.includes('401') || e.message?.includes('Missing')) {
        window.location.href = '/client/login'; return;
      }
      setError(e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Re-render elapsed times every minute
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-widest text-blue-400">GUARDS ON DUTY</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${guards.length > 0 ? 'bg-green-400 animate-pulse' : 'bg-gray-600'}`} />
            <span className="text-gray-400 text-sm whitespace-nowrap">{guards.length} active</span>
          </div>
          <button
            onClick={load}
            className="text-xs text-blue-400 border border-blue-700 rounded-lg px-3 py-1.5 hover:bg-blue-400/10 transition-colors tracking-widest"
          >
            REFRESH
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {loading && <p className="text-gray-500 text-sm">Loading…</p>}

      {!loading && guards.length === 0 && (
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-12 text-center">
          <p className="text-gray-500 text-sm">No guards are currently on duty at this site.</p>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {guards.map((g, i) => {
          const ping = lastPingLabel(g.last_ping_at);
          // Phase 2 Q3: trust the 4-field object. When absent, pass null
          // to the D2 helpers so each cell renders "—" (unknown) rather
          // than silently reading 0 as "0h 00m".
          const h: {
            scheduled_hours: number | null;
            actual_hours:    number | null;
            break_hours:     number | null;
            violation_hours: number | null;
          } = g.hours ?? {
            scheduled_hours: null,
            actual_hours:    null,
            break_hours:     null,
            violation_hours: null,
          };
          return (
            <div
              key={i}
              className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-5 space-y-3"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-blue-900/50 border border-blue-700 flex items-center justify-center">
                  <span className="text-blue-400 font-bold text-sm">{g.name.charAt(0).toUpperCase()}</span>
                </div>
                <div>
                  <p className="text-gray-200 font-medium">{g.name}</p>
                  <p className="text-green-400 text-xs tracking-widest">ON DUTY</p>
                </div>
              </div>

              {/* On-duty headline (D4) — the actual_hours field, big. */}
              <div className="border-t border-[#1A3050] pt-3">
                <p className="text-3xl font-bold text-blue-400 tabular-nums leading-none">
                  {formatHoursHHMM(h.actual_hours)}
                </p>
                <p className="text-gray-500 text-[10px] tracking-widest mt-1">ON DUTY</p>
              </div>

              {/* 4-field detail line — client labels per D3. */}
              <div className="border-t border-[#1A3050] pt-3 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500 tracking-widest">SCHEDULED</span>
                  <span className="text-gray-300 tabular-nums">{formatScheduledHours(h.scheduled_hours)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500 tracking-widest">BREAK</span>
                  <span className="text-gray-300 tabular-nums">{formatHoursHHMM(h.break_hours)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500 tracking-widest">OFF-POST</span>
                  <span className={`tabular-nums ${(h.violation_hours ?? 0) > 0 ? 'text-amber-400' : 'text-gray-300'}`}>
                    {formatOffPostHours(h.violation_hours)}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500 tracking-widest">CLOCKED IN</span>
                  <span className="text-gray-300">
                    {new Date(g.clocked_in_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-gray-500 tracking-widest">LAST PING</span>
                  <span className={ping.stale ? 'text-red-400' : 'text-gray-300'}>{ping.text}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <p className="text-gray-700 text-xs text-center">
        Guard location details are not shared with the client portal for privacy compliance.
      </p>
    </div>
  );
}
