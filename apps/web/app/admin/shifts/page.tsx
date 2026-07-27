'use client';
/**
 * Admin — Shifts Scheduling (/admin/shifts)
 *
 * Two views, toggled via ?view=site|guard (default: site).
 *   • VIEW BY SITE  — grid of site cards summarising shift counts +
 *     assigned/unassigned split for a rolling 2-week window from now.
 *     Clicking a card drills into /admin/shifts/site/<siteId>.
 *   • VIEW BY GUARD — the previous guard-centric card grid, unchanged
 *     apart from being wrapped in the view switch. Selecting a guard
 *     opens the same in-page detail panel + shift table as before.
 *
 * Shared "Schedule Shift" and "Assign Guard" modals are extracted into
 * components so the site drill-in can trigger them without duplicating
 * ~300 lines of form state.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { adminGet } from '../../../lib/adminApi';
import InactiveSiteBadge from '../../../components/InactiveSiteBadge';
import ScheduleShiftModal from '../../../components/admin/ScheduleShiftModal';
import AssignGuardModal, { AssignableShift } from '../../../components/admin/AssignGuardModal';
import { fmtDateShort, fmtDuration, fmtTime } from '../../../lib/shiftFormat';
import { formatHoursHHMM } from '../../../lib/formatHours';

interface Shift {
  id:               string;
  guard_id:         string | null;
  site_id:          string;
  guard_name:       string | null;
  site_name:        string;
  site_is_active?:  boolean;
  company_name?:    string;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'unassigned' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'missed';
}

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean; photo_url?: string | null; }
interface Site  { id: string; name: string; address?: string; company_name?: string }

// Session S6 — coverage-status snapshot per site (rolling 14-day window).
interface CoverageStatus {
  site_id:            string;
  has_active_profile: boolean;
  required:           number;
  scheduled:          number;
  gaps:               number;
}

const STATUS_STYLES: Record<string, string> = {
  unassigned: 'bg-amber-400/20 text-amber-400 border border-amber-400/40',
  scheduled:  'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  active:     'bg-green-500/20 text-green-400 border border-green-500/40',
  completed:  'bg-gray-700/40 text-gray-500 border border-gray-600/40',
  cancelled:  'bg-gray-700/40 text-gray-400 border border-gray-600/50',
  missed:     'bg-red-900/30 text-red-400 border border-red-700/40',
};

const AVAILABILITY_STYLES: Record<string, string> = {
  'ON SHIFT':  'bg-green-500/20 text-green-400 border border-green-500/40',
  'SCHEDULED': 'bg-blue-500/20  text-blue-400  border border-blue-500/40',
  'AVAILABLE': 'bg-[#00C8FF]/10 text-[#00C8FF] border border-[#00C8FF]/30',
};

function getAvailability(guardId: string, shifts: Shift[]) {
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  const guardShifts = shifts.filter((s) => s.guard_id === guardId);
  if (guardShifts.some((s) => s.status === 'active')) return 'ON SHIFT';
  const hasScheduledToday = guardShifts.some((s) => {
    if (s.status !== 'scheduled') return false;
    const start = new Date(s.scheduled_start);
    const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2,'0')}-${String(start.getDate()).padStart(2,'0')}`;
    return startStr === todayStr;
  });
  if (hasScheduledToday) return 'SCHEDULED';
  return 'AVAILABLE';
}

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

function GuardAvatar({ name, photoUrl, size = 'md' }: { name: string; photoUrl?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const [imgError, setImgError] = useState(false);
  const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  const sizeClass = size === 'lg' ? 'w-16 h-16 text-2xl' : size === 'sm' ? 'w-8 h-8 text-xs' : 'w-12 h-12 text-base';
  if (photoUrl && !imgError) {
    return <img src={photoUrl} alt={name} onError={() => setImgError(true)} className={`${sizeClass} rounded-full object-cover border-2 border-[#1A3050]`} />;
  }
  return (
    <div className={`${sizeClass} rounded-full bg-[#00C8FF]/20 border-2 border-[#00C8FF]/40 flex items-center justify-center font-bold text-[#00C8FF] shrink-0`}>
      {initials}
    </div>
  );
}

export default function ShiftsPage() {
  return (
    <Suspense fallback={<div className="text-gray-500 text-sm py-12 text-center">Loading…</div>}>
      <ShiftsPageInner />
    </Suspense>
  );
}

function ShiftsPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();
  const view: 'site' | 'guard' = searchParams?.get('view') === 'guard' ? 'guard' : 'site';

  const [shifts,  setShifts]  = useState<Shift[]>([]);
  const [guards,  setGuards]  = useState<Guard[]>([]);
  const [sites,   setSites]   = useState<Site[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  // Session S6 — coverage snapshot by site_id. Loaded once alongside sites.
  const [coverage, setCoverage] = useState<Record<string, CoverageStatus>>({});

  // Schedule modal state — prefilled site/guard passed via props
  const [showModal,            setShowModal]            = useState(false);
  const [modalPrefilledSite,   setModalPrefilledSite]   = useState<string | undefined>();
  const [modalPrefilledGuard,  setModalPrefilledGuard]  = useState<string | undefined>();

  // Assign-guard modal state
  const [assignShift, setAssignShift] = useState<Shift | null>(null);

  // Guard-view state (only used when view=guard, but kept mounted for cheap toggles)
  const today = useMemo(() => new Date(), []);
  const [weekRef, setWeekRef] = useState<Date>(today);
  const { start: weekStart, end: weekEnd } = useMemo(() => getWeekBounds(weekRef), [weekRef]);
  const [selectedGuard, setSelectedGuard] = useState<Guard | null>(null);

  // Rolling 2-week window (site view). Anchored at midnight local to avoid
  // off-by-fractional-day drift as the tab sits open.
  const { twoWeekStart, twoWeekEnd } = useMemo(() => {
    const s = new Date(today); s.setHours(0, 0, 0, 0);
    const e = new Date(s); e.setDate(s.getDate() + 14); e.setHours(23, 59, 59, 999);
    return { twoWeekStart: s, twoWeekEnd: e };
  }, [today]);

  const load = useCallback(async () => {
    try {
      const [sh, g, s, cov] = await Promise.all([
        adminGet<Shift[]>('/api/shifts'),
        adminGet<Guard[]>('/api/guards'),
        adminGet<Site[]>('/api/sites'),
        // Session S6 — bundle the coverage snapshot in the initial fetch so
        // every site card can render its gap pill without an N+1 round-trip.
        adminGet<CoverageStatus[]>('/api/scheduling/coverage-status').catch(() => [] as CoverageStatus[]),
      ]);
      setShifts(sh); setGuards(g.filter((g) => g)); setSites(s);
      const covMap: Record<string, CoverageStatus> = {};
      for (const c of cov) covMap[c.site_id] = c;
      setCoverage(covMap);
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  function setView(next: 'site' | 'guard') {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    params.set('view', next);
    router.replace(`/admin/shifts?${params.toString()}`, { scroll: false });
  }

  function openScheduleModal(opts?: { siteId?: string; guardId?: string }) {
    setModalPrefilledSite(opts?.siteId);
    setModalPrefilledGuard(opts?.guardId);
    setShowModal(true);
  }

  // Deep-link handler: /admin/shifts?newShift=1&siteId=<uuid> opens the
  // Schedule Shift modal pre-populated with that site. Consumed by the
  // "MANAGE SCHEDULE" link on /admin/sites/[id]. One-shot: params are
  // stripped after the modal opens so a later view toggle or back-nav
  // doesn't reopen it.
  const deepLinkHandled     = useRef(false);
  // Fix 2: when the modal was opened via deep-link, Cancel returns the
  // admin to /admin (dashboard) rather than leaving them stranded on
  // /admin/shifts. Save + close (onCreated → onClose) stays on the page.
  // The ref is set in the deep-link useEffect and cleared in handleClose
  // so subsequent normal opens behave normally.
  const openedViaDeepLink   = useRef(false);
  const createdFromDeepLink = useRef(false);
  useEffect(() => {
    if (deepLinkHandled.current) return;
    const newShift = searchParams?.get('newShift');
    const siteId   = searchParams?.get('siteId');
    if (newShift === '1' && siteId) {
      deepLinkHandled.current   = true;
      openedViaDeepLink.current = true;
      openScheduleModal({ siteId });
      const p = new URLSearchParams(searchParams?.toString() ?? '');
      p.delete('newShift');
      p.delete('siteId');
      const qs = p.toString();
      router.replace(qs ? `/admin/shifts?${qs}` : '/admin/shifts', { scroll: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router]);

  // ScheduleShiftModal collapses "save" and "cancel" into one onClose
  // prop (it calls onCreated() then onClose() after a successful save).
  // We differentiate by having onCreated stamp `createdFromDeepLink`
  // — then handleClose sees it and skips the redirect.
  function handleModalCreated() {
    createdFromDeepLink.current = openedViaDeepLink.current;
    load();
  }
  function handleModalClose() {
    const wasDeepLink = openedViaDeepLink.current;
    const wasCreated  = createdFromDeepLink.current;
    openedViaDeepLink.current   = false;
    createdFromDeepLink.current = false;
    setShowModal(false);
    if (wasDeepLink && !wasCreated) {
      router.push('/admin');
    }
  }

  const unassignedCount = shifts.filter((s) => s.status === 'unassigned').length;
  const activeGuards    = guards.filter((g) => g.is_active !== false);

  // Vishnu multi-company label — same conditional pattern as guards page.
  const showCompanyLabel = useMemo(() => {
    const set = new Set<string>();
    for (const s of shifts)  if (s.company_name) set.add(s.company_name);
    for (const s of sites)   if (s.company_name) set.add(s.company_name);
    return set.size > 1;
  }, [shifts, sites]);

  // Guard detail panel data
  const selectedGuardShifts = useMemo(() => {
    if (!selectedGuard) return [];
    return shifts
      .filter((s) => s.guard_id === selectedGuard.id)
      .sort((a, b) => new Date(b.scheduled_start).getTime() - new Date(a.scheduled_start).getTime());
  }, [selectedGuard, shifts]);

  function prevWeek() { const d = new Date(weekRef); d.setDate(d.getDate() - 7); setWeekRef(d); }
  function nextWeek() { const d = new Date(weekRef); d.setDate(d.getDate() + 7); setWeekRef(d); }

  return (
    <div className="space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-3xl font-bold tracking-widest text-amber-400">SHIFTS</h1>
        <div className="flex gap-3 items-center flex-wrap">
          {/* View toggle */}
          <div className="flex items-center gap-1 bg-[#0F1E35] border border-[#1A3050] rounded-lg p-1">
            {([['site', 'BY SITE'], ['guard', 'BY GUARD']] as const).map(([v, label]) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 rounded text-xs tracking-widest transition-colors ${
                  view === v ? 'bg-amber-500 text-black font-bold' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          {/* Range display — site view shows 2-week window; guard view keeps the ± week navigator */}
          {view === 'site' ? (
            <div className="bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-1.5 text-gray-400 text-xs tracking-widest whitespace-nowrap">
              {isoWeek(twoWeekStart)} — {isoWeek(twoWeekEnd)} · rolling 2 weeks
            </div>
          ) : (
            <div className="flex items-center gap-2 bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-1.5">
              <button onClick={prevWeek} className="text-gray-400 hover:text-amber-400 px-1 transition-colors">‹</button>
              <span className="text-gray-300 text-xs tracking-widest whitespace-nowrap">
                {isoWeek(weekStart)} – {isoWeek(weekEnd)}
              </span>
              <button onClick={nextWeek} className="text-gray-400 hover:text-amber-400 px-1 transition-colors">›</button>
            </div>
          )}
          <button
            onClick={() => openScheduleModal()}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
          >
            + SCHEDULE SHIFT
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Unassigned alert — surfaced on both views */}
      {unassignedCount > 0 && (
        <div className="bg-amber-400/10 border border-amber-400/40 rounded-lg px-4 py-3 flex items-center gap-3">
          <span className="text-amber-400 text-lg">⚠</span>
          <span className="text-amber-300 text-sm">
            <strong>{unassignedCount}</strong> shift{unassignedCount > 1 ? 's' : ''} without an assigned guard.
          </span>
        </div>
      )}

      {/* ── Site view ──────────────────────────────────────────────────── */}
      {view === 'site' && (
        loading ? (
          <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>
        ) : sites.length === 0 ? (
          <div className="text-gray-500 text-sm py-12 text-center">No sites configured yet.</div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {[...sites].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).map((site) => {
              const inWindow = shifts.filter((s) =>
                s.site_id === site.id &&
                s.status !== 'cancelled' &&
                new Date(s.scheduled_start) >= twoWeekStart &&
                new Date(s.scheduled_start) <= twoWeekEnd
              );
              const assigned   = inWindow.filter((s) => s.guard_id !== null).length;
              const unassigned = inWindow.length - assigned;
              const totalHours = inWindow.reduce((acc, s) => acc +
                (new Date(s.scheduled_end).getTime() - new Date(s.scheduled_start).getTime()) / 3_600_000, 0);
              const isActive = inWindow.length > 0;
              return (
                <Link
                  key={site.id}
                  href={`/admin/shifts/site/${site.id}`}
                  className="text-left bg-[#0F1E35] border border-[#1A3050] rounded-xl p-4 transition-all hover:border-[#00C8FF]/50 hover:shadow-lg hover:shadow-[#00C8FF]/5 block"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <p className="text-white font-semibold text-sm truncate">{site.name}</p>
                      {site.address && <p className="text-gray-500 text-xs truncate">{site.address}</p>}
                      {showCompanyLabel && site.company_name && (
                        <p className="text-gray-600 text-[10px] tracking-widest mt-0.5">{site.company_name.toUpperCase()}</p>
                      )}
                    </div>
                    <span className={`text-[10px] tracking-widest font-bold px-2 py-0.5 rounded shrink-0 ${
                      isActive
                        ? 'bg-green-500/20 text-green-400 border border-green-500/40'
                        : 'bg-gray-700/30 text-gray-500 border border-gray-600/40'
                    }`}>
                      {isActive ? 'ACTIVE' : 'INACTIVE'}
                    </span>
                  </div>
                  <p className="text-gray-300 text-sm">
                    <span className="text-white font-bold">{inWindow.length}</span> shift{inWindow.length === 1 ? '' : 's'} this window
                    {inWindow.length > 0 && (
                      <span className="text-gray-500"> — {assigned} assigned, {unassigned} unassigned</span>
                    )}
                  </p>
                  {inWindow.length > 0 && (
                    <p className="text-gray-500 text-xs mt-1">{formatHoursHHMM(totalHours)} scheduled</p>
                  )}
                  {/* Session S6 — gap pill. Only rendered when the site has
                      an active scheduling profile; silent otherwise. */}
                  {(() => {
                    const cov = coverage[site.id];
                    if (!cov?.has_active_profile) return null;
                    return cov.gaps > 0 ? (
                      <p className="text-red-400 text-[11px] tracking-widest mt-1 bg-red-500/10 border border-red-500/40 px-2 py-0.5 rounded inline-block">
                        ⚠ {cov.gaps} gap{cov.gaps === 1 ? '' : 's'} in next 2 weeks
                      </p>
                    ) : (
                      <p className="text-green-400 text-[11px] tracking-widest mt-1 bg-green-500/10 border border-green-500/40 px-2 py-0.5 rounded inline-block">
                        ✓ Fully covered
                      </p>
                    );
                  })()}
                </Link>
              );
            })}
          </div>
        )
      )}

      {/* ── Guard view (preserved from previous UI) ────────────────────── */}
      {view === 'guard' && (
        loading ? (
          <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {activeGuards.map((guard) => {
              const availability = getAvailability(guard.id, shifts);
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
        )
      )}

      {/* ── Guard detail side panel (guard view only) ──────────────────── */}
      {view === 'guard' && selectedGuard && (
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
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
                onClick={() => openScheduleModal({ guardId: selectedGuard.id })}
                className="bg-amber-400 text-gray-900 font-bold tracking-widest text-xs px-3 py-1.5 rounded-lg hover:bg-amber-300 transition-colors"
              >
                + SCHEDULE NEW SHIFT
              </button>
              <button onClick={() => setSelectedGuard(null)} className="text-gray-500 hover:text-gray-300 text-xl">✕</button>
            </div>
          </div>

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
                    <tr
                      key={s.id}
                      onClick={() => router.push(`/admin/shifts/${s.id}`)}
                      className="border-b border-[#1A3050] hover:bg-[#0B1526] transition-colors cursor-pointer"
                    >
                      <td className="p-4 text-gray-300 text-xs font-mono">{fmtDateShort(s.scheduled_start)}</td>
                      <td className="p-4 text-gray-400 text-xs">
                        {s.site_name}
                        <InactiveSiteBadge siteIsActive={s.site_is_active} />
                      </td>
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

      {/* Shared modals */}
      <ScheduleShiftModal
        open={showModal}
        onClose={handleModalClose}
        onCreated={handleModalCreated}
        guards={guards}
        sites={sites}
        prefilledSiteId={modalPrefilledSite}
        prefilledGuardId={modalPrefilledGuard}
      />
      <AssignGuardModal
        shift={assignShift as AssignableShift | null}
        guards={guards}
        onClose={() => setAssignShift(null)}
        onAssigned={load}
      />
    </div>
  );
}
