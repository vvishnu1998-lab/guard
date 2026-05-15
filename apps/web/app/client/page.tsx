'use client';
/**
 * Client Read-Only Portal — Site Activity Log (Section 10)
 * CRITICAL: server scopes data to the client's site_id (Section 11.5).
 *
 * Full-width activity log table (no right-column DownloadPanel — Downloads
 * has its own sidebar tab). Date range only; no guard search.
 */
import { useCallback, useEffect, useState } from 'react';
import { clientGet } from '../../lib/clientApi';
import ActivityLogTable from '../../components/ActivityLogTable';
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
        <ActivityLogTable
          fetcher={clientGet}
          accentClass="text-blue-400"
          heading="SITE ACTIVITY LOG"
          mode="client"
          detailPathPrefix="/client/reports"
        />
      )}
    </div>
  );
}
