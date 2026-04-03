/**
 * Authenticated API client for Vishnu super admin portal.
 * Reads the guard_vishnu_access JWT cookie and attaches it as Bearer token.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.match(/guard_vishnu_access=([^;]+)/)?.[1] ?? '';
}

export async function vishnuFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options?.headers ?? {}),
    },
  });
}

export async function vishnuGet<T>(path: string): Promise<T> {
  const res = await vishnuFetch(path);
  if (!res.ok) {
    if (res.status === 401 && typeof window !== 'undefined') {
      window.location.href = '/vishnu/login';
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
