'use client';
/**
 * Vishnu — Data Retention Status (/vishnu/retention)
 * All sites in or approaching the retention window.
 * Shows milestone flags, days to access expiry, days to hard deletion.
 */
import { useCallback, useEffect, useState } from 'react';
import { vishnuGet } from '../../../lib/vishnuApi';

interface RetentionRow {
  site_id:                    string;
  site_name:                  string;
  company_name:               string;
  client_star_access_until:   string;
  data_delete_at:             string;
  warning_60_sent:            boolean;
  warning_89_sent:            boolean;
  warning_140_sent:           boolean;
  client_star_access_disabled: boolean;
  data_deleted:               boolean;
  days_to_access_end:         number;
  days_to_deletion:           number;
}

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function DaysCell({ days, warn, danger }: { days: number; warn: number; danger: number }) {
  const color = days <= danger ? 'text-red-400 font-bold' :
                days <= warn   ? 'text-orange-400 font-medium' :
                                 'text-gray-400';
  return <span className={`text-sm ${color}`}>{days < 0 ? 'EXPIRED' : `${days}d`}</span>;
}

function Flag({ sent, label }: { sent: boolean; label: string }) {
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded border ${
      sent ? 'border-green-800 text-green-500' : 'border-[#1A3050] text-gray-700'
    }`}>
      {label}
    </span>
  );
}

export default function RetentionPage() {
  const [rows,    setRows]    = useState<RetentionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [filter,  setFilter]  = useState<'all' | 'urgent' | 'expired'>('all');

  const load = useCallback(async () => {
    try {
      setRows(await vishnuGet<RetentionRow[]>('/api/admin/retention-status'));
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const visible = rows.filter((r) => {
    if (filter === 'urgent')  return r.days_to_deletion <= 30 && !r.data_deleted;
    if (filter === 'expired') return r.client_star_access_disabled;
    return true;
  });

  const urgentCount  = rows.filter((r) => r.days_to_deletion <= 30 && !r.data_deleted).length;
  const expiredCount = rows.filter((r) => r.client_star_access_disabled).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-gray-300">RETENTION</h1>
        <button onClick={load} className="text-xs text-gray-500 border border-[#1A3050] rounded-lg px-3 py-2 hover:text-gray-300 hover:border-gray-500 transition-colors tracking-widest">
          REFRESH
        </button>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'IN WINDOW',  value: rows.length,    color: 'text-gray-200' },
          { label: 'URGENT (≤30D)', value: urgentCount,  color: urgentCount > 0 ? 'text-red-400' : 'text-gray-200' },
          { label: 'ACCESS EXPIRED', value: expiredCount, color: expiredCount > 0 ? 'text-orange-400' : 'text-gray-200' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-4 text-center">
            <p className="text-gray-600 text-xs tracking-widest mb-1">{label}</p>
            <p className={`text-3xl font-bold ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Filter tabs */}
      <div className="flex gap-2">
        {(['all', 'urgent', 'expired'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`text-xs tracking-widest px-3 py-1.5 rounded border transition-colors ${
              filter === f ? 'bg-gray-600 border-gray-500 text-white' : 'border-[#1A3050] text-gray-500 hover:text-gray-300'
            }`}
          >
            {f.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-600 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left p-4">SITE</th>
              <th className="text-left p-4">COMPANY</th>
              <th className="text-center p-4">ACCESS ENDS</th>
              <th className="text-center p-4">DAYS TO ACCESS</th>
              <th className="text-center p-4">DELETION DATE</th>
              <th className="text-center p-4">DAYS TO DELETE</th>
              <th className="text-center p-4">NOTICES SENT</th>
              <th className="text-center p-4">STATE</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={8} className="text-center text-gray-500 py-10">Loading…</td></tr>}
            {!loading && visible.length === 0 && <tr><td colSpan={8} className="text-center text-gray-500 py-10">No sites in retention window</td></tr>}
            {visible.map((r) => (
              <tr
                key={r.site_id}
                className={`border-b border-[#1A3050] transition-colors ${
                  r.days_to_deletion <= 10 && !r.data_deleted ? 'bg-red-950/20 hover:bg-red-950/30' :
                  r.days_to_deletion <= 30 && !r.data_deleted ? 'bg-orange-950/10 hover:bg-orange-950/20' :
                  'hover:bg-[#0B1526]'
                }`}
              >
                <td className="p-4">
                  <p className="text-gray-200 font-medium">{r.site_name}</p>
                  <p className="text-gray-700 text-xs font-mono">{r.site_id.slice(0, 8)}…</p>
                </td>
                <td className="p-4 text-gray-400 text-xs">{r.company_name}</td>
                <td className="p-4 text-center text-gray-500 text-xs">{fmtDate(r.client_star_access_until)}</td>
                <td className="p-4 text-center">
                  {r.client_star_access_disabled
                    ? <span className="text-xs text-orange-400 font-medium">DISABLED</span>
                    : <DaysCell days={r.days_to_access_end} warn={30} danger={7} />}
                </td>
                <td className="p-4 text-center text-gray-500 text-xs">{fmtDate(r.data_delete_at)}</td>
                <td className="p-4 text-center">
                  <DaysCell days={r.days_to_deletion} warn={30} danger={10} />
                </td>
                <td className="p-4">
                  <div className="flex gap-1 justify-center flex-wrap">
                    <Flag sent={r.warning_60_sent}  label="D60" />
                    <Flag sent={r.warning_89_sent}  label="D89" />
                    <Flag sent={r.warning_140_sent} label="D140" />
                  </div>
                </td>
                <td className="p-4 text-center">
                  {r.data_deleted ? (
                    <span className="text-xs text-gray-600 tracking-widest">DELETED</span>
                  ) : r.client_star_access_disabled ? (
                    <span className="text-xs text-orange-400 tracking-widest">NO ACCESS</span>
                  ) : (
                    <span className="text-xs text-green-500 tracking-widest">ACTIVE</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-4 text-xs text-gray-600 space-y-1">
        <p><span className="text-gray-400">D60</span> — Notice sent at 30 days before access expiry</p>
        <p><span className="text-gray-400">D89</span> — Final warning sent 1 day before access expiry</p>
        <p><span className="text-gray-400">D140</span> — Vishnu warning sent 10 days before hard deletion</p>
        <p className="pt-1">Nightly purge runs at 00:00 UTC. Hard deletion is irreversible.</p>
      </div>
    </div>
  );
}
