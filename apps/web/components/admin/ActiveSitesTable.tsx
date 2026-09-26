'use client';
import Link from 'next/link';
import { formatHoursHHMM } from '../../lib/formatHours';
import { payableOf } from '../../lib/payableHours';

interface ShiftHours {
  scheduled_hours: number;
  actual_hours:    number;
  // Optional: an API deployed before D19 does not send it (Vercel and
  // Railway deploy separately); the cell then reads '—'.
  payable_hours?:  number;
  break_hours:     number;
  violation_hours: number;
}

interface Site {
  id: string;
  name: string;
  guard_count: number;
  reports_today: number;
  // Legacy scalar retained on the interface (the API still emits it) but
  // never read: it is the STORED total_hours (start-clamped), neither Actual
  // nor Payable. The HOURS cell shows hours.payable_hours, '—' when absent.
  hours_this_week: number;
  hours?: ShiftHours;
  days_until_deletion: number | null;
}

// The site's display status, derived from OPERATIONAL state. This function is
// the only definition of it; the API sends no status of its own. It once sent
// one derived from contract_end, which read "INACTIVE" for a site with a guard
// on post, and this function was added to override it. That column is gone now.
// Order:
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

// The STATUS input, not a displayed figure: any clocked-in time this week,
// raw, so a site whose only work fell outside its scheduled window still
// reads SCHEDULED. Deliberately Actual, not Payable (D19). A missing object
// gives 0, which only means "no activity" here — this value is never
// rendered, so the 0 cannot show up as "0h 00m".
function actualHoursThisWeek(site: Site): number {
  const fromObj = site.hours?.actual_hours;
  return typeof fromObj === 'number' && Number.isFinite(fromObj) ? fromObj : 0;
}

// The DISPLAYED figure: Payable this week (D19), or null — rendered '—' —
// when the API does not send it. Never 0 for "unknown", never Actual.
function payableHoursThisWeek(site: Site): number | null {
  return payableOf(site.hours);
}

const PAYABLE_TITLE = 'Payable: clocked-in time inside the scheduled window, this week';

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
            <th className="text-right p-4" title={PAYABLE_TITLE}>PAYABLE THIS WEEK</th>
            <th className="text-right p-4">STATUS</th>
          </tr>
        </thead>
        <tbody>
          {sites.map((site) => {
            const status = displayStatus(site);
            const hoursWeek = payableHoursThisWeek(site);
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
          const hoursWeek = payableHoursThisWeek(site);
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
                <span className="whitespace-nowrap"><span className="text-gray-600 tracking-widest text-[10px]">PAYABLE</span> {formatHoursHHMM(hoursWeek)}</span>
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
