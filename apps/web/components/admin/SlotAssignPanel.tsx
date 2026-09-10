'use client';
/**
 * Template slot list with multi-select bulk assign.
 *
 * Rendered above the shift table on /admin/shifts/site/[siteId]. Shows every
 * slot the active scheduling profile expands to inside the coverage window —
 * filled or not — and lets an admin tick several and assign one guard to all
 * of them in a single action.
 *
 * ── This is the app's FIRST multi-select. It is built plainly. ────────────
 *
 * A Set<string> of slot_start values, a header checkbox, and a per-row
 * checkbox. No selection framework, no generic <DataTable>, no context. When
 * a second multi-select surface appears, THAT is the moment to extract a
 * shared one — with two real call sites to design against rather than one
 * imagined pair.
 *
 * ── Why a separate table from the shift table below ──────────────────────
 *
 * A slot is not a row in the database; it has no detail page. The shift
 * table's <tr> is a role="link" with an onKeyDown that preventDefault()s
 * Space — which is exactly the key that toggles a focused checkbox — so
 * putting checkboxes in THAT table would mean fighting its own keyboard
 * handler on every row. This table navigates nowhere, so it carries no
 * role="link", no tabIndex on the row, and inherits none of that.
 *
 * ── Two windows, stated in the heading ───────────────────────────────────
 *
 * The shift table below covers -1d..+90d. This covers the coverage window,
 * 14 days from today site-local. They are different ranges over the same
 * site, so the heading names its own dates rather than leaving an admin to
 * assume one range governs both.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { adminGet, adminPost } from '../../lib/adminApi';

interface Slot {
  slot_start:           string;
  slot_end:             string;
  guards_needed:        number;
  filled:               number;
  matched_shift_ids:    string[];
  unassigned_shift_ids: string[];
}

interface SlotsResponse {
  site_id:            string;
  site_timezone:      string;
  has_active_profile: boolean;
  has_slots:          boolean;
  window:             { from: string; to: string } | null;
  slots:              Slot[];
}

interface BlockedEntry {
  slot_start: string;
  reason:     string;
  conflict?:  { site_name: string; scheduled_start: string; scheduled_end: string } | null;
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

interface AssignFailure {
  slot_start: string;
  reason:     string;
  message:    string;
}

/** Guard-facing copy per machine reason. Branch on the ENUM, never on prose —
 *  the server's sentence is shown as-is where it carries detail the client
 *  cannot reconstruct, but the short label comes from the code. */
const REASON_LABEL: Record<string, string> = {
  overlap:              'Busy elsewhere',
  already_on_slot:      'Already on this slot',
  not_assigned_to_site: 'Not assigned to this site',
  guard_inactive:       'Inactive',
  slot_full:            'Slot filled up',
  template_changed:     'Template changed',
  write_failed:         'Could not save',
};

function fmt(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }).format(new Date(iso));
}

export default function SlotAssignPanel({
  siteId, onAssigned,
}: {
  siteId: string;
  /** Called after any slot was assigned, so the page refetches its shift table. */
  onAssigned: () => void;
}) {
  const [data,    setData]    = useState<SlotsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  // Selection is keyed on slot_start — the slot identity. site_profile_shifts
  // row ids are recreated by any template edit and would go stale mid-selection.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [candidates,     setCandidates]     = useState<Candidate[] | null>(null);
  const [candLoading,    setCandLoading]    = useState(false);
  const [chosenGuard,    setChosenGuard]    = useState('');
  const [assigning,      setAssigning]      = useState(false);
  const [failures,       setFailures]       = useState<AssignFailure[]>([]);
  const [lastAssigned,   setLastAssigned]   = useState(0);

  const loadSlots = useCallback(async () => {
    try {
      const d = await adminGet<SlotsResponse>(`/api/scheduling/site/${siteId}/slots`);
      setData(d); setError('');
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [siteId]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  const tz = data?.site_timezone ?? 'America/Los_Angeles';

  // Every guard is evaluated against the WHOLE selection before the admin
  // picks, so nobody is offered and then rejected. Refetched on every change
  // to the selection — the answer is only true for the set it was asked about.
  useEffect(() => {
    if (selected.size === 0) { setCandidates(null); setChosenGuard(''); return; }
    let cancelled = false;
    setCandLoading(true);
    adminPost<{ candidates: Candidate[] }>(
      `/api/scheduling/site/${siteId}/slot-candidates`,
      // Array.from, not spread: apps/web's tsconfig target predates
      // downlevelIteration, so [...set] is a compile error here.
      { slot_starts: Array.from(selected) },
    )
      .then((r) => { if (!cancelled) setCandidates(r.candidates); })
      .catch((e: any) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setCandLoading(false); });
    return () => { cancelled = true; };
  }, [selected, siteId]);

  const selectableSlots = useMemo(
    () => (data?.slots ?? []).filter((s) => s.filled < s.guards_needed),
    [data],
  );

  function toggle(slotStart: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slotStart)) next.delete(slotStart); else next.add(slotStart);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) =>
      prev.size === selectableSlots.length
        ? new Set()
        : new Set(selectableSlots.map((s) => s.slot_start)));
  }

  async function assign() {
    if (!chosenGuard || selected.size === 0) return;
    setAssigning(true);
    try {
      const slots = (data?.slots ?? [])
        .filter((s) => selected.has(s.slot_start))
        // guards_needed and filled go back with the request so the server can
        // detect a template edit underneath the selection and reject rather
        // than assign against stale arithmetic.
        .map((s) => ({ slot_start: s.slot_start, guards_needed: s.guards_needed, filled: s.filled }));

      const r = await adminPost<{
        assigned: Array<{ slot_start: string }>;
        failed:   AssignFailure[];
      }>(`/api/scheduling/site/${siteId}/assign-slots`, { guard_id: chosenGuard, slots });

      setLastAssigned(r.assigned.length);
      setFailures(r.failed);
      // PARTIAL: the ones that worked are done and untick; the ones that did
      // not stay ticked, so the admin can pick a different guard for exactly
      // those without reconstructing the selection.
      setSelected(new Set(r.failed.map((f) => f.slot_start)));
      setChosenGuard('');
      await loadSlots();
      if (r.assigned.length > 0) onAssigned();
    } catch (e: any) { setError(e.message); }
    finally { setAssigning(false); }
  }

  if (loading) {
    return (
      <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl p-6 text-gray-500 text-sm">
        Loading template slots…
      </div>
    );
  }
  // Silent when there is no template — this surface has nothing to say about a
  // site that does not use scheduling profiles.
  if (!data?.has_active_profile) return null;

  const failureBySlot = new Map(failures.map((f) => [f.slot_start, f]));
  const allSelected = selectableSlots.length > 0 && selected.size === selectableSlots.length;

  return (
    <div className="bg-[#0F1E35] border border-[#1A3050] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[#1A3050] flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-gray-300 text-xs tracking-widest font-bold">TEMPLATE SLOTS</h2>
          {/* Its OWN range — the shift table below covers a different one. */}
          <p className="text-gray-600 text-[11px] mt-0.5">
            {data.window
              ? <>{fmt(data.window.from, tz, { day: 'numeric', month: 'short' })} – {fmt(data.window.to, tz, { day: 'numeric', month: 'short' })} · site local</>
              : 'No slots configured'}
          </p>
        </div>
        {selected.size > 0 && (
          <span className="text-amber-400 text-[11px] tracking-widest">
            {selected.size} selected
          </span>
        )}
      </div>

      {!data.has_slots ? (
        <div className="p-6 text-gray-500 text-sm">No slots configured for this site.</div>
      ) : (
        <>
          {/* ── Assign bar. Only once something is ticked. ──────────────── */}
          {selected.size > 0 && (
            <div className="px-4 py-3 border-b border-[#1A3050] bg-[#0B1526] flex items-center gap-3 flex-wrap">
              <label htmlFor="slot-guard" className="text-gray-500 text-[11px] tracking-widest">
                ASSIGN TO
              </label>
              <select
                id="slot-guard"
                value={chosenGuard}
                onChange={(e) => setChosenGuard(e.target.value)}
                disabled={candLoading || assigning}
                className="bg-[#0F1E35] border border-[#1A3050] rounded-lg px-3 py-2 text-sm text-gray-200 min-w-[18rem] disabled:opacity-50"
              >
                <option value="">{candLoading ? 'Checking availability…' : 'Select a guard…'}</option>
                {(candidates ?? []).map((c) => {
                  const free = c.free_count === c.total;
                  // Unavailable guards are GREYED WITH THE REASON, never
                  // hidden. A missing name is what makes an admin ask "where
                  // is X?" and get no answer.
                  const first = c.blocked[0];
                  const why = first
                    ? `${REASON_LABEL[first.reason] ?? first.reason}${
                        first.conflict
                          ? `: ${first.conflict.site_name} ${fmt(first.conflict.scheduled_start, tz, { weekday: 'short', hour: '2-digit', minute: '2-digit' })}`
                          : ''}`
                    : '';
                  return (
                    <option key={c.guard_id} value={c.guard_id} disabled={c.free_count === 0}>
                      {c.name} ({c.badge_number}) — {
                        free
                          ? `free for all ${c.total}`
                          : c.free_count === 0
                            ? why
                            : `free for ${c.free_count} of ${c.total} — ${why}`
                      }
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                onClick={assign}
                disabled={!chosenGuard || assigning}
                className="bg-amber-400 text-gray-900 font-bold tracking-widest text-xs px-4 py-2 rounded-lg hover:bg-amber-300 disabled:opacity-40 transition-colors"
              >
                {assigning ? 'ASSIGNING…' : `ASSIGN ${selected.size}`}
              </button>
              <button
                type="button"
                onClick={() => { setSelected(new Set()); setFailures([]); }}
                className="text-gray-500 hover:text-gray-300 text-[11px] tracking-widest"
              >
                CLEAR
              </button>
            </div>
          )}

          {(lastAssigned > 0 || failures.length > 0) && (
            <div className="px-4 py-2 border-b border-[#1A3050] text-xs">
              {lastAssigned > 0 && (
                <span className="text-green-400">{lastAssigned} slot{lastAssigned === 1 ? '' : 's'} assigned. </span>
              )}
              {failures.length > 0 && (
                <span className="text-amber-300">
                  {failures.length} left ticked — see the reason on each row.
                </span>
              )}
            </div>
          )}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-gray-500 text-xs tracking-widest border-b border-[#1A3050]">
                  <th className="p-3 w-10 text-left">
                    <input
                      type="checkbox"
                      aria-label="Select all unfilled slots"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectableSlots.length === 0}
                      className="accent-amber-400 w-4 h-4 align-middle"
                    />
                  </th>
                  <th className="text-left p-3">DAY</th>
                  <th className="text-left p-3">TIME</th>
                  <th className="text-left p-3">FILLED</th>
                  <th className="text-left p-3"></th>
                </tr>
              </thead>
              <tbody>
                {data.slots.map((s) => {
                  const full = s.filled >= s.guards_needed;
                  const isSel = selected.has(s.slot_start);
                  const fail = failureBySlot.get(s.slot_start);
                  return (
                    <tr
                      key={s.slot_start}
                      className={`border-b border-[#1A3050] last:border-b-0 ${
                        fail ? 'bg-amber-400/5' : isSel ? 'bg-[#0B1526]' : ''
                      }`}
                    >
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={isSel}
                          onChange={() => toggle(s.slot_start)}
                          disabled={full}
                          aria-label={`Select slot ${fmt(s.slot_start, tz, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`}
                          className="accent-amber-400 w-4 h-4 align-middle disabled:opacity-30"
                        />
                      </td>
                      <td className="p-3 text-gray-300 text-xs font-mono whitespace-nowrap">
                        {fmt(s.slot_start, tz, { weekday: 'short', day: 'numeric', month: 'short' })}
                      </td>
                      <td className="p-3 text-gray-400 text-xs font-mono whitespace-nowrap">
                        {fmt(s.slot_start, tz, { hour: '2-digit', minute: '2-digit' })}
                        {' → '}
                        {fmt(s.slot_end, tz, { hour: '2-digit', minute: '2-digit' })}
                      </td>
                      <td className="p-3 text-xs whitespace-nowrap">
                        {/* "1 of 2" — a partly-filled slot stays tickable so
                            the second guard is reachable from here. */}
                        <span className={full ? 'text-green-400' : 'text-amber-400'}>
                          {s.filled} of {s.guards_needed}
                        </span>
                      </td>
                      <td className="p-3 text-xs">
                        {fail && (
                          <span className="text-amber-300">
                            {REASON_LABEL[fail.reason] ?? fail.reason} — {fail.message}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {error && <div className="px-4 py-3 text-red-300 text-xs border-t border-[#1A3050]">{error}</div>}
    </div>
  );
}
