/**
 * Authenticated API client for client portal.
 * Sends the client's session the way lib/session.ts says (N203 stage 2): the
 * API's HttpOnly cookie on the web's own site, the bearer token on a preview.
 * An admin's "Preview as client" arrives the same way, as the client portal's
 * cookie, never as a token in a URL (N206).
 */
import { authInit, signedOut } from './session';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export async function clientFetch(path: string, options?: RequestInit): Promise<Response> {
  const auth = authInit('client');
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
  if (res.status === 401) signedOut('client');
  return res;
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
