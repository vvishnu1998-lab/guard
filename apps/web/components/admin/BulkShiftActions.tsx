'use client';
/**
 * Bulk shift actions — the CONTROLLER. Owns selection, the verb, the guard
 * choice, the candidate fetch, the confirm step and the write loop. Renders
 * the header, the result banner, the confirm panel and the action bars.
 *
 * IT DOES NOT RENDER A TABLE. Its children are a render prop, and each call
 * site supplies its own rows:
 *
 *   /admin/shifts/site/[siteId]   the site's SCHEDULE table, which now also
 *                                 carries the checkboxes. It shows the guard,
 *                                 the duration, the status pill and the
 *                                 inspection badge, and spans -1d..+90d -
 *                                 rows outside the selectable pool render
 *                                 with a disabled checkbox rather than being
 *                                 hidden.
 *   GuardDeactivateDialog         ShiftBulkReassign's own compact table,
 *                                 which keeps a SITE column because that
 *                                 list spans sites.
 *
 * ── Why a render prop and not two components ────────────────────────────
 *
 * run() is the part that must not be duplicated: per-row endpoint routing,
 * sequential writes, partial results, and the rule that a failure stays
 * ticked with its reason. Two copies of that drift, and the drift is
 * invisible until a batch half-fails. The TABLES are what legitimately
 * differ - different columns, different rows, one navigates and one does not
 * - so those are the part that is duplicated, deliberately.
 *
 * ── The write loop ──────────────────────────────────────────────────────
 *
 * One request per shift, sequential, partial results. Sequential rather than
 * Promise.all because two assignments to the same guard in overlapping
 * windows must see each other; kept for cancel so progress is reportable and
 * the two read identically.
 *
 * ASSIGN routes per row on `status` and nothing else:
 *
 *   status === 'unassigned'  ->  PATCH /api/shifts/:id/assign-guard  { guard_id }
 *   everything else          ->  PATCH /api/shifts/:id/reassign      { new_guard_id }
 *
 * ── Degrading when the API is behind ────────────────────────────────────
 *
 * Vercel and Railway never deploy together. If web lands first the candidates
 * call fails; this then falls back to offering every active guard with a
 * visible note - worse than pre-evaluation, better than a dead surface. It
 * fails BACKWARD, not closed, because the write path still refuses anything
 * genuinely invalid.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { adminPatch, adminPost } from '../../lib/adminApi';
import {
  admits, cancelFailureLabel, REASON_LABEL,
} from '../../lib/bulkShiftCopy';
import type { BulkVerb } from '../../lib/bulkShiftCopy';

export type { BulkVerb } from '../../lib/bulkShiftCopy';

export interface BulkShiftRow {
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



/** What each call site's table is handed. Everything it needs to render a
 *  row and nothing about how to render one. */
export interface BulkTableArgs {
  verb:        BulkVerb;
  selected:    Set<string>;
  /** True when this row is in the selectable pool AND the active verb admits
   *  it. A row the caller renders but did not pass in `shifts` — a past shift
   *  on the site page — returns false, which is what makes the merged table
   *  able to show more rows than it can act on. */
  canSelect:   (id: string) => boolean;
  toggle:      (id: string) => void;
  toggleAll:   () => void;
  allSelected: boolean;
  eligibleCount: number;
  busy:        boolean;
  /** Server's word on a row that failed THIS run, keyed by shift id. */
  failures:    Map<string, string>;
  /** Why the CHOSEN guard cannot take a row, before anything is attempted. */
  chosenBlocked: Map<string, BlockedEntry>;
}

interface Props {
  shifts:   BulkShiftRow[];
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
  /** The table. Called with everything above; renders whatever rows it likes. */
  children: (args: BulkTableArgs) => ReactNode;
}

export default function BulkShiftActions({
  shifts, guards, excludeGuardId, reason, onDone,
  title = 'BULK ACTIONS', allowCancel = true, children,
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

  // PRUNING runs on BOTH deps, deliberately. Switching verb narrows what is
  // selectable (a row ticked under assign can be ineligible under cancel), and
  // a refetch can remove a row outright — a shift someone else cancelled, or
  // one that left the window. Either way, carrying an id the batch cannot act
  // on would put a guaranteed failure in it.
  useEffect(() => {
    const ok = new Set(shifts.filter((s) => admits(verb, s.status)).map((s) => s.id));
    setSelected((prev) => {
      const next = new Set(Array.from(prev).filter((id) => ok.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [verb, shifts]);

  // FEEDBACK clears on VERB ONLY — never on `shifts`, and this is the whole
  // point of the split.
  //
  // It used to share the effect above. `onDone` triggers the caller's refetch,
  // the refetch hands down a new `shifts` array, and the effect then wiped
  // `failures` and `movedLast` a few hundred ms after a run finished. Observed
  // directly: a batch of 2 succeeded + 1 failed showed
  // `movedLast=2 failures=1 selected=[s3]` and, once the refetch landed,
  // `movedLast=0 failures=0 selected=[s3]` — the failed row still ticked, with
  // nothing on screen saying why.
  //
  // So the explanation vanished exactly when a batch PARTIALLY succeeded,
  // which is the only case partial results exist to handle: a batch that
  // wholly failed never called onDone, never refetched, and kept its reasons.
  // Feedback is about the run, not about the data, so it outlives the refetch
  // and clears when the admin changes verb.
  useEffect(() => {
    setConfirming(false);
    setFailures(new Map());
    setMovedLast(0);
  }, [verb]);

  // Blocked reasons for the guard currently chosen, keyed by shift.
  const chosenBlocked = useMemo(() => {
    const c = candidates?.find((x) => x.guard_id === guardId);
    return new Map((c?.blocked ?? []).map((b) => [b.shift_id, b]));
  }, [candidates, guardId]);
  const blockedRows = useMemo(
    () => shifts.filter((s) => !admits(verb, s.status)), [shifts, verb]);
  const allSelected = eligible.length > 0 && selected.size === eligible.length;
  // Membership of the selectable pool, by id. A caller's table may render
  // rows that were never passed in `shifts` (the site page shows -1d..+90d
  // while only future rows are actionable); those are not in this set and so
  // are never selectable.
  const eligibleIds = useMemo(() => new Set(eligible.map((s) => s.id)), [eligible]);
  const canSelect = useCallback((id: string) => eligibleIds.has(id), [eligibleIds]);

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
              {failures.size} could not be {verb === 'cancel' ? 'cancelled' : 'assigned'} —
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
          <label htmlFor="bulk-assign-guard" className="text-gray-500 text-[11px] tracking-widest">
            ASSIGN TO
          </label>
          <select
            id="bulk-assign-guard"
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

      {children({
        verb, selected, canSelect, toggle, toggleAll, allSelected,
        eligibleCount: eligible.length, busy, failures, chosenBlocked,
      })}

      {blockedRows.length > 0 && (
        <div className="px-4 py-2 border-t border-[#1A3050] text-gray-600 text-[11px]">
          {blockedRows.length} shift{blockedRows.length === 1 ? '' : 's'} listed but not{' '}
          {verb === 'cancel' ? 'cancellable' : 'assignable'}.
        </div>
      )}
    </div>
  );
}
