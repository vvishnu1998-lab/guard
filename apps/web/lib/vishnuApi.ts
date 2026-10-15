/**
 * Authenticated API client for Vishnu super admin portal.
 * Sends the session the way lib/session.ts says (N203 stage 2): the API's
 * HttpOnly cookie on the web's own site, the bearer token on a preview.
 */
import { authInit, signedOut } from './session';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function vishnuFetch(path: string, options?: RequestInit): Promise<Response> {
  const auth = authInit('vishnu');
  const res = await fetch(`${API}${path}`, {
    credentials: auth.credentials,
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...auth.headers,
      ...(options?.headers ?? {}),
    },
  });
  // N203 stage 2: the API's 401 is the real check. The session is gone: sign in again.
  if (res.status === 401) signedOut('vishnu');
  return res;
}

export async function vishnuGet<T>(path: string): Promise<T> {
  const res = await vishnuFetch(path);
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      return Promise.reject(new Error('Unauthorized'));
    }
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function vishnuPost<T>(path: string, body: unknown): Promise<T> {
  const res = await vishnuFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function vishnuPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await vishnuFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
