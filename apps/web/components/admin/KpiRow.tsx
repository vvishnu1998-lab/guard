import { fetchApi } from '../../lib/api';

interface KpiData {
  active_sites: number;
  guards_on_duty: number;
  reports_today: number;
  geofence_alerts: number;
}

export default async function KpiRow() {
  // Server component — direct fetch
  const data: KpiData = await fetchApi('/api/admin/kpis').catch(() => ({
    active_sites: 0, guards_on_duty: 0, reports_today: 0, geofence_alerts: 0,
  }));

  const kpis = [
    { label: 'ACTIVE SITES', value: data.active_sites, color: 'text-amber-400' },
    { label: 'GUARDS ON DUTY', value: data.guards_on_duty, color: 'text-green-400' },
    { label: 'REPORTS TODAY', value: data.reports_today, color: 'text-blue-400' },
    { label: 'GEOFENCE ALERTS', value: data.geofence_alerts, color: data.geofence_alerts > 0 ? 'text-red-400' : 'text-gray-400' },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {kpis.map(({ label, value, color }) => (
        <div key={label} className="bg-[#242436] border border-[#2E2E48] rounded-xl p-5">
          <p className="text-gray-500 text-xs tracking-widest mb-2">{label}</p>
          <p className={`text-4xl font-bold ${color}`}>{value}</p>
        </div>
      ))}
    </div>
  );
}
