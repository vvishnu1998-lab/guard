'use client';
/**
 * Admin — Analytics (/admin/analytics)
 * Summary stats: monthly hours, report breakdown, incident severity, guard leaderboard.
 * CSV / Excel export via ExportPanel.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet } from '../../../lib/adminApi';
import ExportPanel from '../../../components/admin/ExportPanel';
import { formatHoursHHMM, formatOffPostHours, formatScheduledHours } from '../../../lib/formatHours';

interface ShiftHours {
  scheduled_hours: number;
  actual_hours:    number;
  break_hours:     number;
  violation_hours: number;
}

interface Analytics {
  total_hours_this_month: number;
  // Phase 1 added the 4-field aggregate alongside the legacy scalar.
  totals_this_month?:     ShiftHours;
  reports_by_type:        { report_type: string; count: string }[];
  incidents_by_severity:  { severity: string; count: string }[];
  // total_hours can be null when a guard's only sessions this window are still open
  // (SUM(NULL) = NULL). Phase 2 prefers `hours.actual_hours` (numeric) when
  // present; falls back to the scalar `total_hours` string.
  top_guards: {
    name:         string;
    badge_number: string;
    total_hours:  string | null;
    shift_count:  string;
    hours?:       ShiftHours;
  }[];
  // Phase 1 restructured: the scalar `hours` string was renamed to
  // `hours_legacy`; `hours` is now the 4-field object (Phase 2 reads it
  // when populated, falling back to the legacy scalar).
  monthly_hours_by_site: {
    month:        string;
    site_name:    string;
    hours_legacy: string | null;
    hours?:       Partial<ShiftHours>;
  }[];
}

function parseHours(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(n) ? n : 0;
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

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: React.ReactNode }) {
  return (
    <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
      <p className="text-gray-500 text-xs tracking-widest mb-2">{label}</p>
      <p className="text-2xl md:text-3xl font-bold text-amber-400 whitespace-nowrap">{value}</p>
      {sub && <p className="text-gray-600 text-xs mt-1">{sub}</p>}
    </div>
  );
}

function BarRow({ label, value, valueLabel, max, color }: {
  label: string;
  value: number;
  valueLabel?: string;
  max: number;
  color: string;
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="text-gray-400 text-xs w-24 shrink-0 capitalize">{label}</span>
      <div className="flex-1 bg-[#0B1526] rounded-full h-2">
        <div className={`h-2 rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-gray-400 text-xs w-16 text-right tabular-nums">
        {valueLabel ?? value}
      </span>
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

  // Monthly totals across all sites. Prefer the 4-field object's actual_hours
  // when Phase 1 has shipped; fall back to `hours_legacy` (scalar string) so
  // pre-Phase-1 API responses still render. Empty-window collapse: Math.max
  // of an empty array is -Infinity — the || 1 fallback keeps bar widths sane.
  const monthMap: Record<string, number> = {};
  data?.monthly_hours_by_site.forEach(({ month, hours_legacy, hours }) => {
    const v = hours?.actual_hours != null ? hours.actual_hours : parseHours(hours_legacy);
    monthMap[month] = (monthMap[month] ?? 0) + v;
  });
  const months = Object.entries(monthMap).filter(([, h]) => Number.isFinite(h));
  const maxMonthHours = Math.max(...months.map(([, h]) => h), 1);
  const hasMonthlyData = months.some(([, h]) => h > 0);

  // Phase 2 D4: aggregate rollups show actual (big) with the other three
  // fields in a detail sub-line. Falls back to the pre-Phase-1 scalar when
  // the 4-field object isn't present.
  const monthTotals: ShiftHours = data?.totals_this_month ?? {
    scheduled_hours: 0,
    actual_hours:    data?.total_hours_this_month ?? 0,
    break_hours:     0,
    violation_hours: 0,
  };
  const monthKpiValue = formatHoursHHMM(monthTotals.actual_hours);
  const monthKpiSub = (
    <>
      Scheduled: <span className="text-gray-500">{formatScheduledHours(monthTotals.scheduled_hours)}</span>
      {'  ·  '}
      Break: <span className="text-gray-500">{formatHoursHHMM(monthTotals.break_hours)}</span>
      {'  ·  '}
      Off-post: <span className="text-gray-500">{formatOffPostHours(monthTotals.violation_hours)}</span>
    </>
  );

  // Top-guard KPI card: prefer the 4-field hours.actual_hours (numeric);
  // fall back to legacy total_hours (string). null → "—" per D2.
  const topGuardActual = data?.top_guards[0]
    ? (data.top_guards[0].hours?.actual_hours ?? parseFloat(data.top_guards[0].total_hours ?? '') )
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">ANALYTICS</h1>
        <ExportPanel />
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="HOURS THIS MONTH" value={monthKpiValue} sub={monthKpiSub} />
        <StatCard label="REPORTS (30 DAYS)" value={totalReports} sub="Activity + incident + maintenance" />
        <StatCard
          label="INCIDENTS (30 DAYS)"
          value={data?.reports_by_type.find((r) => r.report_type === 'incident')?.count ?? 0}
          sub="Across all sites"
        />
        <StatCard
          label="TOP GUARD HOURS"
          value={formatHoursHHMM(topGuardActual != null && Number.isFinite(topGuardActual) ? topGuardActual : null)}
          sub={data?.top_guards[0]?.name ?? ''}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly hours */}
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
          <p className="text-amber-400 font-bold tracking-widest text-sm mb-4">MONTHLY HOURS (ALL SITES)</p>
          {!hasMonthlyData ? (
            <p className="text-gray-600 text-xs text-center py-8">No completed shifts yet</p>
          ) : (
            <div className="space-y-3">
              {months.map(([month, hours]) => (
                <BarRow
                  key={month}
                  label={month}
                  value={hours}
                  valueLabel={formatHoursHHMM(hours)}
                  max={maxMonthHours}
                  color="bg-amber-500"
                />
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
              {data?.top_guards.map((g, i) => {
                const actual = g.hours?.actual_hours != null
                  ? g.hours.actual_hours
                  : parseFloat(g.total_hours ?? '');
                return (
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
                    <span className="text-amber-400 text-sm font-bold tabular-nums">
                      {formatHoursHHMM(Number.isFinite(actual) ? actual : null)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
