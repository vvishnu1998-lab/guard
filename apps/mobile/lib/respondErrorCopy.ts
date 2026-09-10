/**
 * Guard-facing copy for a failed swap/handoff accept or decline.
 *
 * ── WHY THIS IS ITS OWN MODULE ──────────────────────────────────────────
 *
 * It is pure — no React, no Sentry, no react-native — so it can be executed
 * by `npm run check:respond-copy` (scripts/check-respond-copy.ts). That check
 * proves this file's behaviour against TODAY'S API is byte-identical to the
 * status-only version it replaces. That property is what makes shipping the
 * mobile half FIRST safe, and it is worth being able to run rather than
 * reason about.
 *
 * ── THE DEFECT THIS FIXES (N46) ─────────────────────────────────────────
 *
 * The previous version keyed entirely on HTTP status and substituted
 *
 *     "This swap was already responded to, or it expired. Pull down to refresh."
 *
 * for EVERY 409. swap-response and handoff-response emit FOUR 409s each and
 * only one of the eight is that situation:
 *
 *   swap-response     :1777 already responded / expired   <- the message is right
 *                     :1829 shift no longer scheduled
 *                     :1834 admin reassigned the shift
 *                     :1850 recipient now double-booked
 *   handoff-response  :2111 already responded / expired   <- the message is right
 *                     :2155 shift no longer active
 *                     :2160 admin reassigned the shift
 *                     :2170 recipient clocked in elsewhere
 *
 * Six of eight told the guard the invite had expired when it had not, and the
 * advice ("pull down to refresh") was not merely wrong — it drove a retry.
 * The card renders only while status is 'pending' or 'accepted'
 * ((tabs)/notifications.tsx). On a real expiry the cron has already flipped
 * the row to 'expired', so refreshing makes the card DISAPPEAR and the advice
 * resolves the situation. On the other six the row is still 'pending', the
 * refetch brings the same card back, and a guard who has just been told the
 * invite expired sees it sitting there and taps again.
 *
 * ── HOW IT BRANCHES, AND WHY IN THAT ORDER ──────────────────────────────
 *
 *   1. err.code            — set by ApiError from the body's `error` field.
 *   2. err.details.code    — the body's `code` field.
 *   3. HTTP status         — the previous behaviour, RETAINED.
 *
 * Two code lookups because the API has two live conventions and this client
 * must read both. ApiError (lib/errors.ts:72) derives `.code` from
 * `body.error`, NOT from `body.code`, so a route that puts prose in `error`
 * and its enum in `code` — openSessionConflictBody does exactly this — never
 * matches on `.code`. lib/openSession.ts:42-56 documents that trap and reads
 * `details.code` for the same reason. Checking both means this file is
 * correct whichever convention a route lands on, and stays correct if one is
 * migrated to the other later.
 *
 * THE STATUS FALLBACK IS LOAD-BEARING AND MUST NOT BE REMOVED. It is what
 * runs during the gap window before the API ships codes, and it is what the
 * devices no OTA reaches keep running afterwards.
 */
import { ApiError } from './errors';

export type RespondKind = 'swap' | 'handoff';

/**
 * Copy per machine reason. Keyed on the ENUM, never on prose — the whole
 * point is that a server reword must not change client behaviour.
 *
 * `{kind}` is substituted with 'swap' or 'handoff'. Codes are listed for both
 * routes even though each route can only emit its own half; a shared map is
 * one place to read rather than two to keep in step.
 *
 * NOTE: none of these are emitted by the API yet. Until that ships every
 * lookup misses and the status fallback answers — which is exactly the
 * property check:respond-copy asserts.
 */
export const RESPOND_REASON_COPY: Record<string, string> = {
  // The one case the old blanket message was already right about.
  SWAP_NOT_PENDING:    'This {kind} was already responded to, or it expired. Pull down to refresh.',
  HANDOFF_NOT_PENDING: 'This {kind} was already responded to, or it expired. Pull down to refresh.',

  SHIFT_NOT_SCHEDULED: "That shift is no longer scheduled, so the {kind} can't go ahead. Pull down to refresh.",
  SHIFT_NOT_ACTIVE:    "That shift is no longer active, so the {kind} can't go ahead. Pull down to refresh.",

  SWAP_STALE_REASSIGNED:    'An admin has moved this shift to someone else, so the {kind} is no longer yours to accept.',
  HANDOFF_STALE_REASSIGNED: 'An admin has moved this shift to someone else, so the {kind} is no longer yours to accept.',

  // Deliberately does NOT say "refresh" — refreshing changes nothing here.
  // The guard has to resolve the clash, not reload the screen.
  RECIPIENT_OVERLAP:   "You already have another shift over these hours, so you can't take this one. Tell your supervisor if that looks wrong.",
  OPEN_SESSION_EXISTS: "You're clocked in to another shift right now. Clock out of it before accepting this {kind}.",
};

/** Machine code from either convention, or null. See the module docblock. */
export function respondReasonCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  const fromDetails = (err.details as { code?: unknown } | undefined)?.code;
  if (typeof fromDetails === 'string' && fromDetails in RESPOND_REASON_COPY) return fromDetails;
  if (typeof err.code === 'string' && err.code in RESPOND_REASON_COPY) return err.code;
  return null;
}

/**
 * The copy for a failed respond, or null when the caller should fall through
 * to guardMessage(). Null is returned for anything this file has no better
 * answer for than the generic fallback — 400, 422, 500, transport failures,
 * and our own bugs.
 *
 * 422 must keep falling through: it is swap-response's eligibility
 * explanation and the server's sentence is the only place that detail exists.
 */
export function respondConflictCopy(err: unknown, kind: RespondKind): string | null {
  if (!(err instanceof ApiError)) return null;

  const code = respondReasonCode(err);
  if (code) return RESPOND_REASON_COPY[code].split('{kind}').join(kind);

  // ── Status fallback. Unchanged from the pre-N46 behaviour. ────────────
  if (err.status === 409) {
    return `This ${kind} was already responded to, or it expired. Pull down to refresh.`;
  }
  if (err.status === 403) {
    return `This ${kind} request isn't addressed to you.`;
  }
  if (err.status === 404) {
    // BOTH 404s per route collapse here — "request not found" and "shift not
    // found". Left collapsed on purpose: distinguishing them needs codes on
    // the 404s too, which is a wider API change than N46 scoped, and both
    // situations genuinely resolve the same way. The card is gone after a
    // refresh either way, so the advice is correct for both.
    return `This ${kind} request no longer exists. Pull down to refresh.`;
  }
  return null;
}
