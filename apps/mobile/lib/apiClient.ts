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

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  retry = true
): Promise<T> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && retry) {
    try {
      await refreshAccessToken();
      return request<T>(method, path, body, false);
    } catch {
      const { useAuthStore } = await import('../store/authStore');
      useAuthStore.getState().logout();
      throw new Error('Session expired. Please log in again.');
    }
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(err.error ?? `Request failed: ${path}`);
  }

  return res.json() as Promise<T>;
}

export const apiClient = {
  get:    <T>(path: string)                   => request<T>('GET', path),
  post:   <T>(path: string, body?: unknown)   => request<T>('POST', path, body),
  patch:  <T>(path: string, body?: unknown)   => request<T>('PATCH', path, body),
  delete: <T>(path: string)                   => request<T>('DELETE', path),
};
