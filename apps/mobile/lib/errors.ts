/**
 * Error taxonomy for every network call the app makes.
 *
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────
 *
 * On 2026-08-22 a checkpoint scan from a device with a mock-location app
 * was rejected by the server with 422 MOCK_LOCATION_REJECTED. The guard was
 * shown "SAVED OFFLINE — saved and will sync automatically". The write had
 * been refused, could never succeed on replay, and was silently discarded.
 *
 * The cause was not the mock gate. It was that the client had only TWO
 * categories — "ApiError" and "everything else" — and treated the second as
 * "the network is down, queue it". A transport failure and a bug in our own
 * code were indistinguishable, and both looked like being offline.
 *
 * There are three distinct situations and they need three different
 * responses. Collapsing any two of them is what produced that screen.
 *
 *   ApiError       The server received the request and answered. Its
 *                  `message` is human copy written by us, server-side, and
 *                  is the ONLY error text that may be shown to a guard
 *                  verbatim. Branch on `.code`, never on `.status` alone —
 *                  most routes emit several different errors at 422.
 *
 *   NetworkError   `fetch` itself rejected. The request may or may not have
 *                  reached the server; we cannot know. Queue-eligible.
 *                  Its `message` is a CODE, never shown to a guard.
 *
 *   anything else  A bug in our own code — a thrown TypeError, a failed GPS
 *                  read, a bad assumption. NOT queue-eligible (there is
 *                  nothing a retry would fix) and never shown raw.
 *
 * These live here rather than in apiClient because refreshManager needs
 * them too and apiClient already imports refreshManager. apiClient
 * re-exports all of them, so existing `from './apiClient'` imports keep
 * working.
 */

/**
 * Structured server error. Thrown for any non-2xx response with a
 * parseable JSON body. Preserves the HTTP status + the server's
 * `error` code + user-facing `message` field so downstream call sites
 * can branch on the code (e.g. PING_OFF_POST) and show a friendly
 * toast rather than the raw enum string.
 *
 * .message inherits from Error and is set to the server's `message`
 * field when present, else `error`, else "Request failed". Keeps
 * legacy `catch (err) { Alert.alert(err.message) }` code working —
 * they now get the friendly message for free.
 *
 * BRANCH ON `.code`, NOT `.status`. Since Wave 2 every guard GPS write
 * route can return more than one distinct error at 422 (its own
 * off-post/quota/window failure, plus MOCK_LOCATION_REJECTED). A branch
 * keyed on status alone will attribute one to the other and tell the
 * guard to fix the wrong thing — checkpoints/scan.tsx rendered a mock
 * rejection as "GPS signal too weak" for exactly this reason.
 *
 * Instantiated only by apiClient.request; do not throw directly.
 */
export class ApiError extends Error {
  status: number;
  code:   string | null;
  details: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    const message =
      (typeof body.message === 'string' && body.message) ||
      (typeof body.error   === 'string' && body.error)   ||
      `Request failed (HTTP ${status})`;
    super(message);
    this.name    = 'ApiError';
    this.status  = status;
    this.code    = typeof body.error === 'string' ? body.error : null;
    this.details = body;
  }
}

/**
 * Thrown when a 401's follow-up refresh was DEFINITIVELY rejected — the
 * session is revoked (tokens_not_before bump, rotated/expired refresh
 * token). Extends ApiError so isNetworkError() returns false: offlineStore
 * must propagate this to the UI, never queue-and-retry it (the pre-Build-48
 * misclassification retried revoked sessions into the shared /api/auth
 * rate-limit budget — deepak lockout, 2026-08-20). `.message` keeps the
 * legacy copy so existing `Alert.alert(err.message)` call sites still read
 * correctly.
 */
export class SessionExpiredError extends ApiError {
  constructor() {
    super(401, { error: 'SESSION_EXPIRED', message: 'Session expired. Please log in again.' });
    this.name = 'SessionExpiredError';
  }
}

/**
 * `fetch` rejected before any status code came back — offline, DNS
 * failure, TLS failure, connection reset, abort. The request may have
 * reached the server and been processed; we have no way to tell, which is
 * exactly why the guard must never be told the write succeeded.
 *
 * `.message` is the constant string 'NETWORK_UNREACHABLE' and is a CODE,
 * not copy. React Native's own text here is "Network request failed",
 * which is developer English and was shown to a guard on 2026-08-22.
 * Route all guard-facing text through guardMessage() in lib/errorCopy.ts.
 *
 * `cause` keeps the original rejection for Sentry.
 */
export class NetworkError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super('NETWORK_UNREACHABLE');
    this.name = 'NetworkError';
    this.cause = cause;
  }
}

/**
 * An error WE raised deliberately whose `message` is already guard-facing
 * copy — a GPS lock that never came, a camera that returned no photo, a
 * file over the upload ceiling.
 *
 * WHY THIS IS NEEDED. Without it these are indistinguishable from a bug in
 * our own code, so guardMessage() would discard perfectly good copy,
 * substitute a generic fallback, and file a Sentry issue for a condition
 * that is not a defect. `throw new Error('GPS lock failed. Move to an area
 * with better signal and try again.')` appears at five call sites and every
 * one of them means exactly what it says.
 *
 * Use it ONLY when the string is written for a guard to read. If the text
 * contains a status code, a stack, a field name, or the words "unexpected"
 * or "invalid", it is not guard-facing — throw a plain Error and let the
 * call site's fallback speak instead.
 */
export class GuardFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardFacingError';
  }
}

/**
 * True ONLY for a transport-level failure — `fetch` rejected before a
 * status code existed. offlineStore branches on this to decide whether an
 * action may be queued.
 *
 * This used to be `err instanceof Error && !(err instanceof ApiError)`,
 * i.e. "anything that isn't an ApiError is a network problem". That is
 * false: a GPS read that throws, or a TypeError in our own code, would
 * both classify as network failures and be queued for a retry that could
 * never fix them. Only a genuine NetworkError qualifies now.
 */
export function isNetworkError(err: unknown): boolean {
  return err instanceof NetworkError;
}
