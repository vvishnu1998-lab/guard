/**
 * Shared guard-facing copy that is POLICY rather than screen text.
 *
 * lib/errorCopy.ts owns what a guard is told when something fails. This owns
 * the handful of lines that are the same sentence everywhere by decision,
 * not by coincidence — where two screens drifting apart would mean two
 * guards being told different things about the same obligation.
 */

/**
 * Swap and handoff are guard-to-guard: the app moves the shift, but no
 * supervisor is in the loop on either side. The admin FYI email fires only
 * on ACCEPT (services/email.ts sendSwapAcceptedFyi / sendHandoffCompletedFyi)
 * — nothing at all is sent when a request is merely raised — so between
 * request and acceptance the roster has changed in the app and nowhere else.
 *
 * This line appears on both sides of both flows: the requester when they
 * send, and the acceptor when they accept. Identical wording is the point.
 * A guard who reads one phrasing when sending and a different one when
 * accepting has to work out whether they are two different instructions.
 */
export const NOTIFY_SUPERVISOR = 'Please notify your supervisor or manager.';
