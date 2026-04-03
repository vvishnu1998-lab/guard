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

const KPI_ZERO: Kpis = { active_sites: 0, guards_on_duty: 0, reports_today: 0, geofence_alerts: 0 };

export default function AdminDashboard() {
  const [kpis,    setKpis]    = useState<Kpis>(KPI_ZERO);
  const [sites,   setSites]   = useState<DashboardSite[]>([]);
  const [guards,  setGuards]  = useState<any[]>([]);
  const [alerts,  setAlerts]  = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    async function load() {
      try {
        const [k, s, g, a] = await Promise.all([
          adminGet<Kpis>('/api/admin/kpis').catch(() => KPI_ZERO),
          adminGet<DashboardSite[]>('/api/admin/dashboard-sites').catch(() => []),
          adminGet<LiveGuard[]>('/api/admin/live-guards').catch(() => []),
          adminGet<Alert[]>('/api/admin/recent-alerts').catch(() => []),
        ]);
        setKpis(k);
        setSites(s);
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
          <div key={label} className="bg-[#242436] border border-[#2E2E48] rounded-xl p-5">
            <p className="text-gray-500 text-xs tracking-widest mb-2">{label}</p>
            {loading
              ? <div className="h-10 w-12 bg-[#2E2E48] rounded animate-pulse" />
              : <p className={`text-4xl font-bold ${color}`}>{value}</p>
            }
          </div>
        ))}
      </div>

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
