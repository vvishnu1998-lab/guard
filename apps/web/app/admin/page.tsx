'use client';
/**
 * Admin Dashboard — /admin
 * KPI row, active sites, guards on duty, recent alerts.
 * Fully client-side so adminApi can attach the auth cookie.
 */
import { useEffect, useState } from 'react';
import { adminGet } from '../../lib/adminApi';
import ActiveSitesTable from '../../components/admin/ActiveSitesTable';
import GuardsOnDuty from '../../components/admin/GuardsOnDuty';
import RecentAlerts from '../../components/admin/RecentAlerts';

interface Kpis {
  active_sites:    number;
  guards_on_duty:  number;
  reports_today:   number;
  geofence_alerts: number;
}

interface LiveGuard {
  id:             string;
  name:           string;
  site_name:      string;
  clocked_in_at:  string;
  last_ping_type: string | null;
  has_violation:  boolean;
}

interface DashboardSite {
  id:                  string;
  name:                string;
  guard_count:         number;
  reports_today:       number;
  hours_this_week:     number;
  // Phase 1 added the 4-field breakdown alongside the legacy scalar.
  // ActiveSitesTable prefers `hours.actual_hours` and falls back to
  // `hours_this_week` when the API hasn't shipped Phase 1 yet.
  hours?: {
    scheduled_hours: number;
    actual_hours:    number;
    break_hours:     number;
    violation_hours: number;
  };
  status:              'active' | 'inactive';
  days_until_deletion: number | null;
}

interface Alert {
  id:          string;
  type:        'incident' | 'geofence_violation' | 'missed_shift';
  description: string;
  site_name:   string;
  guard_name:  string;
  occurred_at: string;
  is_resolved: boolean;
}

interface RecentSwap {
  history_id:      string;
  shift_id:        string;
  accepted_at:     string;
  reason:          string | null;
  from_guard_name: string | null;
  to_guard_name:   string | null;
  site_name:       string;
  scheduled_start: string;
  site_tz:         string | null;
  is_same_site:    boolean;
}

const KPI_ZERO: Kpis = { active_sites: 0, guards_on_duty: 0, reports_today: 0, geofence_alerts: 0 };

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtShiftDayInTz(iso: string, tz: string | null): string {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    timeZone: tz ?? 'America/Los_Angeles',
  }).format(new Date(iso));
}

export default function AdminDashboard() {
  const [kpis,    setKpis]    = useState<Kpis>(KPI_ZERO);
  const [sites,   setSites]   = useState<DashboardSite[]>([]);
  const [guards,  setGuards]  = useState<any[]>([]);
  const [alerts,  setAlerts]  = useState<Alert[]>([]);
  const [swaps,   setSwaps]   = useState<RecentSwap[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [k, s, g, a, sw] = await Promise.all([
          adminGet<Kpis>('/api/admin/kpis').catch(() => KPI_ZERO),
          adminGet<DashboardSite[]>('/api/admin/dashboard-sites').catch(() => []),
          adminGet<LiveGuard[]>('/api/admin/live-guards').catch(() => []),
          adminGet<Alert[]>('/api/admin/recent-alerts').catch(() => []),
          adminGet<RecentSwap[]>('/api/admin/recent-swaps?hours=24').catch(() => []),
        ]);
        setKpis(k);
        setSites(s);
        setSwaps(sw);
        // Map live-guards to GuardsOnDuty shape
        setGuards(g.map((guard) => ({
          id:                 guard.id,
          name:               guard.name,
          site_name:          guard.site_name,
          hours_worked:       guard.clocked_in_at
            ? (Date.now() - new Date(guard.clocked_in_at).getTime()) / 3_600_000
            : 0,
          is_within_geofence: !guard.has_violation,
          on_break:           guard.last_ping_type === 'break_start',
        })));
        setAlerts(a);
      } catch (e: any) {
        setError(e.message ?? 'Failed to load dashboard');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const kpiCards = [
    { label: 'ACTIVE SITES',    value: kpis.active_sites,    color: 'text-amber-400' },
    { label: 'GUARDS ON DUTY',  value: kpis.guards_on_duty,  color: 'text-green-400' },
    { label: 'REPORTS TODAY',   value: kpis.reports_today,   color: 'text-blue-400'  },
    { label: 'GEOFENCE ALERTS', value: kpis.geofence_alerts, color: kpis.geofence_alerts > 0 ? 'text-red-400' : 'text-gray-400' },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold tracking-widest text-amber-400">DASHBOARD</h1>

      {error && (
        <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      {/* KPI Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpiCards.map(({ label, value, color }) => (
          <div key={label} className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-5">
            <p className="text-gray-500 text-xs tracking-widest mb-2">{label}</p>
            {loading
              ? <div className="h-10 w-12 bg-[#1A3050] rounded animate-pulse" />
              : <p className={`text-4xl font-bold ${color}`}>{value}</p>
            }
          </div>
        ))}
      </div>

      {/* Recent coverage swaps — hidden when none in the last 24h.
          FYI-only surface: nothing to click through (yet); admin can see
          history on the shift detail page. */}
      {swaps.length > 0 && (
        <div className="bg-[#0F1E35] border border-cyan-400/30 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-cyan-400 text-xs tracking-widest">RECENT COVERAGE SWAPS · LAST 24H</h2>
            <span className="text-gray-500 text-xs">{swaps.length}</span>
          </div>
          <ul className="space-y-2">
            {swaps.map((s) => (
              <li key={s.history_id} className="flex items-center flex-wrap gap-2 text-sm">
                <span className="text-cyan-400 font-medium">{s.from_guard_name ?? '(unknown)'}</span>
                <span className="text-gray-500">→</span>
                <span className="text-cyan-400 font-medium">{s.to_guard_name ?? '(unknown)'}</span>
                <span className="text-gray-500 text-xs">at</span>
                <span className="text-gray-200">{s.site_name}</span>
                <span className="text-gray-500 text-xs">on</span>
                <span className="text-gray-300 font-mono text-xs">{fmtShiftDayInTz(s.scheduled_start, s.site_tz)}</span>
                <span
                  className={`inline-block text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded border ${
                    s.is_same_site
                      ? 'bg-green-500/10 text-green-400 border-green-500/40'
                      : 'bg-amber-400/10 text-amber-400 border-amber-400/40'
                  }`}
                >
                  {s.is_same_site ? 'SAME SITE' : 'CROSS SITE'}
                </span>
                <span className="text-gray-500 text-xs ml-auto">{timeAgo(s.accepted_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Middle row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <ActiveSitesTable sites={sites} />
        </div>
        <div>
          <GuardsOnDuty guards={guards} />
        </div>
      </div>

      {/* Alerts */}
      <RecentAlerts alerts={alerts} />
    </div>
  );
}
