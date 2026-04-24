/**
 * Authenticated API client for client portal.
 * Reads the guard_client_access JWT cookie and attaches it as Bearer token.
 */

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getToken(): string {
  if (typeof document === 'undefined') return '';
  return document.cookie.match(/guard_client_access=([^;]+)/)?.[1] ?? '';
}

export async function clientFetch(path: string, options?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${getToken()}`,
      ...(options?.headers ?? {}),
    },
  });
}

export async function clientGet<T>(path: string): Promise<T> {
  const res = await clientFetch(path);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetches a short-lived (60 s) PDF download URL from the API.
 * The long-lived client JWT never touches the URL — we POST it as a Bearer
 * token, the server mints a purpose-scoped handoff token, and we
 * `window.open` the returned URL. See audit/WEEK1.md §C4 (CB5 fix).
 */
export async function requestPdfDownloadUrl(from: string, to: string): Promise<string> {
  const res = await clientFetch('/api/client/reports/pdf-link', {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `Failed to build download link: ${res.status}`);
  }
  const { url } = (await res.json()) as { url: string; expires_in: number };
  return `${API}${url}`;
}
