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

/** Returns the PDF download URL with the auth token embedded as a query param. */
export function pdfDownloadUrl(from: string, to: string): string {
  const token = typeof document !== 'undefined'
    ? (document.cookie.match(/guard_client_access=([^;]+)/)?.[1] ?? '')
    : '';
  const params = new URLSearchParams({ from, to, token });
  return `${API}/api/client/reports/pdf?${params}`;
}
