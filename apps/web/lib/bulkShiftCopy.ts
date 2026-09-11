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

/** Can a guard be put on this shift — by moving one, or by filling an empty
 *  post. ONE verb covers both: the admin is picking a guard either way, and
 *  the reassign/assign split is the system's distinction, not theirs.
 *
 *  'unassigned' is admitted because filling an empty post is exactly what an
 *  admin looking at one wants to do. It used to be refused, which left four
 *  production rows greyed out reading "nobody is on this shift to move" —
 *  true, and useless.
 *
 *  Refused: 'completed' and 'missed' (PATCH /:id/reassign 400s both) and
 *  'cancelled' (a cancelled shift is not work any more). A row outside this
 *  set is shown, greyed and labelled, never silently dropped.
 *
 *  WHICH ENDPOINT a row goes to is decided at submit time on this same
 *  status — see ShiftBulkReassign's run(). This predicate only decides
 *  whether the row may be ticked. */
export function isAssignable(status: string): boolean {
  return status === 'scheduled' || status === 'active' || status === 'unassigned';
}

/** The two verbs admit DIFFERENT statuses, which is why row selectability is
 *  verb-aware rather than fixed.
 *
 *  CANCEL is now a strict SUBSET of ASSIGN — {scheduled, unassigned} inside
 *  {scheduled, active, unassigned}. It was not always: before the ASSIGN verb
 *  the two sets were disjoint-ish and this docblock claimed "neither verb's
 *  set contains the other's", which is no longer true and is recorded here so
 *  nobody re-derives the old shape from a stale sentence.
 *
 *  WHAT IS ACTUALLY TRUE: 'active' is ASSIGNABLE and NOT CANCELLABLE, and it
 *  is the only status the two verbs disagree on. An admin may legitimately
 *  move a shift that is in progress — the guard on post changes. Cancelling
 *  one is refused outright, because a guard is clocked in and the route will
 *  not silently decide their paid hours (see the cancel route's REFUSE, NOT
 *  AUTO-CLOSE note).
 *
 *  Subset or not, these stay TWO predicates rather than one with a flag. The
 *  reasons differ per status and the callers read differently; collapsing
 *  them would mean encoding "except active" at every call site.
 *
 *  If selectability were fixed on isAssignable, every cancel batch containing
 *  an 'active' row would carry a guaranteed 409 the UI could have prevented.
 *  That is the defect this split exists to avoid. */
export function isCancellable(status: string): boolean {
  return status === 'scheduled' || status === 'unassigned';
}

export type BulkVerb = 'assign' | 'cancel';

/** The single place that decides whether a row can take a given verb. */
export function admits(verb: BulkVerb, status: string): boolean {
  return verb === 'cancel' ? isCancellable(status) : isAssignable(status);
}

/** Why a listed row cannot take the active verb.
 *
 *  TWO tables render this now — the merged schedule table on
 *  /admin/shifts/site/[siteId] and ShiftBulkReassign's own table in the
 *  deactivation dialog — so the sentence lives here rather than in either of
 *  them. It is the one thing about a blocked row that must not differ between
 *  the two surfaces: an admin who sees "already completed" in one place and
 *  something else in the other has to work out whether they mean the same.
 *
 *  'active' gets its own sentence under CANCEL because a clocked-in guard is a
 *  different reason from a finished shift, and it is the only status the two
 *  verbs disagree on. Every other status that reaches here is something the
 *  shift FINISHED being, so "already X" reads correctly. */
export function blockedLabel(verb: BulkVerb, status: string): string {
  if (verb === 'cancel') {
    return status === 'active'
      ? 'Not cancellable — a guard is clocked in.'
      : `Not cancellable — already ${status}.`;
  }
  return `Not assignable — already ${status}.`;
}

/** Guard-facing copy per machine reason. Branch on the ENUM, never on prose.
 *  Mirrors SlotAssignPanel's map; `already_on_shift` and `not_reassignable`
 *  are this endpoint's, `slot_full`/`template_changed` have no analogue on a
 *  shift and are absent rather than carried over dead. */
export const REASON_LABEL: Record<string, string> = {
  // Assign — lowercase, from POST /api/guards/shift-candidates. These are
  // PRE-FLIGHT reasons shown in the dropdown, not write failures; neither
  // assign route emits a machine code today (filed as N83), so a failed
  // assign falls back to the server's prose.
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

