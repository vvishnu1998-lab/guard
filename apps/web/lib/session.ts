/**
 * N203 stage 2: how the web holds a portal's session (Vishnu's decisions 1a 2a
 * 3b 4a, 2026-10-15).
 *
 * Where the page and the API are the same site (www.netraops.com and
 * api.netraops.com; localhost in development), the session is the API's
 * HttpOnly cookie, set at sign-in. No script here ever reads it: each request
 * sends it (`credentials: 'include'`) and names its portal, which tells the API
 * which of the browser's portal cookies to read. A production sign-in gets no
 * token in its response body (3b).
 *
 * Anywhere else (Vercel previews, 2a) the browser cannot hold that cookie, so
 * the web keeps today's bearer token in `guard_<portal>_access`.
 *
 * Either way, a non-secret hint, `netraops_<portal>_signed_in=1`, tells the page
 * guard (middleware.ts) to let the portal's pages through. It decides nothing:
 * the API's 401 is the real check, and one makes the browser forget the session
 * and open the sign-in page.
 */
export type Portal = 'admin' | 'client' | 'vishnu';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export const SIGN_IN_PATH: Record<Portal, string> = { admin: '/admin/login', client: '/client/login', vishnu: '/vishnu/login' };
/** Names the portal whose cookie authenticates a request (the API's services/webSession.ts). */
export const PORTAL_HEADER = 'X-NetraOps-Portal';
/** The hint the page guard reads. Not a secret: the API decides. */
export const hintCookie = (portal: Portal) => `netraops_${portal}_signed_in`;
/** The bearer path's token (previews), and the session cookie of the web before stage 2. */
export const tokenCookie = (portal: Portal) => `guard_${portal}_access`;
/** The access token's 8 hours. */
const SESSION_S = 8 * 60 * 60;

/** Shown when a sign-in's cookie did not stay in the browser, instead of sending it round to sign in again. */
export const COOKIE_REFUSED = 'Your browser did not keep the sign-in. Allow cookies for netraops.com, then sign in again.';

/** One site: the same host, or the same last two labels (www.netraops.com and api.netraops.com). */
export function sameSite(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const tail = (h: string) => h.split('.').slice(-2).join('.');
  return a.includes('.') && b.includes('.') && !/^[\d.]+$/.test(a) && !/^[\d.]+$/.test(b) && tail(a) === tail(b);
}

/** The API's host, from NEXT_PUBLIC_API_URL. */
export function apiHost(): string {
  try { return new URL(API).hostname; } catch { return ''; }
}

/** True where the session is the API's cookie: the page and the API are one site. */
export function cookieSession(): boolean {
  return typeof window !== 'undefined' && sameSite(window.location.hostname, apiHost());
}

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const m = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? m[1] : '';
}

/** What a request to the API carries to say who is asking: the cookie and the portal's name, or the bearer token. */
export function authInit(portal: Portal): { credentials?: RequestCredentials; headers: Record<string, string> } {
  if (cookieSession()) return { credentials: 'include', headers: { [PORTAL_HEADER]: portal } };
  return { headers: { Authorization: `Bearer ${readCookie(tokenCookie(portal))}` } };
}

/** The headers a sign-in request adds: the portal's name for the cookie web (so the body carries no token, 3b). */
export function signInHeaders(portal: Portal): Record<string, string> {
  return cookieSession() ? { [PORTAL_HEADER]: portal } : {};
}

/** After a sign-in, a site switch or a preview: the hint, and on the bearer path the token as well. */
export function markSignedIn(portal: Portal, access?: string, maxAgeS = SESSION_S): void {
  const secure = typeof window !== 'undefined' && window.location.protocol === 'https:' ? '; Secure' : '';
  if (!cookieSession() && access) document.cookie = `${tokenCookie(portal)}=${access}; path=/; max-age=${maxAgeS}; SameSite=Strict`;
  document.cookie = `${hintCookie(portal)}=1; path=/; max-age=${maxAgeS}; SameSite=Lax${secure}`;
}

/** Forgets the portal's session in this browser: the hint and every token cookie, today's and the web's before stage 2. */
export function forgetSession(portal: Portal): void {
  for (const name of [hintCookie(portal), tokenCookie(portal), `guard_${portal}_refresh`]) {
    document.cookie = `${name}=; path=/; max-age=0`;
  }
}

/** The API's 401: the session is gone. The browser forgets it and opens the portal's sign-in page. */
export function signedOut(portal: Portal): void {
  if (typeof window === 'undefined') return;
  forgetSession(portal);
  if (window.location.pathname !== SIGN_IN_PATH[portal]) window.location.href = SIGN_IN_PATH[portal];
}

/** A cheap read each portal may make, to see that the browser kept the cookie. */
const PROBE: Record<Portal, string> = { admin: '/api/admin/company', client: '/api/client/site', vishnu: '/api/admin/companies' };

/**
 * After a sign-in on the cookie path: did the browser keep the cookie? A 401 says
 * no, and the hint goes; anything else (a 403 hold included) says yes. On the
 * bearer path, yes.
 */
export async function sessionKept(portal: Portal): Promise<boolean> {
  if (!cookieSession()) return true;
  try {
    const r = await fetch(`${API}${PROBE[portal]}`, { ...authInit(portal), cache: 'no-store' });
    if (r.status !== 401) return true;
  } catch {
    return true;
  }
  forgetSession(portal);
  return false;
}
