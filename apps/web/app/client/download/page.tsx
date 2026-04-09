'use client';
/**
 * Client Portal — Downloads (/client/download)
 * Dedicated download page for daily, weekly, and custom date range PDF reports.
 */
import DownloadPanel from '../../../components/client/DownloadPanel';

export default function DownloadPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-widest text-blue-400">DOWNLOADS</h1>
        <p className="text-gray-500 text-xs tracking-widest mt-1">
          PDF reports are scoped to your site only and generated instantly.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <DownloadPanel />

        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-5 space-y-4">
          <h2 className="text-blue-400 font-bold tracking-widest text-sm">ABOUT YOUR REPORTS</h2>
          <div className="space-y-3 text-sm text-gray-400">
            <div className="flex gap-3">
              <span className="w-2 h-2 rounded-full bg-amber-500 mt-1.5 shrink-0" />
              <p><span className="text-amber-400 font-medium">Activity reports</span> — routine patrol notes and observations.</p>
            </div>
            <div className="flex gap-3">
              <span className="w-2 h-2 rounded-full bg-red-500 mt-1.5 shrink-0" />
              <p><span className="text-red-400 font-medium">Incident reports</span> — escalations with severity rating. An email alert was sent to you at time of filing.</p>
            </div>
            <div className="flex gap-3">
              <span className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 shrink-0" />
              <p><span className="text-blue-400 font-medium">Maintenance reports</span> — equipment faults and facility damage.</p>
            </div>
          </div>
          <div className="border-t border-[#1A3050] pt-4 text-xs text-gray-600 space-y-1">
            <p>PDFs are generated in real-time and include all reports within the selected date range.</p>
            <p>Maximum 500 reports per download. Photos are not included in PDF exports.</p>
            <p>Reports older than your data retention limit may not be available.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
