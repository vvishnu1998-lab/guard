'use client';
import Link from 'next/link';
import { formatHoursHHMM } from '../../lib/formatHours';

interface ShiftHours {
  scheduled_hours: number;
  actual_hours:    number;
  break_hours:     number;
  violation_hours: number;
}

interface Site {
  id: string;
  name: string;
  guard_count: number;
  reports_today: number;
  // Legacy scalar (SUM of stored total_hours). Phase 1 added the 4-field
  // `hours` object alongside; Phase 2 prefers it and falls back to the
  // scalar for a brief compat window until every deploy has Phase 1 shipped.
  hours_this_week: number;
  hours?: ShiftHours;
  status: 'active' | 'inactive';
  days_until_deletion: number | null;
}

// Derive display status from OPERATIONAL state, not from the API's `status`
// field. The API's `status` reflects contract_end (contract active vs expired),
// which surfaced as "INACTIVE" on sites with a live guard on-shift. Order:
//   guards on-post   → ACTIVE  (green)
//   completed shifts → SCHEDULED (amber) — no one on-post right now but the
//                      site had activity this week
//   neither          → INACTIVE (gray)
function displayStatus(site: Site): { label: string; color: string } {
  const guards = Number(site.guard_count) || 0;
  const hours  = actualHoursThisWeek(site);
  if (guards > 0) return { label: 'ACTIVE',    color: 'text-green-400' };
  if (hours  > 0) return { label: 'SCHEDULED', color: 'text-amber-400' };
  return                { label: 'INACTIVE',  color: 'text-gray-500' };
}

// Prefer the 4-field object's actual_hours (raw clock_out − clock_in, per
// Phase 1 D1); fall back to the legacy scalar total_hours sum when the API
// hasn't shipped Phase 1 yet.
function actualHoursThisWeek(site: Site): number {
  const fromObj = site.hours?.actual_hours;
  if (typeof fromObj === 'number' && Number.isFinite(fromObj)) return fromObj;
  return Number(site.hours_this_week) || 0;
}

export default function ActiveSitesTable({ sites = [] }: { sites?: Site[] }) {
  return (
    <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[#1A3050]">
        <h2 className="text-amber-400 font-bold tracking-widest text-sm">ACTIVE SITES</h2>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
            <th className="text-left p-4">SITE</th>
            <th className="text-right p-4">GUARDS</th>
            <th className="text-right p-4">REPORTS</th>
            <th className="text-right p-4">HOURS THIS WEEK</th>
            <th className="text-right p-4">STATUS</th>
          </tr>
        </thead>
        <tbody>
          {sites.length === 0 && (
            <tr><td colSpan={5} className="text-center text-gray-500 py-8">No sites yet</td></tr>
          )}
          {sites.map((site) => {
            const status = displayStatus(site);
            const hoursWeek = actualHoursThisWeek(site);
            return (
              <tr key={site.id} className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors">
                <td className="p-4">
                  <Link href={`/admin/sites/${site.id}`} className="text-amber-400 hover:underline">
                    {site.name}
                  </Link>
                  {site.days_until_deletion !== null && site.days_until_deletion <= 30 && (
                    <span className="ml-2 text-xs text-red-400">{site.days_until_deletion}d left</span>
                  )}
                </td>
                <td className="p-4 text-right text-gray-300">{site.guard_count}</td>
                <td className="p-4 text-right text-gray-300">{site.reports_today}</td>
                <td className="p-4 text-right text-gray-300">{formatHoursHHMM(hoursWeek)}</td>
                <td className="p-4 text-right">
                  <span className={`text-xs tracking-widest ${status.color}`}>
                    {status.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
