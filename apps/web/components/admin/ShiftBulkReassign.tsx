'use client';
/**
 * Bulk shift actions for the GUARD DEACTIVATION DIALOG — a compact table,
 * wired to the shared controller.
 *
 * ── Why this still exists as its own component ──────────────────────────
 *
 * /admin/shifts/site/[siteId] used to render this too. It no longer does: its
 * schedule table absorbed the checkboxes, so that page has ONE table instead
 * of two that looked alike, and the picker there now shows the guard, the
 * duration, the status pill and the inspection badge — the columns that
 * actually matter while picking, and which this table has never had.
 *
 * This one stayed because the dialog is not a schedule. Its list SPANS SITES
 * (hence the SITE column, which would be dead weight on a single-site page),
 * it sits in a modal, and it answers "what does this guard hold" rather than
 * "what is happening at this post". Merging it into something schedule-shaped
 * would mean inventing a schedule the dialog does not have.
 *
 * ── What it owns: the table, and only the table ─────────────────────────
 *
 * Selection, the verb, the guard dropdown, the confirm step and the write
 * loop all live in BulkShiftActions. This file is the rows. If you are
 * looking for run(), the endpoint routing or the partial-results rules, they
 * are there.
 */
import BulkShiftActions from './BulkShiftActions';
import type { BulkShiftRow } from './BulkShiftActions';
import { blockedLabel, REASON_LABEL } from '../../lib/bulkShiftCopy';
import { fmtDateShort, fmtTime } from '../../lib/shiftFormat';

// Re-exported so existing importers keep working unchanged — the decision
// moved to lib/bulkShiftCopy.ts so a check could EXECUTE it, not because the
// consumers should have to know that. GuardDeactivateDialog imports
// isAssignable from here.
export { isAssignable, isCancellable, admits } from '../../lib/bulkShiftCopy';
export type { BulkVerb } from '../../lib/bulkShiftCopy';
/** Kept under its original name: GuardDeactivateDialog imports it from here. */
export type ReassignableShift = BulkShiftRow;

interface Guard { id: string; name: string; badge_number: string; is_active?: boolean }

interface Props {
  shifts:  BulkShiftRow[];
  guards:  Guard[];
  excludeGuardId?: string;
  reason?: string;
  onDone:  (movedCount: number) => void;
  title?:  string;
  allowCancel?: boolean;
}

export default function ShiftBulkReassign(props: Props) {
  const { shifts } = props;
  return (
    <BulkShiftActions {...props}>
      {({ verb, selected, canSelect, toggle, toggleAll, allSelected,
          eligibleCount, busy, failures, chosenBlocked }) => (
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
                    disabled={busy || eligibleCount === 0}
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
                const movableRow = canSelect(s.id);
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
                          {blockedLabel(verb, s.status)}
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
      )}
    </BulkShiftActions>
  );
}
