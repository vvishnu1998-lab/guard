'use client';
/**
 * Guard deactivation dialog.
 *
 * Replaces a one-line window.confirm that said "Deactivate this guard? They
 * will no longer be able to log in." and nothing else. It was true and it was
 * useless: a guard at 375 Shopping Complex was disabled holding 17 future
 * shifts, 16 were cancelled by hand, and the 17th is still in the table.
 *
 * ── The whole point: reassign and unassign are DIFFERENT OUTCOMES ───────
 *
 * Two buttons side by side read as two ways of doing the same thing. They are
 * not, so the dialog states what each one leaves behind before the admin
 * picks — the coverage requirement is the half that differs and the half
 * nobody thinks about:
 *
 *   REASSIGN  the shift moves to another guard. The post stays covered.
 *   UNASSIGN  the shift STAYS, with nobody on it. It becomes a visible gap
 *             on the schedule and in the unassigned banner, and somebody has
 *             to fill it. It is not a cancellation — cancelling would remove
 *             the requirement, and nobody decided the post was unnecessary.
 *
 * ── Broader list than the write touches, deliberately ───────────────────
 *
 * GET /deactivation-impact lists status <> 'cancelled'. PATCH /deactivate
 * only moves status IN ('scheduled','active'). They are the same set today,
 * and diverge the first time a guard clocks out early — leaving a 'completed'
 * row whose scheduled_end is still ahead. Such a row is LISTED, greyed, and
 * labelled not actionable, rather than omitted: the admin should see the
 * whole picture and understand which part the override moves.
 *
 * ── Stale API ───────────────────────────────────────────────────────────
 *
 * Vercel and Railway never deploy together. If this page lands before the
 * API, GET /deactivation-impact 404s and the load below throws. The dialog
 * then shows the error and offers only CANCEL — it fails CLOSED. Deactivating
 * anyway from a dialog that could not read the impact would be the old bug
 * with extra steps.
 */
import { useCallback, useEffect, useState } from 'react';
import { adminGet, adminPatch } from '../../lib/adminApi';
import { fmtDateShort } from '../../lib/shiftFormat';
import ShiftBulkReassign, { ReassignableShift, isAssignable } from './ShiftBulkReassign';

interface ImpactShift {
  id:              string;
  scheduled_start: string;
  scheduled_end:   string;
  status:          string;
}

interface ImpactSite {
  site_id:          string;
  site_name:        string;
  site_is_active:   boolean;
  site_timezone:    string;
  shift_count:      number;
  first_start:      string;
  last_start:       string;
  shifts:           ImpactShift[];
  shifts_truncated: boolean;
}

interface Impact {
  guard:  { id: string; name: string; badge_number: string; is_active: boolean };
  blocked: boolean;
  open_session_conflict: {
    message: string;
    open_session: { site_name: string; clocked_in_at: string } | null;
  } | null;
  future_shift_count: number;
  site_count:         number;
  sites:              ImpactSite[];
}

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean }

interface Props {
  /** null → closed. Identified by uuid; badge_number is display only. */
  guard:   { id: string; name: string } | null;
  guards:  Guard[];
  onClose: () => void;
  /** Deactivation committed — caller refetches. */
  onDone:  () => void;
}

export default function GuardDeactivateDialog({ guard, guards, onClose, onDone }: Props) {
  const [impact,  setImpact]  = useState<Impact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');
  const [mode,    setMode]    = useState<'review' | 'reassign' | 'confirm-unassign'>('review');
  const [busy,    setBusy]    = useState(false);

  const guardId = guard?.id ?? '';

  const load = useCallback(async () => {
    if (!guardId) return;
    setLoading(true);
    try {
      const d = await adminGet<Impact>(`/api/guards/${guardId}/deactivation-impact`);
      setImpact(d);
      setError('');
    } catch (e: any) {
      setImpact(null);
      setError(e?.message ?? 'Could not read this guard’s upcoming shifts.');
    } finally { setLoading(false); }
  }, [guardId]);

  useEffect(() => {
    if (!guardId) return;
    setMode('review'); setBusy(false); setError('');
    load();
  }, [guardId, load]);

  if (!guard) return null;

  // `?? []` throughout: an older API that answers this path with a partial
  // body must misrender, never crash the page.
  const sites = impact?.sites ?? [];
  const futureCount = impact?.future_shift_count ?? 0;

  const flatShifts: ReassignableShift[] = sites.flatMap((s) =>
    (s.shifts ?? []).map((sh) => ({
      id:              sh.id,
      site_id:         s.site_id,
      site_name:       s.site_name,
      scheduled_start: sh.scheduled_start,
      scheduled_end:   sh.scheduled_end,
      status:          sh.status,
    })));

  // isAssignable now admits 'unassigned' (the bulk surface gained an ASSIGN
  // verb that fills empty posts as well as moving filled ones). THAT WIDENING
  // IS DELIBERATELY INERT HERE and this count cannot change: flatShifts comes
  // from GET /guards/:id/deactivation-impact, whose predicate is
  // `s.guard_id = $1 AND s.scheduled_end > NOW() AND s.status <> 'cancelled'`
  // — guard-scoped, so guard_id is never null, so no row reaching this dialog
  // can be 'unassigned'.
  //
  // Inert TODAY. Nothing enforces that status and guard_id agree (see
  // routes/shifts.ts on the same point), so if they ever diverged this count
  // would move silently. Named here rather than defended with a second
  // predicate, because a local override would drift from the shared one.
  const movableCount = flatShifts.filter((s) => isAssignable(s.status)).length;
  const notMovableCount = flatShifts.length - movableCount;

  async function commit(unassign: boolean) {
    setBusy(true); setError('');
    try {
      await adminPatch(`/api/guards/${guardId}/deactivate`,
        unassign ? { unassign_future_shifts: true } : {});
      onDone();
      onClose();
    } catch (e: any) {
      setError(e?.message ?? 'Deactivation failed.');
      // Impact may have changed underneath (someone clocked in, shifts moved).
      await load();
      setMode('review');
    } finally { setBusy(false); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-0 sm:p-4">
      <div className="w-full sm:max-w-3xl max-h-[92vh] overflow-y-auto bg-[#0F1E35] border border-[#1A3050] rounded-t-2xl sm:rounded-2xl p-5 sm:p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-amber-400 font-bold tracking-widest text-base sm:text-lg">
            DEACTIVATE {guard.name.toUpperCase()}
          </h2>
          <button onClick={onClose} aria-label="Close"
            className="text-gray-500 hover:text-gray-300 text-xl w-10 h-10 flex items-center justify-center">✕</button>
        </div>

        {loading && <p className="text-gray-500 text-sm py-8 text-center">Reading upcoming shifts…</p>}

        {!loading && error && (
          <div className="bg-red-900/40 border border-red-500 text-red-300 text-sm rounded-lg px-4 py-3 mb-4">
            {error}
          </div>
        )}

        {/* FAILS CLOSED: no impact means no informed decision, so no action. */}
        {!loading && !impact && (
          <div className="flex gap-3">
            <button onClick={onClose}
              className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2.5 text-sm tracking-widest hover:border-gray-500 transition-colors">
              CLOSE
            </button>
          </div>
        )}

        {/* BLOCKED — clocked in. No override, by design. */}
        {!loading && impact?.blocked && (
          <>
            <div className="bg-red-900/30 border border-red-700/50 rounded-lg px-4 py-3 mb-4">
              <p className="text-red-300 text-sm font-medium">
                {impact.open_session_conflict?.message ?? 'This guard is clocked in right now.'}
              </p>
              <p className="text-gray-400 text-xs mt-2">
                A guard on post cannot be deactivated. Wait for the clock-out, or have them
                clock out, then try again.
              </p>
            </div>
            {futureCount > 0 && (
              <p className="text-gray-500 text-xs mb-4">
                They also hold {futureCount} upcoming shift{futureCount === 1 ? '' : 's'} across{' '}
                {impact.site_count} site{impact.site_count === 1 ? '' : 's'}.
              </p>
            )}
            <button onClick={onClose}
              className="w-full border border-[#1A3050] text-gray-400 rounded-lg py-2.5 text-sm tracking-widest hover:border-gray-500 transition-colors">
              CLOSE
            </button>
          </>
        )}

        {/* NOT BLOCKED, NOTHING UPCOMING — the simple case stays simple. */}
        {!loading && impact && !impact.blocked && futureCount === 0 && (
          <>
            <p className="text-gray-400 text-sm mb-2">
              {guard.name} holds no upcoming shifts. Deactivating stops them logging in.
            </p>
            <p className="text-gray-600 text-xs mb-5">
              Site assignments are left in place; deactivation is reversible from this page.
            </p>
            <div className="flex gap-3">
              <button onClick={onClose} disabled={busy}
                className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2.5 text-sm tracking-widest hover:border-gray-500 disabled:opacity-40 transition-colors">
                CANCEL
              </button>
              <button onClick={() => commit(false)} disabled={busy}
                className="flex-1 bg-red-500 text-white font-bold rounded-lg py-2.5 text-sm tracking-widest hover:bg-red-400 disabled:opacity-40 transition-colors">
                {busy ? 'DEACTIVATING…' : 'DEACTIVATE'}
              </button>
            </div>
          </>
        )}

        {/* THE REAL CASE */}
        {!loading && impact && !impact.blocked && futureCount > 0 && (
          <>
            <p className="text-gray-200 text-sm mb-1">
              {guard.name} holds <strong className="text-amber-400">{futureCount}</strong>{' '}
              upcoming shift{futureCount === 1 ? '' : 's'} across {impact.site_count}{' '}
              site{impact.site_count === 1 ? '' : 's'}.
            </p>
            <p className="text-gray-500 text-xs mb-4">
              Deactivating stops them logging in. It does not, on its own, decide what happens
              to this work.
            </p>

            {/* Per site: count + real span, from the server's aggregate. */}
            <div className="border border-[#1A3050] rounded-lg divide-y divide-[#1A3050] mb-5">
              {sites.map((s) => (
                <div key={s.site_id} className="px-4 py-2.5 flex items-baseline justify-between gap-3 flex-wrap">
                  <span className="text-gray-300 text-sm">{s.site_name}</span>
                  <span className="text-gray-500 text-xs font-mono">
                    {s.shift_count} shift{s.shift_count === 1 ? '' : 's'} ·{' '}
                    {fmtDateShort(s.first_start)}
                    {s.first_start !== s.last_start && <> – {fmtDateShort(s.last_start)}</>}
                  </span>
                </div>
              ))}
            </div>

            {mode === 'review' && (
              <>
                {/* The two outcomes, side by side, stated as consequences. */}
                <div className="grid sm:grid-cols-2 gap-3 mb-5">
                  <div className="border border-[#1A3050] rounded-lg p-4">
                    <h3 className="text-gray-200 text-xs tracking-widest font-bold mb-2">REASSIGN</h3>
                    <p className="text-gray-400 text-xs leading-relaxed">
                      Each shift moves to another guard. The posts stay covered and nobody has to
                      remember to fill them.
                    </p>
                    <button
                      onClick={() => setMode('reassign')}
                      disabled={busy || movableCount === 0}
                      className="mt-3 w-full border border-amber-400/40 text-amber-400 rounded-lg py-2 text-xs tracking-widest hover:bg-amber-400/10 disabled:opacity-40 transition-colors"
                    >
                      CHOOSE REPLACEMENTS
                    </button>
                  </div>
                  <div className="border border-[#1A3050] rounded-lg p-4">
                    <h3 className="text-gray-200 text-xs tracking-widest font-bold mb-2">UNASSIGN</h3>
                    <p className="text-gray-400 text-xs leading-relaxed">
                      Each shift stays on the schedule with nobody on it, and shows as a gap until
                      someone fills it. The post is still required — this is not a cancellation.
                    </p>
                    <button
                      onClick={() => setMode('confirm-unassign')}
                      disabled={busy}
                      className="mt-3 w-full border border-red-400/40 text-red-400 rounded-lg py-2 text-xs tracking-widest hover:bg-red-400/10 disabled:opacity-40 transition-colors"
                    >
                      DEACTIVATE AND UNASSIGN
                    </button>
                  </div>
                </div>
                {notMovableCount > 0 && (
                  <p className="text-gray-600 text-[11px] mb-4">
                    {notMovableCount} of the listed shift{notMovableCount === 1 ? ' has' : 's have'}{' '}
                    already completed or been missed. Neither option touches{' '}
                    {notMovableCount === 1 ? 'it' : 'them'}.
                  </p>
                )}
                <button onClick={onClose} disabled={busy}
                  className="w-full border border-[#1A3050] text-gray-400 rounded-lg py-2.5 text-sm tracking-widest hover:border-gray-500 disabled:opacity-40 transition-colors">
                  CANCEL — LEAVE {guard.name.toUpperCase()} ACTIVE
                </button>
              </>
            )}

            {mode === 'reassign' && (
              <>
                <ShiftBulkReassign
                  shifts={flatShifts}
                  guards={guards}
                  excludeGuardId={guardId}
                  reason="guard_deactivated"
                  // Phase E locked this dialog to two outcomes: reassign (the
                  // post stays covered) or unassign (the post stays, as a
                  // gap). Cancel deletes the requirement itself and cannot be
                  // undone - not a verb to offer mid-deactivation. See the
                  // prop's docblock.
                  allowCancel={false}
                  title="THIS GUARD'S UPCOMING SHIFTS"
                  onDone={() => { load(); }}
                />
                <p className="text-gray-500 text-xs mt-3 mb-4">
                  {guard.name} is still active. Once every shift has moved, deactivating is a
                  one-step action with nothing left behind.
                </p>
                <button onClick={() => setMode('review')} disabled={busy}
                  className="w-full border border-[#1A3050] text-gray-400 rounded-lg py-2.5 text-sm tracking-widest hover:border-gray-500 disabled:opacity-40 transition-colors">
                  BACK
                </button>
              </>
            )}

            {mode === 'confirm-unassign' && (
              <>
                <div className="bg-red-900/25 border border-red-700/50 rounded-lg px-4 py-3 mb-4">
                  <p className="text-red-300 text-sm font-medium mb-2">
                    Deactivate {guard.name} and unassign {movableCount} shift
                    {movableCount === 1 ? '' : 's'}?
                  </p>
                  <ul className="text-gray-400 text-xs space-y-1 list-disc list-inside">
                    <li>{guard.name} can no longer log in.</li>
                    <li>
                      {movableCount} shift{movableCount === 1 ? '' : 's'} stay{movableCount === 1 ? 's' : ''}{' '}
                      on the schedule with no guard, and appear{movableCount === 1 ? 's' : ''} in the
                      unassigned banner.
                    </li>
                    <li>Nothing is cancelled — the posts are still required.</li>
                    {notMovableCount > 0 && (
                      <li>
                        {notMovableCount} completed or missed shift
                        {notMovableCount === 1 ? '' : 's'} {notMovableCount === 1 ? 'is' : 'are'} left
                        untouched.
                      </li>
                    )}
                  </ul>
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setMode('review')} disabled={busy}
                    className="flex-1 border border-[#1A3050] text-gray-400 rounded-lg py-2.5 text-sm tracking-widest hover:border-gray-500 disabled:opacity-40 transition-colors">
                    BACK
                  </button>
                  <button onClick={() => commit(true)} disabled={busy}
                    className="flex-1 bg-red-500 text-white font-bold rounded-lg py-2.5 text-sm tracking-widest hover:bg-red-400 disabled:opacity-40 transition-colors">
                    {busy ? 'WORKING…' : 'DEACTIVATE AND UNASSIGN'}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
