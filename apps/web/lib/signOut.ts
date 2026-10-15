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
 *
 * N203 stage 2: on the web's own site the session is the API's HttpOnly cookie,
 * which no script can see, so SIGN OUT always asks the API, naming the portal,
 * and the API clears the cookie. On a preview it sends the bearer token, as
 * before. Then the browser forgets the hint and any token (lib/session.ts).
 */
import { authInit, cookieSession, forgetSession, SIGN_IN_PATH, type Portal } from './session';

export { SIGN_IN_PATH };
export type { Portal };

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

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
    const access = readCookie(`guard_${portal}_access`);
    const refresh = readCookie(`guard_${portal}_refresh`);
    if (cookieSession() || access) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SIGN_OUT_TIMEOUT_MS);
      try {
        await fetch(`${API}/api/auth/logout`, {
          method: 'POST',
          // N203 stage 1: so the browser applies the API's clearing of the HttpOnly session cookie.
          credentials: 'include',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json', ...authInit(portal).headers },
          body: JSON.stringify(refresh ? { refresh_token: refresh } : {}),
        });
      } catch {
        // Refused, unreachable or slower than the cap: the browser signs out all the same.
      } finally {
        clearTimeout(timer);
      }
    }
    forgetSession(portal);
  })();
  pending[portal] = run;
  return run.finally(() => { delete pending[portal]; });
}
