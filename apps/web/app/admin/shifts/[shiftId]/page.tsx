'use client';
/**
 * Admin — Shift Detail (/admin/shifts/<id>)
 *
 * Used by the missed-shift email's "Reassign Guard" link and by row clicks
 * in /admin/shifts. Shows the shift's site/guard/times, a Reassign Guard
 * action (disabled for past shifts), and an always-visible reassignment
 * history.
 *
 * Status colors / Pacific time format mirror the existing shifts list page
 * + the missed-shift email — kept in sync by hand for now.
 */
import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { adminGet, adminPatch, ApiError } from '../../../../lib/adminApi';
import { isoToZonedInputs, zonedInputsToISO } from '../../../../lib/shiftFormat';
import InactiveSiteBadge from '../../../../components/InactiveSiteBadge';

interface ReassignmentRow {
  id:                     string;
  created_at:             string;
  reason:                 string | null;
  reassigned_by_admin_id: string;
  reassigned_by_role:     'company_admin' | 'vishnu';
  reassigned_by_name:     string | null;
  old_guard_id:           string | null;
  old_guard_name:         string | null;
  new_guard_id:           string;
  new_guard_name:         string | null;
}

interface SwapHistoryRow {
  id:               string;
  requested_at:     string;
  accepted_at:      string | null;
  declined_at:      string | null;
  status:           'pending' | 'accepted' | 'declined' | 'expired';
  initiated_by:     'admin' | 'guard_pre_shift' | 'guard_handoff';
  reason:           string | null;
  from_guard_id:    string | null;
  from_guard_name:  string | null;
  to_guard_id:      string | null;
  to_guard_name:    string | null;
}

// schema_v58 — one admin edit to this shift's scheduled hours. `before` and
// `after` are NARROW jsonb snapshots holding only the mutable schedule
// columns, never a whole-row copy (see that migration's header).
interface ScheduleAuditRow {
  id:              string;
  changed_at:      string;
  changed_by:      string;
  changed_by_role: 'company_admin' | 'vishnu';
  changed_by_name: string | null;
  reason:          string | null;
  before:          { scheduled_start: string; scheduled_end: string };
  after:           { scheduled_start: string; scheduled_end: string };
}

// The `conflict` object on a 409 from PATCH /api/shifts/:id — the colliding
// shift, named well enough that the admin can go and deal with it.
interface EditConflict {
  shift_id:        string;
  guard_name:      string | null;
  site_name:       string;
  scheduled_start: string;
  scheduled_end:   string;
}

type HistoryEntry =
  | { source: 'admin_reassign'; ts: string; row: ReassignmentRow }
  | { source: 'guard_swap';     ts: string; row: SwapHistoryRow }
  | { source: 'schedule_edit';  ts: string; row: ScheduleAuditRow };

interface ShiftDetail {
  id:                   string;
  guard_id:             string | null;
  site_id:              string;
  scheduled_start:      string;
  scheduled_end:        string;
  status:               'unassigned' | 'scheduled' | 'active' | 'completed' | 'missed' | 'cancelled';
  missed_alert_sent_at: string | null;
  created_at:           string;
  site_name:            string;
  site_is_active?:      boolean;
  site_address:         string;
  company_id:           string;
  guard_name:           string | null;
  badge_number:         string | null;
  guard_phone:          string | null;
  site_tz:              string | null;
  reassignment_history: ReassignmentRow[];
  swap_history:         SwapHistoryRow[];
  // BOTH OPTIONAL — absent until the API deploys, same convention as
  // inspection_incomplete above. Web and API deploy independently (Vercel
  // on push, Railway on build), so there is always a window in which this
  // page runs against an API that predates these fields. Treating them as
  // required crashes the page in that window.
  schedule_audit?:      ScheduleAuditRow[];
  // True when ANY shift_sessions row exists on this shift. The edit gate
  // checks this directly rather than inferring it from status — see the
  // canEdit comment below.
  has_session?:         boolean;
}

interface Guard {
  id:           string;
  name:         string;
  badge_number: string;
  is_active?:   boolean;
}

// One shift_session row + its (possibly absent) vehicle inspection, from
// GET /api/inspections/shift/:shiftId. Photo URLs arrive PRESIGNED (15-min
// GET) — the API never returns raw S3 URLs on read paths.
interface InspectionSessionRow {
  session_id:               string;
  clocked_in_at:            string;
  clocked_out_at:           string | null;
  guard_name:               string | null;
  id:                       string | null;   // inspection id; null = not started
  vehicle_id:               string | null;
  odometer_reading:         number | null;
  completed_at:             string | null;
  photo_front_url:          string | null;
  photo_rear_url:           string | null;
  photo_driver_side_url:    string | null;
  photo_passenger_side_url: string | null;
  photo_odometer_url:       string | null;
  vehicle_label:            string | null;
  vehicle_plate:            string | null;
  vehicle_make_model:       string | null;
  odometer_unit:            'mi' | 'km' | null;
}

interface InspectionsResponse {
  vehicle_inspection_required: boolean;
  sessions: InspectionSessionRow[];
}

const PHOTO_SLOT_LABELS: Array<{ key: keyof InspectionSessionRow; label: string }> = [
  { key: 'photo_front_url',          label: 'FRONT' },
  { key: 'photo_rear_url',           label: 'REAR' },
  { key: 'photo_driver_side_url',    label: 'DRIVER SIDE' },
  { key: 'photo_passenger_side_url', label: 'PASSENGER SIDE' },
  { key: 'photo_odometer_url',       label: 'ODOMETER' },
];

const STATUS_STYLES: Record<string, string> = {
  unassigned: 'bg-amber-400/20 text-amber-400 border border-amber-400/40',
  scheduled:  'bg-blue-500/20 text-blue-400 border border-blue-500/40',
  active:     'bg-green-500/20 text-green-400 border border-green-500/40',
  completed:  'bg-gray-700/40 text-gray-500 border border-gray-600/40',
  cancelled:  'bg-gray-700/40 text-gray-400 border border-gray-600/50',
  missed:     'bg-red-900/30 text-red-400 border border-red-700/40',
};

function fmtDTPacific(dt: string | Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  }).formatToParts(new Date(dt));
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
  return `${pick('day')} ${pick('month')} ${pick('year')}, ` +
         `${pick('hour')}:${pick('minute')} ${pick('dayPeriod')} ${pick('timeZoneName')}`;
}

export default function ShiftDetailPage() {
  const params   = useParams();
  const router   = useRouter();
  const shiftId  = String(params?.shiftId ?? '');

  const [shift,   setShift]   = useState<ShiftDetail | null>(null);
  const [guards,  setGuards]  = useState<Guard[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  // null = endpoint unavailable / fetch failed → section hidden entirely.
  const [inspections, setInspections] = useState<InspectionsResponse | null>(null);

  // Reassign modal
  const [showModal,   setShowModal]   = useState(false);
  const [pickGuardId, setPickGuardId] = useState('');
  const [reason,      setReason]      = useState('');
  const [submitting,  setSubmitting]  = useState(false);
  const [submitErr,   setSubmitErr]   = useState('');

  // Cancel modal (separate state so opening one doesn't disturb the other)
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason,    setCancelReason]    = useState('');
  const [cancelling,      setCancelling]      = useState(false);
  const [cancelErr,       setCancelErr]       = useState('');
  const [cancelToast,     setCancelToast]     = useState('');

  const [showEditModal,   setShowEditModal]   = useState(false);
  const [editStartDate,   setEditStartDate]   = useState('');
  const [editStartTime,   setEditStartTime]   = useState('');
  const [editEndDate,     setEditEndDate]     = useState('');
  const [editEndTime,     setEditEndTime]     = useState('');
  const [editReason,      setEditReason]      = useState('');
  const [editSubmitting,  setEditSubmitting]  = useState(false);
  const [editErr,         setEditErr]         = useState('');
  const [editToast,       setEditToast]       = useState('');
  const [editConflict,    setEditConflict]    = useState<EditConflict | null>(null);

  const load = useCallback(async () => {
    if (!shiftId) return;
    setLoading(true);
    setLoadErr('');
    try {
      const [sh, gs, insp] = await Promise.all([
        adminGet<ShiftDetail>(`/api/shifts/${shiftId}`),
        adminGet<Guard[]>('/api/guards'),
        adminGet<InspectionsResponse>(`/api/inspections/shift/${shiftId}`).catch(() => null),
      ]);
      setShift(sh);
      setGuards(gs);
      setInspections(insp);
    } catch (e: any) {
      setLoadErr(e?.message ?? 'Failed to load shift');
    } finally {
      setLoading(false);
    }
  }, [shiftId]);

  useEffect(() => { load(); }, [load]);

  const canReassign = !!shift && shift.status !== 'completed' && shift.status !== 'missed';
  const disabledReason = !shift
    ? ''
    : shift.status === 'completed' || shift.status === 'missed'
      ? 'Past shifts cannot be reassigned.'
      : '';

  // Cancel is only available for still-scheduled shifts. Active/completed/
  // missed/already-cancelled all reject at the API layer with a specific
  // 409, but hiding the button up front avoids the round-trip.
  const canCancel = !!shift && shift.status === 'scheduled';

  // Edit mirrors PATCH /api/shifts/:id EXACTLY: status IN
  // ('scheduled','unassigned') AND zero sessions. Both halves are checked
  // here for the same reason the API checks both — status is a proxy for
  // "nobody has clocked in", and two routes are known to desynchronise it.
  // An admin must never be offered an action the API will refuse, so if
  // these two conditions ever drift apart the button disappears rather than
  // 409ing after the click.
  //
  // 'unassigned' is included on purpose: a shift with no guard has nobody
  // to disrupt and is the safest edit there is.
  const canEdit =
    !!shift &&
    (shift.status === 'scheduled' || shift.status === 'unassigned') &&
    // === false, not !has_session. On an API that predates the field it is
    // undefined, and `!undefined` would SHOW the button against an API with
    // no PATCH /api/shifts/:id to serve it. Fail closed: no explicit false,
    // no button.
    shift.has_session === false;

  const pickableGuards = guards
    .filter((g) => g.is_active !== false)
    .filter((g) => g.id !== shift?.guard_id);

  function openModal() {
    setPickGuardId('');
    setReason('');
    setSubmitErr('');
    setShowModal(true);
  }

  function openCancelModal() {
    setCancelReason('');
    setCancelErr('');
    setShowCancelModal(true);
  }

  // Prefill the form with the shift's CURRENT hours, rendered as a wall
  // clock at the SITE — the same clock the panel above the button shows.
  // Deriving these from the browser's zone would disagree with the display
  // for any admin outside Pacific.
  function openEditModal() {
    if (!shift) return;
    const tz = shift.site_tz ?? 'America/Los_Angeles';
    const s  = isoToZonedInputs(shift.scheduled_start, tz);
    const e  = isoToZonedInputs(shift.scheduled_end,   tz);
    setEditStartDate(s.date); setEditStartTime(s.time);
    setEditEndDate(e.date);   setEditEndTime(e.time);
    setEditReason('');
    setEditErr('');
    setEditConflict(null);
    setShowEditModal(true);
  }

  async function submitEdit() {
    if (!shift) return;
    const tz = shift.site_tz ?? 'America/Los_Angeles';
    const startISO = zonedInputsToISO(editStartDate, editStartTime, tz);
    const endISO   = zonedInputsToISO(editEndDate,   editEndTime,   tz);
    if (!startISO || !endISO) {
      setEditErr('Enter a valid date and time for both start and end.');
      return;
    }
    if (new Date(endISO) <= new Date(startISO)) {
      setEditErr('End must be after start.');
      return;
    }
    if (editReason.length > 500) {
      setEditErr('Reason must be 500 characters or fewer.');
      return;
    }
    setEditSubmitting(true);
    setEditErr('');
    setEditConflict(null);
    try {
      const body: { scheduled_start: string; scheduled_end: string; reason?: string } = {
        scheduled_start: startISO,
        scheduled_end:   endISO,
      };
      if (editReason.trim().length > 0) body.reason = editReason.trim();
      await adminPatch(`/api/shifts/${shift.id}`, body);
      setShowEditModal(false);
      setEditToast('Schedule updated');
      window.setTimeout(() => setEditToast(''), 3000);
      await load();
    } catch (e: any) {
      setEditErr(String(e?.message ?? 'Edit failed. Please try again.'));
      // The 409 from an overlap carries a `conflict` object naming the
      // colliding shift. ApiError preserves the whole body so we can render
      // a link to it — "these hours overlap something" with no way to reach
      // that something is not an actionable error.
      const conflict = (e as ApiError)?.body?.conflict as EditConflict | undefined;
      if (conflict?.shift_id) setEditConflict(conflict);
    } finally {
      setEditSubmitting(false);
    }
  }

  async function submitCancel() {
    if (!shift) return;
    if (cancelReason.length > 200) {
      setCancelErr('Reason must be 200 characters or fewer.');
      return;
    }
    setCancelling(true);
    setCancelErr('');
    try {
      const body: { reason?: string } = {};
      if (cancelReason.trim().length > 0) body.reason = cancelReason.trim();
      await adminPatch(`/api/shifts/${shift.id}/cancel`, body);
      setShowCancelModal(false);
      setCancelToast('Shift cancelled');
      window.setTimeout(() => setCancelToast(''), 3000);
      await load();
    } catch (e: any) {
      setCancelErr(String(e?.message ?? 'Cancel failed. Please try again.'));
    } finally {
      setCancelling(false);
    }
  }

  async function submitReassign() {
    if (!shift) return;
    if (!pickGuardId) { setSubmitErr('Select a guard.'); return; }
    if (reason.length > 500) { setSubmitErr('Reason must be 500 characters or fewer.'); return; }
    setSubmitting(true);
    setSubmitErr('');
    try {
      const body: { new_guard_id: string; reason?: string } = { new_guard_id: pickGuardId };
      if (reason.trim().length > 0) body.reason = reason.trim();
      await adminPatch(`/api/shifts/${shift.id}/reassign`, body);
      setShowModal(false);
      await load();
    } catch (e: any) {
      const msg = String(e?.message ?? '');
      // Map server error codes to operator-friendly messages.
      if (msg.includes('overlapping shift')) {
        setSubmitErr('Selected guard has an overlapping shift in the same time window.');
      } else if (msg.includes('cannot be reassigned')) {
        setSubmitErr('This shift cannot be reassigned — it has already completed or was marked missed.');
      } else {
        setSubmitErr(msg || 'Reassignment failed. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-gray-500 text-sm">Loading shift…</div>
      </div>
    );
  }
  if (loadErr || !shift) {
    return (
      <div className="p-6 space-y-4">
        <Link href="/admin/shifts" className="text-sm text-amber-400 hover:text-amber-300">← Back to shifts</Link>
        <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3">
          {loadErr || 'Shift not found.'}
        </div>
      </div>
    );
  }

  const reassignedByLabel = (row: ReassignmentRow) =>
    row.reassigned_by_role === 'vishnu'
      ? 'NetraOps support'
      : (row.reassigned_by_name ?? 'Admin');

  // Same fallback chain as reassignedByLabel: a 'vishnu' actor has no
  // company_admins row, so changed_by_name comes back null and the role is
  // the only identity we can show.
  const scheduleChangedByLabel = (row: ScheduleAuditRow) =>
    row.changed_by_role === 'vishnu'
      ? 'NetraOps support'
      : (row.changed_by_name ?? 'Admin');

  function SwapStatusPill({ status }: { status: SwapHistoryRow['status'] }) {
    const styles: Record<SwapHistoryRow['status'], string> = {
      pending:  'bg-amber-400/10 text-amber-400 border-amber-400/40',
      accepted: 'bg-green-500/10 text-green-400 border-green-500/40',
      declined: 'bg-red-500/10   text-red-400   border-red-500/40',
      expired:  'bg-gray-700/40  text-gray-400  border-gray-600/50',
    };
    return (
      <span className={`inline-block text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded border ${styles[status]}`}>
        {status.toUpperCase()}
      </span>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-4xl">

      {/* Back link */}
      <Link href="/admin/shifts" className="text-sm text-amber-400 hover:text-amber-300">← Back to shifts</Link>

      {/* Header — site + status pill */}
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-widest text-amber-400">
            {shift.site_name.toUpperCase()}
            <InactiveSiteBadge siteIsActive={shift.site_is_active} />
          </h1>
          <p className="text-gray-500 text-sm mt-1">{shift.site_address}</p>
        </div>
        <span className={`inline-block text-xs tracking-widest font-medium px-3 py-1 rounded ${STATUS_STYLES[shift.status] ?? 'text-gray-500'}`}>
          {shift.status.toUpperCase()}
        </span>
      </div>

      {/* Shift card */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-5">
        <h2 className="text-gray-500 text-xs tracking-widest mb-4">SHIFT</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-gray-500 text-xs tracking-widest mb-1">SCHEDULED START</p>
            <p className="text-gray-200 font-mono text-xs">{fmtDTPacific(shift.scheduled_start)}</p>
          </div>
          <div>
            <p className="text-gray-500 text-xs tracking-widest mb-1">SCHEDULED END</p>
            <p className="text-gray-200 font-mono text-xs">{fmtDTPacific(shift.scheduled_end)}</p>
          </div>
        </div>
      </div>

      {/* Guard card */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-5">
        <h2 className="text-gray-500 text-xs tracking-widest mb-4">ASSIGNED GUARD</h2>
        {shift.guard_id && shift.guard_name ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div>
              <p className="text-gray-500 text-xs tracking-widest mb-1">NAME</p>
              <p className="text-gray-200">{shift.guard_name}</p>
            </div>
            <div>
              <p className="text-gray-500 text-xs tracking-widest mb-1">BADGE</p>
              <p className="text-gray-200 font-mono text-xs">{shift.badge_number ?? '—'}</p>
            </div>
            {shift.guard_phone && (
              <div className="md:col-span-2">
                <p className="text-gray-500 text-xs tracking-widest mb-1">PHONE</p>
                <a href={`tel:${shift.guard_phone}`} className="text-amber-400 hover:text-amber-300 font-mono text-xs">
                  {shift.guard_phone}
                </a>
              </div>
            )}
          </div>
        ) : (
          <p className="text-gray-500 text-sm">No guard assigned.</p>
        )}
      </div>

      {/* Vehicle inspection (schema_v48) — one per session; handoff shifts
          show several. Rendered only when the site requires inspection or
          an inspection actually exists. Admin-only page; photos are
          15-minute presigned GETs. */}
      {inspections && (inspections.vehicle_inspection_required || inspections.sessions.some((s) => s.id)) && (
        <div className="bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-5">
          <h2 className="text-gray-500 text-xs tracking-widest mb-4">VEHICLE INSPECTION</h2>
          {inspections.sessions.length === 0 ? (
            <p className="text-gray-500 text-sm">No clock-in yet — inspection starts after the guard clocks in.</p>
          ) : (
            <div className="space-y-5">
              {inspections.sessions.map((s) => (
                <div key={s.session_id} className="border border-[#1A3050] rounded-lg p-4">
                  <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                    <div className="min-w-0">
                      <p className="text-gray-200 text-sm">{s.guard_name ?? 'Unknown guard'}</p>
                      <p className="text-gray-500 text-xs font-mono mt-0.5">
                        Session {fmtDTPacific(s.clocked_in_at)}
                      </p>
                    </div>
                    <span
                      className={`inline-block text-xs tracking-widest font-medium px-2 py-0.5 rounded border ${
                        s.completed_at
                          ? 'bg-green-500/20 text-green-400 border-green-500/40'
                          : s.id
                            ? 'bg-amber-400/20 text-amber-400 border-amber-400/40'
                            : 'bg-gray-700/40 text-gray-400 border-gray-600/40'
                      }`}
                    >
                      {s.completed_at ? 'COMPLETE' : s.id ? 'INCOMPLETE' : 'NOT STARTED'}
                    </span>
                  </div>

                  {s.id ? (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm mb-4">
                        <div>
                          <p className="text-gray-500 text-xs tracking-widest mb-1">VEHICLE</p>
                          <p className="text-gray-200 text-xs">
                            {s.vehicle_label}
                            {s.vehicle_plate ? <span className="text-gray-500 font-mono"> · {s.vehicle_plate}</span> : null}
                          </p>
                          {s.vehicle_make_model && <p className="text-gray-500 text-xs mt-0.5">{s.vehicle_make_model}</p>}
                        </div>
                        <div>
                          <p className="text-gray-500 text-xs tracking-widest mb-1">ODOMETER</p>
                          <p className="text-gray-200 font-mono text-xs">
                            {s.odometer_reading !== null
                              ? `${s.odometer_reading.toLocaleString()} ${s.odometer_unit ?? 'mi'}`
                              : '—'}
                          </p>
                        </div>
                        {s.completed_at && (
                          <div>
                            <p className="text-gray-500 text-xs tracking-widest mb-1">COMPLETED</p>
                            <p className="text-gray-200 font-mono text-xs">{fmtDTPacific(s.completed_at)}</p>
                          </div>
                        )}
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
                        {PHOTO_SLOT_LABELS.map(({ key, label }) => {
                          const url = s[key] as string | null;
                          return (
                            <div key={label}>
                              <p className="text-gray-500 text-[10px] tracking-widest mb-1">{label}</p>
                              {url ? (
                                <a href={url} target="_blank" rel="noreferrer" className="block">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img
                                    src={url}
                                    alt={`${label} inspection photo`}
                                    className="w-full h-24 object-cover rounded border border-[#1A3050] hover:border-amber-400/60 transition-colors"
                                  />
                                </a>
                              ) : (
                                <div className="w-full h-24 rounded border border-dashed border-[#1A3050] flex items-center justify-center">
                                  <span className="text-gray-600 text-[10px] tracking-widest">MISSING</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <p className="text-gray-500 text-sm">Guard has not started the inspection.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Reassign + cancel actions */}
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={openModal}
          disabled={!canReassign}
          title={disabledReason || undefined}
          className={`px-4 py-2 rounded-lg text-sm font-bold tracking-widest transition-colors ${
            canReassign
              ? 'bg-amber-400 text-[#0B1526] hover:bg-amber-300'
              : 'bg-gray-700 text-gray-500 cursor-not-allowed'
          }`}
        >
          REASSIGN GUARD
        </button>
        {/* Rendered ONLY when PATCH /api/shifts/:id would accept — never
            disabled-but-visible, because a greyed-out button invites a
            support question and this gate is not something an admin can
            act on (they cannot un-clock-in a guard). */}
        {canEdit && (
          <button
            onClick={openEditModal}
            className="px-4 py-2 rounded-lg text-sm font-bold tracking-widest transition-colors border border-[#00C8FF] text-[#00C8FF] hover:bg-[#00C8FF]/10 hover:text-cyan-200"
          >
            EDIT SCHEDULE
          </button>
        )}
        {canCancel && (
          <button
            onClick={openCancelModal}
            className="px-4 py-2 rounded-lg text-sm font-bold tracking-widest transition-colors border border-red-500 text-red-400 hover:bg-red-500/10 hover:text-red-300"
          >
            CANCEL SHIFT
          </button>
        )}
        {!canReassign && disabledReason && (
          <span className="text-gray-500 text-xs">{disabledReason}</span>
        )}
      </div>

      {/* Cancel-success toast — auto-dismisses after 3s */}
      {cancelToast && (
        <div className="fixed bottom-6 right-6 z-40 bg-[#0F1E35] border border-red-500/40 text-red-300 rounded-lg px-4 py-3 shadow-lg">
          {cancelToast}
        </div>
      )}

      {/* Edit-success toast — cyan to match the action, red is destructive */}
      {editToast && (
        <div className="fixed bottom-6 right-6 z-40 bg-[#0F1E35] border border-[#00C8FF]/40 text-cyan-200 rounded-lg px-4 py-3 shadow-lg">
          {editToast}
        </div>
      )}

      {/* Combined history — admin reassigns + guard-to-guard swaps.
          Guard swaps carry a status pill (pending/accepted/declined/
          expired); admin reassigns are always accepted (they represent a
          committed action). Sort desc by timestamp so most recent first. */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-5">
        <h2 className="text-gray-500 text-xs tracking-widest mb-4">SHIFT HISTORY</h2>
        {(() => {
          const combined: HistoryEntry[] = [
            ...shift.reassignment_history.map((r): HistoryEntry => ({ source: 'admin_reassign', ts: r.created_at,   row: r })),
            ...shift.swap_history        .map((r): HistoryEntry => ({ source: 'guard_swap',     ts: r.requested_at, row: r })),
            // schema_v58 — schedule edits belong in the SAME feed as
            // reassigns and swaps: they are all "something changed about
            // this shift", and an admin reconstructing what happened should
            // read one chronological list, not three panels.
            // ?? [] — an API predating schema_v58 omits this entirely, and
            // .map on undefined throws, taking the whole page down rather
            // than just hiding the new entries.
            ...(shift.schedule_audit ?? []).map((r): HistoryEntry => ({ source: 'schedule_edit', ts: r.changed_at, row: r })),
          ].sort((a, b) => (a.ts < b.ts ? 1 : -1));
          if (combined.length === 0) {
            return <p className="text-gray-500 text-sm">No history yet.</p>;
          }
          return (
            <ul className="space-y-3">
              {combined.map((entry) => (
                <li
                  key={`${entry.source}-${entry.row.id}`}
                  className={`border-l-2 pl-4 py-1 ${
                    entry.source === 'admin_reassign' ? 'border-amber-400/40'
                    : entry.source === 'schedule_edit' ? 'border-emerald-400/40'
                    : 'border-cyan-400/40'
                  }`}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-xs text-gray-500">{fmtDTPacific(entry.ts)}</span>
                    <span
                      className={`inline-block text-[9px] font-bold tracking-widest px-1.5 py-0.5 rounded border ${
                        entry.source === 'admin_reassign'
                          ? 'bg-amber-400/10 text-amber-400 border-amber-400/40'
                          : entry.source === 'schedule_edit'
                            ? 'bg-emerald-400/10 text-emerald-300 border-emerald-400/40'
                            : 'bg-cyan-400/10 text-cyan-400 border-cyan-400/40'
                      }`}
                    >
                      {entry.source === 'admin_reassign' ? 'ADMIN REASSIGN'
                        : entry.source === 'schedule_edit' ? 'SCHEDULE EDIT'
                        : 'GUARD SWAP'}
                    </span>
                    {entry.source === 'guard_swap' && <SwapStatusPill status={entry.row.status} />}
                  </div>

                  {entry.source === 'admin_reassign' ? (
                    <p className="text-gray-300 text-sm mt-1">
                      <span className="text-gray-200">{reassignedByLabel(entry.row)}</span>
                      {' reassigned from '}
                      <span className="text-amber-400">{entry.row.old_guard_name ?? '(unassigned)'}</span>
                      {' → '}
                      <span className="text-amber-400">{entry.row.new_guard_name ?? '(unknown)'}</span>
                    </p>
                  ) : entry.source === 'schedule_edit' ? (
                    // before → after, both rendered in the same Pacific
                    // format as the SCHEDULED START / END panel above, so
                    // the reader can compare them without converting
                    // anything in their head.
                    <div className="text-sm mt-1">
                      <p className="text-gray-300">
                        <span className="text-gray-200">{scheduleChangedByLabel(entry.row)}</span>
                        {' changed the scheduled hours'}
                      </p>
                      <p className="text-gray-500 font-mono text-xs mt-1 line-through decoration-gray-600">
                        {fmtDTPacific(entry.row.before.scheduled_start)} → {fmtDTPacific(entry.row.before.scheduled_end)}
                      </p>
                      <p className="text-emerald-300 font-mono text-xs">
                        {fmtDTPacific(entry.row.after.scheduled_start)} → {fmtDTPacific(entry.row.after.scheduled_end)}
                      </p>
                    </div>
                  ) : (
                    <p className="text-gray-300 text-sm mt-1">
                      <span className="text-cyan-400">{entry.row.from_guard_name ?? '(unknown)'}</span>
                      {' requested swap to '}
                      <span className="text-cyan-400">{entry.row.to_guard_name ?? '(unknown)'}</span>
                    </p>
                  )}

                  {entry.row.reason && (
                    <p className="text-gray-500 text-xs mt-1 italic">&ldquo;{entry.row.reason}&rdquo;</p>
                  )}
                </li>
              ))}
            </ul>
          );
        })()}
      </div>

      {/* Reassign modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={() => !submitting && setShowModal(false)}>
          <div className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-amber-400 font-bold tracking-widest text-lg">REASSIGN GUARD</h2>
              <button onClick={() => !submitting && setShowModal(false)} className="text-gray-500 hover:text-gray-300 text-xl" disabled={submitting}>✕</button>
            </div>

            {submitErr && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">
                {submitErr}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">NEW GUARD <span className="text-amber-400">*</span></label>
                <select
                  value={pickGuardId}
                  onChange={(e) => setPickGuardId(e.target.value)}
                  disabled={submitting}
                  className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 disabled:opacity-50"
                >
                  <option value="">Select guard…</option>
                  {pickableGuards.map((g) => (
                    <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>
                  ))}
                </select>
                {pickableGuards.length === 0 && (
                  <p className="text-gray-500 text-xs mt-1">No other active guards available.</p>
                )}
              </div>

              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">REASON <span className="text-gray-600 text-xs normal-case">(optional, max 500 chars)</span></label>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  disabled={submitting}
                  maxLength={500}
                  rows={3}
                  className="w-full bg-[#070F1E] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 disabled:opacity-50 resize-none"
                  placeholder="e.g., Guard called in sick."
                />
                <p className="text-right text-gray-600 text-xs mt-1">{reason.length} / 500</p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => !submitting && setShowModal(false)}
                  disabled={submitting}
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-bold tracking-widest bg-[#0B1526] border border-[#1A3050] text-gray-300 hover:text-gray-200 disabled:opacity-50"
                >
                  CANCEL
                </button>
                <button
                  onClick={submitReassign}
                  disabled={submitting || !pickGuardId}
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-bold tracking-widest bg-amber-400 text-[#0B1526] hover:bg-amber-300 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? 'REASSIGNING…' : 'CONFIRM'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cancel confirmation modal */}
      {showCancelModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => !cancelling && setShowCancelModal(false)}
        >
          <div
            className="w-full max-w-md bg-[#0F1E35] border border-red-500/40 rounded-2xl p-6 mx-4 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-red-400 font-bold tracking-widest text-lg">CANCEL THIS SHIFT?</h2>
              <button
                onClick={() => !cancelling && setShowCancelModal(false)}
                className="text-gray-500 hover:text-gray-300 text-xl"
                disabled={cancelling}
              >
                ✕
              </button>
            </div>

            <p className="text-gray-300 text-sm mb-4 leading-relaxed">
              {shift.guard_id && shift.guard_name
                ? <>This will cancel <strong>{shift.guard_name}</strong>&apos;s shift at <strong>{shift.site_name}</strong> on {fmtDTPacific(shift.scheduled_start)}. The guard will be notified.</>
                : <>This will cancel the unassigned shift at <strong>{shift.site_name}</strong> on {fmtDTPacific(shift.scheduled_start)}.</>}
              {' '}
              <span className="text-red-400">This action cannot be undone.</span>
            </p>

            {cancelErr && (
              <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-2 mb-4">
                {cancelErr}
              </div>
            )}

            <div className="mb-4">
              <label className="block text-gray-500 text-xs tracking-widest mb-1">
                REASON <span className="text-gray-600 normal-case">(optional, max 200)</span>
              </label>
              <textarea
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value.slice(0, 200))}
                rows={2}
                disabled={cancelling}
                className="w-full bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-red-500 disabled:opacity-50 resize-none"
                placeholder="e.g. scheduled to wrong site"
              />
              <p className="text-gray-600 text-xs mt-1 text-right">{cancelReason.length}/200</p>
            </div>

            <div className="flex gap-3 pt-2">
              <button
                onClick={() => !cancelling && setShowCancelModal(false)}
                disabled={cancelling}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-bold tracking-widest bg-[#0B1526] border border-[#1A3050] text-gray-300 hover:text-gray-200 disabled:opacity-50"
              >
                KEEP SHIFT
              </button>
              <button
                onClick={submitCancel}
                disabled={cancelling}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-bold tracking-widest bg-red-500 text-white hover:bg-red-400 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {cancelling ? 'CANCELLING…' : 'CANCEL SHIFT'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit-schedule modal */}
      {showEditModal && shift && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => !editSubmitting && setShowEditModal(false)}
        >
          <div
            className="w-full max-w-md bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-6 mx-4 max-h-[90vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[#00C8FF] font-bold tracking-widest text-lg">EDIT SCHEDULE</h2>
              <button
                onClick={() => !editSubmitting && setShowEditModal(false)}
                className="text-gray-500 hover:text-gray-300 text-xl"
                disabled={editSubmitting}
              >
                ✕
              </button>
            </div>

            <p className="text-gray-500 text-xs mb-4">
              Times are local to {shift.site_name}
              {shift.site_tz ? ` (${shift.site_tz.split('/')[1]?.replace('_', ' ')})` : ''}.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">START</label>
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={editStartDate}
                    onChange={(e) => setEditStartDate(e.target.value)}
                    disabled={editSubmitting}
                    className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-[#00C8FF] disabled:opacity-50"
                  />
                  <input
                    type="time"
                    value={editStartTime}
                    onChange={(e) => setEditStartTime(e.target.value)}
                    disabled={editSubmitting}
                    className="w-32 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-[#00C8FF] disabled:opacity-50"
                  />
                </div>
              </div>

              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">END</label>
                <div className="flex gap-2">
                  <input
                    type="date"
                    value={editEndDate}
                    onChange={(e) => setEditEndDate(e.target.value)}
                    disabled={editSubmitting}
                    className="flex-1 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-[#00C8FF] disabled:opacity-50"
                  />
                  <input
                    type="time"
                    value={editEndTime}
                    onChange={(e) => setEditEndTime(e.target.value)}
                    disabled={editSubmitting}
                    className="w-32 bg-[#0B1526] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-[#00C8FF] disabled:opacity-50"
                  />
                </div>
                {/* Overnight shifts are normal here — Cristo Rey runs
                    19:00→06:00 — so an end DATE after the start date is
                    expected, not an error. */}
              </div>

              <div>
                <label className="block text-gray-500 text-xs tracking-widest mb-1">
                  REASON <span className="text-gray-600">(optional, shown in history)</span>
                </label>
                <textarea
                  value={editReason}
                  onChange={(e) => setEditReason(e.target.value)}
                  disabled={editSubmitting}
                  rows={3}
                  maxLength={500}
                  placeholder="e.g. Client moved the coverage window"
                  className="w-full bg-[#070F1E] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-[#00C8FF] disabled:opacity-50 resize-none"
                />
              </div>
            </div>

            {editErr && (
              <div className="mt-4 bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-3 py-2">
                {editErr}
              </div>
            )}

            {/* Overlap 409 — the colliding shift, with a link to it. That
                page carries REASSIGN and CANCEL, so the admin lands
                somewhere they can actually resolve the collision. */}
            {editConflict && (
              <div className="mt-3 bg-[#0B1526] border border-amber-400/40 rounded-lg px-3 py-3">
                <p className="text-amber-400 text-[10px] tracking-widest font-bold mb-1">CONFLICTING SHIFT</p>
                <p className="text-gray-300 text-sm">
                  {editConflict.guard_name ?? 'Unassigned'} · {editConflict.site_name}
                </p>
                <p className="text-gray-500 font-mono text-xs mt-1">
                  {fmtDTPacific(editConflict.scheduled_start)} → {fmtDTPacific(editConflict.scheduled_end)}
                </p>
                <Link
                  href={`/admin/shifts/${editConflict.shift_id}`}
                  className="inline-block mt-2 text-[#00C8FF] hover:text-cyan-200 text-xs tracking-widest hover:underline"
                >
                  OPEN THAT SHIFT →
                </Link>
              </div>
            )}

            <div className="flex gap-3 mt-5">
              <button
                onClick={() => !editSubmitting && setShowEditModal(false)}
                disabled={editSubmitting}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-bold tracking-widest bg-[#0B1526] border border-[#1A3050] text-gray-300 hover:text-gray-200 disabled:opacity-50"
              >
                CANCEL
              </button>
              <button
                onClick={submitEdit}
                disabled={editSubmitting || !editStartDate || !editStartTime || !editEndDate || !editEndTime}
                className="flex-1 px-4 py-2 rounded-lg text-sm font-bold tracking-widest bg-[#00C8FF] text-[#0B1526] hover:bg-cyan-300 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {editSubmitting ? 'SAVING…' : 'SAVE CHANGES'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
