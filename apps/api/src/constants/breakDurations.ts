/**
 * Break policy source of truth.
 *
 * Keep in sync with apps/mobile/constants/breakDurations.ts. That file is a
 * hand-maintained copy — the monorepo has no shared package between apps/api
 * and apps/mobile, and introducing one is not in scope here. The drift
 * control is: this header names the mobile path, the mobile header names
 * this path, and BOTH must land in the same batch. Anything derived from
 * these numbers that the CLIENT must agree with is ALSO sent on the wire
 * (planned_duration_minutes on break-start, the whole break_quotas object on
 * active-session), so a drifted mobile constant degrades the UI copy but can
 * never change an accept/reject decision — the server is the only authority.
 *
 * ── ONE BREAK TYPE (design locked 2026-08-29) ────────────────────────────
 *
 * Previously three types (meal 30 / rest 15 / other 10) with a per-type
 * quota. Now ONE type, label "break", 30 minutes, PAID. The type column no
 * longer carries a decision, only a label; allowance is derived from the
 * SCHEDULED length of the shift instead.
 *
 * The historical 30/15/10 distinction is not lost: it lives on each existing
 * row in break_sessions.planned_duration_minutes, which schema_v61 leaves
 * untouched while relabelling break_type.
 */

/** The only break type. schema_v62 narrows the DB CHECK to this single value. */
export type BreakType = 'break';

export const BREAK_TYPE: BreakType = 'break';

/** Planned length of a break, in minutes. Drives break_sessions.planned_duration_minutes,
 *  and therefore breakExpiryCron's auto-close at break_start + plan. */
export const BREAK_DURATION_MINUTES = 30;

/**
 * A break whose break_end lands within this many seconds of its
 * break_start is a mis-tap: it does not burn allowance. Chosen over a
 * duration_minutes=0 test because duration is computed at CLOSE and
 * cannot gate a check at START; a start-then-immediately-end also
 * cannot farm allowance this way.
 *
 * Load-bearing in prod: 15 of the 26 break_sessions rows at the time of
 * writing are sub-60-second mis-taps, most of them from the double-tap that
 * starts-then-ends a break. Removing this would have charged real guards for
 * a UI defect.
 */
export const BREAK_MISTAP_SECONDS = 60;

/**
 * Allowance boundary. A shift SCHEDULED at more than this many hours earns a
 * second break.
 *
 * Boundary picked against real data: STARNET's schedule is effectively two
 * lengths, 6.00h (49 shifts) and 12.00h (17). Every value in (6, 10) splits
 * that population identically, so 8 is the round number in the middle of a
 * wide safe band rather than a threshold anything sits on. Note the
 * comparison is strictly greater-than, so an exactly-8.00h shift earns ONE
 * break — the 6-8 bucket for STARNET is entirely 6.00h, so nothing real
 * currently sits on the boundary either.
 */
export const BREAK_LONG_SHIFT_HOURS = 8;

/**
 * Gate 1 — a shift's FIRST break requires this many minutes elapsed since
 * the guard actually clocked in (MIN(clocked_in_at) across every session on
 * the shift, so a handoff inherits the original clock-in rather than
 * restarting the clock).
 *
 * Measured from ACTUAL clock-in, not scheduled_start: a guard who clocks in
 * late has not yet worked four hours, and a guard who clocks in early has.
 */
export const BREAK_FIRST_AFTER_MINUTES = 240;

/**
 * Gate 2 — a subsequent break requires this many minutes between the
 * previous break's break_end and the new break's break_start.
 */
export const BREAK_MIN_GAP_MINUTES = 120;

/**
 * Breaks allowed on a shift of `scheduledHours` scheduled hours.
 *
 * SHIFT-scoped, not session-scoped: the allowance belongs to the shift, so
 * after a handoff guard B inherits whatever guard A already consumed. The
 * caller is responsible for counting used breaks across ALL sessions on the
 * shift — see the break-start gate in routes/shifts.ts.
 *
 * Defensive on a non-finite input (a NULL scheduled_start/end reaching here
 * would otherwise yield NaN > 8 === false, silently granting 1): an
 * unusable length grants the smaller allowance, which is the direction that
 * cannot over-grant.
 */
export function breakAllowanceForShift(scheduledHours: number): number {
  if (!Number.isFinite(scheduledHours)) return 1;
  return scheduledHours > BREAK_LONG_SHIFT_HOURS ? 2 : 1;
}

export function isBreakType(v: unknown): v is BreakType {
  return v === 'break';
}

/**
 * Labels that older mobile bundles still put on the wire. Storage is ALWAYS
 * 'break' — this list only decides what the API is willing to be told.
 */
const LEGACY_WIRE_BREAK_TYPES: readonly string[] = ['meal', 'rest', 'other'];

/**
 * Normalise a client-supplied break_type to the single stored value, or null
 * if it is not a label we recognise at all.
 *
 * ── WHY THIS SHIM EXISTS ─────────────────────────────────────────────────
 *
 * This is NOT part of the one-break-type design; it is a deploy-safety shim,
 * and it should be deleted once no shipped bundle sends a legacy label.
 *
 * Every mobile binary and OTA in the field today sends 'meal' | 'rest' |
 * 'other'. Verified 2026-08-29: Build 46 is the newest binary, the newest
 * production OTA group is 20e07590 (from 451abc0), and the break screen on
 * BOTH sends one of the three legacy labels. The mobile fix is a separate
 * phase that explicitly does not build or publish, so there is a window —
 * possibly a long one — in which the new API serves old clients.
 *
 * Without this shim, a strict isBreakType() check would 400 every
 * break-start from every guard in the field the moment the API deploys.
 * That is the precise cross-tier failure this codebase has already shipped
 * twice: a server-side change whose client half was not landed in the same
 * dispatch, invisible in server logs because the client simply stops being
 * able to proceed.
 *
 * Rejecting an unknown string is still correct — that is a malformed request,
 * not an old client.
 *
 * ── REMOVAL PRECONDITION (added 2026-08-29) ──────────────────────────────
 *
 * Delete this shim, and go back to a strict isBreakType() check, ONLY once
 * no bundle in the field can still send a legacy label. Concretely, ALL of:
 *
 *   * every active iOS build carries the Phase 5 break screen, and
 *   * every published OTA update group on ALL THREE channels — production,
 *     preview, smoke — carries it too.
 *
 * A channel is easy to forget: `eas update:republish` targets one branch,
 * so preview and smoke can sit on an older bundle indefinitely while
 * production looks current.
 *
 * Blockers as of 2026-08-29, by id:
 *
 *   * iOS Build 46 — commit be2c9015 ("feat(mobile): vehicle inspection flow
 *     + site-flag gating"). Newest binary; its EMBEDDED bundle sends legacy
 *     labels, and at least one real device is running exactly that with no
 *     OTA applied (STARNET guard 802a842f, is_embedded_launch = true).
 *   * production OTA group 20e07590-b77b-46f2-903b-2cc2cd1cd0f0 — commit
 *     451abc0, published 2026-08-26. Newest published bundle; also sends
 *     legacy labels.
 *
 * Both were read directly, not inferred: break/index.tsx on main and on
 * origin/batch/mobile-14 both post one of 'meal' | 'rest' | 'other'.
 *
 * Do not delete this on the grounds that a NEWER build exists — the test is
 * that no OLDER one is still in use. Check active installs, not the newest
 * artifact.
 */
export function normalizeWireBreakType(v: unknown): BreakType | null {
  if (v === BREAK_TYPE) return BREAK_TYPE;
  if (typeof v === 'string' && LEGACY_WIRE_BREAK_TYPES.includes(v)) return BREAK_TYPE;
  return null;
}
