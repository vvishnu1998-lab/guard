'use client';
/**
 * Shared "Schedule Shift" modal — used by /admin/shifts (both views) and
 * the per-site drill-in. Wraps the full flow (guard picker, site picker
 * with assignment-filter, start/end time, repeat mode with mini
 * calendar) so the calling page just mounts <ScheduleShiftModal /> and
 * reacts to onCreated.
 *
 * Extracted from the inline modal previously in /admin/shifts/page.tsx.
 */
import { useEffect, useMemo, useState } from 'react';
import { adminGet, adminPost } from '../../lib/adminApi';
import { fmtDate } from '../../lib/shiftFormat';

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean }
interface Site  { id: string; name: string }

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  guards: Guard[];
  sites:  Site[];
  prefilledSiteId?:  string;
  prefilledGuardId?: string;
}

const DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function buildISO(date: Date, timeStr: string): string {
  const [h, m] = timeStr.split(':').map(Number);
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

function MiniCalendar({
  year, month, selectedDate, selectedDates, highlightDows, minDate, multiSelect,
  onSelectDate, onPrevMonth, onNextMonth,
}: {
  year: number; month: number;
  selectedDate: Date | null;
  selectedDates?: Date[];
  highlightDows: number[];
  minDate?: Date;
  multiSelect?: boolean;
  onSelectDate: (d: Date) => void;
  onPrevMonth: () => void; onNextMonth: () => void;
}) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = Array(firstDay).fill(null);
  for (let i = 1; i <= daysInMonth; i++) cells.push(i);
  while (cells.length % 7 !== 0) cells.push(null);

  const minMidnight = minDate ? new Date(minDate.getFullYear(), minDate.getMonth(), minDate.getDate()).getTime() : -Infinity;
  const selectedKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const selectedSet = new Set((selectedDates ?? []).map(selectedKey));

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
          const isSelectedSingle = !multiSelect && selectedDate !== null &&
            selectedDate.getFullYear() === year && selectedDate.getMonth() === month && selectedDate.getDate() === day;
          const isSelectedMulti = !!multiSelect && selectedSet.has(selectedKey(thisDate));
          const isPast = thisDate.getTime() < minMidnight;
          return (
            <button key={day} type="button" disabled={isPast} onClick={() => onSelectDate(thisDate)}
              className={['text-center text-xs py-1.5 rounded transition-colors',
                isPast ? 'text-gray-700 cursor-not-allowed opacity-40'
                : isSelectedMulti ? 'bg-[#00C8FF] text-[#0B1526] font-bold hover:bg-[#00C8FF]/90'
                : isSelectedSingle ? 'ring-2 ring-amber-400 text-amber-400 font-bold bg-amber-400/10'
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

export default function ScheduleShiftModal({
  open, onClose, onCreated, guards, sites, prefilledSiteId, prefilledGuardId,
}: Props) {
  const today = useMemo(() => new Date(), []);
  const todayInputMin = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  const [guardId,    setGuardId]    = useState('');
  const [siteId,     setSiteId]     = useState('');
  const [startTime,  setStartTime]  = useState('');
  const [endTime,    setEndTime]    = useState('');
  const [singleDate, setSingleDate] = useState('');
  const [repeatMode, setRepeatMode] = useState<'none' | 'days' | 'specific'>('none');
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [calYear,  setCalYear]  = useState(today.getFullYear());
  const [calMonth, setCalMonth] = useState(today.getMonth());
  const [calStart, setCalStart] = useState<Date | null>(null);
  const [specificDates, setSpecificDates] = useState<Date[]>([]);
  const [saving,    setSaving]    = useState(false);
  const [formError, setFormError] = useState('');

  // Guard→assigned-sites narrowing (unchanged from the previous inline modal).
  const [assignedSites, setAssignedSites] = useState<Site[] | null>(null);
  const [assignedSitesLoading, setAssignedSitesLoading] = useState(false);

  // Session S6 — if the selected site has an active scheduling profile,
  // auto-fill date + start/end times from its first active shift (starting
  // from today's day-of-week and rolling forward). Shown as a subtle cyan
  // hint above the form; admin can override any field.
  const [siteProfile, setSiteProfile] = useState<{ profile_name: string } | null>(null);

  // Re-initialise state when the modal opens. When it closes, state is
  // retained until the next open — cheap since the modal is unmounted-invisible.
  useEffect(() => {
    if (!open) return;
    setGuardId(prefilledGuardId ?? '');
    setSiteId(prefilledSiteId ?? '');
    setStartTime(''); setEndTime('');
    setSingleDate('');
    setRepeatMode('none'); setRepeatDays([]);
    setCalStart(null);
    setSpecificDates([]);
    setCalYear(today.getFullYear()); setCalMonth(today.getMonth());
    setFormError('');
    setSaving(false);
  }, [open, prefilledSiteId, prefilledGuardId, today]);

  // Session S6 — fetch site's active profile on site pick + auto-fill.
  useEffect(() => {
    if (!siteId) { setSiteProfile(null); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await adminGet<{ profiles: Array<{
          profile_name: string;
          is_active:    boolean;
          shifts:       Array<{ day_of_week: number; shift_start_time: string; shift_length_hours: number; active: boolean }>;
        }> }>(`/api/scheduling/site/${siteId}`);
        if (cancelled) return;
        const active = r.profiles.find((p) => p.is_active);
        if (!active) { setSiteProfile(null); return; }
        setSiteProfile({ profile_name: active.profile_name });
        // Find the first upcoming shift starting today's day-of-week and
        // rolling forward up to 6 days.
        const today = new Date();
        const todayDow = today.getDay();
        let candidate: { day_of_week: number; shift_start_time: string; shift_length_hours: number } | null = null;
        let candidateDow = todayDow;
        for (let offset = 0; offset < 7; offset++) {
          const dow = (todayDow + offset) % 7;
          const forDay = active.shifts.filter((s) => s.day_of_week === dow && s.active)
            .sort((a, b) => a.shift_start_time.localeCompare(b.shift_start_time));
          if (forDay.length > 0) {
            candidate = forDay[0];
            candidateDow = dow;
            break;
          }
        }
        if (!candidate) return;
        // Materialise date + times.
        const daysToAdd = (candidateDow - todayDow + 7) % 7;
        const target = new Date(today.getFullYear(), today.getMonth(), today.getDate() + daysToAdd);
        const dateStr = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
        const startStr = candidate.shift_start_time.slice(0, 5);
        const [h, m] = startStr.split(':').map(Number);
        const total = h * 60 + m + candidate.shift_length_hours * 60;
        const endH = Math.floor(total / 60) % 24;
        const endM = Math.floor(total % 60);
        const endStr = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;
        setSingleDate(dateStr);
        setStartTime(startStr);
        setEndTime(endStr);
      } catch { if (!cancelled) setSiteProfile(null); }
    })();
    return () => { cancelled = true; };
  }, [siteId]);

  useEffect(() => {
    if (!guardId) { setAssignedSites(null); return; }
    let cancelled = false;
    setAssignedSitesLoading(true);
    (async () => {
      try {
        // Filter by TOMORROW Pacific — see original comment in shifts/page.tsx
        // for the End-Now interaction rationale (kept intact on extract).
        const tomorrow = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'America/Los_Angeles',
          year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date(Date.now() + 24 * 60 * 60 * 1000));
        const r = await adminGet<{ sites: { site_id: string; site_name: string }[] }>(
          `/api/guards/${guardId}/assigned-sites?date=${tomorrow}`
        );
        if (cancelled) return;
        const filtered: Site[] = r.sites.map(s => ({ id: s.site_id, name: s.site_name }));
        setAssignedSites(filtered);
        setSiteId(prev => (prev && !filtered.some(s => s.id === prev) ? '' : prev));
      } catch { if (!cancelled) setAssignedSites([]); }
      finally { if (!cancelled) setAssignedSitesLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [guardId]);

  const visibleSites: Site[] = guardId ? (assignedSites ?? []) : sites;
  const noAssignmentsForGuard = !!guardId && assignedSites !== null && assignedSites.length === 0;

  const isOvernight = useMemo(() => {
    if (!startTime || !endTime) return false;
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    return eh * 60 + em < sh * 60 + sm;
  }, [startTime, endTime]);

  function toggleRepeatDay(day: number) {
    setRepeatDays((prev) => prev.includes(day) ? prev.filter((d) => d !== day) : [...prev, day]);
  }
  function toggleSpecificDate(d: Date) {
    setSpecificDates((prev) => {
      const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
      const k = key(d);
      const exists = prev.some((x) => key(x) === k);
      if (exists) return prev.filter((x) => key(x) !== k);
      return [...prev, d].sort((a, b) => a.getTime() - b.getTime());
    });
  }
  function fmtSpecificDate(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function prevMonth() { if (calMonth === 0) { setCalMonth(11); setCalYear((y) => y - 1); } else setCalMonth((m) => m - 1); }
  function nextMonth() { if (calMonth === 11) { setCalMonth(0); setCalYear((y) => y + 1); } else setCalMonth((m) => m + 1); }

  async function createShift() {
    if (!siteId)    { setFormError('Site is required'); return; }
    if (!startTime) { setFormError('Start time is required'); return; }
    if (!endTime)   { setFormError('End time is required'); return; }
    if (repeatMode === 'none') {
      if (!singleDate) { setFormError('Date is required'); return; }
    } else if (repeatMode === 'days') {
      if (repeatDays.length === 0) { setFormError('Select at least one day'); return; }
      if (!calStart) { setFormError('Select a start date from the calendar'); return; }
    } else {
      if (specificDates.length === 0) { setFormError('Pick at least one date'); return; }
      if (specificDates.length > 60)  { setFormError('Pick at most 60 dates'); return; }
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
      } else if (repeatMode === 'days') {
        const scheduledStart = buildISO(calStart!, startTime);
        const endBaseDate = isOvernight ? new Date(calStart!.getTime() + 86400000) : calStart!;
        const scheduledEnd = buildISO(endBaseDate, endTime);
        const payload: any = { site_id: siteId, scheduled_start: scheduledStart, scheduled_end: scheduledEnd, repeat_days: repeatDays };
        if (guardId) payload.guard_id = guardId;
        await adminPost('/api/shifts', payload);
      } else {
        const payload: any = {
          mode: 'specific_dates',
          site_id: siteId,
          start_time: startTime,
          end_time: endTime,
          dates: specificDates.map(fmtSpecificDate),
        };
        if (guardId) payload.guard_id = guardId;
        await adminPost('/api/shifts', payload);
      }
      onCreated();
      onClose();
    } catch (e: any) { setFormError(e.message); }
    finally { setSaving(false); }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-amber-400 font-bold tracking-widest text-lg">SCHEDULE SHIFT</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
        </div>
        {formError && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">{formError}</div>}
        <div className="space-y-4">

          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">GUARD <span className="text-gray-600 text-xs normal-case">(optional)</span></label>
            <select value={guardId} onChange={(e) => setGuardId(e.target.value)}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
              <option value="">Unassigned</option>
              {guards.filter((g) => g.is_active !== false).map((g) => (
                <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-gray-500 text-xs tracking-widest mb-1">SITE <span className="text-amber-400">*</span></label>
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} disabled={noAssignmentsForGuard}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 disabled:opacity-40">
              <option value="">
                {noAssignmentsForGuard
                  ? 'No sites assigned — assign guard on the Guards page first'
                  : (assignedSitesLoading ? 'Loading sites…' : 'Select site…')}
              </option>
              {visibleSites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            {noAssignmentsForGuard && (
              <p className="text-amber-400/80 text-xs mt-1">
                This guard has no active site assignments. Go to <span className="font-mono">/admin/guards</span> and click ASSIGN.
              </p>
            )}
            {siteProfile && (
              <p className="text-cyan-400 text-xs mt-1">
                Auto-filled from <span className="font-bold">{siteProfile.profile_name}</span> profile. You can override.
              </p>
            )}
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
            <select value={repeatMode} onChange={(e) => { setRepeatMode(e.target.value as 'none' | 'days' | 'specific'); setRepeatDays([]); setCalStart(null); setSpecificDates([]); }}
              className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400">
              <option value="none">Does not repeat</option>
              <option value="days">Repeat on selected days</option>
              <option value="specific">Pick specific dates</option>
            </select>
          </div>

          {repeatMode === 'none' && (
            <div>
              <label className="block text-gray-500 text-xs tracking-widest mb-1">DATE <span className="text-amber-400">*</span></label>
              <div className="relative">
                <input type="date" value={singleDate} min={todayInputMin} onChange={(e) => setSingleDate(e.target.value)}
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
                minDate={today}
                onSelectDate={(d) => setCalStart(d)} onPrevMonth={prevMonth} onNextMonth={nextMonth} />
            </div>
          )}

          {repeatMode === 'specific' && (
            <div data-testid="specific-dates-panel">
              <div className="flex items-center justify-between mb-2">
                <p className="text-gray-500 text-xs tracking-widest">
                  {specificDates.length} DATE{specificDates.length === 1 ? '' : 'S'} SELECTED
                </p>
                {specificDates.length > 0 && (
                  <button type="button" onClick={() => setSpecificDates([])}
                    className="text-gray-500 hover:text-amber-400 text-xs tracking-widest underline">
                    CLEAR ALL
                  </button>
                )}
              </div>
              {specificDates.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {specificDates.map((d) => (
                    <button key={fmtSpecificDate(d)} type="button" onClick={() => toggleSpecificDate(d)}
                      className="px-2 py-0.5 rounded bg-[#00C8FF]/15 border border-[#00C8FF]/40 text-[#00C8FF] text-xs font-mono hover:bg-[#00C8FF]/25 transition-colors">
                      {fmtDate(d)} ×
                    </button>
                  ))}
                </div>
              )}
              <p className="text-gray-600 text-xs mb-1">Pick up to 60 individual dates. One shift per date, all sharing the same time + site.</p>
              <MiniCalendar year={calYear} month={calMonth} selectedDate={null} selectedDates={specificDates}
                highlightDows={[]} minDate={today} multiSelect
                onSelectDate={toggleSpecificDate} onPrevMonth={prevMonth} onNextMonth={nextMonth} />
            </div>
          )}
        </div>

        <div className="flex gap-3 mt-6">
          <button onClick={onClose} className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2 text-sm tracking-widest hover:border-gray-500 transition-colors">CANCEL</button>
          <button onClick={createShift} disabled={saving || noAssignmentsForGuard} className="flex-1 bg-amber-400 text-gray-900 font-bold rounded-lg py-2 text-sm tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors">
            {saving ? 'SAVING…' : repeatMode === 'none' ? 'SCHEDULE' : `CREATE ${repeatMode === 'specific' ? specificDates.length || '' : ''} SHIFTS`.replace(/\s+/g, ' ').trim()}
          </button>
        </div>
      </div>
    </div>
  );
}
