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
import { ApiError, SessionExpiredError, NetworkError, isNetworkError } from './errors';

// Re-exported so the ~25 call sites importing these from './apiClient'
// keep working. lib/errors.ts is the definition; see its header for why
// the three-way distinction exists.
export { ApiError, SessionExpiredError, NetworkError, isNetworkError };

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

  // A rejection here means no status code ever existed — offline, DNS, TLS,
  // reset, abort. It is NOT interchangeable with a 4xx/5xx and must not be
  // shown to a guard raw: RN's own message is "Network request failed".
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (cause) {
    throw new NetworkError(cause);
  }

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
