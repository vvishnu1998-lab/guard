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
    cache: 'no-store',  // never serve a stale list — refetches after mutations must reflect them
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

/**
 * Download a file from an authenticated admin endpoint. Uses fetch + blob so
 * the Bearer token goes on the request header — window.location.href
 * downloads don't send cross-origin cookies (or headers), which is why the
 * old ?token= query-param pattern silently 401'd in prod.
 *
 * Throws on non-2xx or on any transport error. The caller shows a UI error.
 */
export async function adminDownload(path: string, filename: string): Promise<void> {
  const res = await adminFetch(path);
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Download failed (${res.status}): ${msg.slice(0, 200)}`);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}

/**
 * POST-body download variant: sends filter payload as JSON, gets a blob
 * back, triggers browser download. Used by activity-logs PDF export
 * where filter state is too large / structured for query params.
 */
export async function adminDownloadPost(path: string, body: unknown, filename: string): Promise<void> {
  const res = await adminFetch(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) {
    const msg = await res.text().catch(() => '');
    throw new Error(`Download failed (${res.status}): ${msg.slice(0, 200)}`);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
}
