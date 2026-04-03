'use client';
import { useState } from 'react';
import { formatDistanceToNow, format } from 'date-fns';

interface Report {
  id: string;
  report_type: 'activity' | 'incident' | 'maintenance';
  description: string;
  severity?: string;
  reported_at: string;
  guard_name: string; // only name shown — no badge, email, or personal details (Section 10)
  photos?: string[];
  email_sent?: boolean;
}

const TYPE_STYLES = {
  activity: 'border-amber-500',
  incident: 'border-red-500',
  maintenance: 'border-blue-500',
};

const TYPE_LABELS = {
  activity: 'ACTIVITY',
  incident: 'INCIDENT',
  maintenance: 'MAINTENANCE',
};

const SEVERITY_COLORS: Record<string, string> = {
  low: 'text-green-400',
  medium: 'text-yellow-400',
  high: 'text-orange-400',
  critical: 'text-red-400',
};

export default function ReportsFeed({ reports = [] }: { reports?: Report[] }) {
  const [filter, setFilter] = useState<'all' | Report['report_type']>('all');

  const filtered = filter === 'all' ? reports : reports.filter((r) => r.report_type === filter);

  return (
    <div className="space-y-4">
      {/* Daily KPI strip */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: 'REPORTS', value: reports.length },
          { label: 'INCIDENTS', value: reports.filter((r) => r.report_type === 'incident').length },
          { label: 'TASKS', value: 0 },
          { label: 'HOURS', value: '0.0' },
        ].map(({ label, value }) => (
          <div key={label} className="bg-[#242436] border border-[#2E2E48] rounded-lg p-3 text-center">
            <p className="text-gray-500 text-xs tracking-widest">{label}</p>
            <p className="text-2xl font-bold text-blue-400 mt-1">{value}</p>
          </div>
        ))}
      </div>

      {/* Filter chips */}
      <div className="flex gap-2">
        {(['all', 'activity', 'incident', 'maintenance'] as const).map((type) => (
          <button
            key={type}
            onClick={() => setFilter(type)}
            className={`text-xs tracking-widest px-3 py-1.5 rounded-full border transition-colors ${
              filter === type
                ? 'bg-blue-500 border-blue-500 text-white'
                : 'border-[#2E2E48] text-gray-400 hover:border-blue-400'
            }`}
          >
            {type.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Report cards */}
      {filtered.length === 0 && (
        <p className="text-gray-500 text-center py-12">No reports found</p>
      )}
      {filtered.map((report) => (
        <div
          key={report.id}
          className={`bg-[#242436] border-l-4 rounded-xl p-5 ${TYPE_STYLES[report.report_type]}`}
        >
          <div className="flex justify-between items-start mb-2">
            <div className="flex items-center gap-2">
              <span className="text-xs tracking-widest text-gray-400">{TYPE_LABELS[report.report_type]}</span>
              {report.report_type === 'incident' && report.email_sent && (
                <span className="text-xs bg-red-900 text-red-300 px-2 py-0.5 rounded">EMAIL SENT</span>
              )}
              {report.severity && (
                <span className={`text-xs tracking-widest uppercase ${SEVERITY_COLORS[report.severity] || ''}`}>
                  {report.severity}
                </span>
              )}
            </div>
            <span className="text-xs text-gray-500">
              {format(new Date(report.reported_at), 'MMM d, HH:mm')}
            </span>
          </div>
          <p className="text-gray-200 text-sm leading-relaxed">{report.description}</p>
          <p className="text-gray-500 text-xs mt-2">Guard: {report.guard_name}</p>
          {report.photos && report.photos.length > 0 && (
            <div className="flex gap-2 mt-3">
              {report.photos.map((url, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={url} alt="" className="w-16 h-16 rounded object-cover" />
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
