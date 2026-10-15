/**
 * N203 stage 1 and N205 (Vishnu's decisions 1a 2a 3a 4a, 2026-10-14).
 *
 * N203 moves the web's session out of cookies that page scripts can read. This
 * stage only adds the server's half; the web still sends its bearer token, and
 * stage 2 (no earlier than 8 hours after this deploys) moves it over.
 *
 * - At sign-in, and when a client switches site, the API also sets the session as
 *   an HttpOnly cookie, one per portal (1a): SameSite=Lax, Path=/, Secure on https,
 *   for the access token's 8 hours. It is host-only, so it is sent to the API's
 *   host alone. It is set only for an origin in ALLOWED_ORIGINS: Vercel previews
 *   keep the bearer path (2a), and a request without an Origin is not a browser.
 * - requireAuth accepts the cookie when a request has no Authorization header and
 *   names its portal in X-NetraOps-Portal. The header says which portal's cookie
 *   to read (one browser can hold all three), and another site cannot send it
 *   without passing CORS. A write the cookie authenticates must also come from an
 *   allowed Origin (3a).
 * - Sign-out and a change of password clear it.
 *
 * Stage 2 (Vishnu's decisions 1a 2a 3b 4a, 2026-10-15): the web uses the cookie
 * on its own site, and names its portal on every request, sign-in included. A
 * session made for that web, from a production netraops.com origin, is not also
 * handed to the page in the response body (3b): previews, the mobile app and the
 * web before stage 2 name no portal, so they keep the tokens they need. The
 * admin's "Preview as client" gets its read-only token as the client portal's
 * cookie, for the token's 30 minutes (N206).
 *
 * N205: every web sign-in gets a session id (`sid`), carried by every token minted
 * from it and from its refreshes. A revoked_tokens row keyed `sid:<sid>` revokes
 * all of them at once: sign-out writes one, and a client's site switch writes one
 * before it starts a new sid for the new site. Guards' tokens carry no sid.
 */
import crypto from 'crypto';
import type { Request, Response } from 'express';
import { pool } from '../db/pool';

export type WebRole = 'company_admin' | 'client' | 'vishnu';
type Portal = 'admin' | 'client' | 'vishnu';

const PORTAL_ROLE: Record<Portal, WebRole> = { admin: 'company_admin', client: 'client', vishnu: 'vishnu' };
const ROLE_PORTAL: Record<WebRole, Portal> = { company_admin: 'admin', client: 'client', vishnu: 'vishnu' };
const PORTALS = Object.keys(PORTAL_ROLE) as Portal[];
const WEB_ROLES = Object.keys(ROLE_PORTAL) as WebRole[];

/** The request header that names the portal whose cookie authenticates a request. */
export const PORTAL_HEADER = 'x-netraops-portal';
export const SESSION_COOKIE: Record<Portal, string> = {
  admin: 'netraops_admin_session',
  client: 'netraops_client_session',
  vishnu: 'netraops_vishnu_session',
};
/** The access token's lifetime (ACCESS_TOKEN_TTL in routes/auth.ts): the cookie never outlives its token. */
const SESSION_COOKIE_MAX_AGE_S = 8 * 60 * 60;
/** The refresh token's lifetime (REFRESH_TOKEN_TTL): no token of a revoked sign-in outlives its row. */
const SID_REVOCATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function isWebRole(role: unknown): role is WebRole {
  return WEB_ROLES.includes(role as WebRole);
}

export function newSid(): string {
  return crypto.randomUUID();
}

/** The revoked_tokens key that revokes a whole sign-in. */
export function sidKey(sid: string): string {
  return `sid:${sid}`;
}

/** ALLOWED_ORIGINS, parsed exactly as index.ts parses it for CORS. */
export function allowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
}

export function isAllowedOrigin(origin: unknown): origin is string {
  return typeof origin === 'string' && allowedOrigins().includes(origin);
}

function cookieAttributes(origin: string): string | null {
  let secure: boolean;
  try {
    secure = new URL(origin).protocol === 'https:';
  } catch {
    return null;
  }
  return ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])].join('; ');
}

function writeCookie(req: Request, res: Response, role: unknown, value: string, maxAge: number): void {
  const origin = req.headers.origin;
  if (!isWebRole(role) || !isAllowedOrigin(origin)) return;
  const attributes = cookieAttributes(origin);
  if (!attributes) return;
  res.append('Set-Cookie', `${SESSION_COOKIE[ROLE_PORTAL[role]]}=${value}; ${attributes}; Max-Age=${maxAge}`);
}

/** Sets the portal's session cookie, for a browser on an allowed origin only, for the token's lifetime. */
export function setSessionCookie(req: Request, res: Response, role: unknown, accessToken: string, maxAgeS = SESSION_COOKIE_MAX_AGE_S): void {
  writeCookie(req, res, role, accessToken, maxAgeS);
}

/** Clears the portal's session cookie, with the attributes it was set with. */
export function clearSessionCookie(req: Request, res: Response, role: unknown): void {
  writeCookie(req, res, role, '', 0);
}

/**
 * 3b: a request from the web that keeps its session in the cookie: a production
 * netraops.com origin (https, in ALLOWED_ORIGINS) that names a portal.
 */
export function isCookieWebRequest(req: Request): boolean {
  const origin = req.headers.origin;
  const named = req.headers[PORTAL_HEADER];
  if (!isAllowedOrigin(origin) || typeof named !== 'string' || !PORTALS.includes(named as Portal)) return false;
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && (url.hostname === 'netraops.com' || url.hostname.endsWith('.netraops.com'));
  } catch {
    return false;
  }
}

/** The tokens a response's body carries: none for the cookie web (3b), all of them for everyone else. */
export function bodyTokens<T extends object>(req: Request, tokens: T): Partial<T> {
  return isCookieWebRequest(req) ? {} : tokens;
}

/**
 * The session cookie a request names in X-NetraOps-Portal, or null. Two different
 * values under one name is a session that cannot be told apart: null.
 */
export function sessionFromCookie(req: Request): { role: WebRole; token: string } | null {
  const named = req.headers[PORTAL_HEADER];
  if (typeof named !== 'string' || !PORTALS.includes(named as Portal)) return null;
  const portal = named as Portal;
  const values: string[] = [];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === SESSION_COOKIE[portal]) values.push(part.slice(eq + 1).trim());
  }
  if (values.length === 0 || !values[0] || values.some((v) => v !== values[0])) return null;
  return { role: PORTAL_ROLE[portal], token: values[0] };
}

/**
 * N205: ends a client's sign-in, every token minted from it, before a site switch
 * starts a new one. False when another switch or a sign-out ended it first: the
 * caller refuses, so one sign-in never becomes two.
 */
export async function endSignInForSwitch(user: { jti?: string; sid?: string; exp: number }): Promise<boolean> {
  const rows: Array<[string, Date]> = [];
  if (user.sid) rows.push([sidKey(user.sid), new Date(Date.now() + SID_REVOCATION_TTL_MS)]);
  if (user.jti) rows.push([user.jti, new Date(user.exp * 1000)]);
  for (const [i, [key, expires]] of rows.entries()) {
    try {
      await pool.query('INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2)', [key, expires]);
    } catch (err: any) {
      // The first row decides: if it was already revoked, someone else ended this sign-in.
      if (err?.code !== '23505') throw err;
      if (i === 0) return false;
    }
  }
  return rows.length > 0;
}

/** N205: sign-out ends the whole sign-in. Already ended is ended (sign-out stays idempotent). */
export async function endSignIn(sid: string | undefined): Promise<void> {
  if (!sid) return;
  await pool.query(
    'INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2) ON CONFLICT (jti) DO NOTHING',
    [sidKey(sid), new Date(Date.now() + SID_REVOCATION_TTL_MS)],
  );
}
