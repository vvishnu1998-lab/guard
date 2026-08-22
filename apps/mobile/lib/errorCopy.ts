/**
 * The single place that decides what error text a guard is allowed to see.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────
 *
 * `err.message` is guard-facing ONLY when we know who wrote it. That is
 * true for an ApiError (the server's own copy) and a GuardFacingError (our
 * copy). It is NOT true for anything else — React Native's fetch rejection
 * carries the message "Network request failed", which was shown verbatim
 * to a guard on 2026-08-22 under the heading "LINK FAILED".
 *
 * Before this file, 37 call sites did `err?.message ?? 'Could not do X'`.
 * That reads as a safe default and is not one: the `??` only fires when
 * `message` is null or undefined, which for a real Error it never is. The
 * fallback was effectively dead and the raw text always won.
 *
 * ── CHOOSING A FALLBACK ─────────────────────────────────────────────────
 *
 * The fallback is shown only in the last case — an unexpected internal
 * failure. It should still tell the guard what did not happen and what to
 * do next. "Something went wrong" repeated across the app teaches nothing:
 * a guard who reads it on a clock-in and again on a checkpoint scan cannot
 * tell the two situations apart, cannot tell whether their shift started,
 * and has no idea whether to retry or call someone.
 *
 * Write it as: <what failed>. <what to do>.
 *   good  "Could not end your shift. Try again, or tell your supervisor."
 *   bad   "Something went wrong."
 */
import * as Sentry from '@sentry/react-native';
import { ApiError, NetworkError, GuardFacingError } from './errors';

/**
 * Shown whenever the request never reached the server. Deliberately does
 * not say "you are offline" — we do not know that. We know we could not
 * reach the server, which is a different and honest claim.
 */
export const NETWORK_COPY =
  "We couldn't reach the server. Check your signal and try again.";

/**
 * Resolve the text to show a guard for a caught error.
 *
 * @param fallback  Copy for an unexpected internal failure. Say what failed
 *                  and what to do — see the note above.
 * @param where     Stable identifier for the call site, e.g. 'clock-out'.
 *                  Attached to the Sentry event so an unexpected failure is
 *                  traceable to a screen without a stack.
 */
export function guardMessage(err: unknown, fallback: string, where: string): string {
  // Server-authored copy. Branch on err.code at the call site if a specific
  // failure needs bespoke handling — never on err.status alone.
  if (err instanceof ApiError) return err.message;

  // Our own copy, raised deliberately.
  if (err instanceof GuardFacingError) return err.message;

  // Transport failure. The guard learns the write did not land.
  if (err instanceof NetworkError) return NETWORK_COPY;

  // Anything else is a defect. The guard gets our fallback; we get an issue.
  Sentry.captureException(err, { extra: { where, handledBy: 'guardMessage' } });
  return fallback;
}
