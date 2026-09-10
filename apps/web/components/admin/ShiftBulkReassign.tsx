'use client';
/**
 * Bulk reassign — move N shifts to one guard.
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
 * and the endpoint is PATCH /api/shifts/:id/reassign rather than a bulk POST.
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
 * rather than Promise.all because two reassignments to the same guard in
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
import { fmtDateShort, fmtTime } from '../../lib/shiftFormat';

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

/** Only these two statuses can move. Mirrors PATCH /:id/reassign, which
 *  refuses 'completed' and 'missed' with a 400, and mirrors the write set of
 *  PATCH /guards/:id/deactivate. A row outside this set is shown, greyed and
 *  labelled, never silently dropped. */
export function isReassignable(status: string): boolean {
  return status === 'scheduled' || status === 'active';
}

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

/** Guard-facing copy per machine reason. Branch on the ENUM, never on prose.
 *  Mirrors SlotAssignPanel's map; `already_on_shift` and `not_reassignable`
 *  are this endpoint's, `slot_full`/`template_changed` have no analogue on a
 *  shift and are absent rather than carried over dead. */
const REASON_LABEL: Record<string, string> = {
  guard_inactive:       'Inactive',
  not_reassignable:     'Already completed or missed',
  already_on_shift:     'Already on this shift',
  not_assigned_to_site: 'Not assigned to this site',
  overlap:              'Busy elsewhere',
};

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
}

export default function ShiftBulkReassign({
  shifts, guards, excludeGuardId, reason, onDone, title = 'REASSIGN SHIFTS',
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

  const movable = useMemo(() => shifts.filter((s) => isReassignable(s.status)), [shifts]);

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
    const ids = selectionKey ? selectionKey.split(',') : [];
    loadCandidates(ids);
  }, [selectionKey, loadCandidates]);

  // Blocked reasons for the guard currently chosen, keyed by shift.
  const chosenBlocked = useMemo(() => {
    const c = candidates?.find((x) => x.guard_id === guardId);
    return new Map((c?.blocked ?? []).map((b) => [b.shift_id, b]));
  }, [candidates, guardId]);
  const blockedRows = useMemo(() => shifts.filter((s) => !isReassignable(s.status)), [shifts]);
  const allSelected = movable.length > 0 && selected.size === movable.length;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === movable.length ? new Set() : new Set(movable.map((s) => s.id)));
  }

  async function run() {
    if (!guardId || selected.size === 0) return;
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

    const failed = new Map<string, string>();
    let moved = 0;
    setProgress({ done: 0, total: ids.length });

    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      try {
        await adminPatch(`/api/shifts/${id}/reassign`, {
          new_guard_id: guardId,
          ...(reason ? { reason } : {}),
        });
        moved++;
      } catch (e: any) {
        failed.set(id, e?.message ?? 'Could not reassign');
      }
      setProgress({ done: i + 1, total: ids.length });
    }

    setFailures(failed);
    // What worked unticks; what failed stays ticked so the admin can pick a
    // different guard for exactly those without rebuilding the selection.
    setSelected(new Set(failed.keys()));
    setMovedLast(moved);
    setGuardId('');
    setProgress(null);
    setBusy(false);
    if (moved > 0) onDone(moved);
  }

  if (shifts.length === 0) return null;

  return (
    <div className="border border-[#1A3050] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1A3050] flex items-center justify-between flex-wrap gap-2">
        <h3 className="text-gray-300 text-xs tracking-widest font-bold">{title}</h3>
        {selected.size > 0 && (
          <span className="text-amber-400 text-[11px] tracking-widest">{selected.size} selected</span>
        )}
      </div>

      {(movedLast > 0 || failures.size > 0) && (
        <div className="px-4 py-2 border-b border-[#1A3050] bg-[#0B1526] text-xs">
          {movedLast > 0 && (
            <p className="text-green-400">
              {movedLast} shift{movedLast === 1 ? '' : 's'} reassigned.
            </p>
          )}
          {failures.size > 0 && (
            <p className="text-red-400">
              {failures.size} could not be moved — still selected, with the reason on each row.
            </p>
          )}
        </div>
      )}

      {/* Assign bar. Only once something is ticked. */}
      {selected.size > 0 && (
        <div className="px-4 py-3 border-b border-[#1A3050] bg-[#0B1526] flex items-center gap-3 flex-wrap">
          <label htmlFor="bulk-reassign-guard" className="text-gray-500 text-[11px] tracking-widest">
            REASSIGN TO
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
              unavailable one will be refused when you reassign.
            </span>
          )}
          <button
            onClick={run}
            disabled={busy || !guardId}
            className="bg-amber-400 text-gray-900 font-bold rounded-lg px-4 py-2 text-xs tracking-widest hover:bg-amber-300 disabled:opacity-40 transition-colors"
          >
            {progress ? `MOVING ${progress.done}/${progress.total}…` : 'REASSIGN'}
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
                  aria-label="Select all reassignable shifts"
                  checked={allSelected}
                  onChange={toggleAll}
                  disabled={busy || movable.length === 0}
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
              const movableRow = isReassignable(s.status);
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
                        Not reassignable — already {s.status}.
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
          {blockedRows.length} shift{blockedRows.length === 1 ? '' : 's'} listed but not reassignable.
        </div>
      )}
    </div>
  );
}
