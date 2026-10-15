/**
 * N202: SIGN OUT ends the session on the server, in all three web portals
 * (Vishnu's decisions 1a and 2a, 2026-10-14).
 *
 * Until now SIGN OUT only cleared the browser's cookies. The session token then
 * stayed valid for up to 8 hours, and the refresh token for 30 days, for anyone
 * holding a copy. POST /api/auth/logout revokes the session token and, when one
 * is sent, the refresh token, and records the sign-out.
 *
 * The browser no longer stores a refresh token (2a): nothing in the web ever
 * read it. One stored before this change is sent once, so it is revoked too,
 * and then cleared.
 *
 * The cookies go, and the caller opens the sign-in page, whatever the API
 * answers and after at most SIGN_OUT_TIMEOUT_MS: a network error never keeps
 * anyone signed in. Two clicks make one request.
 *
 * No keepalive: SIGN OUT waits for the answer before it leaves the page, so it
 * needs none, and a keepalive request that needs a CORS preflight, as this one
 * does (JSON and a bearer token, to the API's origin), has been refused by
 * browsers: Chrome refused it when keepalive shipped (Chrome 152 sends it). A
 * refused request would sign the browser out and leave the session alive.
 */
const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type Portal = 'admin' | 'client' | 'vishnu';

const COOKIE_PREFIX: Record<Portal, string> = { admin: 'guard_admin', client: 'guard_client', vishnu: 'guard_vishnu' };
export const SIGN_IN_PATH: Record<Portal, string> = { admin: '/admin/login', client: '/client/login', vishnu: '/vishnu/login' };
export const SIGN_OUT_TIMEOUT_MS = 3000;

function readCookie(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : '';
}

const pending: Partial<Record<Portal, Promise<void>>> = {};

/** Ends the portal's session on the server (best effort, bounded), then in the browser. */
export function endSession(portal: Portal): Promise<void> {
  const inFlight = pending[portal];
  if (inFlight) return inFlight;
  const run = (async () => {
    const prefix = COOKIE_PREFIX[portal];
    const access = readCookie(`${prefix}_access`);
    const refresh = readCookie(`${prefix}_refresh`);
    if (access) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SIGN_OUT_TIMEOUT_MS);
      try {
        await fetch(`${API}/api/auth/logout`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${access}` },
          body: JSON.stringify(refresh ? { refresh_token: refresh } : {}),
        });
      } catch {
        // Refused, unreachable or slower than the cap: the browser signs out all the same.
      } finally {
        clearTimeout(timer);
      }
    }
    document.cookie = `${prefix}_access=; path=/; max-age=0`;
    document.cookie = `${prefix}_refresh=; path=/; max-age=0`;
  })();
  pending[portal] = run;
  return run.finally(() => { delete pending[portal]; });
}
