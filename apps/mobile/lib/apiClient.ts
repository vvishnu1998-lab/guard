/**
 * Mobile API client
 * - Automatically attaches Bearer token to every request
 * - Silently refreshes access token on 401 (single retry)
 * - Triggers logout on refresh failure
 */
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Updates from 'expo-updates';
import { refreshTokens, RefreshRejectedError } from './refreshManager';

const BASE = process.env.EXPO_PUBLIC_API_URL;

/**
 * Client identity header — X-NetraOps-Client.
 *
 * WHY THIS EXISTS: Android sends a bare `okhttp/4.12.0` user agent with no
 * app version, so Railway HTTP logs cannot tell which build a request came
 * from. Establishing which runtime one guard's device was on cost a full
 * session of forensics on 2026-08-21 and ultimately had to be answered from
 * Sentry tags. With this header, every future runtime question is one log
 * query.
 *
 * Format: `platform/<os>; version/<appVersion>; build/<buildNumber>; runtime/<runtimeVersion>; update/<updateId>`
 *
 * Computed ONCE at module load — these values cannot change within a
 * process, and rebuilding the string per request would be waste on the
 * hot path.
 *
 * Note `version` is the JS bundle's app version (from the update manifest
 * after an OTA), while `build` is the NATIVE binary's build number.
 * They diverge deliberately: build tells you the binary, version+runtime
 * tell you what JS is running on it. app.json's buildNumber/versionCode lag
 * EAS remote versioning, so treat `build` as indicative, `runtime` as
 * authoritative for OTA targeting.
 */
const CLIENT_HEADER: string = (() => {
  try {
    const cfg = Constants.expoConfig;
    const version = cfg?.version ?? 'unknown';
    const build =
      Platform.OS === 'ios'
        ? cfg?.ios?.buildNumber ?? 'unknown'
        : String(cfg?.android?.versionCode ?? 'unknown');
    // Updates.runtimeVersion / updateId are null in Expo Go and in dev
    // builds with updates disabled — never throw over telemetry.
    const runtime = Updates.runtimeVersion ?? 'unknown';
    const update = Updates.updateId ?? 'embedded';
    return `platform/${Platform.OS}; version/${version}; build/${build}; runtime/${runtime}; update/${update}`;
  } catch {
    return `platform/${Platform.OS}; version/unknown; build/unknown; runtime/unknown; update/unknown`;
  }
})();

async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync('guard_access_token');
}

export interface ApiRequestOptions {
  /** Extra headers to merge in (e.g. Idempotency-Key). Caller-supplied
   *  values cannot overwrite Content-Type or Authorization. */
  headers?: Record<string, string>;
}

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

/** True for network / DNS / abort failures — anything where `fetch` itself
 *  rejected before we got a status code. offlineStore branches on this to
 *  decide whether to queue (network failure → queue) or propagate to the
 *  UI (4xx server response → re-throw). SessionExpiredError is an ApiError,
 *  so revocation is never mistaken for a network failure. */
export function isNetworkError(err: unknown): boolean {
  return err instanceof Error && !(err instanceof ApiError);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: ApiRequestOptions,
  retry = true,
): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-NetraOps-Client': CLIENT_HEADER,
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options?.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      if (k === 'Content-Type' || k === 'Authorization' || k === 'X-NetraOps-Client') continue;
      headers[k] = v;
    }
  }

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry) {
    try {
      await refreshTokens();
    } catch (refreshErr) {
      if (refreshErr instanceof RefreshRejectedError) {
        // Definitive revocation. logout() is single-flight and skips the
        // network calls when the token is dead, so N concurrent 401s
        // collapse into one teardown + one login redirect — no volley of
        // fcm-null / /auth/logout / further refresh requests.
        const { useAuthStore } = await import('../store/authStore');
        void useAuthStore.getState().logout({ tokenRevoked: true });
        throw new SessionExpiredError();
      }
      // Transient failure (network drop, refresh 5xx): NOT a revocation.
      // Propagate the raw error so isNetworkError() callers keep their
      // queue/banner retry behaviour and nobody gets logged out offline.
      throw refreshErr;
    }
    return request<T>(method, path, body, options, false);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new ApiError(res.status, body);
  }

  return res.json() as Promise<T>;
}

export const apiClient = {
  get:    <T>(path: string, options?: ApiRequestOptions)                   => request<T>('GET', path, undefined, options),
  post:   <T>(path: string, body?: unknown, options?: ApiRequestOptions)   => request<T>('POST', path, body, options),
  patch:  <T>(path: string, body?: unknown, options?: ApiRequestOptions)   => request<T>('PATCH', path, body, options),
  delete: <T>(path: string, options?: ApiRequestOptions)                   => request<T>('DELETE', path, undefined, options),
};
