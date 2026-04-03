'use client';
import { formatDistanceToNow } from 'date-fns';

interface Alert {
  id: string;
  type: 'incident' | 'geofence_violation' | 'missed_shift';
  description: string;
  site_name: string;
  guard_name: string;
  occurred_at: string;
  is_resolved: boolean;
}

const ALERT_STYLES: Record<Alert['type'], string> = {
  incident: 'border-red-500 bg-red-950',
  geofence_violation: 'border-orange-500 bg-orange-950',
  missed_shift: 'border-yellow-500 bg-yellow-950',
};

const ALERT_LABELS: Record<Alert['type'], string> = {
  incident: 'INCIDENT',
  geofence_violation: 'GEOFENCE',
  missed_shift: 'MISSED SHIFT',
};

export default function RecentAlerts({ alerts = [] }: { alerts?: Alert[] }) {
  return (
    <div className="bg-[#242436] border border-[#2E2E48] rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[#2E2E48]">
        <h2 className="text-amber-400 font-bold tracking-widest text-sm">RECENT ALERTS</h2>
      </div>
      <div className="p-4 space-y-3">
        {alerts.length === 0 && <p className="text-gray-500 text-sm text-center py-4">No recent alerts</p>}
        {alerts.map((alert) => (
          <div key={alert.id} className={`border-l-4 rounded p-3 ${ALERT_STYLES[alert.type]}`}>
            <div className="flex justify-between items-start">
              <span className="text-xs tracking-widest text-gray-400">{ALERT_LABELS[alert.type]}</span>
              <span className="text-xs text-gray-500">
                {formatDistanceToNow(new Date(alert.occurred_at), { addSuffix: true })}
              </span>
            </div>
            <p className="text-gray-200 text-sm mt-1">{alert.description}</p>
            <p className="text-gray-500 text-xs mt-1">{alert.site_name} · {alert.guard_name}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
