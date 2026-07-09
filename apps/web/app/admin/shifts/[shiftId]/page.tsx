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
import { adminGet, adminPatch } from '../../../../lib/adminApi';
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
  reassignment_history: ReassignmentRow[];
}

interface Guard {
  id:           string;
  name:         string;
  badge_number: string;
  is_active?:   boolean;
}

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

  const load = useCallback(async () => {
    if (!shiftId) return;
    setLoading(true);
    setLoadErr('');
    try {
      const [sh, gs] = await Promise.all([
        adminGet<ShiftDetail>(`/api/shifts/${shiftId}`),
        adminGet<Guard[]>('/api/guards'),
      ]);
      setShift(sh);
      setGuards(gs);
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

      {/* Reassignment history — always visible */}
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-2xl p-5">
        <h2 className="text-gray-500 text-xs tracking-widest mb-4">REASSIGNMENT HISTORY</h2>
        {shift.reassignment_history.length === 0 ? (
          <p className="text-gray-500 text-sm">No reassignments yet.</p>
        ) : (
          <ul className="space-y-3">
            {shift.reassignment_history.map((r) => (
              <li key={r.id} className="border-l-2 border-amber-400/40 pl-4 py-1">
                <p className="text-gray-300 text-sm">
                  <span className="font-mono text-xs text-gray-500">{fmtDTPacific(r.created_at)}</span>
                  {' — '}
                  <span className="text-gray-200">{reassignedByLabel(r)}</span>
                  {' reassigned from '}
                  <span className="text-amber-400">{r.old_guard_name ?? '(unassigned)'}</span>
                  {' → '}
                  <span className="text-amber-400">{r.new_guard_name ?? '(unknown)'}</span>
                </p>
                {r.reason && (
                  <p className="text-gray-500 text-xs mt-1 italic">&ldquo;{r.reason}&rdquo;</p>
                )}
              </li>
            ))}
          </ul>
        )}
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
    </div>
  );
}
