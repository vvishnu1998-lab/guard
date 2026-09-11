'use client';
/**
 * Admin — Site Shifts Drill-In (/admin/shifts/site/[siteId])
 *
 * Reached from the site cards on /admin/shifts?view=site. Asks the server
 * for this site's shifts from yesterday to +90d — site_id and the date
 * bounds are query params, and the bounds are bare dates resolved against
 * the SITE's calendar days, not the browser's. Rendered as an
 * ascending-date table with no further date filtering client-side.
 * Local SCHEDULE SHIFT and ASSIGN GUARD
 * modals share components with the parent page (see
 * apps/web/components/admin/ScheduleShiftModal.tsx and
 * AssignGuardModal.tsx). Site dropdown in the schedule modal is pre-
 * filled + limited to this site — an admin who needs a different site
 * navigates back to the grid.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { adminGet } from '../../../../../lib/adminApi';
import InactiveSiteBadge from '../../../../../components/InactiveSiteBadge';
import ScheduleShiftModal from '../../../../../components/admin/ScheduleShiftModal';
import AssignGuardModal, { AssignableShift } from '../../../../../components/admin/AssignGuardModal';
import SlotAssignPanel from '../../../../../components/admin/SlotAssignPanel';
import BulkShiftActions, { BulkShiftRow } from '../../../../../components/admin/BulkShiftActions';
import { blockedLabel, REASON_LABEL } from '../../../../../lib/bulkShiftCopy';
import { dayOffsetInZone, fmtCalRange, fmtDateShort, fmtDuration, fmtTime } from '../../../../../lib/shiftFormat';

interface Site {
  id:             string;
  name:           string;
  address?:       string;
  radius_meters?: number | null;
  is_active?:     boolean;
  company_name?:  string;
  // sites.timezone is NOT NULL server-side, but this page tolerates a stale
  // API that predates it — dayOffsetInZone(undefined) falls back to the
  // browser's zone rather than throwing.
  timezone?:      string;
}

interface Shift {
  id:               string;
  guard_id:         string | null;
  site_id:          string;
  guard_name:       string | null;
  site_name:        string;
  site_is_active?:  boolean;
  scheduled_start:  string;
  scheduled_end:    string;
  status:           'unassigned' | 'scheduled' | 'active' | 'completed' | 'cancelled' | 'missed';
  // schema_v48 — site requires vehicle inspection and a session on this
  // shift lacks a completed one. Optional: absent until the API deploys.
  inspection_incomplete?: boolean;
}

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean }

const STATUS_STYLES: Record<string, string> = {
  unassigned: 'bg-amber-400/20 text-amber-400 border border-amber-400/40',
  scheduled:  'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  active:     'bg-green-500/20 text-green-400 border border-green-500/40',
  completed:  'bg-gray-700/40 text-gray-500 border border-gray-600/40',
  cancelled:  'bg-gray-700/40 text-gray-400 border border-gray-600/50',
  missed:     'bg-red-900/30 text-red-400 border border-red-700/40',
};

export default function SiteShiftsPage() {
  const params = useParams<{ siteId: string }>();
  const router = useRouter();
  const siteId = params?.siteId ?? '';

  const [site,    setSite]    = useState<Site | null>(null);
  const [shifts,  setShifts]  = useState<Shift[]>([]);
  const [guards,  setGuards]  = useState<Guard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  const [showModal,   setShowModal]   = useState(false);
  const [assignShift, setAssignShift] = useState<Shift | null>(null);

  // The window this page asks the server for, and the only one it shows.
  // There is no client-side date filter any more: the server returns exactly
  // this range, site-local. Held in state so the header can name it.
  const [windowFrom, setWindowFrom] = useState('');
  const [windowTo,   setWindowTo]   = useState('');

  const load = useCallback(async () => {
    if (!siteId) return;
    try {
      // The site is fetched FIRST, not in parallel, because its timezone
      // decides which calendar dates the shift query asks for. A browser in
      // IST resolves "today" to a different date than a Los Angeles site
      // does, and that one-day slip is the whole reason this page was
      // showing a partial schedule.
      const siteData = await adminGet<Site>(`/api/sites/${siteId}`);
      setSite(siteData);

      // -1d, not 0: an overnight shift (19:30 -> 11:30 next day) carries
      // scheduled_start on the PRIOR day, so `from = today` would hide a
      // shift that is in progress right now.
      const from = dayOffsetInZone(-1, siteData.timezone);
      const to   = dayOffsetInZone(90, siteData.timezone);
      setWindowFrom(from); setWindowTo(to);

      const [shiftData, guardData] = await Promise.all([
        adminGet<Shift[]>(`/api/shifts?site_id=${encodeURIComponent(siteId)}&from=${from}&to=${to}`),
        adminGet<Guard[]>('/api/guards'),
      ]);
      setShifts(shiftData);
      setGuards(guardData);
      setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { load(); }, [load]);

  // No date predicate: the server already returned exactly windowFrom..
  // windowTo for this site, anchored in the site's own calendar days. The
  // site_id check is retained as a cheap guard against a dropped param.
  const siteShifts = useMemo(() => {
    return shifts
      .filter((s) => s.site_id === siteId && s.status !== 'cancelled')
      .sort((a, b) => new Date(a.scheduled_start).getTime() - new Date(b.scheduled_start).getTime());
  }, [shifts, siteId]);

  // Every upcoming, non-cancelled shift at this site — the SELECTABLE POOL,
  // which is narrower than what the table below RENDERS.
  //
  // The table shows the whole -1d..+90d window; this pool is the future half.
  // A past row is rendered with a disabled checkbox rather than hidden,
  // because the table is the schedule first and the picker second. Measured
  // before merging: past rows are 16% of the largest site's 67 and a minority
  // everywhere, so the window does NOT need narrowing to make selection work.
  //
  // Per-verb admissibility is decided by admits() inside BulkShiftActions and
  // must not be pre-filtered here: the
  // two verbs admit different statuses and neither set contains the other.
  //
  // NO guard_id FILTER — deliberate, and it used to be here. Cancel admits
  // status='unassigned' (see PATCH /api/shifts/:id/cancel), and those rows
  // have guard_id null, so filtering on guard_id removed them from the list
  // before the component could offer them. Widening isCancellable alone would
  // NOT have fixed that; this line was the actual gate.
  //
  // "Upcoming" still means what GET /guards/:id/deactivation-impact means by
  // it — `scheduled_end > now`, not cancelled — so the two surfaces still give
  // the same answer to the question an admin can ask in both places. What
  // differs is only that this one is not guard-scoped, because it is not about
  // one guard. `scheduled_end`, not `scheduled_start`: a shift that has
  // started with nobody on it is exactly the row worth acting on.
  //
  // Rows the active verb cannot take are still SHOWN, greyed and labelled, by
  // the component. Widening this pool widens what is DISPLAYED, never what is
  // actionable.
  const bulkPool: BulkShiftRow[] = useMemo(() => {
    const now = Date.now();
    return siteShifts
      .filter((s) => new Date(s.scheduled_end).getTime() > now)
      .map((s) => ({
        id:              s.id,
        site_id:         s.site_id,
        site_name:       s.site_name,
        scheduled_start: s.scheduled_start,
        scheduled_end:   s.scheduled_end,
        status:          s.status,
        guard_name:      s.guard_name,
      }));
  }, [siteShifts]);

  return (
    <div className="space-y-6">
      {/* Header + back */}
      <div>
        <Link href="/admin/shifts?view=site"
          className="text-gray-500 hover:text-amber-400 text-xs tracking-widest inline-flex items-center gap-1 mb-2">
          ← BACK TO SHIFTS
        </Link>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="min-w-0">
            <h1 className="text-2xl md:text-3xl font-bold tracking-widest text-amber-400 break-words">
              SHIFTS AT {(site?.name ?? '…').toUpperCase()}
              <InactiveSiteBadge siteIsActive={site?.is_active} />
            </h1>
            {site && (
              <div className="text-gray-500 text-xs mt-2 flex flex-wrap gap-x-3 gap-y-1">
                {site.address && <span>{site.address}</span>}
                {site.radius_meters != null && (
                  <span className="text-gray-600">· geofence {site.radius_meters}m</span>
                )}
                {site.company_name && (
                  <span className="text-gray-600">· {site.company_name}</span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="bg-amber-400 text-gray-900 font-bold tracking-widest text-sm px-4 py-2 rounded-lg hover:bg-amber-300 transition-colors"
          >
            + SCHEDULE SHIFT
          </button>
        </div>
      </div>

      {error && <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">{error}</div>}

      {/* Template slots — renders nothing when the site has no active
          scheduling profile, so a site that does not use them is unchanged.
          Its window (14d) differs from the shift table's (-1d..+90d) and it
          names its own dates in its heading for that reason. */}
      {siteId && <SlotAssignPanel siteId={siteId} onAssigned={load} />}

      {/* ONE table, not two.
          This page used to render a separate bulk PICKER above the schedule
          table — same rows, fewer columns. The picker had DATE, TIME, SITE
          and STATUS; the schedule had DATE, TIME, GUARD, duration, a status
          PILL and the inspection badge. So the surface for CHOOSING shifts
          lacked the column that matters most while choosing, which is who is
          on the shift, and carried a SITE column that on a single-site page
          says nothing.
          They are merged. BulkShiftActions supplies the header, the verb
          switcher, the guard dropdown and the confirm step; the table below
          is this page's own and now carries the checkboxes. */}
      <BulkShiftActions
        shifts={bulkPool}
        guards={guards}
        title="SHIFTS AT THIS SITE"
        onDone={load}
      >
        {({ verb, selected, canSelect, toggle, toggleAll, allSelected,
            eligibleCount, busy, failures, chosenBlocked }) => (
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-10 text-center text-gray-500 text-sm">Loading…</div>
        ) : siteShifts.length === 0 ? (
          <div className="p-10 text-center text-gray-500 text-sm">
            No shifts at this site{windowFrom && windowTo ? ` between ${fmtCalRange(windowFrom, windowTo)}` : ''}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                  <th className="p-4 w-10 text-left">
                    <input
                      type="checkbox"
                      aria-label={verb === 'cancel'
                        ? 'Select all cancellable shifts'
                        : 'Select all assignable shifts'}
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={busy || eligibleCount === 0}
                      className="accent-amber-400"
                    />
                  </th>
                  <th className="text-left p-4">DATE</th>
                  <th className="text-left p-4">TIME</th>
                  <th className="text-left p-4">ASSIGNED GUARD</th>
                  <th className="text-center p-4">STATUS</th>
                  <th className="text-right p-4"></th>
                </tr>
              </thead>
              <tbody>
                {siteShifts.map((s) => (
                  // THE ROW IS NO LONGER A LINK, and that is load-bearing.
                  //
                  // It used to be role="link" + tabIndex={0} + an onKeyDown
                  // that preventDefault()ed Enter AND Space. Space is exactly
                  // the key that toggles a focused checkbox, and a keydown on
                  // the checkbox BUBBLES to the row — so once this table
                  // carried checkboxes, that handler cancelled the toggle.
                  //
                  // Measured in a browser against a control checkbox with no
                  // ancestor handler, same real keypress: the control toggled,
                  // the in-row checkbox did not, AND the row navigated away.
                  // Pressing Space to pick a shift lost the page you were
                  // picking on. SlotAssignPanel's docblock predicted this and
                  // is why the slot list was built as a separate table.
                  //
                  // Guarding around it (stopPropagation on the checkbox)
                  // would fix the symptom. Deleting the handler removes the
                  // cause. Navigation moves to a real <Link> in the DATE cell,
                  // which is REQUIRED, not cosmetic: removing tabIndex and
                  // onKeyDown removes the row's only keyboard path.
                  //
                  // The ARIA fix rides along — a role="link" containing a
                  // checkbox and a button is invalid nesting — but it is not
                  // why this changed. Both controls stayed reachable; the
                  // stolen keypress is the defect.
                  //
                  // onClick stays for mouse convenience, with a target test so
                  // a click on the checkbox, its label, or ASSIGN GUARD does
                  // not also navigate.
                  <tr
                    key={s.id}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('input,button,a')) return;
                      router.push(`/admin/shifts/${s.id}`);
                    }}
                    className="border-b border-[#1A3050] last:border-b-0 hover:bg-[#0B1526] transition-colors cursor-pointer"
                  >
                    <td className="p-4 align-top">
                      <input
                        type="checkbox"
                        aria-label={`Select shift on ${fmtDateShort(s.scheduled_start)}`}
                        checked={selected.has(s.id)}
                        onChange={() => toggle(s.id)}
                        disabled={busy || !canSelect(s.id)}
                        className="accent-amber-400"
                      />
                    </td>
                    <td className="p-4 text-gray-300 text-xs font-mono whitespace-nowrap">
                      {/* The keyboard path. Was the row; is now this. */}
                      <Link
                        href={`/admin/shifts/${s.id}`}
                        className="hover:text-amber-400 focus:outline-none focus:ring-1 focus:ring-[#00C8FF]/50 rounded"
                      >
                        {fmtDateShort(s.scheduled_start)}
                      </Link>
                    </td>
                    <td className="p-4 text-gray-400 text-xs font-mono whitespace-nowrap">
                      {fmtTime(s.scheduled_start)} → {fmtTime(s.scheduled_end)}
                      <span className="text-gray-600 ml-2">({fmtDuration(s.scheduled_start, s.scheduled_end)})</span>
                    </td>
                    <td className="p-4">
                      {s.guard_name ? (
                        <span className="text-gray-200 text-sm">{s.guard_name}</span>
                      ) : (
                        <span className="text-amber-400 tracking-widest text-xs font-bold">— UNASSIGNED —</span>
                      )}
                    </td>
                    <td className="p-4 text-center">
                      <span className={`inline-block text-xs tracking-widest font-medium px-2 py-0.5 rounded ${STATUS_STYLES[s.status] ?? 'text-gray-500'}`}>
                        {s.status.toUpperCase()}
                      </span>
                      {s.inspection_incomplete && (
                        <span
                          title="Vehicle inspection incomplete"
                          className="inline-block ml-1.5 text-[9px] tracking-widest font-bold px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/40"
                        >
                          INSPECTION
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-right align-top">
                      {/* Why this row cannot take the active verb, or what the
                          server said when it refused. Same sentences as the
                          dialog's table, from lib/bulkShiftCopy — an admin
                          must not meet two wordings for one reason. */}
                      {!canSelect(s.id) && bulkPool.some((b) => b.id === s.id) && (
                        <span className="block text-gray-600 text-[11px] mb-1 text-left">
                          {blockedLabel(verb, s.status)}
                        </span>
                      )}
                      {canSelect(s.id) && !failures.get(s.id) && chosenBlocked.has(s.id) && (
                        <span className="block text-amber-400/80 text-[11px] mb-1 text-left">
                          {REASON_LABEL[chosenBlocked.get(s.id)!.reason] ?? 'Unavailable'}
                          {chosenBlocked.get(s.id)!.conflict && (
                            <> — {chosenBlocked.get(s.id)!.conflict!.site_name}</>
                          )}
                        </span>
                      )}
                      {failures.get(s.id) && (
                        <span className="block text-red-400 text-[11px] mb-1 text-left">
                          {failures.get(s.id)}
                        </span>
                      )}
                      {!s.guard_id && (
                        <button
                          // stopPropagation, or this also fires the row's
                          // navigate and the modal opens on a page the
                          // admin is already leaving.
                          onClick={(e) => { e.stopPropagation(); setAssignShift(s); }}
                          className="text-xs text-amber-400 tracking-widest hover:underline whitespace-nowrap"
                        >
                          ASSIGN GUARD
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
        )}
      </BulkShiftActions>

      {/* Shared modals — Schedule modal is pre-filled + limited to this site */}
      <ScheduleShiftModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onCreated={load}
        guards={guards}
        sites={site ? [{ id: site.id, name: site.name }] : []}
        prefilledSiteId={siteId}
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
