'use client';
/**
 * Vishnu Super Admin — Overview (/vishnu)
 * Platform-wide KPIs + company list with billing summary.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { vishnuGet, vishnuPatch } from '../../lib/vishnuApi';

interface KPIs {
  total_companies: number;
  active_sites:    number;
  active_guards:   number;
  legal_holds:     number;
  expiring_30d:    number;
}

interface Company {
  id:                  string;
  name:                string;
  default_photo_limit: number;
  is_active:           boolean;
  created_at:          string;
  active_sites:        string;
  active_guards:       string;
  admin_count:         string;
}

function KpiCard({ label, value, accent }: { label: string; value: number | string; accent?: string }) {
  return (
    <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-5">
      <p className="text-gray-500 text-xs tracking-widest mb-2">{label}</p>
      <p className={`text-4xl font-bold ${accent ?? 'text-gray-200'}`}>{value}</p>
    </div>
  );
}

export default function VishnuOverview() {
  const [kpis,      setKpis]      = useState<KPIs | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [toggling,  setToggling]  = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [k, c] = await Promise.all([
        vishnuGet<KPIs>('/api/admin/vishnu-kpis'),
        vishnuGet<Company[]>('/api/admin/companies'),
      ]);
      setKpis(k); setCompanies(c); setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleActive(c: Company) {
    setToggling(c.id);
    try {
      await vishnuPatch(`/api/admin/companies/${c.id}`, { is_active: !c.is_active });
      await load();
    } catch (e: any) { setError(e.message); }
    finally { setToggling(null); }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <h1 className="text-3xl font-bold tracking-widest text-gray-300">SUPER ADMIN</h1>
        <Link
          href="/vishnu/companies"
          className="self-start md:self-auto bg-gray-600 text-white text-xs tracking-widest font-bold px-4 py-2 rounded-lg hover:bg-gray-500 transition-colors whitespace-nowrap"
        >
          + NEW COMPANY
        </Link>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* KPI row — 5 cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <KpiCard label="COMPANIES"     value={kpis?.total_companies ?? '—'} />
        <KpiCard label="ACTIVE SITES"  value={kpis?.active_sites    ?? '—'} accent="text-green-400" />
        <KpiCard label="ACTIVE GUARDS" value={kpis?.active_guards   ?? '—'} />
        <KpiCard
          label="LEGAL HOLDS"
          value={kpis?.legal_holds ?? '—'}
          accent={kpis?.legal_holds ? 'text-orange-400' : 'text-gray-200'}
        />
        <KpiCard
          label="EXPIRING 30D"
          value={kpis?.expiring_30d ?? '—'}
          accent={kpis?.expiring_30d ? 'text-yellow-400' : 'text-gray-200'}
        />
      </div>

      {/* Companies table */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <div className="flex items-center justify-between p-4 border-b border-[#1A3050]">
          <h2 className="text-gray-400 text-xs tracking-widest font-bold">ALL COMPANIES</h2>
          <Link href="/vishnu/companies" className="text-xs text-gray-500 hover:text-gray-300 tracking-widest transition-colors">
            MANAGE →
          </Link>
        </div>
        {/*
         * 7-column table clips at <md. Wrap in overflow-x-auto and floor the
         * inner width at 540px so the table scrolls horizontally as a unit
         * inside the panel instead of pushing body scroll. Matches the
         * pattern already in /vishnu/compliance. Desktop unaffected — min-w
         * floors, doesn't cap.
         */}
        <div className="overflow-x-auto">
        <table className="w-full min-w-[540px] text-sm">
          <thead>
            <tr className="text-gray-600 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left p-4">COMPANY</th>
              <th className="text-center p-4">SITES</th>
              <th className="text-center p-4">GUARDS</th>
              <th className="text-center p-4">ADMINS</th>
              <th className="text-center p-4">PHOTO LIMIT</th>
              <th className="text-center p-4">STATUS</th>
              <th className="text-left p-4">CREATED</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center text-gray-500 py-10">Loading…</td></tr>}
            {!loading && companies.length === 0 && (
              <tr><td colSpan={7} className="text-center text-gray-500 py-10">No companies yet</td></tr>
            )}
            {companies.map((c) => (
              <tr key={c.id} className={`border-b border-[#1A3050] transition-colors ${c.is_active ? 'hover:bg-[#0B1526]' : 'opacity-50 hover:opacity-70'}`}>
                <td className="p-4">
                  <p className="text-gray-200 font-medium">{c.name}</p>
                  <p className="text-gray-600 text-xs font-mono">{c.id.slice(0, 8)}…</p>
                </td>
                <td className="p-4 text-center text-gray-300">{c.active_sites}</td>
                <td className="p-4 text-center text-gray-300">{c.active_guards}</td>
                <td className="p-4 text-center text-gray-500">{c.admin_count}</td>
                <td className="p-4 text-center text-gray-400 text-xs">{c.default_photo_limit} / report</td>
                <td className="p-4 text-center">
                  <button
                    onClick={() => toggleActive(c)}
                    disabled={toggling === c.id}
                    className={`text-xs tracking-widest px-2 py-1 rounded border transition-colors disabled:opacity-40 ${
                      c.is_active
                        ? 'border-red-700 text-red-400 hover:bg-red-900/30'
                        : 'border-green-700 text-green-400 hover:bg-green-900/30'
                    }`}
                  >
                    {toggling === c.id ? '…' : c.is_active ? 'DEACTIVATE' : 'ACTIVATE'}
                  </button>
                </td>
                <td className="p-4 text-gray-600 text-xs">
                  {new Date(c.created_at).toLocaleDateString('en-GB')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}
