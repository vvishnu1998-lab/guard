'use client';

interface GuardOnDuty {
  id: string;
  name: string;
  site_name: string;
  hours_worked: number;
  is_within_geofence: boolean;
  on_break: boolean;
}

export default function GuardsOnDuty({ guards = [] }: { guards?: GuardOnDuty[] }) {
  return (
    <div className="bg-[#242436] border border-[#2E2E48] rounded-xl overflow-hidden">
      <div className="p-4 border-b border-[#2E2E48] flex justify-between items-center">
        <h2 className="text-amber-400 font-bold tracking-widest text-sm">GUARDS ON DUTY</h2>
        <span className="text-green-400 text-xs">{guards.length} ACTIVE</span>
      </div>
      <div className="divide-y divide-[#2E2E48]">
        {guards.length === 0 && (
          <p className="text-center text-gray-500 py-8 text-sm">No guards on duty</p>
        )}
        {guards.map((guard) => (
          <div key={guard.id} className="p-4 flex items-center justify-between">
            <div>
              <p className="text-gray-200 font-medium text-sm">{guard.name}</p>
              <p className="text-gray-500 text-xs mt-0.5">{guard.site_name}</p>
            </div>
            <div className="text-right">
              <p className="text-gray-400 text-xs">{guard.hours_worked.toFixed(1)}h</p>
              <div className="flex gap-1 mt-1 justify-end">
                {guard.on_break && (
                  <span className="text-xs bg-yellow-900 text-yellow-400 px-1.5 py-0.5 rounded">BREAK</span>
                )}
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  guard.is_within_geofence
                    ? 'bg-green-900 text-green-400'
                    : 'bg-red-900 text-red-400'
                }`}>
                  {guard.is_within_geofence ? 'IN ZONE' : 'VIOLATION'}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
