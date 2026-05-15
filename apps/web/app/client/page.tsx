'use client';
/**
 * Client Read-Only Portal — Site Activity Log (Section 10)
 * CRITICAL: server scopes data to the client's site_id (Section 11.5).
 *
 * Layout: activity log table on the left (2/3 width), download +
 * retention notice panels on the right (1/3 width). Same table component
 * as /admin/reports — see components/ActivityLogTable.tsx.
 */
import { useCallback, useEffect, useState } from 'react';
import { clientGet } from '../../lib/clientApi';
import ActivityLogTable from '../../components/ActivityLogTable';
import DownloadPanel from '../../components/client/DownloadPanel';
import RetentionNotice from '../../components/client/RetentionNotice';

interface SiteInfo {
  id:                  string;
  name:                string;
  data_delete_at:      string | null;
  days_until_deletion: number | null;
}

export default function ClientPortal() {
  const [site,    setSite]    = useState<SiteInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const load = useCallback(async () => {
    try {
      const s = await clientGet<SiteInfo>('/api/client/site');
      setSite(s);
      setError('');
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
          <h1 className="text-3xl font-bold tracking-widest text-blue-400">SITE ACTIVITY</h1>
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
            <ActivityLogTable
              fetcher={clientGet}
              accentClass="text-blue-400"
              heading="SITE ACTIVITY LOG"
            />
          </div>
          <div>
            <DownloadPanel />
          </div>
        </div>
      )}
    </div>
  );
}
