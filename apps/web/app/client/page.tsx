'use client';
/**
 * Client Read-Only Portal — Reports Feed (Section 10)
 * CRITICAL: All data must be scoped to client's site_id only (Section 11.5)
 */
import { useCallback, useEffect, useState } from 'react';
import { clientGet } from '../../lib/clientApi';
import ReportsFeed from '../../components/client/ReportsFeed';
import DownloadPanel from '../../components/client/DownloadPanel';
import RetentionNotice from '../../components/client/RetentionNotice';

interface SiteInfo {
  id:                  string;
  name:                string;
  data_delete_at:      string | null;
  days_until_deletion: number | null;
}

interface Report {
  id:          string;
  report_type: 'activity' | 'incident' | 'maintenance';
  description: string;
  severity?:   string;
  reported_at: string;
  guard_name:  string;
  photos?:     string[];
  email_sent?: boolean;
}

export default function ClientPortal() {
  const [site,    setSite]    = useState<SiteInfo | null>(null);
  const [reports, setReports] = useState<Report[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        clientGet<SiteInfo>('/api/client/site'),
        clientGet<Report[]>('/api/client/reports'),
      ]);
      setSite(s); setReports(r); setError('');
    } catch (e: any) {
      if (e.message?.includes('401') || e.message?.includes('Missing') || e.message?.includes('Invalid')) {
        window.location.href = '/client/login';
        return;
      }
      setError(e.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const daysRemaining = site?.days_until_deletion ?? undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-widest text-blue-400">SITE REPORTS</h1>
          {site && <p className="text-gray-500 text-xs tracking-widest mt-1">{site.name}</p>}
        </div>
      </div>

      {daysRemaining !== undefined && daysRemaining <= 30 && (
        <RetentionNotice daysRemaining={daysRemaining} />
      )}

      {error && (
        <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>
      )}

      {loading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <ReportsFeed reports={reports} />
          </div>
          <div>
            <DownloadPanel />
          </div>
        </div>
      )}
    </div>
  );
}
