'use client';
/**
 * Admin — Analytics (/admin/analytics)
 * Summary stats: monthly hours, report breakdown, incident severity, guard leaderboard.
 * CSV / Excel export via ExportPanel.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet } from '../../../lib/adminApi';
import ExportPanel from '../../../components/admin/ExportPanel';

interface Analytics {
  total_hours_this_month: number;
  reports_by_type:        { report_type: string; count: string }[];
  incidents_by_severity:  { severity: string; count: string }[];
  top_guards:             { name: string; badge_number: string; total_hours: string; shift_count: string }[];
  monthly_hours_by_site:  { month: string; site_name: string; hours: string }[];
}

const TYPE_COLOR: Record<string, string> = {
  activity:    'bg-amber-500',
  incident:    'bg-red-500',
  maintenance: 'bg-blue-500',
};

const SEV_COLOR: Record<string, string> = {
  low:      'bg-gray-500',
  medium:   'bg-yellow-500',
  high:     'bg-orange-500',
  critical: 'bg-red-600',
};

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
      <p className="text-gray-500 text-xs tracking-widest mb-2">{label}</p>
      <p className="text-3xl font-bold text-amber-400">{value}</p>
      {sub && <p className="text-gray-600 text-xs mt-1">{sub}</p>}
    </div>
  );
}

function BarRow({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-gray-400 text-xs w-24 shrink-0 capitalize">{label}</span>
      <div className="flex-1 bg-[#0B1526] rounded-full h-2">
        <div className={`h-2 rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-gray-400 text-xs w-8 text-right">{value}</span>
    </div>
  );
}

export default function AnalyticsPage() {
  const [data,    setData]    = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    try {
      setData(await adminGet<Analytics>('/api/admin/analytics'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">ANALYTICS</h1>
        <p className="text-gray-500 text-sm">Loading…</p>
      </div>
    );
  }

  const totalReports = data?.reports_by_type.reduce((s, r) => s + parseInt(r.count), 0) ?? 0;
  const maxSeverity  = Math.max(...(data?.incidents_by_severity.map((i) => parseInt(i.count)) ?? [1]));

  // Monthly totals across all sites
  const monthMap: Record<string, number> = {};
  data?.monthly_hours_by_site.forEach(({ month, hours }) => {
    monthMap[month] = (monthMap[month] ?? 0) + parseFloat(hours);
  });
  const months = Object.entries(monthMap);
  const maxMonthHours = Math.max(...months.map(([, h]) => h), 1);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">ANALYTICS</h1>
        <ExportPanel />
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="HOURS THIS MONTH" value={data?.total_hours_this_month ?? 0} sub="All sites combined" />
        <StatCard label="REPORTS (30 DAYS)" value={totalReports} sub="Activity + incident + maintenance" />
        <StatCard
          label="INCIDENTS (30 DAYS)"
          value={data?.reports_by_type.find((r) => r.report_type === 'incident')?.count ?? 0}
          sub="Across all sites"
        />
        <StatCard
          label="TOP GUARD HOURS"
          value={data?.top_guards[0] ? `${data.top_guards[0].total_hours}h` : '—'}
          sub={data?.top_guards[0]?.name ?? ''}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly hours */}
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
          <p className="text-amber-400 font-bold tracking-widest text-sm mb-4">MONTHLY HOURS (ALL SITES)</p>
          {months.length === 0 ? (
            <p className="text-gray-600 text-xs text-center py-8">No data yet</p>
          ) : (
            <div className="space-y-3">
              {months.map(([month, hours]) => (
                <BarRow key={month} label={month} value={Math.round(hours)} max={maxMonthHours} color="bg-amber-500" />
              ))}
            </div>
          )}
        </div>

        {/* Report type breakdown */}
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
          <p className="text-amber-400 font-bold tracking-widest text-sm mb-4">REPORTS BY TYPE (30 DAYS)</p>
          {totalReports === 0 ? (
            <p className="text-gray-600 text-xs text-center py-8">No reports yet</p>
          ) : (
            <div className="space-y-3">
              {data?.reports_by_type.map((r) => (
                <BarRow
                  key={r.report_type}
                  label={r.report_type}
                  value={parseInt(r.count)}
                  max={totalReports}
                  color={TYPE_COLOR[r.report_type] ?? 'bg-gray-500'}
                />
              ))}
            </div>
          )}
        </div>

        {/* Incident severity */}
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
          <p className="text-amber-400 font-bold tracking-widest text-sm mb-4">INCIDENT SEVERITY (30 DAYS)</p>
          {(data?.incidents_by_severity.length ?? 0) === 0 ? (
            <p className="text-gray-600 text-xs text-center py-8">No incidents in last 30 days</p>
          ) : (
            <div className="space-y-3">
              {(['critical', 'high', 'medium', 'low'] as const).map((sev) => {
                const row = data?.incidents_by_severity.find((i) => i.severity === sev);
                if (!row) return null;
                return (
                  <BarRow
                    key={sev}
                    label={sev}
                    value={parseInt(row.count)}
                    max={maxSeverity}
                    color={SEV_COLOR[sev]}
                  />
                );
              })}
            </div>
          )}
        </div>

        {/* Guard leaderboard */}
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
          <p className="text-amber-400 font-bold tracking-widest text-sm mb-4">GUARD HOURS LEADERBOARD (30 DAYS)</p>
          {(data?.top_guards.length ?? 0) === 0 ? (
            <p className="text-gray-600 text-xs text-center py-8">No completed shifts yet</p>
          ) : (
            <div className="space-y-2">
              {data?.top_guards.map((g, i) => (
                <div key={g.badge_number} className="flex items-center gap-3">
                  <span className={`text-xs font-bold w-5 text-right ${i === 0 ? 'text-amber-400' : 'text-gray-600'}`}>
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-gray-300 text-sm truncate">{g.name}</p>
                    <p className="text-gray-600 text-xs font-mono">
                      {g.badge_number} · {g.shift_count} shift{parseInt(g.shift_count) !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <span className="text-amber-400 text-sm font-bold">{g.total_hours}h</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
