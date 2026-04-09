'use client';
import { useState } from 'react';
import { format, startOfDay, endOfDay, startOfWeek, endOfWeek } from 'date-fns';
import { pdfDownloadUrl } from '../../lib/clientApi';

export default function DownloadPanel() {
  const [dateFrom, setDateFrom] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [dateTo,   setDateTo]   = useState(format(new Date(), 'yyyy-MM-dd'));

  function downloadPdf(range: 'daily' | 'weekly' | 'custom') {
    let from: string;
    let to: string;
    if (range === 'daily') {
      from = format(startOfDay(new Date()), "yyyy-MM-dd'T'HH:mm:ss");
      to   = format(endOfDay(new Date()),   "yyyy-MM-dd'T'HH:mm:ss");
    } else if (range === 'weekly') {
      from = format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd'T'HH:mm:ss");
      to   = format(endOfWeek(new Date(),   { weekStartsOn: 1 }), "yyyy-MM-dd'T'HH:mm:ss");
    } else {
      from = dateFrom;
      to   = dateTo + 'T23:59:59';
    }
    // Open in new tab so current page stays; token embedded as query param
    window.open(pdfDownloadUrl(from, to), '_blank');
  }

  return (
    <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-5 space-y-4">
      <h2 className="text-blue-400 font-bold tracking-widest text-sm">DOWNLOAD REPORTS</h2>

      <button
        onClick={() => downloadPdf('daily')}
        className="w-full border border-blue-500 text-blue-400 py-2 rounded text-xs tracking-widest hover:bg-blue-500 hover:text-white transition-colors"
      >
        TODAY'S DAILY PDF
      </button>

      <button
        onClick={() => downloadPdf('weekly')}
        className="w-full border border-blue-500 text-blue-400 py-2 rounded text-xs tracking-widest hover:bg-blue-500 hover:text-white transition-colors"
      >
        THIS WEEK'S PDF
      </button>

      <div className="border-t border-[#1A3050] pt-4 space-y-3">
        <p className="text-gray-500 text-xs tracking-widest">CUSTOM DATE RANGE</p>
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
        <button
          onClick={() => downloadPdf('custom')}
          className="w-full bg-blue-500 text-white py-2 rounded text-xs tracking-widest hover:bg-blue-600 transition-colors"
        >
          DOWNLOAD PDF
        </button>
      </div>
    </div>
  );
}
