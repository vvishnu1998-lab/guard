/**
 * Refresh token rotation — shared, deduped, sub-guarded.
 *
 * Why this file exists:
 *   Two callers used to independently POST /api/auth/refresh with the same
 *   refresh_token: apiClient.refreshAccessToken (401-retry path) and
 *   authStore._refreshTokens (loadSession path). When N auth-required
 *   requests 401 near-simultaneously (e.g. right after a tokens_not_before
 *   bump), N concurrent /refresh calls fire with the same jti. Server-side
 *   this raced through the JTI rotation (see fix 476fa22 which now
 *   serializes it) but the mobile-side fix is to only ever have ONE
 *   /refresh call in flight at a time. All callers await the same
 *   `pendingRefresh` promise.
 *
 * Sub-mismatch guard: after the server responds, we decode the new access
 * token's payload and compare its `sub` against the SecureStore-persisted
 * guard_id. If they differ, something has gone very wrong (server-side
 * confusion, MITM, response mixup) and we do NOT save the new tokens.
 * Sentry captureMessage('error') so it's visible in the issues feed, then
 * throw — caller's catch surfaces a login screen.
 */
import * as Sentry from '@sentry/react-native';
import * as SecureStore from 'expo-secure-store';
import { ApiError, NetworkError } from './errors';

const BASE = process.env.EXPO_PUBLIC_API_URL;

const KEYS = {
  ACCESS: 'guard_access_token',
  REFRESH: 'guard_refresh_token',
  GUARD_ID: 'guard_id',
};

// Match authStore._saveSession / apiClient KEYCHAIN_OPTS: rewrites of
// guard_access_token and guard_refresh_token must retain
// AFTER_FIRST_UNLOCK accessibility so the background geofence-Exit task
// (tasks/locationBackground.ts) can read them from a locked phone.
const KEYCHAIN_OPTS = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

/**
 * Thrown when the server DEFINITIVELY rejected our session (401/403 on
 * /auth/refresh — nbf revocation, expired/rotated refresh token), when we
 * have no refresh token at all, or on a sub mismatch. Distinguishes "this
 * session is dead, log out" from a transient network/5xx failure, which
 * propagates as a plain error and must NOT trigger logout — offline guards
 * keep their retry + banner behaviour (spec 2026-08-20, deepak lockout).
 */
export class RefreshRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefreshRejectedError';
  }
}

let pendingRefresh: Promise<void> | null = null;

function decodeJwtSub(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return typeof payload?.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

async function doRefresh(): Promise<void> {
  const refresh = await SecureStore.getItemAsync(KEYS.REFRESH);
  if (!refresh) throw new RefreshRejectedError('No refresh token');

  Sentry.addBreadcrumb({ category: 'auth', message: 'refresh start', level: 'info' });

  // This fetch is not routed through apiClient (that would recurse), so it
  // classifies its own failures. A transport rejection must surface as a
  // NetworkError or callers downgrade it to "unknown error" and stop
  // treating it as retryable.
  let res: Response;
  try {
    res = await fetch(`${BASE}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }
  // 401/403 = the server rejected the refresh token itself (nbf bump,
  // rotation, expiry) — the session is unrecoverable. Any other non-2xx
  // (5xx, gateway timeout) is transient and must stay retryable rather
  // than logging the guard out mid-shift. It is thrown as an ApiError
  // carrying the real status, so isRetryableRestoreError's `status >= 500`
  // test sees it; a plain Error would now read as a bug in our own code
  // and stop being retried.
  if (res.status === 401 || res.status === 403) {
    throw new RefreshRejectedError('refresh rejected');
  }
  if (!res.ok) throw new ApiError(res.status, { error: 'REFRESH_FAILED' });
  const data: { access: string; refresh: string } = await res.json();

  const jwtSub = decodeJwtSub(data.access);
  const storedSub = await SecureStore.getItemAsync(KEYS.GUARD_ID);
  if (storedSub && jwtSub && storedSub !== jwtSub) {
    Sentry.captureMessage('refresh token sub mismatch — potential hijack attempt', {
      level: 'error',
      tags: { path: 'refresh_manager' },
      extra: { stored_sub: storedSub, jwt_sub: jwtSub },
    });
    throw new RefreshRejectedError('Session invalid');
  }

  await SecureStore.setItemAsync(KEYS.ACCESS, data.access, KEYCHAIN_OPTS);
  await SecureStore.setItemAsync(KEYS.REFRESH, data.refresh, KEYCHAIN_OPTS);
}

/**
 * Rotate access + refresh tokens via POST /api/auth/refresh, deduping
 * concurrent callers through a shared in-flight promise. Persists ONLY
 * the two token keys — guard_id / company_id are login-only side effects
 * and don't change across a refresh.
 *
 * Throws on: no refresh token in SecureStore, server 4xx/5xx, sub mismatch
 * between the new access token and the stored guard_id. Callers should
 * treat any throw as "log the user out."
 */
export async function refreshTokens(): Promise<void> {
  if (pendingRefresh) {
    Sentry.addBreadcrumb({
      category: 'auth',
      message: 'refresh dedup: reusing in-flight',
      level: 'info',
    });
    return pendingRefresh;
  }

  pendingRefresh = (async () => {
    try {
      await doRefresh();
    } finally {
      pendingRefresh = null;
    }
  })();

  return pendingRefresh;
}
