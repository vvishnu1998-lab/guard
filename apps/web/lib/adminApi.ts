/**
 * Authenticated API client for admin web portal.
 * Reads the guard_admin_access JWT cookie and attaches it as Bearer token.
 * All pages in /admin use this instead of raw fetch.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.match(/guard_admin_access=([^;]+)/)?.[1] ?? '';
}

export async function adminFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options?.headers ?? {}),
    },
  });
}

/** Throws if response is not ok, returns parsed JSON. */
export async function adminGet<T>(path: string): Promise<T> {
  const res = await adminFetch(path);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function adminPost<T>(path: string, body: unknown): Promise<T> {
  const res = await adminFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function adminPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await adminFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function adminDelete(path: string): Promise<void> {
  const res = await adminFetch(path, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
}
