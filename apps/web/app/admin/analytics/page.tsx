'use client';
/**
 * Admin — Analytics (/admin/analytics)
 * Summary stats: monthly payable hours, report breakdown, incident severity,
 * guard leaderboard. CSV / Excel export via ExportPanel.
 *
 * The hours figures here are PAYABLE (D19): clocked-in time inside the
 * scheduled window. Actual (raw clock-out − clock-in) is shown beside the
 * month total. See lib/payableHours.ts for why a missing payable_hours
 * renders '—' and never falls back to another figure.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet } from '../../../lib/adminApi';
import ExportPanel from '../../../components/admin/ExportPanel';
import { formatHoursHHMM, formatOffPostHours, formatScheduledHours } from '../../../lib/formatHours';
import { monthlyPayable, payableOf } from '../../../lib/payableHours';

interface ShiftHours {
  scheduled_hours: number;
  actual_hours:    number;
  // Optional: an API deployed before D19 does not send it (Vercel and
  // Railway deploy separately). Required here would also invite a `?? 0`.
  payable_hours?:  number;
  break_hours:     number;
  violation_hours: number;
}

interface Analytics {
  // Legacy scalars below (total_hours_this_month, top_guards[].total_hours,
  // hours_legacy) are the STORED total_hours column — start-clamped, neither
  // Actual nor Payable. Kept in the type because the API still sends them;
  // nothing on this page reads them.
  total_hours_this_month: number;
  totals_this_month?:     ShiftHours;
  reports_by_type:        { report_type: string; count: string }[];
  incidents_by_severity:  { severity: string; count: string }[];
  top_guards: {
    name:         string;
    badge_number: string;
    total_hours:  string | null;
    shift_count:  string;
    hours?:       ShiftHours;
  }[];
  monthly_hours_by_site: {
    month:        string;
    site_name:    string;
    hours_legacy: string | null;
    hours?:       Partial<ShiftHours>;
  }[];
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

  // Monthly PAYABLE totals across all sites. A month whose payable is unknown
  // (an API from before D19) keeps its row and shows '—'; the empty state
  // keys on whether there are rows at all, so unknown never reads as
  // "No completed shifts yet".
  const monthly = monthlyPayable(data?.monthly_hours_by_site ?? []);
  const hasMonthlyRows = monthly.months.length > 0;

  // D19: the month total headlines PAYABLE; Actual leads the sub-line so an
  // admin sees both. No fallback object — if the API sends no breakdown,
  // every figure reads '—' rather than a different number under its label.
  const monthTotals = data?.totals_this_month;
  const monthKpiValue = formatHoursHHMM(payableOf(monthTotals));
  const monthKpiSub = (
    <>
      Actual: <span className="text-gray-500">{formatHoursHHMM(monthTotals?.actual_hours)}</span>
      {'  ·  '}
      Scheduled: <span className="text-gray-500">{formatScheduledHours(monthTotals?.scheduled_hours)}</span>
      {'  ·  '}
      Break: <span className="text-gray-500">{formatHoursHHMM(monthTotals?.break_hours)}</span>
      {'  ·  '}
      Geofence violation: <span className="text-gray-500">{formatOffPostHours(monthTotals?.violation_hours)}</span>
    </>
  );

  // Top-guard KPI card: the leaderboard's first row, by Payable. Its sub-line
  // is the guard's name, so it carries no Actual figure.
  const topGuardPayable = payableOf(data?.top_guards[0]?.hours);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">ANALYTICS</h1>
        <ExportPanel />
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="PAYABLE THIS MONTH" value={monthKpiValue} sub={monthKpiSub} />
        <StatCard label="REPORTS (30 DAYS)" value={totalReports} sub="Activity + incident + maintenance" />
        <StatCard
          label="INCIDENTS (30 DAYS)"
          value={data?.reports_by_type.find((r) => r.report_type === 'incident')?.count ?? 0}
          sub="Across all sites"
        />
        <StatCard
          label="TOP GUARD · PAYABLE"
          value={formatHoursHHMM(topGuardPayable)}
          sub={data?.top_guards[0]?.name ?? ''}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Monthly payable hours */}
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6">
          <p className="text-amber-400 font-bold tracking-widest text-sm mb-4">MONTHLY PAYABLE (ALL SITES)</p>
          {!hasMonthlyRows ? (
            <p className="text-gray-600 text-xs text-center py-8">No completed shifts yet</p>
          ) : (
            <div className="space-y-3">
              {monthly.months.map(([month, hours]) => (
                <BarRow
                  key={month}
                  label={month}
                  value={hours ?? 0}
                  valueLabel={formatHoursHHMM(hours)}
                  max={monthly.max}
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
          <p className="text-amber-400 font-bold tracking-widest text-sm mb-4">GUARD PAYABLE HOURS (30 DAYS)</p>
          {(data?.top_guards.length ?? 0) === 0 ? (
            <p className="text-gray-600 text-xs text-center py-8">No completed shifts yet</p>
          ) : (
            <div className="space-y-2">
              {data?.top_guards.map((g, i) => {
                const payable = payableOf(g.hours);
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
                      {formatHoursHHMM(payable)}
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
