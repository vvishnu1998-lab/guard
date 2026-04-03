'use client';
import Link from 'next/link';

interface Site {
  id: string;
  name: string;
  guard_count: number;
  reports_today: number;
  hours_this_week: number;
  status: 'active' | 'inactive';
  days_until_deletion: number | null;
}

export default function ActiveSitesTable({ sites = [] }: { sites?: Site[] }) {
  return (
    <div className="bg-[#242436] border border-[#2E2E48] rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[#2E2E48]">
        <h2 className="text-amber-400 font-bold tracking-widest text-sm">ACTIVE SITES</h2>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-gray-500 text-xs tracking-widest border-b border-[#2E2E48]">
            <th className="text-left p-4">SITE</th>
            <th className="text-right p-4">GUARDS</th>
            <th className="text-right p-4">REPORTS</th>
            <th className="text-right p-4">HOURS</th>
            <th className="text-right p-4">STATUS</th>
          </tr>
        </thead>
        <tbody>
          {sites.length === 0 && (
            <tr><td colSpan={5} className="text-center text-gray-500 py-8">No sites yet</td></tr>
          )}
          {sites.map((site) => (
            <tr key={site.id} className="border-b border-[#2E2E48] hover:bg-[#1A1A2E] transition-colors">
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
              <td className="p-4 text-right text-gray-300">{site.hours_this_week.toFixed(1)}h</td>
              <td className="p-4 text-right">
                <span className={`text-xs tracking-widest ${site.status === 'active' ? 'text-green-400' : 'text-gray-500'}`}>
                  {site.status.toUpperCase()}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
