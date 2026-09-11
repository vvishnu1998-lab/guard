/**
 * Pure decision + copy for the bulk shift actions. No React, no fetch, so
 * `npm run check:bulk-cancel-copy` can execute it instead of reasoning about
 * it — same arrangement as lib/respondErrorCopy.ts on mobile.
 *
 * Two things live here and both are contracts the UI must not restate:
 *
 *   admits(verb, status)   which rows a given verb may act on. The two verbs
 *                          admit DIFFERENT statuses, which is why row
 *                          selectability is verb-aware rather than fixed.
 *   cancelFailureLabel(e)  the per-shift reason for a failed cancel, keyed on
 *                          the machine enum, never on prose.
 */
import { ApiError } from './adminApi';

/** Only these two statuses can move. Mirrors PATCH /:id/reassign, which
 *  refuses 'completed' and 'missed' with a 400, and mirrors the write set of
 *  PATCH /guards/:id/deactivate. A row outside this set is shown, greyed and
 *  labelled, never silently dropped. */
export function isReassignable(status: string): boolean {
  return status === 'scheduled' || status === 'active';
}

/** The two verbs admit DIFFERENT statuses, and that is the whole reason row
 *  selectability is verb-aware rather than fixed.
 *
 *  PATCH /shifts/:id/cancel admits 'scheduled' and NOTHING else — 'active'
 *  is refused (a guard is on post; see the route's own note on why it
 *  refuses rather than auto-closing), and so are completed/missed/cancelled/
 *  unassigned. Reassign additionally admits 'active', because an admin may
 *  legitimately move a shift that is in progress.
 *
 *  If selectability stayed fixed on isReassignable, every cancel batch
 *  containing an 'active' row would carry a guaranteed 409 the UI could have
 *  prevented. That is the defect this split exists to avoid. */
export function isCancellable(status: string): boolean {
  return status === 'scheduled';
}

export type BulkVerb = 'reassign' | 'cancel';

/** The single place that decides whether a row can take a given verb. */
export function admits(verb: BulkVerb, status: string): boolean {
  return verb === 'cancel' ? isCancellable(status) : isReassignable(status);
}

/** Guard-facing copy per machine reason. Branch on the ENUM, never on prose.
 *  Mirrors SlotAssignPanel's map; `already_on_shift` and `not_reassignable`
 *  are this endpoint's, `slot_full`/`template_changed` have no analogue on a
 *  shift and are absent rather than carried over dead. */
export const REASON_LABEL: Record<string, string> = {
  // Reassign — lowercase, from POST /api/guards/shift-candidates.
  guard_inactive:       'Inactive',
  not_reassignable:     'Already completed or missed',
  already_on_shift:     'Already on this shift',
  not_assigned_to_site: 'Not assigned to this site',
  overlap:              'Busy elsewhere',

  // Cancel — UPPERCASE, from PATCH /api/shifts/:id/cancel. Distinct
  // namespace, so one map serves both verbs without collision. Extended
  // rather than forked: a second map would drift.
  SHIFT_HAS_OPEN_SESSION: 'A guard is clocked in on this shift',
  SHIFT_NOT_SCHEDULED:    'No longer scheduled',
  ALREADY_CANCELLED:      'Already cancelled',
};

/** The cancel route is WEB-ONLY and web's ApiError has no `code` field — it
 *  keeps the parsed body on `.body`, so the enum is read from there. See the
 *  route docblock in apps/api/src/routes/shifts.ts for why the enum lives in
 *  `code` only and `error` keeps its prose. */
export function cancelFailureLabel(e: unknown): string {
  if (e instanceof ApiError) {
    const code = (e.body as { code?: unknown } | undefined)?.code;
    if (typeof code === 'string' && REASON_LABEL[code]) return REASON_LABEL[code];
    // 404 carries no code — both of the route's 404s mean the same thing to
    // an admin, and the row is gone from the list after the refetch either way.
    if (e.status === 404) return 'No longer exists';
    return e.message;
  }
  return 'Could not cancel';
}

