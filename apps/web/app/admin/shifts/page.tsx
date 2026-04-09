'use client';
/**
 * Admin — Shifts Scheduling (/admin/shifts)
 * List all company shifts, schedule new shift (guard + site + time window).
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPost } from '../../../lib/adminApi';

interface Shift {
  id:               string;
  guard_id:         string;
  site_id:          string;
  guard_name:       string;
  site_name:        string;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'scheduled' | 'active' | 'completed' | 'cancelled';
}

interface Guard { id: string; name: string; badge_number: string; }
interface Site  { id: string; name: string; }

const STATUS_STYLES: Record<string, string> = {
  scheduled:  'text-amber-400',
  active:     'text-green-400',
  completed:  'text-gray-500',
  cancelled:  'text-red-400',
};

function fmtDT(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDuration(start: string, end: string) {
  const h = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return `${h.toFixed(1)}h`;
}

export default function ShiftsPage() {
  const [shifts,     setShifts]     = useState<Shift[]>([]);
  const [guards,     setGuards]     = useState<Guard[]>([]);
  const [sites,      setSites]      = useState<Site[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState('');
  const [showModal,  setShowModal]  = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [formError,  setFormError]  = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const EMPTY = { guard_id: '', site_id: '', scheduled_start: '', scheduled_end: '' };
  const [form, setForm] = useState(EMPTY);

  const load = useCallback(async () => {
    try {
      const [sh, g, s] = await Promise.all([
        adminGet<Shift[]>('/api/shifts'),
        adminGet<Guard[]>('/api/guards'),
        adminGet<Site[]>('/api/sites'),
      ]);
      setShifts(sh); setGuards(g.filter((g) => g)); setSites(s); setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function createShift() {
    const { guard_id, site_id, scheduled_start, scheduled_end } = form;
    if (!guard_id || !site_id || !scheduled_start || !scheduled_end) {
      setFormError('All fields are required'); return;
    }
    if (new Date(scheduled_end) <= new Date(scheduled_start)) {
      setFormError('End must be after start'); return;
    }
    setSaving(true); setFormError('');
    try {
      await adminPost('/api/shifts', form);
      setShowModal(false); setForm(EMPTY);
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  const visible = statusFilter ? shifts.filter((s) => s.status === statusFilter) : shifts;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">SHIFTS</h1>
        <div className="flex gap-3 items-center">
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-300 text-xs tracking-widest focus:outline-none focus:border-amber-400"
          >
            <option value="">ALL STATUSES</option>
            <option value="scheduled">SCHEDULED</option>
            <option value="active">ACTIVE</option>
            <option value="completed">COMPLETED</option>
            <option value="cancelled">CANCELLED</option>
          </select>
          <button
            onClick={() => { setShowModal(true); setFormError(''); setForm(EMPTY); }}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
          >
            + SCHEDULE SHIFT
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="text-left p-4">GUARD</th>
              <th className="text-left p-4">SITE</th>
              <th className="text-left p-4">START</th>
              <th className="text-left p-4">END</th>
              <th className="text-center p-4">DURATION</th>
              <th className="text-center p-4">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="text-center text-gray-500 py-10">Loading…</td></tr>}
            {!loading && visible.length === 0 && <tr><td colSpan={6} className="text-center text-gray-500 py-10">No shifts found</td></tr>}
            {visible.map((s) => (
              <tr key={s.id} className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors">
                <td className="p-4 text-gray-200">{s.guard_name}</td>
                <td className="p-4 text-gray-400 text-xs">{s.site_name}</td>
                <td className="p-4 text-gray-400 text-xs font-mono">{fmtDT(s.scheduled_start)}</td>
                <td className="p-4 text-gray-400 text-xs font-mono">{fmtDT(s.scheduled_end)}</td>
                <td className="p-4 text-center text-gray-500 text-xs">{fmtDuration(s.scheduled_start, s.scheduled_end)}</td>
                <td className="p-4 text-center">
                  <span className={`text-xs tracking-widest font-medium ${STATUS_STYLES[s.status] ?? 'text-gray-500'}`}>
                    {s.status.toUpperCase()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Schedule Shift Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">SCHEDULE SHIFT</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD <span className="text-amber-400">*</span></label>
                <select
                  value={form.guard_id}
                  onChange={(e) => setForm((f) => ({ ...f, guard_id: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  <option value="">Select guard…</option>
                  {guards.filter((g: any) => g.is_active !== false).map((g) => (
                    <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE <span className="text-amber-400">*</span></label>
                <select
                  value={form.site_id}
                  onChange={(e) => setForm((f) => ({ ...f, site_id: e.target.value }))}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  <option value="">Select site…</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">START <span className="text-amber-400">*</span></label>
                  <input
                    type="datetime-local"
                    value={form.scheduled_start}
                    onChange={(e) => setForm((f) => ({ ...f, scheduled_start: e.target.value }))}
                    className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">END <span className="text-amber-400">*</span></label>
                  <input
                    type="datetime-local"
                    value={form.scheduled_end}
                    onChange={(e) => setForm((f) => ({ ...f, scheduled_end: e.target.value }))}
                    className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={createShift} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'SAVING…' : 'SCHEDULE'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
