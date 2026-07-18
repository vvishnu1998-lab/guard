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
  // Legacy scalar retained on the interface (the API still emits it) but
  // Phase 2 Q3 has us trust the `hours` object exclusively. If the API ever
  // omits `hours`, actualHoursThisWeek() returns 0 and the cell shows "—"
  // via formatHoursHHMM — no silent regression to the stored-total_hours
  // formula.
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

// Phase 2 Q3: trust `hours.actual_hours` exclusively. The Phase 1 API
// always emits the object alongside the legacy scalar, so this branch
// only degrades to 0 (rendered "—") if the API has genuinely regressed.
function actualHoursThisWeek(site: Site): number {
  const fromObj = site.hours?.actual_hours;
  return typeof fromObj === 'number' && Number.isFinite(fromObj) ? fromObj : 0;
}

export default function ActiveSitesTable({ sites = [] }: { sites?: Site[] }) {
  return (
    <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[#1A3050]">
        <h2 className="text-amber-400 font-bold tracking-widest text-sm">ACTIVE SITES</h2>
      </div>

      {sites.length === 0 && (
        <p className="text-center text-gray-500 py-8">No sites yet</p>
      )}

      {/* Desktop table (md+). Below md we use the card list further down. */}
      <table className="hidden md:table w-full text-sm">
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

      {/* Mobile card list (below md). Site name gets its own line so it
          doesn't have to wrap into 3 lines competing with metric columns;
          the four stats sit on a compact metric row below. */}
      <div className="md:hidden">
        {sites.map((site) => {
          const status = displayStatus(site);
          const hoursWeek = actualHoursThisWeek(site);
          return (
            <div
              key={site.id}
              className="px-4 py-3 border-b border-[#1A3050] last:border-b-0 hover:bg-[#0B1526] transition-colors"
            >
              <div className="flex items-start justify-between gap-3 mb-2">
                <Link
                  href={`/admin/sites/${site.id}`}
                  className="text-amber-400 hover:underline text-sm font-medium min-w-0 truncate"
                >
                  {site.name}
                </Link>
                <span className={`text-[10px] tracking-widest shrink-0 ${status.color}`}>
                  {status.label}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs text-gray-400 gap-3">
                <span><span className="text-gray-600 tracking-widest text-[10px]">GUARDS</span> {site.guard_count}</span>
                <span><span className="text-gray-600 tracking-widest text-[10px]">REPORTS</span> {site.reports_today}</span>
                <span className="whitespace-nowrap"><span className="text-gray-600 tracking-widest text-[10px]">HOURS</span> {formatHoursHHMM(hoursWeek)}</span>
              </div>
              {site.days_until_deletion !== null && site.days_until_deletion <= 30 && (
                <p className="text-[11px] text-red-400 mt-1">{site.days_until_deletion}d left</p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
