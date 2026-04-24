'use client';
import { useState, useEffect, useCallback } from 'react';
import { format, startOfDay, endOfDay, startOfWeek, endOfWeek } from 'date-fns';
import { requestPdfDownloadUrl, clientGet } from '../../lib/clientApi';

interface ReportRow {
  report_type: 'activity' | 'incident' | 'maintenance' | string;
}

interface PreviewSummary {
  total: number;
  activity: number;
  incidents: number;
  maintenance: number;
  loading: boolean;
  error: boolean;
}

function buildFromTo(range: 'daily' | 'weekly' | 'custom', dateFrom: string, dateTo: string) {
  if (range === 'daily') {
    return {
      from: format(startOfDay(new Date()), "yyyy-MM-dd'T'HH:mm:ss"),
      to:   format(endOfDay(new Date()),   "yyyy-MM-dd'T'HH:mm:ss"),
      label: 'today',
    };
  }
  if (range === 'weekly') {
    return {
      from: format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd'T'HH:mm:ss"),
      to:   format(endOfWeek(new Date(),   { weekStartsOn: 1 }), "yyyy-MM-dd'T'HH:mm:ss"),
      label: 'this week',
    };
  }
  return {
    from: dateFrom,
    to:   dateTo + 'T23:59:59',
    label: `${dateFrom} \u2192 ${dateTo}`,
  };
}

export default function DownloadPanel() {
  const [dateFrom, setDateFrom] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [dateTo,   setDateTo]   = useState(format(new Date(), 'yyyy-MM-dd'));
  const [activeRange, setActiveRange] = useState<'daily' | 'weekly' | 'custom'>('daily');
  const [preview, setPreview] = useState<PreviewSummary>({
    total: 0, activity: 0, incidents: 0, maintenance: 0, loading: true, error: false,
  });

  const fetchPreview = useCallback(async () => {
    setPreview(p => ({ ...p, loading: true, error: false }));
    try {
      const { from, to } = buildFromTo(activeRange, dateFrom, dateTo);
      const rows = await clientGet<ReportRow[]>(
        `/api/client/reports?date_from=${encodeURIComponent(from)}&date_to=${encodeURIComponent(to)}`
      );
      setPreview({
        total:       rows.length,
        activity:    rows.filter(r => r.report_type === 'activity').length,
        incidents:   rows.filter(r => r.report_type === 'incident').length,
        maintenance: rows.filter(r => r.report_type === 'maintenance').length,
        loading: false,
        error: false,
      });
    } catch {
      setPreview(p => ({ ...p, loading: false, error: true }));
    }
  }, [activeRange, dateFrom, dateTo]);

  useEffect(() => { fetchPreview(); }, [fetchPreview]);

  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  async function downloadPdf() {
    setDownloadError(null);
    setDownloading(true);
    try {
      const { from, to } = buildFromTo(activeRange, dateFrom, dateTo);
      const url = await requestPdfDownloadUrl(from, to);
      // The URL carries a 60-second, purpose-scoped token — opening it now
      // triggers the download without the long-lived client JWT ever
      // appearing in the URL.
      window.open(url, '_blank');
    } catch (e) {
      setDownloadError(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  }

  const { label: periodLabel } = buildFromTo(activeRange, dateFrom, dateTo);

  return (
    <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-5 space-y-4">
      <h2 className="text-blue-400 font-bold tracking-widest text-sm">DOWNLOAD REPORTS</h2>

      {/* Range selector */}
      <div className="flex gap-2">
        {(['daily', 'weekly', 'custom'] as const).map(r => (
          <button
            key={r}
            onClick={() => setActiveRange(r)}
            className={`flex-1 py-2 rounded text-xs tracking-widest transition-colors border ${
              activeRange === r
                ? 'bg-blue-500 border-blue-500 text-white'
                : 'border-[#1A3050] text-gray-400 hover:border-blue-500 hover:text-blue-400'
            }`}
          >
            {r === 'daily' ? "TODAY" : r === 'weekly' ? "THIS WEEK" : "CUSTOM"}
          </button>
        ))}
      </div>

      {/* Custom date inputs */}
      {activeRange === 'custom' && (
        <div className="space-y-2">
          <p className="text-gray-500 text-xs tracking-widest">DATE RANGE</p>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="w-full bg-[#0B1526] border border-[#1A3050] text-gray-300 text-sm rounded p-2"
          />
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="w-full bg-[#0B1526] border border-[#1A3050] text-gray-300 text-sm rounded p-2"
          />
        </div>
      )}

      {/* Preview summary card */}
      <div className="border border-[#1A3050] rounded-lg p-4 bg-[#0B1526] space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-gray-400 text-xs tracking-widest uppercase">PDF Preview</p>
          {preview.loading && (
            <span className="text-gray-600 text-xs animate-pulse">Loading...</span>
          )}
          {preview.error && (
            <span className="text-red-400 text-xs">Could not fetch preview</span>
          )}
        </div>

        {!preview.loading && !preview.error && (
          <>
            <p className="text-gray-300 text-sm">
              This PDF will contain{' '}
              <span className="text-white font-bold">{preview.total} report{preview.total !== 1 ? 's' : ''}</span>{' '}
              covering <span className="text-blue-400">{periodLabel}</span>
            </p>
            <div className="flex gap-4">
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />
                <span className="text-gray-400 text-xs">{preview.activity} activity</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" />
                <span className="text-gray-400 text-xs">{preview.incidents} incident{preview.incidents !== 1 ? 's' : ''}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                <span className="text-gray-400 text-xs">{preview.maintenance} maintenance</span>
              </div>
            </div>
            {/* Proportion bar */}
            {preview.total > 0 && (
              <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
                {preview.activity > 0 && (
                  <div
                    className="bg-blue-500 rounded-full"
                    style={{ flex: preview.activity }}
                  />
                )}
                {preview.incidents > 0 && (
                  <div
                    className="bg-red-500 rounded-full"
                    style={{ flex: preview.incidents }}
                  />
                )}
                {preview.maintenance > 0 && (
                  <div
                    className="bg-amber-500 rounded-full"
                    style={{ flex: preview.maintenance }}
                  />
                )}
              </div>
            )}
            <p className="text-gray-600 text-xs">
              5-page PDF: cover summary, activity timeline, incident deep dive, maintenance table, guard performance
            </p>
          </>
        )}
      </div>

      {/* Download button */}
      <button
        onClick={downloadPdf}
        disabled={
          downloading || (!preview.loading && !preview.error && preview.total === 0)
        }
        className="w-full bg-blue-500 text-white py-2.5 rounded text-xs tracking-widest hover:bg-blue-600 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {downloading
          ? 'PREPARING DOWNLOAD…'
          : preview.total === 0 && !preview.loading
            ? 'NO REPORTS IN PERIOD'
            : 'DOWNLOAD PDF REPORT'}
      </button>
      {downloadError && (
        <p className="text-red-400 text-xs">{downloadError}</p>
      )}
    </div>
  );
}
