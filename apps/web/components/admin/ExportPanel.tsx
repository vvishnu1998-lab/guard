'use client';
import { useState } from 'react';
import { adminDownload } from '../../lib/adminApi';

type ExportType = 'all' | 'hours' | 'reports' | 'violations';

export default function ExportPanel() {
  const [siteId,   setSiteId]   = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo,   setDateTo]   = useState('');
  const [expType,  setExpType]  = useState<ExportType>('all');
  const [open,     setOpen]     = useState(false);
  const [busy,     setBusy]     = useState<'csv' | 'xlsx' | null>(null);
  const [error,    setError]    = useState('');

  async function download(format: 'csv' | 'xlsx') {
    setBusy(format);
    setError('');
    try {
      const params = new URLSearchParams();
      if (siteId)   params.set('site_id',   siteId);
      if (dateFrom) params.set('date_from', dateFrom);
      if (dateTo)   params.set('date_to',   dateTo);
      if (expType !== 'all') params.set('type', expType);
      const qs = params.toString();
      const path = `/api/exports/analytics/${format}${qs ? `?${qs}` : ''}`;
      const filename = `guard-analytics-${new Date().toISOString().slice(0, 10)}.${format}`;
      await adminDownload(path, filename);
    } catch (e: any) {
      setError(e.message ?? 'Download failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="border border-amber-400 text-amber-400 text-xs tracking-widest px-4 py-2 rounded-lg hover:bg-amber-400 hover:text-gray-900 transition-colors"
      >
        EXPORT ▾
      </button>

      {open && (
        <div className="absolute right-0 top-10 w-72 bg-[#0F1E35] border border-[#1A3050] rounded-xl shadow-2xl p-5 z-50 space-y-3">
          <p className="text-amber-400 font-bold tracking-widest text-xs mb-2">EXPORT OPTIONS</p>

          {/* Data type */}
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">DATA</label>
            <select
              value={expType}
              onChange={(e) => setExpType(e.target.value as ExportType)}
              className="w-full bg-[#0B1526] border border-[#1A3050] text-gray-300 text-sm rounded p-2"
            >
              <option value="all">All sheets</option>
              <option value="hours">Guard hours only</option>
              <option value="reports">Reports only</option>
              <option value="violations">Violations only</option>
            </select>
          </div>

          {/* Date range */}
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">FROM</label>
            <input
              type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] text-gray-300 text-sm rounded p-2"
            />
          </div>
          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">TO</label>
            <input
              type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] text-gray-300 text-sm rounded p-2"
            />
          </div>

          {error && (
            <p className="text-red-400 text-xs">{error}</p>
          )}

          {/* Download buttons */}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => download('csv')}
              disabled={busy !== null}
              className="flex-1 bg-[#0B1526] border border-[#1A3050] text-gray-300 text-xs tracking-widest py-2 rounded hover:border-amber-400 hover:text-amber-400 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {busy === 'csv' ? '…' : 'CSV'}
            </button>
            <button
              onClick={() => download('xlsx')}
              disabled={busy !== null}
              className="flex-1 bg-amber-400 text-gray-900 text-xs tracking-widest py-2 rounded font-bold hover:bg-amber-300 transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              {busy === 'xlsx' ? '…' : 'EXCEL'}
            </button>
          </div>
          <p className="text-gray-600 text-xs">Max 5,000 rows per sheet. Scoped to your company.</p>
        </div>
      )}
    </div>
  );
}
