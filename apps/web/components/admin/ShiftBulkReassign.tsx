'use client';
/**
 * Bulk actions on a site's shifts — ASSIGN N shifts to one guard, or CANCEL
 * them.
 *
 * ASSIGN COVERS TWO WRITES AND ONE IDEA. A shift that has a guard gets MOVED;
 * one that has nobody gets FILLED. The admin is picking a guard either way, so
 * they see one verb. Underneath, run() routes per row on `status`:
 *
 *   status === 'unassigned'  ->  PATCH /api/shifts/:id/assign-guard  { guard_id }
 *   everything else          ->  PATCH /api/shifts/:id/reassign      { new_guard_id }
 *
 * The branch is on that status and NOTHING else. Sending an assigned row to
 * assign-guard 409s ("This shift already has a guard"), and the two routes
 * differ in ways neither is a superset of - see N82.
 *
 * ── This is NOT a reuse of SlotAssignPanel ──────────────────────────────
 *
 * Phase D's panel selects TEMPLATE SLOTS, keyed on `slot_start`, because a
 * slot has no row of its own — site_profile_shifts.id is unstable across a
 * template edit, so (site_id, slot_start) is the only durable identity.
 * Assigning one CREATES or claims a shift, and the server re-checks capacity
 * (`guards_needed` vs `filled`) inside the write.
 *
 * This selects SHIFTS, keyed on `shift_id`, which is a real primary key. There
 * is no slot arithmetic, no staleness triple to send back, no capacity check,
 * and the writes are per-shift PATCHes rather than a bulk POST.
 * Change the key from slot_start to shift_id and nothing inside that component
 * survives — not the types, not the payload, not the reason codes.
 *
 * What IS carried over is the SHAPE of the interaction, deliberately, because
 * the admin learned it two screens ago: tick a set, pick one guard, get a
 * partial result where what worked disappears and what failed stays ticked
 * with its reason. That is a pattern, not a component, and pretending
 * otherwise by extracting a premature generic from a sample of two would make
 * both harder to read.
 *
 * ── Partial success IS right here, unlike deactivation ──────────────────
 *
 * These are N independent shifts and each can fail for its own reason: the
 * new guard is not assigned to that site on that date (422), already has an
 * overlapping shift (409), the site is deactivated (409), or the shift has
 * already completed (400). Six of one selection succeeding and four failing
 * is a genuine, useful answer — which is exactly why PATCH /:id/deactivate is
 * the opposite and runs as one transaction: there, a partial result IS the
 * orphan bug.
 *
 * So: sequential, one request per shift, no shared transaction. Sequential
 * rather than Promise.all because two assignments to the same guard in
 * overlapping windows must be able to see each other — fired in parallel they
 * would both pass the overlap check and double-book.
 *
 * ── Candidates are evaluated BEFORE the pick ────────────────────────────
 *
 * POST /api/guards/shift-candidates scores every guard in the company against
 * the WHOLE current selection and returns free_count/total plus a blocked[]
 * carrying a machine reason per shift. The dropdown shows that ratio, greys a
 * guard who can take nothing, and marks the individual rows a chosen guard
 * cannot take — so nobody is offered and then rejected.
 *
 * That rule is SlotAssignPanel's, and it is worth restating why it is not
 * cosmetic. Measured against prod for one guard's 25 shifts: of 16 guards in
 * the company, 3 are inactive, 11 are not assigned to that site, 1 already
 * holds the shifts, and exactly ONE can take them. Without pre-evaluation an
 * admin picks from 13 apparently-fine names and has a 1-in-13 chance of
 * avoiding 25 consecutive failures.
 *
 * Reasons are branched on the ENUM, never the prose — REASON_LABEL below. The
 * server's sentence is still rendered verbatim for a failure that happens at
 * WRITE time, because it carries detail the client cannot reconstruct (which
 * date, which site, which colliding shift).
 *
 * ── Degrading when the API is behind ────────────────────────────────────
 *
 * Vercel and Railway never deploy together. If this page lands first the
 * candidates call fails; the component then falls back to offering every
 * active guard with a visible note, which is Phase 4's behaviour — worse than
 * pre-evaluation, better than a dead surface. It fails BACKWARD, not closed,
 * because the write path still refuses anything genuinely invalid.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminPatch, adminPost } from '../../lib/adminApi';
import {
  admits, cancelFailureLabel, REASON_LABEL,
} from '../../lib/bulkShiftCopy';
import type { BulkVerb } from '../../lib/bulkShiftCopy';
import { fmtDateShort, fmtTime } from '../../lib/shiftFormat';

// Re-exported so existing importers keep working unchanged — the decision
// moved to lib/bulkShiftCopy.ts so a check could EXECUTE it, not because the
// consumers should have to know that. GuardDeactivateDialog imports
// isAssignable from here.
export { isAssignable, isCancellable, admits } from '../../lib/bulkShiftCopy';
export type { BulkVerb } from '../../lib/bulkShiftCopy';

export interface ReassignableShift {
  id:              string;
  site_id:         string;
  site_name:       string;
  scheduled_start: string;
  scheduled_end:   string;
  status:          string;
  guard_name?:     string | null;
}

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean }

interface BlockedEntry {
  shift_id: string;
  reason:   string;
  conflict?: {
    shift_id: string; site_name: string;
    scheduled_start: string; scheduled_end: string;
  } | null;
}

interface Candidate {
  guard_id:     string;
  name:         string;
  badge_number: string;
  is_active:    boolean;
  total:        number;
  free_count:   number;
  blocked:      BlockedEntry[];
}



interface Props {
  shifts:   ReassignableShift[];
  guards:   Guard[];
  /** Guard id to omit from the picker — reassigning to the current holder is
   *  a no-op the server would accept. */
  excludeGuardId?: string;
  /** Written to shift_reassignments.reason. */
  reason?:  string;
  /** Fired once after a run that moved at least one shift. */
  onDone:   (movedCount: number) => void;
  /** Rendered above the list. */
  title?:   string;
  /**
   * Whether the CANCEL verb is offered at all. Default true.
   *
   * WHY THE TWO CALL SITES DIFFER - do not "complete" this by turning it on
   * everywhere. /admin/shifts/site/[siteId] gets cancel: an admin looking at
   * a site's schedule is in the right place to remove work from it.
   *
   * GuardDeactivateDialog passes false. That dialog exists to MOVE a
   * departing guard's work, and Phase E locked it to exactly two outcomes -
   * reassign (the post stays covered) or unassign (the post stays, as a gap).
   * Cancel is a third, IRREVERSIBLE outcome that deletes the requirement
   * itself, and an admin midway through deactivating someone is the worst
   * moment to be offered it: the shifts on screen are there because they
   * belong to the guard being removed, not because anyone decided the posts
   * were unnecessary. Offering cancel there invites a one-way action taken
   * for the wrong reason.
   *
   * If that is ever revisited it is a change to Phase E's decision, not to
   * this component's.
   */
  allowCancel?: boolean;
}

export default function ShiftBulkReassign({
  shifts, guards, excludeGuardId, reason, onDone,
  title = 'BULK ACTIONS', allowCancel = true,
}: Props) {
  const [selected,  setSelected]  = useState<Set<string>>(new Set());
  const [guardId,   setGuardId]   = useState('');
  const [busy,      setBusy]      = useState(false);
  const [progress,  setProgress]  = useState<{ done: number; total: number } | null>(null);
  const [failures,  setFailures]  = useState<Map<string, string>>(new Map());
  const [movedLast, setMovedLast] = useState(0);
  const [candidates,  setCandidates]  = useState<Candidate[] | null>(null);
  const [candLoading, setCandLoading] = useState(false);
  const [candUnavailable, setCandUnavailable] = useState(false);
  const [verbState, setVerb] = useState<BulkVerb>('assign');
  // Derived, not just hidden: with cancel gated off there is no state a stale
  // 'cancel' could survive in, so the verb cannot be reached by any path.
  const verb: BulkVerb = allowCancel ? verbState : 'assign';
  // Cancel is one-way and there is no un-cancel path anywhere in the API, so
  // it never fires straight off the action bar. See the confirm panel below.
  const [confirming, setConfirming] = useState(false);

  // Eligible rows depend on the VERB, not on a fixed predicate. This is the
  // part that reaches the table body: the same row is selectable under
  // reassign and not under cancel.
  const eligible = useMemo(
    () => shifts.filter((s) => admits(verb, s.status)), [shifts, verb]);

  // Stable key so the effect re-runs on WHAT is selected, not on the Set
  // identity — toggling two shifts on and off again must not refetch.
  const selectionKey = useMemo(() => Array.from(selected).sort().join(','), [selected]);

  const loadCandidates = useCallback(async (ids: string[]) => {
    if (ids.length === 0) { setCandidates(null); return; }
    setCandLoading(true);
    try {
      const r = await adminPost<{ candidates: Candidate[] }>(
        '/api/guards/shift-candidates', { shift_ids: ids });
      setCandidates(r.candidates ?? []);
      setCandUnavailable(false);
    } catch {
      // Stale API, or the endpoint is unreachable. Fall back to offering every
      // active guard rather than leaving the surface unusable.
      setCandidates(null);
      setCandUnavailable(true);
    } finally { setCandLoading(false); }
  }, []);

  useEffect(() => {
    // Candidates are an ASSIGN concept - they answer "which guard could take
    // these rows", for both the move and the fill. Under cancel there is no
    // guard to pick, so the request is not made at all rather than made and
    // ignored.
    if (verb === 'cancel') { setCandidates(null); setCandUnavailable(false); return; }
    const ids = selectionKey ? selectionKey.split(',') : [];
    loadCandidates(ids);
  }, [verb, selectionKey, loadCandidates]);

  // Switching verb narrows what is selectable, so a row ticked under reassign
  // can become ineligible under cancel. Drop those rather than carrying a
  // selection the new verb cannot act on — otherwise the batch would contain
  // a guaranteed failure the UI already knows about.
  useEffect(() => {
    const ok = new Set(shifts.filter((s) => admits(verb, s.status)).map((s) => s.id));
    setSelected((prev) => {
      const next = new Set(Array.from(prev).filter((id) => ok.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setConfirming(false);
    setFailures(new Map());
    setMovedLast(0);
  }, [verb, shifts]);

  // Blocked reasons for the guard currently chosen, keyed by shift.
  const chosenBlocked = useMemo(() => {
    const c = candidates?.find((x) => x.guard_id === guardId);
    return new Map((c?.blocked ?? []).map((b) => [b.shift_id, b]));
  }, [candidates, guardId]);
  const blockedRows = useMemo(
    () => shifts.filter((s) => !admits(verb, s.status)), [shifts, verb]);
  const allSelected = eligible.length > 0 && selected.size === eligible.length;

  // Sites covered by the current selection — the confirm panel names them,
  // because "cancel 12 shifts" without a site is not a reviewable sentence.
  const selectedSites = useMemo(() => {
    const names = new Set(
      shifts.filter((s) => selected.has(s.id)).map((s) => s.site_name));
    return Array.from(names);
  }, [shifts, selected]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === eligible.length ? new Set() : new Set(eligible.map((s) => s.id)));
  }

  /** Sequential, one request per shift, partial results — the shape both
   *  verbs share. Sequential rather than Promise.all for reassign because two
   *  moves to the same guard in overlapping windows must see each other; kept
   *  for cancel so progress is reportable and the two read identically. */
  async function run() {
    if (selected.size === 0) return;
    if (verb === 'assign' && !guardId) return;
    if (verb === 'cancel' && !confirming) { setConfirming(true); return; }
    setBusy(true);
    setFailures(new Map());
    setMovedLast(0);

    // Array.from, not [...selected] — spreading a Set needs
    // --downlevelIteration under this tsconfig and fails with TS2802.
    const ids = Array.from(selected);
    // Chronological, so a same-guard overlap is reported against the LATER
    // shift rather than whichever happened to be enumerated second.
    const order = new Map(shifts.map((s, i) => [s.id, i]));
    ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    // Status by id, for the per-row endpoint choice below. Built from the
    // same `shifts` prop the rows were rendered from, so the route a row
    // takes matches the row the admin actually ticked.
    const shiftById = new Map(shifts.map((s) => [s.id, s]));

    const failed = new Map<string, string>();
    let moved = 0;
    setProgress({ done: 0, total: ids.length });

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        if (verb === 'cancel') {
          // Fixed reason, never a prompt. shifts.cancellation_reason has ZERO
          // readers anywhere in api/web/mobile, so a free-text field would be
          // write-only; a fixed value at least keeps bulk cancels separable
          // from ad-hoc ones later, which is the one thing the column was
          // ever wanted for.
          await adminPatch(`/api/shifts/${id}/cancel`, { reason: 'admin_bulk_cancelled' });
        } else if (shiftById.get(id)?.status === 'unassigned') {
          // FILL an empty post. The branch is on status and NOTHING else:
          // assign-guard admits only status='unassigned' AND guard_id IS NULL
          // and 409s anything else, so a mis-branch is a guaranteed failure
          // the UI could have prevented.
          //
          // Different body key, deliberately not normalised on the server:
          // guard_id here, new_guard_id on reassign. Renaming either is an
          // API change and does not belong in a UI verb rename.
          await adminPatch(`/api/shifts/${id}/assign-guard`, {
            guard_id: guardId,
            ...(reason ? { reason } : {}),
          });
        } else {
          // MOVE a shift that already has somebody on it.
          await adminPatch(`/api/shifts/${id}/reassign`, {
            new_guard_id: guardId,
            ...(reason ? { reason } : {}),
          });
        }
        moved++;
      } catch (e: any) {
        // Cancel resolves on the machine enum; assign has none on either
        // route yet (N83), so it renders the server's prose as reassign
        // always has.
        failed.set(id, verb === 'cancel'
          ? cancelFailureLabel(e)
          : (e?.message ?? 'Could not assign'));
      }
      setProgress({ done: i + 1, total: ids.length });
    }

    setFailures(failed);
    // What worked unticks; what failed stays ticked so the admin can pick a
    // different guard for exactly those without rebuilding the selection.
    setSelected(new Set(failed.keys()));
    setMovedLast(moved);
    setGuardId('');
    setConfirming(false);
    setProgress(null);
    setBusy(false);
    if (moved > 0) onDone(moved);
  }

  if (shifts.length === 0) return null;

  return (
    <div className="border border-[#1A3050] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1A3050] flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-gray-300 text-xs tracking-widest font-bold">{title}</h3>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Verb switcher. NOT two peer buttons that both act — picking a
              verb only changes what is selectable and what the action bar
              offers. Cancel still needs its own confirm before anything is
              written. */}
          {allowCancel && (
          <div role="group" aria-label="Bulk action" className="flex rounded-lg overflow-hidden border border-[#1A3050]">
            {(['assign', 'cancel'] as BulkVerb[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setVerb(v)}
                disabled={busy}
                aria-pressed={verb === v}
                className={`px-3 py-1 text-[11px] tracking-widest transition-colors disabled:opacity-40 ${
                  verb === v
                    ? (v === 'cancel'
                        ? 'bg-red-500/20 text-red-300'
                        : 'bg-amber-400/20 text-amber-300')
                    : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {v === 'cancel' ? 'CANCEL' : 'ASSIGN'}
              </button>
            ))}
          </div>
          )}
          {selected.size > 0 && (
            <span className="text-amber-400 text-[11px] tracking-widest">{selected.size} selected</span>
          )}
        </div>
      </div>

      {(movedLast > 0 || failures.size > 0) && (
        <div className="px-4 py-2 border-b border-[#1A3050] bg-[#0B1526] text-xs">
          {movedLast > 0 && (
            <p className="text-green-400">
              {movedLast} shift{movedLast === 1 ? '' : 's'}{' '}
              {verb === 'cancel' ? 'cancelled.' : 'assigned.'}
            </p>
          )}
          {failures.size > 0 && (
            <p className="text-red-400">
              {failures.size} could not be {verb === 'cancel' ? 'cancelled' : 'moved'} —
              {' '}still selected, with the reason on each row.
            </p>
          )}
        </div>
      )}

      {/* Cancel confirm. Cancel is ONE-WAY: no route or job anywhere in the
          API moves a shift out of 'cancelled', `shifts` has no updated_at, and
          recovery means hand-written SQL against prod. So it never fires off
          the action bar — this panel names the count and the site first.

          Deliberately the COMPLEMENT of GuardDeactivateDialog's unassign
          panel rather than a new pattern: that one says the shift stays and
          the requirement remains, this one says both go. */}
      {verb === 'cancel' && selected.size > 0 && confirming && (
        <div className="px-4 py-3 border-b border-[#1A3050] bg-red-900/25">
          <p className="text-red-300 text-sm font-medium mb-2">
            Cancel {selected.size} shift{selected.size === 1 ? '' : 's'}
            {selectedSites.length === 1
              ? <> at {selectedSites[0]}</>
              : <> across {selectedSites.length} sites</>}?
          </p>
          <ul className="text-gray-400 text-xs space-y-1 list-disc list-inside mb-3">
            <li>
              {selected.size === 1 ? 'The shift leaves' : 'Each shift leaves'} the schedule.
              The requirement disappears with it — nothing shows as a gap, and nobody
              will be asked to fill it.
            </li>
            <li>This is not the same as unassigning. Unassigning keeps the post; this removes it.</li>
            <li>
              <strong className="text-red-300">This cannot be undone.</strong> There is no
              un-cancel — restoring these would mean editing the database by hand.
            </li>
            {selectedSites.length > 1 && (
              <li>Sites affected: {selectedSites.join(', ')}.</li>
            )}
          </ul>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="border border-[#1A3050] text-gray-400 rounded-lg px-4 py-2 text-xs tracking-widest hover:border-gray-500 disabled:opacity-40 transition-colors"
            >
              KEEP THEM
            </button>
            <button
              type="button"
              onClick={run}
              disabled={busy}
              className="bg-red-500 text-white font-bold rounded-lg px-4 py-2 text-xs tracking-widest hover:bg-red-400 disabled:opacity-40 transition-colors"
            >
              {progress
                ? `CANCELLING ${progress.done}/${progress.total}…`
                : `CANCEL ${selected.size} SHIFT${selected.size === 1 ? '' : 'S'}`}
            </button>
          </div>
        </div>
      )}

      {/* Cancel action bar — opens the confirm, never writes. */}
      {verb === 'cancel' && selected.size > 0 && !confirming && (
        <div className="px-4 py-3 border-b border-[#1A3050] bg-[#0B1526] flex items-center gap-3 flex-wrap">
          <span className="text-gray-500 text-[11px] tracking-widest">
            {selected.size} shift{selected.size === 1 ? '' : 's'} selected
          </span>
          <button
            type="button"
            onClick={run}
            disabled={busy}
            className="border border-red-400/40 text-red-400 rounded-lg px-4 py-2 text-xs tracking-widest hover:bg-red-400/10 disabled:opacity-40 transition-colors"
          >
            CANCEL SHIFTS…
          </button>
        </div>
      )}

      {/* Assign bar. Only once something is ticked, and only under assign. */}
      {verb === 'assign' && selected.size > 0 && (
        <div className="px-4 py-3 border-b border-[#1A3050] bg-[#0B1526] flex items-center gap-3 flex-wrap">
          <label htmlFor="bulk-reassign-guard" className="text-gray-500 text-[11px] tracking-widest">
            ASSIGN TO
          </label>
          <select
            id="bulk-reassign-guard"
            value={guardId}
            onChange={(e) => setGuardId(e.target.value)}
            disabled={busy || candLoading}
            className="bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 text-gray-200 text-sm focus:outline-none focus:border-amber-400 disabled:opacity-40"
          >
            <option value="">
              {candLoading ? 'Checking availability…' : 'Select guard…'}
            </option>
            {/* Pre-evaluated: every guard is listed, an unavailable one is
                shown WITH the reason and cannot be chosen. Filtering them out
                is what makes an admin ask "where is X?" and get no answer. */}
            {candidates
              ? candidates
                  .filter((c) => c.guard_id !== excludeGuardId)
                  .map((c) => {
                    const only = c.blocked.length > 0
                      ? REASON_LABEL[c.blocked[0].reason] ?? 'Unavailable'
                      : '';
                    const allSameReason = c.blocked.length > 0
                      && c.blocked.every((b) => b.reason === c.blocked[0].reason);
                    const suffix = c.free_count === 0
                      ? ` — ${allSameReason ? only : 'unavailable'}`
                      : c.free_count < c.total
                        ? ` — ${c.free_count}/${c.total} available`
                        : '';
                    return (
                      <option key={c.guard_id} value={c.guard_id} disabled={c.free_count === 0}>
                        {c.name} — {c.badge_number}{suffix}
                      </option>
                    );
                  })
              : guards
                  .filter((g) => g.is_active !== false && g.id !== excludeGuardId)
                  .map((g) => (
                    <option key={g.id} value={g.id}>{g.name} — {g.badge_number}</option>
                  ))}
          </select>
          {candUnavailable && (
            <span className="text-amber-400/80 text-[11px] w-full">
              Availability could not be checked — every active guard is listed, and an
              unavailable one will be refused when you assign.
            </span>
          )}
          <button
            onClick={run}
            disabled={busy || !guardId}
            className="bg-amber-400 text-gray-900 font-bold rounded-lg px-4 py-2 text-xs tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors"
          >
            {progress ? `ASSIGNING ${progress.done}/${progress.total}…` : 'ASSIGN'}
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
              <th className="p-3 w-10 text-left">
                <input
                  type="checkbox"
                  aria-label={verb === 'cancel'
                    ? 'Select all cancellable shifts'
                    : 'Select all assignable shifts'}
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={busy || eligible.length === 0}
                  className="accent-amber-400"
                />
              </th>
              <th className="text-left p-3">DATE</th>
              <th className="text-left p-3">TIME</th>
              <th className="text-left p-3">SITE</th>
              <th className="text-left p-3">STATUS</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map((s) => {
              // Verb-aware. Under cancel an 'active' row is NOT selectable,
              // because the route refuses it — the UI must not offer a batch
              // that is guaranteed to fail on that row.
              const movableRow = admits(verb, s.status);
              const failure = failures.get(s.id);
              return (
                <tr
                  key={s.id}
                  className={`border-b border-[#1A3050] last:border-b-0 ${movableRow ? '' : 'opacity-50'}`}
                >
                  <td className="p-3 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Select shift on ${fmtDateShort(s.scheduled_start)}`}
                      checked={selected.has(s.id)}
                      onChange={() => toggle(s.id)}
                      disabled={busy || !movableRow}
                      className="accent-amber-400"
                    />
                  </td>
                  <td className="p-3 text-gray-300 text-xs font-mono whitespace-nowrap align-top">
                    {fmtDateShort(s.scheduled_start)}
                  </td>
                  <td className="p-3 text-gray-400 text-xs font-mono whitespace-nowrap align-top">
                    {fmtTime(s.scheduled_start)} → {fmtTime(s.scheduled_end)}
                  </td>
                  <td className="p-3 text-gray-400 text-xs align-top">{s.site_name}</td>
                  <td className="p-3 text-xs align-top">
                    <span className="text-gray-400">{s.status.toUpperCase()}</span>
                    {/* Shown, not hidden. The list is broader than what can
                        move, and the admin should see the whole picture with
                        the untouchable part marked. */}
                    {!movableRow && (
                      <span className="block text-gray-600 text-[11px] mt-0.5">
                        {/* Both verbs now admit 'unassigned', so the only
                            statuses that reach here are completed, missed and
                            cancelled — plus 'active' under cancel, which has
                            its own sentence because a clocked-in guard is a
                            different reason from a finished shift. "already X"
                            reads correctly for all of them: each is something
                            the shift FINISHED being. */}
                        {verb === 'cancel'
                          ? (s.status === 'active'
                              ? 'Not cancellable — a guard is clocked in.'
                              : `Not cancellable — already ${s.status}.`)
                          : `Not assignable — already ${s.status}.`}
                      </span>
                    )}
                    {/* Before the attempt: why the CHOSEN guard cannot take
                        this particular row. After it: what the server said. */}
                    {!failure && movableRow && chosenBlocked.has(s.id) && (
                      <span className="block text-amber-400/80 text-[11px] mt-0.5">
                        {REASON_LABEL[chosenBlocked.get(s.id)!.reason] ?? 'Unavailable'}
                        {chosenBlocked.get(s.id)!.conflict && (
                          <> — {chosenBlocked.get(s.id)!.conflict!.site_name}</>
                        )}
                      </span>
                    )}
                    {failure && (
                      <span className="block text-red-400 text-[11px] mt-0.5">{failure}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {blockedRows.length > 0 && (
        <div className="px-4 py-2 border-t border-[#1A3050] text-gray-600 text-[11px]">
          {blockedRows.length} shift{blockedRows.length === 1 ? '' : 's'} listed but not{' '}
          {verb === 'cancel' ? 'cancellable' : 'assignable'}.
        </div>
      )}
    </div>
  );
}
