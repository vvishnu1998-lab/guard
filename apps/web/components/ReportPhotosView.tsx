'use client';
/**
 * Shared "all photos for one report" view. Used by the admin and client
 * detail pages opened from the Activity Log via target="_blank".
 *
 * Fetches GET /api/reports/<id> and renders every photo in a responsive
 * grid plus the report meta + description above. Caller picks the
 * accent colour (admin amber, client blue).
 */
import { useEffect, useState } from 'react';

interface ReportDetail {
  id:          string;
  report_type: 'activity' | 'incident' | 'maintenance';
  severity:    'low' | 'medium' | 'high' | 'critical' | null;
  description: string;
  reported_at: string;
  site_name:   string;
  guard_name:  string;
  photos:      string[];
}

const TYPE_BADGE: Record<string, string> = {
  activity:    'bg-sky-900/40    text-sky-300    border-sky-700',
  incident:    'bg-red-900/40    text-red-300    border-red-700',
  maintenance: 'bg-violet-900/40 text-violet-300 border-violet-700',
};

const SEV_TEXT: Record<string, string> = {
  low:      'text-gray-400',
  medium:   'text-yellow-400',
  high:     'text-orange-400',
  critical: 'text-red-400 font-bold',
};

function fmtDT(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export interface ReportPhotosViewProps {
  reportId: string;
  fetcher:  <T>(path: string) => Promise<T>;
  accentClass?: string;
}

export default function ReportPhotosView({
  reportId,
  fetcher,
  accentClass = 'text-amber-400',
}: ReportPhotosViewProps) {
  const [report,  setReport]  = useState<ReportDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    fetcher<ReportDetail>(`/api/reports/${reportId}`)
      .then(setReport)
      .catch((e: any) => setError(e?.message ?? 'Failed to load'))
      .finally(() => setLoading(false));
  }, [reportId, fetcher]);

  if (loading) return <div className="text-center text-gray-500 py-12 text-sm">Loading…</div>;
  if (error)   return <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>;
  if (!report) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className={`text-3xl font-bold tracking-widest ${accentClass}`}>REPORT PHOTOS</h1>
        <span className="text-gray-500 text-xs tracking-widest">{report.photos.length} PHOTO{report.photos.length === 1 ? '' : 'S'}</span>
      </div>

      {/* Meta + description */}
      <div className="bg-[#0B1526] border border-[#1A3050] rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-xs tracking-widest px-2 py-0.5 rounded border ${TYPE_BADGE[report.report_type]}`}>
            {report.report_type.toUpperCase()}
          </span>
          {report.severity && (
            <span className={`text-xs tracking-widest ${SEV_TEXT[report.severity]}`}>
              {report.severity.toUpperCase()}
            </span>
          )}
          <span className="text-xs text-gray-500 tracking-widest ml-auto">{fmtDT(report.reported_at)}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span>Guard: <span className="text-gray-200">{report.guard_name}</span></span>
          <span className="text-gray-700">·</span>
          <span>Site: <span className="text-gray-200">{report.site_name}</span></span>
        </div>
        <p className="text-gray-300 text-sm whitespace-pre-wrap leading-relaxed border-t border-[#1A3050] pt-3">
          {report.description}
        </p>
      </div>

      {/* Photo grid */}
      {report.photos.length === 0 ? (
        <p className="text-center text-gray-500 text-sm py-8">No photos attached to this report.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {report.photos.map((url, i) => (
            <a key={i} href={url} target="_blank" rel="noreferrer" className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={url}
                alt={`Photo ${i + 1}`}
                className="w-full aspect-square object-cover rounded-lg border border-[#1A3050] hover:border-amber-400 transition-colors"
              />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
