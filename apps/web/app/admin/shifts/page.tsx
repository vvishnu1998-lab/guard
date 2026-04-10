'use client';
/**
 * Admin — Shifts Scheduling (/admin/shifts)
 * List all company shifts, schedule new shift (guard optional + repeat).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminGet, adminPost, adminPatch } from '../../../lib/adminApi';

interface Shift {
  id:               string;
  guard_id:         string | null;
  site_id:          string;
  guard_name:       string | null;
  site_name:        string;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'unassigned' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'missed';
}

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean; }
interface Site  { id: string; name: string; }

const STATUS_STYLES: Record<string, string> = {
  unassigned: 'bg-amber-400/20 text-amber-400 border border-amber-400/40',
  scheduled:  'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  active:     'bg-green-500/20 text-green-400 border border-green-500/40',
  completed:  'bg-gray-700/40 text-gray-500 border border-gray-600/40',
  cancelled:  'bg-red-900/30 text-red-400 border border-red-700/40',
  missed:     'bg-red-900/30 text-red-400 border border-red-700/40',
};

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function fmtDT(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function fmtDuration(start: string, end: string) {
  const h = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return `${h.toFixed(1)}h`;
}

/** Format a Date as dd/mm/yyyy for display */
function fmtDate(d: Date) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

/** Build an ISO datetime string from a local date + "HH:MM" time string */
function buildISO(date: Date, timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/** Mini inline calendar component */
function MiniCalendar({
  year,
  month,
  selectedDate,
  highlightDows,
  onSelectDate,
  onPrevMonth,
  onNextMonth,
}: {
  year: number;
  month: number; // 0-based
  selectedDate: Date | null;
  highlightDows: number[]; // 0=Sun..6=Sat
  onSelectDate: (d: Date) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
}) {
  // Build grid: first cell = day-of-week of 1st of month
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(firstDay).fill(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(i);
  // pad to complete last week
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="mt-3 bg-[#070F1E] border border-[#1A3050] rounded-xl p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <button
          type="button"
          onClick={onPrevMonth}
          className="text-gray-400 hover:text-amber-400 px-2 py-1 rounded transition-colors text-sm"
        >
          ‹
        </button>
        <span className="text-gray-200 text-xs font-bold tracking-widest">
          {MONTH_NAMES[month].toUpperCase()} {year}
        </span>
        <button
          type="button"
          onClick={onNextMonth}
          className="text-gray-400 hover:text-amber-400 px-2 py-1 rounded transition-colors text-sm"
        >
          ›
        </button>
      </div>
      {/* Day-of-week headers */}
      <div className="grid grid-cols-7 mb-1">
        {DAYS.map((d) => (
          <div key={d} className="text-center text-gray-600 text-xs tracking-widest py-1">
            {d.toUpperCase().slice(0, 2)}
          </div>
        ))}
      </div>
      {/* Date grid */}
      <div className="grid grid-cols-7">
        {cells.map((day, idx) => {
          if (day === null) return <div key={`e-${idx}`} />;
          const thisDate = new Date(year, month, day);
          const dow = thisDate.getDay();
          const isHighlighted = highlightDows.includes(dow);
          const isSelected =
            selectedDate !== null &&
            selectedDate.getFullYear() === year &&
            selectedDate.getMonth() === month &&
            selectedDate.getDate() === day;
          return (
            <button
              key={day}
              type="button"
              onClick={() => onSelectDate(thisDate)}
              className={[
                'text-center text-xs py-1.5 rounded transition-colors',
                isSelected
                  ? 'ring-2 ring-amber-400 text-amber-400 font-bold bg-amber-400/10'
                  : isHighlighted
                  ? 'bg-amber-400/20 text-amber-300 hover:bg-amber-400/30'
                  : 'text-gray-400 hover:bg-[#1A3050] hover:text-gray-200',
              ].join(' ')}
            >
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function ShiftsPage() {
  const [shifts,        setShifts]        = useState<Shift[]>([]);
  const [guards,        setGuards]        = useState<Guard[]>([]);
  const [sites,         setSites]         = useState<Site[]>([]);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState('');
  const [showModal,     setShowModal]     = useState(false);
  const [saving,        setSaving]        = useState(false);
  const [formError,     setFormError]     = useState('');
  const [statusFilter,  setStatusFilter]  = useState('');

  // Assign-guard panel
  const [assignShift,   setAssignShift]   = useState<Shift | null>(null);
  const [assignGuardId, setAssignGuardId] = useState('');
  const [assigning,     setAssigning]     = useState(false);
  const [assignError,   setAssignError]   = useState('');

  // Form state — time pickers + separate date
  const [guardId,    setGuardId]    = useState('');
  const [siteId,     setSiteId]     = useState('');
  const [startTime,  setStartTime]  = useState('');   // "HH:MM" 24h
  const [endTime,    setEndTime]    = useState('');   // "HH:MM" 24h

  // Single-date mode
  const [singleDate, setSingleDate] = useState('');   // HTML date input value "YYYY-MM-DD"

  // Repeat state
  const [repeatMode,  setRepeatMode]  = useState<'none' | 'days'>('none');
  const [repeatDays,  setRepeatDays]  = useState<number[]>([]);

  // Calendar state (for repeat mode)
  const today = new Date();
  const [calYear,  setCalYear]  = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [calStart, setCalStart] = useState<Date | null>(null); // selected start date from calendar

  // Overnight detection
  const isOvernight = useMemo(() => {
    if (!startTime || !endTime) return false;
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    return eh * 60 + em < sh * 60 + sm;
  }, [startTime, endTime]);

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

  function resetModal() {
    setGuardId(''); setSiteId('');
    setStartTime(''); setEndTime('');
    setSingleDate('');
    setRepeatMode('none'); setRepeatDays([]);
    setCalStart(null);
    setCalYear(today.getFullYear());
    setCalMonth(today.getMonth());
    setFormError('');
  }

  async function createShift() {
    if (!siteId)      { setFormError('Site is required'); return; }
    if (!startTime)   { setFormError('Start time is required'); return; }
    if (!endTime)     { setFormError('End time is required'); return; }

    if (repeatMode === 'none') {
      if (!singleDate) { setFormError('Date is required'); return; }
    } else {
      if (repeatDays.length === 0) { setFormError('Select at least one day to repeat on'); return; }
      if (!calStart) { setFormError('Select a start date from the calendar'); return; }
    }

    setSaving(true); setFormError('');
    try {
      if (repeatMode === 'none') {
        // Build start and end ISO datetimes
        const baseDate = new Date(singleDate + 'T00:00:00');
        const scheduledStart = buildISO(baseDate, startTime);

        // For overnight, end date is next day
        const endDate = isOvernight ? new Date(baseDate.getTime() + 86400000) : baseDate;
        const scheduledEnd = buildISO(endDate, endTime);

        const payload: any = { site_id: siteId, scheduled_start: scheduledStart, scheduled_end: scheduledEnd };
        if (guardId) payload.guard_id = guardId;
        await adminPost('/api/shifts', payload);
      } else {
        // Repeat mode: pass scheduled_start (start date + time), scheduled_end (same day + end time or next day if overnight),
        // and repeat_days to the API which iterates 4 weeks
        const scheduledStart = buildISO(calStart!, startTime);
        const endBaseDate = isOvernight
          ? new Date(calStart!.getTime() + 86400000)
          : calStart!;
        const scheduledEnd = buildISO(endBaseDate, endTime);

        const payload: any = {
          site_id: siteId,
          scheduled_start: scheduledStart,
          scheduled_end: scheduledEnd,
          repeat_days: repeatDays,
        };
        if (guardId) payload.guard_id = guardId;
        await adminPost('/api/shifts', payload);
      }

      setShowModal(false);
      resetModal();
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  function toggleRepeatDay(day: number) {
    setRepeatDays((prev) =>
      prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]
    );
  }

  function prevMonth() {
    if (calMonth === 0) { setCalMonth(11); setCalYear((y) => y - 1); }
    else setCalMonth((m) => m - 1);
  }
  function nextMonth() {
    if (calMonth === 11) { setCalMonth(0); setCalYear((y) => y + 1); }
    else setCalMonth((m) => m + 1);
  }

  async function assignGuard() {
    if (!assignGuardId) { setAssignError('Select a guard'); return; }
    setAssigning(true); setAssignError('');
    try {
      await adminPatch(`/api/shifts/${assignShift!.id}/assign-guard`, { guard_id: assignGuardId });
      setAssignShift(null);
      setAssignGuardId('');
      await load();
    } catch (e: any) { setAssignError(e.message); }
    finally { setAssigning(false); }
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
            <option value="unassigned">UNASSIGNED</option>
            <option value="scheduled">SCHEDULED</option>
            <option value="active">ACTIVE</option>
            <option value="completed">COMPLETED</option>
            <option value="cancelled">CANCELLED</option>
          </select>
          <button
            onClick={() => { resetModal(); setShowModal(true); }}
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
              <tr
                key={s.id}
                className={`border-b border-[#1A3050] transition-colors ${s.status === 'unassigned' ? 'hover:bg-amber-400/5 cursor-pointer' : 'hover:bg-[#0B1526]'}`}
                onClick={s.status === 'unassigned' ? () => { setAssignShift(s); setAssignGuardId(''); setAssignError(''); } : undefined}
              >
                <td className="p-4">
                  {s.guard_name ? (
                    <span className="text-gray-200">{s.guard_name}</span>
                  ) : (
                    <span className="text-amber-400/70 italic text-xs">Unassigned — click to assign</span>
                  )}
                </td>
                <td className="p-4 text-gray-400 text-xs">{s.site_name}</td>
                <td className="p-4 text-gray-400 text-xs font-mono">{fmtDT(s.scheduled_start)}</td>
                <td className="p-4 text-gray-400 text-xs font-mono">{fmtDT(s.scheduled_end)}</td>
                <td className="p-4 text-center text-gray-500 text-xs">{fmtDuration(s.scheduled_start, s.scheduled_end)}</td>
                <td className="p-4 text-center">
                  <span className={`inline-block text-xs tracking-widest font-medium px-2 py-0.5 rounded ${STATUS_STYLES[s.status] ?? 'text-gray-500'}`}>
                    {s.status.toUpperCase()}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Schedule Shift Modal ──────────────────────────────────────── */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">SCHEDULE SHIFT</h2>
              <button onClick={() => setShowModal(false)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
            <div className="space-y-4">

              {/* Guard — optional */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD <span className="text-gray-600 text-xs normal-case">(optional)</span></label>
                <select
                  value={guardId}
                  onChange={(e) => setGuardId(e.target.value)}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  <option value="">Unassigned</option>
                  {guards.filter((g: any) => g.is_active !== false).map((g) => (
                    <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>
                  ))}
                </select>
              </div>

              {/* Site */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE <span className="text-amber-400">*</span></label>
                <select
                  value={siteId}
                  onChange={(e) => setSiteId(e.target.value)}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  <option value="">Select site…</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              {/* Start Time / End Time */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">START TIME <span className="text-amber-400">*</span></label>
                  <input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full bg-[#070F1E] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">END TIME <span className="text-amber-400">*</span></label>
                  <input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full bg-[#070F1E] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                  />
                </div>
              </div>

              {/* Overnight note */}
              {isOvernight && startTime && endTime && (
                <p className="text-cyan-400 text-xs tracking-wide -mt-1">
                  Overnight — ends next day
                </p>
              )}

              {/* Repeat selector */}
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">REPEAT</label>
                <select
                  value={repeatMode}
                  onChange={(e) => { setRepeatMode(e.target.value as 'none' | 'days'); setRepeatDays([]); setCalStart(null); }}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                >
                  <option value="none">Does not repeat</option>
                  <option value="days">Repeat on selected days</option>
                </select>
              </div>

              {/* Does not repeat: single date picker */}
              {repeatMode === 'none' && (
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">DATE <span className="text-amber-400">*</span></label>
                  <div className="relative">
                    <input
                      type="date"
                      value={singleDate}
                      onChange={(e) => setSingleDate(e.target.value)}
                      className="w-full bg-[#070F1E] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
                    />
                    {singleDate && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs pointer-events-none">
                        {fmtDate(new Date(singleDate + 'T00:00:00'))}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Repeat on selected days: day pills + calendar */}
              {repeatMode === 'days' && (
                <div>
                  <p className="text-gray-500 text-xs tracking-widest mb-2">SELECT DAYS</p>
                  <div className="flex gap-2 flex-wrap">
                    {DAYS.map((day, idx) => (
                      <button
                        key={day}
                        type="button"
                        onClick={() => toggleRepeatDay(idx)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold tracking-widest transition-colors ${
                          repeatDays.includes(idx)
                            ? 'bg-amber-400 text-gray-900'
                            : 'bg-[#0B1526] border border-[#1A3050] text-gray-400 hover:border-amber-400/50'
                        }`}
                      >
                        {day.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <p className="text-gray-600 text-xs mt-2 mb-1">
                    SELECT START DATE — shifts repeat for 28 days from this date.
                  </p>
                  {calStart && (
                    <p className="text-amber-400 text-xs mb-1">
                      Start: {fmtDate(calStart)}
                    </p>
                  )}
                  <MiniCalendar
                    year={calYear}
                    month={calMonth}
                    selectedDate={calStart}
                    highlightDows={repeatDays}
                    onSelectDate={(d) => setCalStart(d)}
                    onPrevMonth={prevMonth}
                    onNextMonth={nextMonth}
                  />
                </div>
              )}
            </div>

            <div className="flex gap-3 mt-6">
              <button onClick={() => setShowModal(false)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={createShift} disabled={saving} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {saving ? 'SAVING…' : repeatMode === 'days' ? 'CREATE SHIFTS' : 'SCHEDULE'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Assign Guard Modal (for unassigned shifts) ────────────────── */}
      {assignShift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">ASSIGN GUARD</h2>
              <button onClick={() => setAssignShift(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-xs mb-1">Site: <span className="text-gray-300">{assignShift.site_name}</span></p>
            <p className="text-gray-500 text-xs mb-4">
              {fmtDT(assignShift.scheduled_start)} → {fmtDT(assignShift.scheduled_end)}
            </p>
            {assignError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{assignError}</div>}
            <div className="mb-5">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD <span className="text-amber-400">*</span></label>
              <select
                value={assignGuardId}
                onChange={(e) => setAssignGuardId(e.target.value)}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400"
              >
                <option value="">Select guard…</option>
                {guards.filter((g: any) => g.is_active !== false).map((g) => (
                  <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-3">
              <button onClick={() => setAssignShift(null)} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
              <button onClick={assignGuard} disabled={assigning} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
                {assigning ? 'ASSIGNING…' : 'ASSIGN'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
