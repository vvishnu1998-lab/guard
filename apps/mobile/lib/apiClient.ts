/**
 * Mobile API client
 * - Automatically attaches Bearer token to every request
 * - Silently refreshes access token on 401 (single retry)
 * - Triggers logout on refresh failure
 */
import * as SecureStore from 'expo-secure-store';

const BASE = process.env.EXPO_PUBLIC_API_URL;

async function getAccessToken(): Promise<string | null> {
  return SecureStore.getItemAsync('guard_access_token');
}

async function refreshAccessToken(): Promise<string> {
  const refresh = await SecureStore.getItemAsync('guard_refresh_token');
  if (!refresh) throw new Error('No refresh token available');

  const res = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: refresh }),
  });
  if (!res.ok) throw new Error('Session expired — please log in again');

  const data = await res.json();
  await SecureStore.setItemAsync('guard_access_token', data.access);
  await SecureStore.setItemAsync('guard_refresh_token', data.refresh);
  return data.access;
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

/** True for network / DNS / abort failures — anything where `fetch` itself
 *  rejected before we got a status code. offlineStore branches on this to
 *  decide whether to queue (network failure → queue) or propagate to the
 *  UI (4xx server response → re-throw). */
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
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (options?.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      if (k === 'Content-Type' || k === 'Authorization') continue;
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
      await refreshAccessToken();
      return request<T>(method, path, body, options, false);
    } catch {
      const { useAuthStore } = await import('../store/authStore');
      useAuthStore.getState().logout();
      throw new Error('Session expired. Please log in again.');
    }
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
