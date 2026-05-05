'use client';
/**
 * Admin — Shifts Scheduling (/admin/shifts)
 * Guard-centric cards grid. Clicking a card opens that guard's full schedule.
 * The original Schedule Shift modal is preserved.
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

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean; photo_url?: string | null; }
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

function fmtDateShort(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDuration(start: string, end: string) {
  const h = (new Date(end).getTime() - new Date(start).getTime()) / 3_600_000;
  return `${h.toFixed(1)}h`;
}

function fmtDate(d: Date) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function buildISO(date: Date, timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/** Derive availability badge from shifts */
function getAvailability(guardId: string, shifts: Shift[], weekStart: Date, weekEnd: Date) {
  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd   = new Date(now); todayEnd.setHours(23, 59, 59, 999);

  const guardShifts = shifts.filter((s) => s.guard_id === guardId);

  const activeNow = guardShifts.find(
    (s) => s.status === 'active' ||
      (s.status === 'scheduled' && new Date(s.scheduled_start) <= now && new Date(s.scheduled_end) >= now)
  );
  if (activeNow) return 'ON SHIFT';

  const scheduledToday = guardShifts.find(
    (s) => s.status === 'scheduled' &&
      new Date(s.scheduled_start) >= todayStart &&
      new Date(s.scheduled_start) <= todayEnd &&
      new Date(s.scheduled_start) > now
  );
  if (scheduledToday) return 'SCHEDULED';

  const thisWeek = guardShifts.filter(
    (s) => new Date(s.scheduled_start) >= weekStart && new Date(s.scheduled_start) <= weekEnd &&
      s.status !== 'cancelled'
  );
  if (thisWeek.length === 0) return 'OFF';

  return 'AVAILABLE';
}

const AVAILABILITY_STYLES: Record<string, string> = {
  'ON SHIFT':  'bg-green-500/20 text-green-400 border border-green-500/40',
  'SCHEDULED': 'bg-blue-500/20  text-blue-400  border border-blue-500/40',
  'AVAILABLE': 'bg-[#00C8FF]/10 text-[#00C8FF] border border-[#00C8FF]/30',
  'OFF':       'bg-gray-700/30  text-gray-500  border border-gray-600/30',
};

function getWeekBounds(referenceDate: Date) {
  const d = new Date(referenceDate);
  const dow = d.getDay();
  const start = new Date(d); start.setDate(d.getDate() - dow); start.setHours(0, 0, 0, 0);
  const end   = new Date(start); end.setDate(start.getDate() + 6); end.setHours(23, 59, 59, 999);
  return { start, end };
}

function isoWeek(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/** Mini inline calendar component */
function MiniCalendar({
  year, month, selectedDate, highlightDows, onSelectDate, onPrevMonth, onNextMonth,
}: {
  year: number; month: number;
  selectedDate: Date | null; highlightDows: number[];
  onSelectDate: (d: Date) => void;
  onPrevMonth: () => void; onNextMonth: () => void;
}) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(firstDay).fill(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(i);
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="mt-3 bg-[#070F1E] border border-[#1A3050] rounded-xl p-3">
      <div className="flex items-center justify-between mb-3">
        <button type="button" onClick={onPrevMonth} className="text-gray-400 hover:text-amber-400 px-2 py-1 rounded transition-colors text-sm">‹</button>
        <span className="text-gray-200 text-xs font-bold tracking-widest">{MONTH_NAMES[month].toUpperCase()} {year}</span>
        <button type="button" onClick={onNextMonth} className="text-gray-400 hover:text-amber-400 px-2 py-1 rounded transition-colors text-sm">›</button>
      </div>
      <div className="grid grid-cols-7 mb-1">
        {DAYS.map((d) => <div key={d} className="text-center text-gray-600 text-xs tracking-widest py-1">{d.toUpperCase().slice(0,2)}</div>)}
      </div>
      <div className="grid grid-cols-7">
        {cells.map((day, idx) => {
          if (day === null) return <div key={`e-${idx}`} />;
          const thisDate = new Date(year, month, day);
          const dow = thisDate.getDay();
          const isHighlighted = highlightDows.includes(dow);
          const isSelected = selectedDate !== null &&
            selectedDate.getFullYear() === year && selectedDate.getMonth() === month && selectedDate.getDate() === day;
          return (
            <button key={day} type="button" onClick={() => onSelectDate(thisDate)}
              className={['text-center text-xs py-1.5 rounded transition-colors',
                isSelected ? 'ring-2 ring-amber-400 text-amber-400 font-bold bg-amber-400/10'
                : isHighlighted ? 'bg-amber-400/20 text-amber-300 hover:bg-amber-400/30'
                : 'text-gray-400 hover:bg-[#1A3050] hover:text-gray-200'].join(' ')}>
              {day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Guard avatar — photo or initials */
function GuardAvatar({ name, photoUrl, size = 'md' }: { name: string; photoUrl?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const [imgError, setImgError] = useState(false);
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const sizeClass = size === 'lg' ? 'w-16 h-16 text-2xl' : size === 'sm' ? 'w-8 h-8 text-xs' : 'w-12 h-12 text-base';

  if (photoUrl && !imgError) {
    return (
      <img src={photoUrl} alt={name} onError={() => setImgError(true)}
        className={`${sizeClass} rounded-full object-cover border-2 border-[#1A3050]`} />
    );
  }
  return (
    <div className={`${sizeClass} rounded-full bg-[#00C8FF]/20 border-2 border-[#00C8FF]/40 flex items-center justify-center font-bold text-[#00C8FF] shrink-0`}>
      {initials}
    </div>
  );
}

export default function ShiftsPage() {
  const [shifts,  setShifts]  = useState<Shift[]>([]);
  const [guards,  setGuards]  = useState<Guard[]>([]);
  const [sites,   setSites]   = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // Week filter
  const today = new Date();
  const [weekRef, setWeekRef] = useState<Date>(today);
  const { start: weekStart, end: weekEnd } = useMemo(() => getWeekBounds(weekRef), [weekRef]);

  // Guard detail panel
  const [selectedGuard, setSelectedGuard] = useState<Guard | null>(null);
  const [guardPanelPrefilledGuard, setGuardPanelPrefilledGuard] = useState('');

  // Schedule modal
  const [showModal, setShowModal] = useState(false);
  const [saving,    setSaving]    = useState(false);
  const [formError, setFormError] = useState('');

  // Assign-guard panel
  const [assignShift,   setAssignShift]   = useState<Shift | null>(null);
  const [assignGuardId, setAssignGuardId] = useState('');
  const [assigning,     setAssigning]     = useState(false);
  const [assignError,   setAssignError]   = useState('');

  // Form state
  const [guardId,    setGuardId]    = useState('');
  const [siteId,     setSiteId]     = useState('');
  const [startTime,  setStartTime]  = useState('');
  const [endTime,    setEndTime]    = useState('');
  const [singleDate, setSingleDate] = useState('');
  const [repeatMode, setRepeatMode] = useState<'none' | 'days'>('none');
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [calYear,  setCalYear]  = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [calStart, setCalStart] = useState<Date | null>(null);

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
    setCalYear(today.getFullYear()); setCalMonth(today.getMonth());
    setFormError('');
  }

  function openScheduleForGuard(g: Guard) {
    resetModal();
    setGuardPanelPrefilledGuard(g.id);
    setGuardId(g.id);
    setShowModal(true);
  }

  async function createShift() {
    if (!siteId)    { setFormError('Site is required'); return; }
    if (!startTime) { setFormError('Start time is required'); return; }
    if (!endTime)   { setFormError('End time is required'); return; }
    if (repeatMode === 'none') {
      if (!singleDate) { setFormError('Date is required'); return; }
    } else {
      if (repeatDays.length === 0) { setFormError('Select at least one day'); return; }
      if (!calStart) { setFormError('Select a start date from the calendar'); return; }
    }

    setSaving(true); setFormError('');
    try {
      if (repeatMode === 'none') {
        const baseDate = new Date(singleDate + 'T00:00:00');
        const scheduledStart = buildISO(baseDate, startTime);
        const endDate = isOvernight ? new Date(baseDate.getTime() + 86400000) : baseDate;
        const scheduledEnd = buildISO(endDate, endTime);
        const payload: any = { site_id: siteId, scheduled_start: scheduledStart, scheduled_end: scheduledEnd };
        if (guardId) payload.guard_id = guardId;
        await adminPost('/api/shifts', payload);
      } else {
        const scheduledStart = buildISO(calStart!, startTime);
        const endBaseDate = isOvernight ? new Date(calStart!.getTime() + 86400000) : calStart!;
        const scheduledEnd = buildISO(endBaseDate, endTime);
        const payload: any = { site_id: siteId, scheduled_start: scheduledStart, scheduled_end: scheduledEnd, repeat_days: repeatDays };
        if (guardId) payload.guard_id = guardId;
        await adminPost('/api/shifts', payload);
      }
      setShowModal(false); resetModal();
      await load();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  function toggleRepeatDay(day: number) {
    setRepeatDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);
  }
  function prevMonth() { if (calMonth === 0) { setCalMonth(11); setCalYear((y) => y - 1); } else setCalMonth((m) => m - 1); }
  function nextMonth() { if (calMonth === 11) { setCalMonth(0); setCalYear((y) => y + 1); } else setCalMonth((m) => m + 1); }

  async function assignGuard() {
    if (!assignGuardId) { setAssignError('Select a guard'); return; }
    setAssigning(true); setAssignError('');
    try {
      await adminPatch(`/api/shifts/${assignShift!.id}/assign-guard`, { guard_id: assignGuardId });
      setAssignShift(null); setAssignGuardId('');
      await load();
    } catch (e: any) { setAssignError(e.message); }
    finally { setAssigning(false); }
  }

  // Guard detail panel data
  const selectedGuardShifts = useMemo(() => {
    if (!selectedGuard) return [];
    return shifts
      .filter((s) => s.guard_id === selectedGuard.id)
      .sort((a, b) => new Date(b.scheduled_start).getTime() - new Date(a.scheduled_start).getTime());
  }, [selectedGuard, shifts]);

  // Unassigned shifts count
  const unassignedCount = shifts.filter((s) => s.status === 'unassigned').length;

  // Active guards — for the current week view
  const activeGuards = guards.filter((g) => g.is_active !== false);

  function prevWeek() { const d = new Date(weekRef); d.setDate(d.getDate() - 7); setWeekRef(d); }
  function nextWeek() { const d = new Date(weekRef); d.setDate(d.getDate() + 7); setWeekRef(d); }

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">SHIFTS</h1>
        <div className="flex gap-3 items-center flex-wrap">
          {/* Week navigator */}
          <div className="flex items-center gap-2 bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-1.5">
            <button onClick={prevWeek} className="text-gray-400 hover:text-amber-400 px-1 transition-colors">‹</button>
            <span className="text-gray-300 text-xs tracking-widest whitespace-nowrap">
              {isoWeek(weekStart)} – {isoWeek(weekEnd)}
            </span>
            <button onClick={nextWeek} className="text-gray-400 hover:text-amber-400 px-1 transition-colors">›</button>
          </div>
          <button
            onClick={() => { resetModal(); setGuardId(''); setGuardPanelPrefilledGuard(''); setShowModal(true); }}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
          >
            + SCHEDULE SHIFT
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Unassigned alert */}
      {unassignedCount > 0 && (
        <div className="bg-amber-400/10 border border-amber-400/40 rounded-lg px-4 py-3 flex items-center gap-3">
          <span className="text-amber-400 text-lg">⚠</span>
          <span className="text-amber-300 text-sm">
            <strong>{unassignedCount}</strong> shift{unassignedCount > 1 ? 's' : ''} without an assigned guard.
            Click a guard card and use "Schedule New Shift" to assign.
          </span>
        </div>
      )}

      {/* ── Guard cards grid ───────────────────────────────────────────── */}
      {loading ? (
        <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {activeGuards.map((guard) => {
            const availability = getAvailability(guard.id, shifts, weekStart, weekEnd);
            const weekShifts = shifts.filter(
              (s) => s.guard_id === guard.id &&
                new Date(s.scheduled_start) >= weekStart &&
                new Date(s.scheduled_start) <= weekEnd &&
                s.status !== 'cancelled'
            );
            const isSelected = selectedGuard?.id === guard.id;

            return (
              <button
                key={guard.id}
                onClick={() => setSelectedGuard(isSelected ? null : guard)}
                className={`text-left bg-[#0F1E35] border rounded-xl p-4 transition-all hover:border-[#00C8FF]/50 hover:shadow-lg hover:shadow-[#00C8FF]/5 ${
                  isSelected ? 'border-[#00C8FF] shadow-lg shadow-[#00C8FF]/10' : 'border-[#1A3050]'
                }`}
              >
                <div className="flex items-center gap-3 mb-3">
                  <GuardAvatar name={guard.name} photoUrl={guard.photo_url} />
                  <div className="min-w-0 flex-1">
                    <p className="text-white font-semibold text-sm truncate">{guard.name}</p>
                    <p className="text-gray-600 text-xs">{guard.badge_number}</p>
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className={`inline-block text-xs tracking-widest font-medium px-2 py-0.5 rounded ${AVAILABILITY_STYLES[availability]}`}>
                    {availability}
                  </span>
                  <span className="text-gray-600 text-xs">{weekShifts.length} shift{weekShifts.length !== 1 ? 's' : ''}</span>
                </div>
              </button>
            );
          })}
          {activeGuards.length === 0 && (
            <div className="col-span-4 text-center text-gray-500 py-12">No active guards found.</div>
          )}
        </div>
      )}

      {/* ── Guard detail side panel ─────────────────────────────────────── */}
      {selectedGuard && (
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
          {/* Panel header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-[#1A3050]">
            <div className="flex items-center gap-4">
              <GuardAvatar name={selectedGuard.name} photoUrl={selectedGuard.photo_url} size="lg" />
              <div>
                <h2 className="text-white font-bold tracking-widest text-lg">{selectedGuard.name.toUpperCase()}</h2>
                <p className="text-gray-500 text-xs">{selectedGuard.badge_number}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => openScheduleForGuard(selectedGuard)}
                className="bg-amber-400 text-gray-900 font-bold tracking-widest text-xs px-3 py-1.5 rounded-lg hover:bg-amber-300 transition-colors"
              >
                + SCHEDULE NEW SHIFT
              </button>
              <button onClick={() => setSelectedGuard(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
          </div>

          {/* Shift list */}
          {selectedGuardShifts.length === 0 ? (
            <div className="text-center text-gray-500 text-sm py-10">No shifts scheduled for this guard.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                    <th className="text-left p-4">DATE</th>
                    <th className="text-left p-4">SITE</th>
                    <th className="text-left p-4">START → END</th>
                    <th className="text-center p-4">DURATION</th>
                    <th className="text-center p-4">STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedGuardShifts.map((s) => (
                    <tr key={s.id} className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors">
                      <td className="p-4 text-gray-300 text-xs font-mono">{fmtDateShort(s.scheduled_start)}</td>
                      <td className="p-4 text-gray-400 text-xs">{s.site_name}</td>
                      <td className="p-4 text-gray-400 text-xs font-mono">
                        {fmtTime(s.scheduled_start)} → {fmtTime(s.scheduled_end)}
                      </td>
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
          )}
        </div>
      )}

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

              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD <span className="text-gray-600 text-xs normal-case">(optional)</span></label>
                <select value={guardId} onChange={(e) => setGuardId(e.target.value)}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
                  <option value="">Unassigned</option>
                  {guards.filter((g: any) => g.is_active !== false).map((g) => (
                    <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE <span className="text-amber-400">*</span></label>
                <select value={siteId} onChange={(e) => setSiteId(e.target.value)}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
                  <option value="">Select site…</option>
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">START TIME <span className="text-amber-400">*</span></label>
                  <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)}
                    className="w-full bg-[#070F1E] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400" />
                </div>
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">END TIME <span className="text-amber-400">*</span></label>
                  <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)}
                    className="w-full bg-[#070F1E] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400" />
                </div>
              </div>

              {isOvernight && startTime && endTime && (
                <p className="text-cyan-400 text-xs tracking-wide -mt-1">Overnight — ends next day</p>
              )}

              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">REPEAT</label>
                <select value={repeatMode} onChange={(e) => { setRepeatMode(e.target.value as 'none' | 'days'); setRepeatDays([]); setCalStart(null); }}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
                  <option value="none">Does not repeat</option>
                  <option value="days">Repeat on selected days</option>
                </select>
              </div>

              {repeatMode === 'none' && (
                <div>
                  <label className="block text-gray-500 text-xs tracking-widest mb-1">DATE <span className="text-amber-400">*</span></label>
                  <div className="relative">
                    <input type="date" value={singleDate} onChange={(e) => setSingleDate(e.target.value)}
                      className="w-full bg-[#070F1E] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400" />
                    {singleDate && (
                      <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs pointer-events-none">
                        {fmtDate(new Date(singleDate + 'T00:00:00'))}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {repeatMode === 'days' && (
                <div>
                  <p className="text-gray-500 text-xs tracking-widest mb-2">SELECT DAYS</p>
                  <div className="flex gap-2 flex-wrap">
                    {DAYS.map((day, idx) => (
                      <button key={day} type="button" onClick={() => toggleRepeatDay(idx)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-bold tracking-widest transition-colors ${
                          repeatDays.includes(idx) ? 'bg-amber-400 text-gray-900' : 'bg-[#0B1526] border border-[#1A3050] text-gray-400 hover:border-amber-400/50'
                        }`}>
                        {day.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  <p className="text-gray-600 text-xs mt-2 mb-1">SELECT START DATE — shifts repeat for 28 days from this date.</p>
                  {calStart && <p className="text-amber-400 text-xs mb-1">Start: {fmtDate(calStart)}</p>}
                  <MiniCalendar year={calYear} month={calMonth} selectedDate={calStart} highlightDows={repeatDays}
                    onSelectDate={(d) => setCalStart(d)} onPrevMonth={prevMonth} onNextMonth={nextMonth} />
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

      {/* ── Assign Guard Modal ────────────────────────────────────────── */}
      {assignShift && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">ASSIGN GUARD</h2>
              <button onClick={() => setAssignShift(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
            <p className="text-gray-500 text-xs mb-1">Site: <span className="text-gray-300">{assignShift.site_name}</span></p>
            <p className="text-gray-500 text-xs mb-4">{fmtDT(assignShift.scheduled_start)} → {fmtDT(assignShift.scheduled_end)}</p>
            {assignError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{assignError}</div>}
            <div className="mb-5">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD <span className="text-amber-400">*</span></label>
              <select value={assignGuardId} onChange={(e) => setAssignGuardId(e.target.value)}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
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
